/**
 * 「模板 → spec」推断（docs/需求与架构.md §7.2 路径 1）
 *
 * 定位：把人工做好的空报送模板翻译成 spec **草稿**，由人在 Web 上确认后定稿。
 *
 * ★ 本模块的设计立场：**推断器是提案者，不是决策者。**
 *   它必须把「读到的」与「猜的」严格分开（`source: 'template' | 'guessed'`），
 *   并输出完整的证据链与未识别清单。原因：
 *     - 猜错维度会静默产出错误的报送表 —— 财务场景下这比报错严重得多
 *     - 模板里的名字与注册表对不上（"集团有限公司" vs "集团公司"）是**常态**，
 *       不显式报告，三个月后数据就全是孤儿行（文档 R1）
 *
 * 安全不变量（铁律 1）：本模块只吃「标签文本 + 结构」，从不读模板里的数字。
 *   证据链里出现的只有标签名与坐标，所以推断结果可以安全地进 LLM 上下文 ——
 *   这也是「agent 当入口」能成立的前提。
 */
import type { Spec, Block, SheetSpec } from './types.ts';
import {
  openTemplate,
  readRegion,
  findHeader,
  type Region,
  type RegionRow,
  type HeaderHint,
} from './template.ts';
import type { Workbook } from 'xlsx-populate';

/** 注册表快照 —— 由调用方注入，使本模块可脱库测试 */
export interface Registry {
  metrics: string[];
  companies: string[];
  periodTypes: string[];
  /** 轴名（"指标"/"公司"/"口径"/"月份"/"年份"）—— 用于识别表头左侧的角格 */
  axisNames: string[];
}

export type Source = 'template' | 'guessed';

export interface InferredAxis {
  dim: string;
  order: string[];
  source: Source;
  /** 若 source === 'template'，这里是它在模板中的坐标；否则是候选来源说明 */
  evidence: string;
}

export interface ExcludedRow {
  sheet: string;
  row: number;
  label: string | null;
  reason: string;
}

export interface InferIssue {
  level: 'warn' | 'error';
  sheet: string;
  message: string;
}

export interface InferredBlock {
  sheet: string;
  anchor: string | { name: string };
  anchorNote: string;
  rows: InferredAxis;
  cols: InferredAxis;
  format: string | null;
  /** 被排除、不会写入数据区的行（公式行等） */
  excluded: ExcludedRow[];
}

export interface InferResult {
  spec: Spec;
  yaml: string;
  blocks: InferredBlock[];
  issues: InferIssue[];
  /** 模板里出现但注册表里找不到的名字 —— 导入前必须确认（R1 主数据对齐） */
  unmatched: Array<{ sheet: string; axis: 'rows' | 'cols'; names: string[] }>;
}

// ---------------- 维度判定 ----------------

/** 一组标签整体落在哪个维度的取值集合里（要求全部命中，避免"半数像指标"就武断下结论） */
function matchDim(labels: string[], reg: Registry): string | null {
  if (labels.length === 0) return null;
  const all = (set: string[]) => labels.every((l) => set.includes(l));
  if (all(reg.periodTypes)) return 'period_type';
  if (all(reg.metrics)) return 'metric';
  if (all(reg.companies)) return 'company';
  return null;
}

/** 部分命中：用于「未识别清单」——哪些名字不在任何注册表里 */
function unmatchedIn(labels: string[], reg: Registry): string[] {
  const known = new Set([...reg.metrics, ...reg.companies, ...reg.periodTypes]);
  return labels.filter((l) => !known.has(l));
}

/** 轴名 → 维度键 */
const AXIS_TO_DIM: Record<string, string> = {
  指标: 'metric',
  公司: 'company',
  口径: 'period_type',
  月份: 'month',
  年份: 'year',
};

/** 维度 → 候选取值（用于"模板没预置行标签"时给候选） */
function candidatesFor(dim: string, reg: Registry): string[] {
  if (dim === 'metric') return reg.metrics;
  if (dim === 'company') return reg.companies;
  if (dim === 'period_type') return reg.periodTypes;
  return [];
}

// ---------------- 主流程 ----------------

interface SheetInference {
  block: InferredBlock;
  sheetSpec: SheetSpec;
  issues: InferIssue[];
  unmatched: InferResult['unmatched'];
}

/**
 * 推断单个 sheet。
 *
 * @param sheetName  模板中的 sheet 名
 * @param anchorHint 定义名称锚点（若模板为数据区提供了命名区域，优先用它）
 */
function inferSheet(
  wb: Workbook,
  sheetName: string,
  reg: Registry,
  anchorHint?: { name: string; row: number; col: number },
): SheetInference | null {
  const issues: InferIssue[] = [];
  const unmatched: InferResult['unmatched'] = [];

  // ---- 1. 定位数据区左上角 ----
  let start: { row: number; col: number };
  let anchor: string | { name: string };
  let anchorNote: string;

  if (anchorHint) {
    start = { row: anchorHint.row, col: anchorHint.col };
    anchor = { name: anchorHint.name };
    anchorNote = `用定义名称 ${anchorHint.name}（模板改版式时跟着走）`;
  } else {
    const hint: HeaderHint = {
      values: new Set([...reg.metrics, ...reg.companies, ...reg.periodTypes]),
      axisNames: new Set(reg.axisNames),
    };
    const ws = wb.sheet(sheetName);
    const found = ws ? findHeader(ws, hint) : null;
    if (!found) return null; // 这个 sheet 没有可识别的表头，跳过（不是数据表）
    start = found;
    anchor = `${String.fromCharCode(64 + found.col)}${found.row}`;
    anchorNote = `未定义名称，按表头位置推断为 ${anchor}`;
    issues.push({
      level: 'warn',
      sheet: sheetName,
      message: `模板未给数据区定义名称，已按表头位置推断锚点 ${anchor}。建议在模板中加一个定义名称（如 DATA_START）指向该格，这样以后改版式 spec 不用跟着改。`,
    });
  }

  const region: Region = readRegion(wb, sheetName, start.row, start.col);

  // ---- 2. 列：表头文本 ----
  const colsDim = matchDim(region.colLabels, reg);
  if (!colsDim) {
    if (region.colLabels.length === 0) {
      issues.push({ level: 'error', sheet: sheetName, message: '锚点上方一行没有任何表头文本，无法判定列口径。' });
    } else {
      issues.push({
        level: 'error',
        sheet: sheetName,
        message: `锚点上方表头 [${region.colLabels.join(', ')}] 无法整体识别为已注册的口径/指标/公司，需要人工指定 cols.dim。`,
      });
    }
  }
  const badCols = unmatchedIn(region.colLabels, reg);
  if (badCols.length) unmatched.push({ sheet: sheetName, axis: 'cols', names: badCols });

  // ---- 3. 排除公式行（关键信号：模板末尾的「合计 =SUM(...)」）----
  //
  // ★ 必须**先**排除、再做维度判定。否则「合计」这个公式行的标签会被当成
  //   一个普通行标签送去匹配，导致整列匹配失败（它当然不在指标注册表里），
  //   一个本该识别成功的数据区被判成"无法识别"。
  const excluded: ExcludedRow[] = [];
  const dataRows: RegionRow[] = [];
  for (const r of region.rows) {
    if (r.computed) {
      excluded.push({
        sheet: sheetName,
        row: r.row,
        label: r.label,
        reason: `该行数据格是公式（${r.formulas[0]}），保留模板原样、不写入，避免覆盖模板的合计逻辑`,
      });
    } else if (r.label !== null) {
      dataRows.push(r);
    }
  }
  const dataLabels = dataRows.map((r) => r.label as string);

  // ---- 4. 行维度判定：先看模板预置的行标签，再看表头左侧的角格 ----
  const cornerCell = textLeftOf(wb, sheetName, start);
  const cornerDim = cornerCell ? AXIS_TO_DIM[cornerCell] ?? null : null;

  let rowsDim: string | null = null;
  let rowsSource: Source = 'template';
  let rowsEvidence = '';

  const labelDim = matchDim(dataLabels, reg);
  if (labelDim) {
    rowsDim = labelDim;
    rowsSource = 'template';
    rowsEvidence = `模板 ${region.anchor.ref} 左方一列已预置 ${dataLabels.length} 个行标签`;

    // 模板预置的行标签应当是**完整**的：维度取值集合里的项若缺了，宁可提示也不要静默少填。
    const missing = candidatesFor(rowsDim, reg).filter((x) => !dataLabels.includes(x));
    if (missing.length) {
      issues.push({
        level: 'warn',
        sheet: sheetName,
        message: `模板预置的行标签比注册表少 ${missing.length} 项（${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}）。已严格按模板的行清单生成 order；若模板是漏写，请补齐模板或手工加回 order。`,
      });
    }
  } else if (cornerDim) {
    // 模板没预置行标签，但表头左侧写了轴名（如「公司」）→ 用注册表补候选
    rowsDim = cornerDim;
    rowsSource = 'guessed';
    rowsEvidence = `表头左侧角格写着「${cornerCell}」，据此判定行维为 ${cornerDim}；模板未预置行标签，候选值取自注册表`;
    issues.push({
      level: 'warn',
      sheet: sheetName,
      message: `模板未预置行标签，已按角格「${cornerCell}」推断行维为 ${cornerDim}，候选值取自注册表。**请人工确认行清单与顺序**。`,
    });
  } else if (dataLabels.length > 0) {
    issues.push({
      level: 'error',
      sheet: sheetName,
      message: `模板预置的行标签 [${dataLabels.slice(0, 5).join(', ')}${dataLabels.length > 5 ? '…' : ''}] 无法整体识别为已注册的指标/公司，需要人工指定 rows.dim。`,
    });
  }

  const badRows = unmatchedIn(dataLabels, reg);
  if (badRows.length) unmatched.push({ sheet: sheetName, axis: 'rows', names: badRows });

  // ---- 5. 组装 order ----
  const rowsOrder = rowsSource === 'template' ? dataLabels : rowsDim ? candidatesFor(rowsDim, reg) : [];
  const colsOrder = region.colLabels;

  const block: InferredBlock = {
    sheet: sheetName,
    anchor,
    anchorNote,
    rows: { dim: rowsDim ?? '(待指定)', order: rowsOrder, source: rowsSource, evidence: rowsEvidence },
    cols: {
      dim: colsDim ?? '(待指定)',
      order: colsOrder,
      source: 'template',
      evidence: `锚点上方表头给出 ${colsOrder.length} 个标签：${colsOrder.join(' / ')}`,
    },
    format: region.format,
    excluded,
  };

  const specBlock: Block = {
    anchor,
    rows: { dim: rowsDim ?? 'metric', order: rowsOrder },
    cols: { dim: colsDim ?? 'period_type', order: colsOrder },
    value: {
      measure: 'amount',
      agg: 'sum',
      format: region.format ?? '#,##0.00',
    },
    // ★ 时间范围必须显式声明。
    // 实测教训：示例 spec 曾经声明了 params: {year, month} 却从未引用它们，
    // 结果 12 个月的数被静默加总（B4 得 765345 而非 2026-06 的 66826）。
    // 报送表按「某年某月」出，所以 scope.time 不是可选项。
    scope: { time: { year: '{{year}}', month: '{{month}}' } },
  };

  return {
    block,
    sheetSpec: { name: sheetName, blocks: [specBlock] },
    issues,
    unmatched,
  };
}

/** 读数据区左侧一列的表头角格（如「公司」） */
function textLeftOf(wb: Workbook, sheetName: string, start: { row: number; col: number }): string | null {
  const ws = wb.sheet(sheetName);
  if (!ws || start.col <= 1) return null;
  try {
    const v = ws.cell(start.row - 1, start.col - 1).value();
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

// ---------------- YAML 输出 ----------------

/** 中文标签通常不需要引号，但含 YAML 特殊字符时必须加，否则 `#,##0.00` 会被当注释截断 */
function yamlScalar(s: string): string {
  if (/^[A-Za-z0-9\u4e00-\u9fa5_\-./]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function yamlList(items: string[], indent: string): string {
  return `[${items.map(yamlScalar).join(', ')}]`;
}

/**
 * 手写 YAML 而不是 `yaml.stringify()` —— 因为注释是这份草稿的主要价值：
 * 人要能一眼看出哪一行是"换口径时该改的那一行"（§5.2 的核心体验）。
 */
function renderYaml(spec: Spec, inf: InferResult): string {
  const L: string[] = [];
  L.push('# 由 bi-lite 从模板推断生成的 spec 草稿（docs/需求与架构.md §7.2 路径 1）');
  L.push('# 请人工核对带「猜」标记的轴，确认后再定稿。');
  L.push(`id: ${yamlScalar(spec.id)}`);
  if (spec.title) L.push(`title: ${yamlScalar(spec.title)}`);
  L.push(`template: ${spec.template}`);
  L.push('');
  L.push('params:');
  L.push('  year: 2026');
  L.push('  month: 6');
  L.push('');
  L.push('sheets:');
  for (const sheet of spec.sheets) {
    L.push(`  - name: ${yamlScalar(sheet.name)}`);
    L.push('    blocks:');
    for (const b of sheet.blocks) {
      const meta = inf.blocks.find((x) => x.sheet === sheet.name);
      L.push(`      - anchor: ${typeof b.anchor === 'object' ? `{ name: ${b.anchor.name} }` : yamlScalar(b.anchor)}`);
      if (meta) L.push(`        # ${meta.anchorNote}`);
      L.push('        rows:');
      L.push(`          dim: ${b.rows.dim}`);
      L.push(`          order: ${yamlList(b.rows.order ?? [], '          ')}`);
      if (meta) {
        L.push(`          # ${meta.rows.source === 'guessed' ? '⚠ 猜的：' : '读到的：'}${meta.rows.evidence}`);
      }
      L.push('        cols:');
      L.push(`          dim: ${b.cols.dim}          # ← 换口径只改这一行`);
      L.push(`          order: ${yamlList(b.cols.order ?? [], '          ')}`);
      L.push('        value:');
      L.push(`          measure: ${b.value.measure}`);
      L.push(`          agg: ${b.value.agg}`);
      if (b.value.format) L.push(`          format: ${JSON.stringify(b.value.format)}`);
      if (b.scope?.time) {
        L.push('        scope:');
        L.push('          time:');
        L.push(`            year: ${JSON.stringify(String(b.scope.time.year))}`);
        L.push(`            month: ${JSON.stringify(String(b.scope.time.month))}`);
      }
      if (meta && meta.excluded.length) {
        for (const e of meta.excluded) {
          L.push(`        # 已排除第 ${e.row} 行「${e.label ?? '(无标签)'}」：${e.reason}`);
        }
      }
    }
  }
  return L.join('\n') + '\n';
}

// ---------------- 对外入口 ----------------

export interface InferOptions {
  template: string;
  registry: Registry;
  /** 只推断这些 sheet；省略则推断模板里所有能识别出表头的 sheet */
  sheets?: string[];
  id?: string;
  title?: string;
}

/**
 * 从模板推断 spec 草稿。
 *
 * 纯读：不改模板、不查数据库（注册表由调用方注入）、不接触任何金额。
 */
export async function inferSpec(opts: InferOptions): Promise<InferResult> {
  const { template, registry: reg } = opts;
  const wb = await openTemplate(template);

  // 定义名称锚点（模板作者显式指定的数据区起点，可信度最高）
  const { readTemplateSchema } = await import('./template.ts');
  const schema = await readTemplateSchema(template);
  const anchorByName = new Map(
    schema.anchors.filter((a) => a.sheet && a.row !== null && a.col !== null).map((a) => [a.sheet as string, a]),
  );

  const sheetNames = opts.sheets ?? wb.sheets().map((s) => s.name());

  const sheetSpecs: SheetSpec[] = [];
  const blocks: InferredBlock[] = [];
  const issues: InferIssue[] = [];
  const unmatched: InferResult['unmatched'] = [];

  for (const name of sheetNames) {
    const a = anchorByName.get(name);
    const inf = inferSheet(wb, name, reg, a ? { name: a.name, row: a.row as number, col: a.col as number } : undefined);
    if (!inf) continue;
    sheetSpecs.push(inf.sheetSpec);
    blocks.push(inf.block);
    issues.push(...inf.issues);
    unmatched.push(...inf.unmatched);
  }

  if (sheetSpecs.length === 0) {
    throw new Error(`未能从模板 ${template} 中识别出任何数据区（没有找到含已注册口径/指标/公司的表头）`);
  }

  const spec: Spec = {
    id: opts.id ?? '从模板推断的报表',
    title: opts.title,
    template,
    params: { year: 2026, month: 6 },
    sheets: sheetSpecs,
  };

  const result: InferResult = { spec, yaml: '', blocks, issues, unmatched };
  result.yaml = renderYaml(spec, result);
  return result;
}

/** 汇总所有「猜的」轴 —— Web 与 CLI 用它决定是否要弹确认 */
export function guessedAxes(r: InferResult): Array<{ sheet: string; axis: string; dim: string; count: number }> {
  const out: Array<{ sheet: string; axis: string; dim: string; count: number }> = [];
  for (const b of r.blocks) {
    if (b.rows.source === 'guessed') out.push({ sheet: b.sheet, axis: 'rows', dim: b.rows.dim, count: b.rows.order.length });
    if (b.cols.source === 'guessed') out.push({ sheet: b.sheet, axis: 'cols', dim: b.cols.dim, count: b.cols.order.length });
  }
  return out;
}
