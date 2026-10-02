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
import type { Workbook } from 'xlsx-populate';
import * as db from '../db/index.ts';
import { catalog } from '../semantic/query.ts';
import { parseSpec, expandBlock, diagnoseSpec, type Spec } from '../spec/types.ts';
import { compileBlock, runCompiled, planOf } from '../spec/compile.ts';
import { renderTemplate, parseRef as excelParseRef, toRef as excelToRef, type RenderBlock } from '../render/excel.ts';
import { readTemplateSchema, textAt } from '../spec/template.ts';
import { inferSpec, guessedAxes, type Registry } from '../spec/infer.ts';
import { chartShape, type ChartSpec } from '../render/chart.ts';
import { diagnoseIngest, parseIngestSpec, parseDecisions, type IngestSpec } from '../ingest/types.ts';
import { resolveSource } from '../ingest/dryrun.ts';
import { runIngest, type IngestRunResult } from '../ingest/run.ts';
import { masterCatalog } from '../ingest/master.ts';

const OUTPUT_DIR = 'output';
const DEFAULT_TEMPLATE = 'test/fixtures/月度保送表.xlsx';
const AUDIT_LOG = 'data/audit/mcp.jsonl';

/** 模板标签扫描上限（防止一个畸形模板把整张表灌进上下文）—— 已在 src/spec/template.ts 统一 */

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
const parseRef = excelParseRef;
const toRef = excelToRef;

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
  const schema = await readTemplateSchema(tpl);

  return {
    template: schema.template,
    sheets: schema.sheets,
    anchors: schema.anchors.map((a) => ({
      name: a.name,
      refersTo: a.refersTo,
      cell: a.cell,
      sheet: a.sheet,
      headerAbove: a.headerAbove,
      labelsLeft: a.labelsLeft,
    })),
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
 * 2.5 lint_spec —— 静态诊断（§7.2 路径 2 的前置条件）
 *
 * ★ 这是"让 agent 从自然语言写 spec"能成立的关键一步。
 *   如果语言本身允许欠约束的 spec，agent 每写一次就可能静默算错一次。
 *   有了本工具，agent 可以在把 spec 交给人之前**自己先撞一次墙**：
 *   ① 从自然语言写草稿 → ② lint_spec 自检 → ③ 按 issues 修 → ④ preview_spec → ⑤ 人确认。
 *
 * 诊断只看 spec 文本结构，不查库、不含金额（铁律 1）。
 */
async function lintSpecTool(args: { spec?: string; specFile?: string }) {
  let yamlText: string;
  let from: string;
  if (args.specFile) {
    if (!fs.existsSync(args.specFile)) throw new Error(`spec 文件不存在: ${args.specFile}`);
    yamlText = fs.readFileSync(args.specFile, 'utf8');
    from = args.specFile;
  } else if (args.spec) {
    yamlText = args.spec;
    from = '(内联 YAML)';
  } else {
    throw new Error('需要 spec（YAML 文本）或 specFile（路径）');
  }

  const d = diagnoseSpec(yamlText);
  const byLevel = (lv: 'error' | 'warn') => d.issues.filter((i) => i.level === lv);

  return {
    from,
    specId: d.spec?.id ?? null,
    ok: !d.willBeRejected,
    willBeRejected: d.willBeRejected,
    parseError: d.parseError,
    errors: d.errors,
    errorCount: byLevel('error').length,
    warnCount: byLevel('warn').length,
    issues: d.issues.map((i) => ({ level: i.level, code: i.code, at: i.at, message: i.message, hint: i.hint ?? null })),
    unusedParams: d.unusedParams,
    note:
      d.willBeRejected
        ? '这份 spec **保存会被拒绝**。请先修掉 errors 里每一条 —— 尤其是「没有指标/口径约束」：' +
          '它会把多个指标的金额静默加成同一个数，跑出来的数字同量级、格式正常，人不会怀疑。'
        : d.issues.length
          ? '结构上可以保存。warn 级提醒请人工判断（通常是"轴留空""顺序重复"这类不致命但会让人困惑的问题）。'
          : '没有发现问题。',
  };
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

/** 6. generate_spec —— 从模板推断 spec 草稿（§7.2 路径 1） */async function generateSpec(args: { template?: string; sheets?: string[]; id?: string; title?: string }) {
  const tpl = args.template ?? DEFAULT_TEMPLATE;
  if (!fs.existsSync(tpl)) throw new Error(`模板不存在: ${tpl}`);

  const cat = await catalog();
  const registry: Registry = {
    metrics: cat.metrics.map((m) => m.name),
    companies: cat.companies.map((c) => c.name),
    periodTypes: cat.periodTypes.map((p) => p.id),
    axisNames: cat.dimensions.map((d) => d.label),
  };

  const r = await inferSpec({ template: tpl, registry, sheets: args.sheets, id: args.id, title: args.title });

  // ★ 草稿可能**保存不了** —— 这是特性不是故障。
  //   模板里若没有指标信息（如只有「公司 × 本年累计」的分板块表），
  //   推断器宁可让 parseSpec 拒绝，也不产出一份语法合法、数字却错了的 spec。
  //   这里显式回报"能不能直接用"，让人（和 agent）一眼看到该不该先补东西。
  let draftValid = true;
  let draftError: string | null = null;
  try {
    parseSpec(r.yaml);
  } catch (e) {
    draftValid = false;
    draftError = (e as Error).message;
  }

  return {
    template: tpl,
    specId: r.spec.id,
    yaml: r.yaml,
    draftValid,
    draftError,
    blocks: r.blocks.map((b) => ({
      sheet: b.sheet,
      anchor: b.anchor,
      anchorNote: b.anchorNote,
      // dimSource：行清单来自模板（事实）、维度却是猜的 —— 只报 source 会把这次猜测藏起来
      rows: {
        dim: b.rows.dim,
        source: b.rows.source,
        dimSource: b.rows.dimSource ?? null,
        count: b.rows.order.length,
        labels: b.rows.order,
        evidence: b.rows.evidence,
      },
      cols: { dim: b.cols.dim, source: b.cols.source, count: b.cols.order.length, labels: b.cols.order, evidence: b.cols.evidence },
      // 期数读自模板（B 列/年月列）；null = 没读到，params 里那个是默认值
      period: b.period,
      format: b.format,
      excluded: b.excluded,
    })),
    // 猜的部分必须显式列出来 —— 人只核对这些，不必通读整份 YAML
    guessed: guessedAxes(r),
    unmatched: r.unmatched,
    issues: r.issues,
    note:
      '这是**草稿**，不是定稿。source=guessed 的轴与 issues 里的 warn/error 需要人工确认；' +
      'unmatched 里的名字不在注册表中，导入数据前必须先建映射（文档 R1 主数据对齐）。' +
      'draftValid=false 表示这份草稿**直接被校验拒绝**（通常是模板里没有指标信息），' +
      '请先按 issues 里的 error 补上约束再保存 —— 不要试图绕过校验。' +
      '本工具只读模板结构与标签文本，不读模板里的任何数字，也不查数据库。',
  };
}


// ---------------- 接入规格（源 Excel → 星型表）的工具 ----------------

function loadIngestSpecText(args: { spec?: string; specFile?: string }): { text: string; from: string } {
  if (args.specFile) {
    if (!fs.existsSync(args.specFile)) throw new Error(`接入规格文件不存在: ${args.specFile}`);
    return { text: fs.readFileSync(args.specFile, 'utf8'), from: args.specFile };
  }
  if (args.spec) return { text: args.spec, from: '(内联 YAML)' };
  throw new Error('需要 spec（接入规格 YAML 文本）或 specFile（路径）');
}

// 决定的解析与校验已统一到 `src/ingest/types.ts` 的 parseDecisions() ——
// 曾在这里另写一份，CLI 进来时就会变成两份判据（铁律 17）。

/**
 * 2.6 look_at_source —— 看源文件/模板的**文本视图**
 *
 * ★ 存在的理由：agent 看不到 xlsx。要写接入规格，它必须知道表头在第几行、
 *   行标签在哪一列、哪些列是数字列、哪些行带公式。这些都不需要金额。
 *
 * 安全不变量（铁律 1）：数字格**只报"这里是个数"**，永不回传数值本身。
 *   所以这个工具既能看见形状，又结构上不可能把数带出去。
 */
async function lookAtSource(args: { source?: string; sheet?: string; range?: string; maxRows?: number; maxCols?: number }) {
  if (!args.source) throw new Error('需要 source（源 Excel 路径，相对仓库根）');
  const resolved = resolveSource(args.source);
  if (!fs.existsSync(resolved)) throw new Error(`源文件不存在: ${args.source}`);
  const wb = await XLSXPopulate.fromFileAsync(resolved);
  const names = wb.sheets().map((sh) => sh.name());
  const sheetName = args.sheet ?? names[0];
  const sheet = wb.sheet(sheetName);
  if (!sheet) throw new Error(`sheet 不存在: ${sheetName}。实际有: ${names.join(', ')}`);

  const maxRows = Math.min(Math.max(args.maxRows ?? 60, 1), 500);
  const maxCols = Math.min(Math.max(args.maxCols ?? 30, 1), 80);

  const used = sheet.usedRange();
  const usedRef = used ? `${excelToRef(used.startCell().rowNumber(), used.startCell().columnNumber())}:${excelToRef(used.endCell().rowNumber(), used.endCell().columnNumber())}` : null;
  const start = args.range ? excelParseRef(args.range.split(':')[0]) : { row: 1, col: 1 };
  const stop = args.range
    ? excelParseRef(args.range.includes(':') ? args.range.split(':')[1] : args.range)
    : { row: (used?.endCell().rowNumber() ?? 1), col: (used?.endCell().columnNumber() ?? 1) };

  const lastRow = Math.min(stop.row, start.row + maxRows - 1);
  const lastCol = Math.min(stop.col, start.col + maxCols - 1);
  const countText = new Map<string, number>();

  const rows: Array<Array<unknown>> = [];
  for (let r = start.row; r <= lastRow; r++) {
    const line: Array<unknown> = [];
    for (let c = start.col; c <= lastCol; c++) {
      const cell = sheet.cell(r, c);
      const v = cell.value();
      const formula = (cell as { formula?: () => unknown }).formula?.();
      const mark: Record<string, unknown> = {};
      if (typeof v === 'string' && v !== '') mark.text = v;
      else if (typeof v === 'number') mark.num = true;
      else if (v instanceof Date) mark.date = true;
      else if (typeof v === 'boolean') mark.bool = true;
      else if (v !== undefined && v !== null && v !== '') mark.other = true;
      if (formula) mark.formula = true;
      if (!Object.keys(mark).length) {
        line.push(null);
        continue;
      }
      const key = `${r}.${c}`;
      countText.set(key, 1);
      line.push(mark);
    }
    rows.push(line);
  }

  return {
    source: args.source,
    sheets: names,
    sheet: sheetName,
    usedRange: usedRef,
    range: `${excelToRef(start.row, start.col)}:${excelToRef(lastRow, lastCol)}`,
    truncated: { rows: stop.row > lastRow, cols: stop.col > lastCol },
    legend: {
      text: '文本格原样回传（表头/行标签/期数多在这里）',
      num: '数字格 —— **只报"这里有个数"，值不回传**（哪几列是数据列看这个）',
      date: '日期格式格（值不回传）',
      formula: '带公式的格（模板里的「合计」行多在这里，写 drop 时要排除）',
    },
    rows,
    note:
      '这是源文件的文本视图，用来写接入规格：先看表头在第几行、行标签在哪一列、' +
      '哪几列是 num、哪些行 formula=true（要 drop）。金额永远看不到，也不需要看到。',
  };
}

/** 2.7 lint_ingest —— 接入规格的静态诊断（一个字都不落到库） */
async function lintIngestTool(args: { spec?: string; specFile?: string }) {
  const { text, from } = loadIngestSpecText(args);
  const cat = await masterCatalog();
  const d = diagnoseIngest(text, { periodTypes: cat.periodTypes });
  const errors = d.issues.filter((i) => i.level === 'error');
  const warnings = d.issues.filter((i) => i.level === 'warn');
  return {
    from,
    id: d.spec?.id ?? null,
    source: d.spec?.source ?? null,
    willBeRejected: d.willBeRejected,
    parseError: d.parseError ?? null,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
    note:
      'errors 非空 → parseIngestSpec 会直接拒绝，先改规格。warnings 是可以带着跑的提醒。' +
      '本工具不读源文件、不碰数据库。',
  };
}

/** 2.8 dry_run_ingest —— 干跑：形状 + 主数据判定，一次库都不写 */
async function dryRunIngestTool(args: { spec?: string; specFile?: string; decisions?: unknown }) {
  const { text, from } = loadIngestSpecText(args);
  const cat = await masterCatalog();
  const d = diagnoseIngest(text, { periodTypes: cat.periodTypes });
  if (d.willBeRejected) {
    return {
      from,
      ok: false,
      refused: true,
      errors: d.issues.filter((i) => i.level === 'error'),
      note: '规格没通过静态诊断，先按 errors 改规格（这一步连源文件都没读）。',
    };
  }
  const spec = parseIngestSpec(text);
  const r = await runIngest(spec, { catalog: cat, planOnly: true, decisions: parseDecisions(args.decisions) });
  return { from, planOnly: true, ...r };
}

/** 2.9 run_ingest —— 真正落库（源 Excel → 星型表）。这是唯一会写库的接入工具 */
async function runIngestTool(args: { spec?: string; specFile?: string; decisions?: unknown; strict?: boolean }) {
  const { text, from } = loadIngestSpecText(args);
  const cat = await masterCatalog();
  const d = diagnoseIngest(text, { periodTypes: cat.periodTypes });
  if (d.willBeRejected) {
    return {
      from,
      ok: false,
      refused: true,
      errors: d.issues.filter((i) => i.level === 'error'),
      note: '规格没通过静态诊断，没有落任何数据。',
    };
  }
  const spec = parseIngestSpec(text);
  const r: IngestRunResult = await runIngest(spec, {
    catalog: cat,
    decisions: parseDecisions(args.decisions),
    strict: args.strict === true,
  });
  return { from, ...r };
}

/**
 * 12. get_catalog —— 把「库里现在有什么」交给 agent（架构 §8.2 ②③、§8.5）。
 *
 * ★ 存在的理由：**只给规则是不够的**。skill 告诉 agent 语法（怎么写才合法），
 *   但它不知道现在有哪些 code —— 于是看到"应收账款"就造一个 `receivable_amount`，
 *   而库里早有 `account.receivable`。那不是维度值重复，是**指标身份重复**：
 *   同一个口径两个 code，之后所有汇总都会出错，而且不报错。
 *
 * ★ 结构安全：这里返回的是**结构、成员名与计数**，一个格里的值都没有（连行数都只是计数）。
 *   金额兜底（`callTool`）仍然照过一遍 —— 但真正的保证是"它压根不查明细值"。
 */
async function getCatalog(args: { object?: string }) {
  const { catalogDump, catalogShow } = await import('../meta/catalog.ts');
  if (args.object) {
    const one = await catalogShow(args.object);
    return { ...one, note: '单表结构：列、角色、粒度、行数。**格里的值一个都不回传**。' };
  }
  return catalogDump();
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
    name: 'lint_spec',
    description:
      '静态诊断一份 spec **在任何数字被算出来之前**：有没有漏掉指标/口径约束（会把多个指标静默加成同一个数）、' +
      '派生表达式引用了不存在的口径、filter 列名写错、维度名不在白名单里、order 为空或重复、chart.include 引用了不存在的标签。' +
      '返回 issues 数组（level=error 的必须改，否则 parseSpec 会直接拒绝；level=warn 的请人工判断）。' +
      '★ 从自然语言写 spec 时，应当先跑本工具自检，再交给 preview_spec / 人确认。' +
      '本工具只读 spec 文本结构，不查数据库、不返回任何金额。',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: 'spec 的 YAML 文本（与 specFile 二选一）' },
        specFile: { type: 'string', description: 'spec 文件路径，如 specs/月度保送表.yaml' },
      },
      additionalProperties: false,
    },
    handler: (a) => lintSpecTool(a as { spec?: string; specFile?: string }),
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
  {
    name: 'generate_spec',
    description:
      '从一个 Excel 报送模板**推断**出 spec 草稿（YAML）。识别表头口径、预置行标签、定义名称锚点，' +
      '并自动排除模板里的公式行（如「合计 =SUM(...)」）。返回草稿 YAML + 证据链 + 未识别清单（unmatched）。' +
      'source=guessed 的轴是推断的，必须人工确认后再用 preview_spec / render_report。' +
      '本工具只读模板标签文本，不读任何数字，也不查数据库。',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: '模板路径；省略则用默认示例模板' },
        sheets: { type: 'array', items: { type: 'string' }, description: '只推断这些 sheet；省略则自动识别所有含已注册表头的 sheet' },
        id: { type: 'string', description: '生成的 spec id（可选）' },
        title: { type: 'string', description: '生成的 spec 标题（可选）' },
      },
      additionalProperties: false,
    },
    handler: (a) => generateSpec(a as { template?: string; sheets?: string[]; id?: string; title?: string }),
  },
  {
    name: 'look_at_source',
    description:
      '看一份源 Excel（或报表模板）的**文本视图**：表头文本、行标签文本、哪些格是数字（只报"这里有个数"，' +
      '永不回传数值）、哪些格带公式（模板里的「合计」行）。写接入规格前先用它确认表头在第几行、' +
      '行标签在哪一列、数据列是哪几列、哪些行要 drop。金额看不到，也不需要看到。',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '源 Excel 路径（相对仓库根，必须在 data/ templates/ test/fixtures/ 之内）' },
        sheet: { type: 'string', description: 'sheet 名；省略则用第一个' },
        range: { type: 'string', description: '要看的区域，如 "A1:L40"；省略则从 A1 起到 usedRange 的末尾' },
        maxRows: { type: 'number', description: '最多看多少行（默认 60，上限 500）' },
        maxCols: { type: 'number', description: '最多看多少列（默认 30，上限 80）' },
      },
      required: ['source'],
      additionalProperties: false,
    },
    handler: (a) => lookAtSource(a as { source?: string; sheet?: string; range?: string; maxRows?: number; maxCols?: number }),
  },
  {
    name: 'lint_ingest',
    description:
      '诊断一份**接入规格 YAML**（源 Excel → 星型表的映射）：结构、列号、行键维度、值列与口径的对应、' +
      '必需坐标（公司/指标/期数/口径）有没有来源。给 error/warn 清单与位置，一个字都不落到库、也不读源文件。',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: '接入规格 YAML 文本' },
        specFile: { type: 'string', description: '接入规格文件路径（与 spec 二选一）' },
      },
      additionalProperties: false,
    },
    handler: (a) => lintIngestTool(a as { spec?: string; specFile?: string }),
  },
  {
    name: 'dry_run_ingest',
    description:
      '**干跑**一份接入规格：读出形状（数据行数、被 drop 的行、重复的行键、值列与口径、坐标完整性、期数、' +
      '库里对不上的主数据名）并做一次主数据判定（哪些会自动归并、哪些要人拍板、哪些会新建），' +
      '一次库都不写。返回里没有任何金额。人手拍板前用这个把结论摆出来。',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: '接入规格 YAML 文本' },
        specFile: { type: 'string', description: '接入规格文件路径（与 spec 二选一）' },
        decisions: {
          type: 'array',
          description: '人对未识别主数据的处置（可选）：{kind: company|metric, raw, action: merge|create, targetId?, note?}',
          items: { type: 'object' },
        },
      },
      additionalProperties: false,
    },
    handler: (a) => dryRunIngestTool(a as { spec?: string; specFile?: string; decisions?: unknown }),
  },
  {
    name: 'run_ingest',
    description:
      '按接入规格把源 Excel **真正落库**（展开成星型表的 (公司,指标,期数,口径,金额) 行）。' +
      '有歧义的名字（像已有主数据但不确定）会整批拒绝、一行都不写，并把要拍板的清单回给你；' +
      '给出 decisions 后重跑即可。重复坐标按规格的 onConflict 处理（默认整批拒绝，不静默覆盖）。',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'string', description: '接入规格 YAML 文本' },
        specFile: { type: 'string', description: '接入规格文件路径（与 spec 二选一）' },
        decisions: {
          type: 'array',
          description: '人对未识别主数据的处置：{kind: company|metric, raw, action: merge|create, targetId?, note?}',
          items: { type: 'object' },
        },
        strict: { type: 'boolean', description: '遇到要人拍板的名称直接报错（默认 false：返回清单让人处理）' },
      },
      additionalProperties: false,
    },
    handler: (a) => runIngestTool(a as { spec?: string; specFile?: string; decisions?: unknown; strict?: boolean }),
  },
  {
    name: 'get_catalog',
    description:
      '导出**库里现在有什么** —— 写任何 YAML 之前先读它，否则你会造出重复的指标/维度名。' +
      '三层：L1 业务成员（已注册的指标 / 公司 / 口径 / 维度）、L2 物理结构（表 / 列 / 角色 / 粒度）、' +
      'L3 版本（apiVersion + ddlHash）。' +
      '★ **按需下钻是默认用法**：传 object（如 object="fact_finance"）只看那一张表，别把整库吞下去。' +
      '★ 返回值里**没有任何金额**，也不含装载批次历史（那是装载侧的事）。' +
      '★ 它是一份**快照**，会过期：写完 YAML 要让 lint_ingest / lint_spec / validate 读**当下**结构复核。',
    inputSchema: {
      type: 'object',
      properties: {
        object: {
          type: 'string',
          description: '只看这一个对象（表名，如 fact_finance）—— 默认路径；省略则导出全部三层',
        },
      },
      additionalProperties: false,
    },
    handler: (a) => getCatalog(a as { object?: string }),
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
