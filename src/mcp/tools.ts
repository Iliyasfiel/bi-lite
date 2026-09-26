/**
 * MCP 工具集（docs/需求与架构.md §7.1）
 *
 * ★ 这是 agent 与数据之间的**唯一**接缝。设计上只有五个工具，且**没有一个能取数**。
 *
 * 安全不变量（铁律 1）：本文件导出的任何函数都不得把金额写进返回值。
 *   - `list_metrics`       只读维度表，零金额
 *   - `get_template_schema` 读模板结构；**模板里的数字一律不回传**，只回标签文本
 *   - `preview_spec`       出坐标网格；**根本不查库**，因此结构上不可能泄漏
 *   - `render_report`      内部查库填 Excel，数值只存在于本地变量，只回路径与计数
 *   - `diff_report`        比较 spec 文本差异；spec 里只有标签与格式串，没有金额
 *
 * 另外设一道**机械兜底**（`findAmountLike`）：任何工具返回值里若出现 ≥ 10000 的数字，
 * 本次调用直接失败。它不替代上面的结构设计，只是让"将来某次改动不小心泄漏"变成
 * 一个响亮的错误，而不是一条安静的泄漏。
 */
import fs from 'node:fs';
import path from 'node:path';
import XLSXPopulate from 'xlsx-populate';
import type { Workbook, Sheet } from 'xlsx-populate';
import * as db from '../db/index.ts';
import { catalog } from '../semantic/query.ts';
import { parseSpec, expandBlock, type Spec } from '../spec/types.ts';
import { compileBlock, runCompiled, planOf } from '../spec/compile.ts';
import { renderTemplate, type RenderBlock } from '../render/excel.ts';
import { chartShape, type ChartSpec } from '../render/chart.ts';

const OUTPUT_DIR = 'output';
const DEFAULT_TEMPLATE = 'test/fixtures/月度保送表.xlsx';
const AUDIT_LOG = 'data/audit/mcp.jsonl';

/** 模板标签扫描上限（防止一个畸形模板把整张表灌进上下文） */
const TEXT_SCAN_LIMIT = 40;

// ---------------- 审计（§6.2 第④层：记录字段级输出） ----------------

/**
 * 审计日志：记**字段名**，不记值。
 * 写失败绝不静默（铁律 12），但也绝不因此中断工具（审计是旁路）。
 */
export function audit(entry: Record<string, unknown>) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true });
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error('[审计] 写入失败:', (e as Error).message);
  }
}

// ---------------- 机械兜底：金额形状的数字 ----------------

/** 超过这个量级的数字不允许出现在工具返回值里（结构性计数都在百以内） */
export const AMOUNT_TRIPWIRE = 10_000;

/** 深度找出所有"像金额"的数字，返回其路径 */
export function findAmountLike(value: unknown, at = '$'): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (typeof v === 'number') {
      if (Number.isFinite(v) && Math.abs(v) >= AMOUNT_TRIPWIRE) hits.push(`${p} = ${v}`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
    }
  };
  walk(value, at);
  return hits;
}

// ---------------- 工具实现 ----------------

/** 1. list_metrics —— 已注册的指标 / 维度 / 口径 / 公司（纯元数据） */
async function listMetrics() {
  const cat = await catalog();
  return {
    dimensions: cat.dimensions,
    periodTypes: cat.periodTypes,
    metrics: cat.metrics,
    companies: cat.companies,
    note: '以上均为元数据，不含任何金额',
  };
}

/** 单元格地址 "B4" → {row, col} */
function parseRef(ref: string): { row: number; col: number } {
  const m = ref.match(/^\$?([A-Za-z]+)\$?(\d+)$/);
  if (!m) throw new Error(`非法单元格引用: ${ref}`);
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.codePointAt(0)! - 64);
  return { row: Number(m[2]), col };
}

function toRef(row: number, col: number): string {
  let s = '';
  while (col > 0) {
    const r = (col - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    col = Math.floor((col - 1) / 26);
  }
  return `${s}${row}`;
}

/**
 * 只取**文本**单元格。模板里若有残留数字（脏模板），一律不返回 ——
 * 这是"模板必须为空表"（AGENTS.md 铁律 3 注）在 agent 侧的对应防线。
 */
function textAt(sheet: Sheet, row: number, col: number): string | null {
  if (row < 1 || col < 1) return null;
  try {
    const v = sheet.cell(row, col).value();
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** 解析 spec 里的 anchor；定义名称要给模板才能解析 */
function resolveAnchor(
  wb: Workbook | null,
  sheetName: string,
  anchor: string | { name: string },
): { ref: string; row: number; col: number; via: 'name' | 'ref'; warning?: string } {
  if (typeof anchor === 'object' && 'name' in anchor) {
    if (!wb) throw new Error(`anchor 用了定义名称 ${anchor.name}，但 spec 未声明 template，无法解析`);
    const named = wb.definedName(anchor.name);
    if (!named) throw new Error(`模板中找不到定义名称: ${anchor.name}`);
    const namedSheet = named.sheet()?.name();
    const warning =
      namedSheet && namedSheet !== sheetName
        ? `定义名称 ${anchor.name} 指向 sheet「${namedSheet}」，与 block.sheet「${sheetName}」不一致`
        : undefined;
    return { ref: named.address(), row: named.rowNumber(), col: named.columnNumber(), via: 'name', warning };
  }
  const { row, col } = parseRef(anchor);
  return { ref: toRef(row, col), row, col, via: 'ref' };
}

/** 2. get_template_schema —— 模板结构：锚点、表头、行标签、合并区（只回文本） */
async function getTemplateSchema(args: { template?: string }) {
  const tpl = args.template ?? DEFAULT_TEMPLATE;
  if (!fs.existsSync(tpl)) throw new Error(`模板不存在: ${tpl}`);
  const wb = await XLSXPopulate.fromFileAsync(tpl);

  const sheets = wb.sheets().map((s) => {
    const ur = s.usedRange();
    return {
      name: s.name(),
      usedRange: ur ? `${ur.startCell().address()}:${ur.endCell().address()}` : null,
      // 合并区：往合并区写值只能写左上角（§5.3.4 坑 3）
      mergedCells: Object.keys((s as unknown as { _mergeCells?: Record<string, unknown> })._mergeCells ?? {}),
      dataValidationCount: Object.keys((s as unknown as { _dataValidations?: Record<string, unknown> })._dataValidations ?? {}).length,
    };
  });

  // 定义名称 —— agent 最该用的锚点形式（模板改版式时命名区域跟着走）
  const dnNode = (wb as unknown as { _node?: { children?: Array<{ name: string; children?: unknown[] }> } })._node?.children?.find(
    (c) => c.name === 'definedNames',
  );
  const anchors = (dnNode?.children ?? []).map((n) => {
    const node = n as { attributes?: { name?: string }; children?: unknown[] };
    const name = node.attributes?.name ?? '(unnamed)';
    const refersTo = String(node.children?.[0] ?? '');
    const m = refersTo.match(/^'?([^'!]+)'?!\$?([A-Z]+)\$?(\d+)$/);
    if (!m) return { name, refersTo, cell: null, sheet: null, headerAbove: [], labelsLeft: [] };
    const [, sheetName, colLetters, rowNum] = m;
    const row = Number(rowNum);
    let col = 0;
    for (const ch of colLetters.toUpperCase()) col = col * 26 + (ch.codePointAt(0)! - 64);
    const sheet = wb.sheet(sheetName);
    const headerAbove: string[] = [];
    const labelsLeft: string[] = [];
    if (sheet) {
      // 表头在锚点上方一行、行标签在锚点左方一列 —— 这是本项目的模板约定
      for (let c = col, n = 0; n < TEXT_SCAN_LIMIT; n++, c++) {
        const t = textAt(sheet, row - 1, c);
        if (t === null) break;
        headerAbove.push(t);
      }
      for (let r = row, n = 0; n < TEXT_SCAN_LIMIT; n++, r++) {
        const t = textAt(sheet, r, col - 1);
        if (t === null) break;
        labelsLeft.push(t);
      }
    }
    return { name, refersTo, cell: `${colLetters}${row}`, sheet: sheetName, headerAbove, labelsLeft };
  });

  return {
    template: tpl,
    sheets,
    anchors,
    hint: 'anchor 优先用定义名称；headerAbove 是锚点上一行、labelsLeft 是锚点左一列，可直接对应 rows.order / cols.order',
    note: '本结构只含标签文本，模板里的任何数字都不会回传',
  };
}

/** 从参数里拿 spec（支持传 YAML 文本或文件路径） */
function loadSpec(args: { spec?: string; specFile?: string }): { spec: Spec; from: string } {
  if (args.specFile) {
    if (!fs.existsSync(args.specFile)) throw new Error(`spec 文件不存在: ${args.specFile}`);
    return { spec: parseSpec(fs.readFileSync(args.specFile, 'utf8')), from: args.specFile };
  }
  if (args.spec) return { spec: parseSpec(args.spec), from: '(内联 YAML)' };
  throw new Error('需要 spec（YAML 文本）或 specFile（路径）');
}

/**
 * 3. preview_spec —— spec 将填充的坐标网格
 *
 * ★ 关键性质：**本函数不查数据库**。坐标完全由 spec + 模板锚点推出，
 *   所以"预览不含金额"不是靠过滤保证的，是结构上不可能。
 */
async function previewSpec(args: { spec?: string; specFile?: string; params?: Record<string, string | number> }) {
  const { spec, from } = loadSpec(args);
  const p = { ...(spec.params ?? {}), ...(args.params ?? {}) };

  const wb = spec.template && fs.existsSync(spec.template) ? await XLSXPopulate.fromFileAsync(spec.template) : null;

  const planSheets = [];
  const blocks = [];

  for (const sheet of spec.sheets) {
    for (const b of sheet.blocks) {
      const anchor = resolveAnchor(wb, sheet.name, b.anchor);
      const { rowLabels, colLabels } = expandBlock(b, p);
      const endRef = toRef(anchor.row + Math.max(rowLabels.length, 1) - 1, anchor.col + Math.max(colLabels.length, 1) - 1);

      const chart = b.chart
        ? chartShape(b.chart as ChartSpec, {
            rowLabels,
            colLabels,
            matrix: rowLabels.map((l) => ({ label: l, values: colLabels.map(() => null) })),
          })
        : null;

      const headerAbove = wb
        ? colLabels.map((_, i) => {
            const s = wb.sheet(sheet.name);
            return s ? textAt(s, anchor.row - 1, anchor.col + i) : null;
          })
        : [];

      blocks.push({
        sheet: sheet.name,
        anchor: { kind: anchor.via, value: typeof b.anchor === 'object' ? b.anchor.name : b.anchor, resolved: anchor.ref },
        dataRange: `${anchor.ref}:${endRef}`,
        rows: { dim: b.rows.dim, count: rowLabels.length, labels: rowLabels },
        cols: { dim: b.cols.dim, count: colLabels.length, labels: colLabels },
        cells: rowLabels.length * colLabels.length,
        templateHeaderAbove: headerAbove,
        chart,
        ...(anchor.warning ? { warning: anchor.warning } : {}),
      });

      planSheets.push({
        sheet: sheet.name,
        anchor: anchor.ref,
        rowLabels,
        colLabels,
      });
    }
  }

  return {
    spec: { id: spec.id, title: spec.title ?? null, template: spec.template ?? null },
    from,
    params: p,
    blocks,
    plan: planOf(spec, planSheets),
    note: '预览只含坐标与形状，不含任何金额（本工具不查数据库）',
  };
}

/** 4. render_report —— 渲染 Excel，只回路径与计数 */
async function renderReport(args: {
  spec?: string;
  specFile?: string;
  params?: Record<string, string | number>;
  output?: string;
}) {
  const { spec } = loadSpec(args);
  const p = { ...(spec.params ?? {}), ...(args.params ?? {}) };
  if (!spec.template) throw new Error('spec 未声明 template，无法渲染 Excel');
  if (!fs.existsSync(spec.template)) throw new Error(`模板不存在: ${spec.template}`);

  const renderBlocks: RenderBlock[] = [];
  const planSheets = [];

  for (const sheet of spec.sheets) {
    for (const b of sheet.blocks) {
      // ↓ 数值只在本地变量里停留，绝不进返回值
      const compiled = compileBlock(b, p);
      const result = await runCompiled(compiled, (sql) => db.query(sql));
      renderBlocks.push({
        sheet: sheet.name,
        anchor: b.anchor,
        colLabels: result.colLabels,
        rows: result.matrix.map((m) => ({ label: m.label, values: m.values })),
        format: b.value.format,
        writeRowLabels: false, // 模板已预置行标签
        writeColLabels: false, // 模板已预置列标签
      });
      planSheets.push({
        sheet: sheet.name,
        anchor: String(typeof b.anchor === 'object' ? b.anchor.name : b.anchor),
        rowLabels: result.rowLabels,
        colLabels: result.colLabels,
      });
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const base = spec.id.replace(/[^\w\u4e00-\u9fa5.\-]/g, '_');
  const outName = args.output
    ? path.basename(args.output)
    : `${base}-${p.year ?? ''}${String(p.month ?? '').padStart(2, '0')}.xlsx`;
  const outPath = path.join(OUTPUT_DIR, outName);

  const result = await renderTemplate(spec.template, outPath, renderBlocks);

  return {
    outputPath: result.outputPath,
    cellsWritten: result.cellsWritten,
    blocks: result.blocks,
    formatKept: result.formatKept,
    warnings: result.warnings,
    plan: planOf(spec, planSheets),
    note: '文件已写入本地磁盘；数值不在本返回值中，请让人在 Web 上预览',
  };
}

/** 5. diff_report —— 比较两版 spec */

interface Change {
  path: string;
  before: unknown;
  after: unknown;
}

/**
 * 深度 diff。
 *
 * ★ 数组必须**逐下标递归**，不能整体当一个值 —— 否则改一行 `cols.order`
 *   会被报成"整个 sheets 变了"，`before/after` 只能打印成 `[[object Object]]`，
 *   这个工具也就没用了。（这是实测踩出来的：首版就是把数组当整体比。）
 *
 * 但**纯字符串数组**（如 order: [本年累计, 单月]）整体报告更像人话：
 * 逐下标比会得到"新增了一项、删了一项"，而人想知道的是"口径从这 4 个变成这 2 个"。
 */
function diffObjects(before: unknown, after: unknown, at = ''): Change[] {
  const out: Change[] = [];
  const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

  if (isStrArr(before) && isStrArr(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path: at, before, after });
    return out;
  }

  if (Array.isArray(before) || Array.isArray(after)) {
    const b = Array.isArray(before) ? before : [];
    const a = Array.isArray(after) ? after : [];
    const n = Math.max(b.length, a.length);
    for (let i = 0; i < n; i++) out.push(...diffObjects(b[i], a[i], `${at}[${i}]`));
    return out;
  }

  if (before && after && typeof before === 'object' && typeof after === 'object') {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      const bv = (before as Record<string, unknown>)[k];
      const av = (after as Record<string, unknown>)[k];
      out.push(...diffObjects(bv, av, at ? `${at}.${k}` : k));
    }
    return out;
  }

  if (before !== after) out.push({ path: at, before, after });
  return out;
}

async function diffReport(args: { before?: string; after?: string; beforeFile?: string; afterFile?: string }) {
  const b = loadSpec({ spec: args.before, specFile: args.beforeFile });
  const a = loadSpec({ spec: args.after, specFile: args.afterFile });
  const changes = diffObjects(b.spec, a.spec);
  const LIMIT = 100;

  // 值全部转成短文本：agent 要的是"哪个字段从什么变成什么"，
  // 嵌套对象也压成可读的一行，避免出现 `[object Object]`。
  const describe = (v: unknown): string => {
    if (v === undefined) return '(不存在)';
    if (v === null) return 'null';
    if (Array.isArray(v)) return `[${v.map(describe).join(', ')}]`;
    if (typeof v === 'object') {
      return `{${Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => `${k}: ${describe(x)}`)
        .join(', ')}}`;
    }
    return String(v);
  };

  return {
    before: { from: b.from, id: b.spec.id },
    after: { from: a.from, id: a.spec.id },
    changed: changes.length > 0,
    changeCount: changes.length,
    changes: changes.slice(0, LIMIT).map((c) => ({
      path: c.path,
      before: describe(c.before),
      after: describe(c.after),
    })),
    truncated: changes.length > LIMIT,
    // 这是本工具存在的理由：改口径只是 spec 文本的 diff，不需要任何数值参与
    note: '差异仅涉及 spec 文本（标签 / 顺序 / 格式），改口径无需任何金额参与',
  };
}

// ---------------- 工具注册表 ----------------

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_metrics',
    description:
      '列出 bi-lite 已注册的指标、维度、度量口径与公司主数据。返回纯元数据，不含任何金额。' +
      '写 spec 前先用它确认名称的准确字面值（指标名/口径名必须与这里完全一致）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => listMetrics(),
  },
  {
    name: 'get_template_schema',
    description:
      '解析一个 Excel 报送模板的结构：sheet 列表、定义名称锚点、锚点上方的表头、锚点左方的行标签、合并单元格。' +
      '用于把"人工做好的空模板"翻译成 spec 的 rows/cols/anchor。只返回标签文本，模板里的任何数字都不会回传。',
    inputSchema: {
      type: 'object',
      properties: { template: { type: 'string', description: '模板路径；省略则用默认示例模板' } },
      additionalProperties: false,
    },
    handler: (a) => getTemplateSchema(a as { template?: string }),
  },
  {
    name: 'preview_spec',
    description:
      '预览一个 spec 将填充的坐标网格：每个 block 的锚点、写入区域（如 B4:E8）、行标签、列口径标签、单元格数。' +
      '**不返回任何金额，且本工具不查数据库** —— 用于让 agent 在"数字出现之前"验证口径映射是否正确。',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'spec 的 YAML 文本（与 specFile 二选一）' },
        specFile: { type: 'string', description: 'spec 文件路径，如 specs/月度保送表.yaml' },
        params: { type: 'object', description: '覆盖 spec.params，如 { year: 2026, month: 6 }' },
      },
      additionalProperties: false,
    },
    handler: (a) => previewSpec(a as { spec?: string; specFile?: string; params?: Record<string, string | number> }),
  },
  {
    name: 'render_report',
    description:
      '按 spec 填充 Excel 模板并写出报送文件。保持模板原有版式（样式/合并/公式/图表/批注）不变。' +
      '只返回输出文件路径与写入计数，不返回任何金额 —— 人需要在 Web 界面上预览与确认。',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'spec 的 YAML 文本（与 specFile 二选一）' },
        specFile: { type: 'string', description: 'spec 文件路径' },
        params: { type: 'object', description: '覆盖 spec.params' },
        output: { type: 'string', description: '输出文件名（可选）' },
      },
      additionalProperties: false,
    },
    handler: (a) =>
      renderReport(a as { spec?: string; specFile?: string; params?: Record<string, string | number>; output?: string }),
  },
  {
    name: 'diff_report',
    description:
      '比较两版 spec 的差异（如换口径前后）。返回逐字段的 before/after 文本。' +
      '这是"经常更换表格口径"的正解：差异只在 spec 文本层面，不需要任何数值参与。',
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'string', description: '旧 spec 的 YAML 文本' },
        after: { type: 'string', description: '新 spec 的 YAML 文本' },
        beforeFile: { type: 'string', description: '旧 spec 文件路径' },
        afterFile: { type: 'string', description: '新 spec 文件路径' },
      },
      additionalProperties: false,
    },
    handler: (a) => diffReport(a as { before?: string; after?: string; beforeFile?: string; afterFile?: string }),
  },
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** MCP 期望的工具清单形状（剥离 handler） */
export function toolListPayload() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export interface CallOutcome {
  ok: boolean;
  text: string;
}

/**
 * 调用一个工具，并施加两道执行纪律：
 *   ① 金额兜底：返回值里出现 ≥ 10000 的数字 → 本次调用失败（不泄漏）
 *   ② 审计：记录工具名、参数键、返回值字段名（不记值）
 */
export async function callTool(name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  const tool = toolByName(name);
  if (!tool) {
    audit({ tool: name, ok: false, reason: 'UNKNOWN_TOOL' });
    return { ok: false, text: `未知工具: ${name}。可用工具: ${TOOLS.map((t) => t.name).join(', ')}` };
  }

  const started = Date.now();
  try {
    const result = await tool.handler(args ?? {});

    // ① 机械兜底 —— 不替代结构设计，只保证"不小心泄漏"变成响亮的错误
    const hits = findAmountLike(result);
    if (hits.length) {
      audit({ tool: name, ok: false, reason: 'AMOUNT_TRIPWIRE', hits: hits.length, argKeys: Object.keys(args ?? {}) });
      console.error(`[MCP] 金额兜底拦截 ${name}: ${hits.join('; ')}`);
      return { ok: false, text: `内部错误：工具 ${name} 的返回值出现疑似金额，已拦截（安全不变量）。` };
    }

    // ② 审计：只记字段名
    const resultKeys = result && typeof result === 'object' ? Object.keys(result as object) : [];
    audit({ tool: name, ok: true, ms: Date.now() - started, argKeys: Object.keys(args ?? {}), resultKeys });

    return { ok: true, text: JSON.stringify(result, null, 2) };
  } catch (e) {
    const err = e as Error;
    audit({ tool: name, ok: false, reason: err.name, message: err.message, argKeys: Object.keys(args ?? {}) });
    return { ok: false, text: `${err.name}: ${err.message}` };
  }
}
