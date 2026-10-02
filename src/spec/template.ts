/**
 * 模板结构读取 —— 「模板 → spec」推断与 MCP `get_template_schema` 的共同底座。
 *
 * 安全不变量（铁律 1）：本模块只向外传**文本**。
 * 这不是靠"过滤掉数字"实现的：`textAt()` 的返回类型就是 `string | null`，
 * 非字符串一律返回 null，所以模板里残留的数值在类型层面就没有出口。
 * 与 §7.1.1「预览不含金额是结构保证」是同一类论证。
 */
import XLSXPopulate from 'xlsx-populate';
import type { Workbook, Sheet } from 'xlsx-populate';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { parseRef, toRef, readNumberFormat } from '../render/excel.ts';

/**
 * 「可读工作簿」的**最小结构** —— 只列读取侧真正用到的那几个方法。
 *
 * ★ 为什么要这组接口，而不是在签名里写死 `Sheet` / `Workbook`：
 *   接入层需要能**从 `raw_cell` 读**（而不是每次都去开 xlsx），这要求一个
 *   "长得像工作簿"的适配器（`src/land/read.ts`）。若签名写死具体类，
 *   适配器就只能靠 `as` 骗过类型 —— 那种"类型撒谎"的适配器最容易在下一次改动时静默错位。
 *   `xlsx-populate` 的 `Sheet` / `Workbook` **结构上满足**这组接口，故既有调用点一行都不用改。
 */
export interface ReadableCell {
  value(): unknown;
  formula?(): string | null;
}

export interface ReadableSheet {
  name(): string;
  cell(row: number, col: number): ReadableCell;
}

export interface ReadableWorkbook {
  sheets(): ReadableSheet[];
  sheet(name: string): ReadableSheet | undefined;
}

/**
 * 扫描的安全上限（防止一个畸形模板把推断变成 O(n²)）。
 *
 * ★ 关键不是"有上限"，而是**撞到上限必须上报**。
 *   实测教训：这里原本是固定的 40，而一份真实财务报表模板有 130 行指标 ——
 *   后 90 行被无声吞掉，唯一的信号是一句「模板预置的行标签比注册表少 90 项」，
 *   把读取侧的截断说成了模板的漏写。人于是去改模板，而模板本来是对的。
 *   上限是防线，静默才是 bug：readRegion 撞上限时返回 clip，由推断器变成 error。
 */
export const MAX_SCAN_ROWS = 2000;
export const MAX_SCAN_COLS = 256;

/**
 * 只取**文本**单元格。模板里若残留数字（脏模板），一律返回 null ——
 * 这是 "模板必须为空表"（AGENTS.md 铁律 3 注）在读取侧的对应防线。
 */
export function textAt(sheet: ReadableSheet, row: number, col: number): string | null {
  if (row < 1 || col < 1) return null;
  try {
    const v = sheet.cell(row, col).value();
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** 单元格是否带公式（xlsx-populate 的 Cell.formula 未在 d.ts 里声明，故做窄化访问） */
function formulaAt(sheet: Sheet, row: number, col: number): string | null {
  try {
    const cell = sheet.cell(row, col) as unknown as { formula?: () => string | null };
    const f = typeof cell.formula === 'function' ? cell.formula() : null;
    return typeof f === 'string' && f.trim() ? f.trim() : null;
  } catch {
    return null;
  }
}

export interface SheetSummary {
  name: string;
  usedRange: string | null;
  mergedCells: string[];
  dataValidationCount: number;
}

export interface AnchorSummary {
  name: string;
  refersTo: string;
  cell: string | null;
  sheet: string | null;
  row: number | null;
  col: number | null;
  headerAbove: string[];
  labelsLeft: string[];
}

export interface TemplateSchema {
  template: string;
  sheets: SheetSummary[];
  anchors: AnchorSummary[];
}

/** 读取工作簿的定义名称节点（未在 d.ts 中声明，故做窄化访问） */
function definedNamesNode(wb: Workbook) {
  const node = (wb as unknown as { _node?: { children?: Array<{ name: string; children?: unknown[] }> } })._node;
  return node?.children?.find((c) => c.name === 'definedNames');
}

/** 把一个定义名称的 refersTo 串（如 `'主要指标'!$B$4`）解析成坐标 */
function parseRefersTo(refersTo: string): { sheet: string; row: number; col: number; letters: string } | null {
  const m = refersTo.match(/^'?([^'!]+)'?!\$?([A-Z]+)\$?(\d+)$/);
  if (!m) return null;
  const [, sheet, letters, rowNum] = m;
  const { row, col } = parseRef(`${letters}${rowNum}`);
  return { sheet, row, col, letters };
}

/** 模板全景：sheet / 合并区 / 定义名称锚点及其上方表头、左方行标签 */
export async function readTemplateSchema(template: string): Promise<TemplateSchema> {
  const wb = await XLSXPopulate.fromFileAsync(template);

  const sheets = wb.sheets().map((s) => {
    const ur = s.usedRange();
    return {
      name: s.name(),
      usedRange: ur ? `${ur.startCell().address()}:${ur.endCell().address()}` : null,
      // 合并区：往合并区写值只能写左上角（§5.3.4 坑 3）
      mergedCells: Object.keys((s as unknown as { _mergeCells?: Record<string, unknown> })._mergeCells ?? {}),
      dataValidationCount: Object.keys(
        (s as unknown as { _dataValidations?: Record<string, unknown> })._dataValidations ?? {},
      ).length,
    };
  });

  const anchors: AnchorSummary[] = (definedNamesNode(wb)?.children ?? []).map((n) => {
    const node = n as { attributes?: { name?: string }; children?: unknown[] };
    const name = node.attributes?.name ?? '(unnamed)';
    const refersTo = String(node.children?.[0] ?? '');
    const parsed = parseRefersTo(refersTo);
    if (!parsed) {
      return { name, refersTo, cell: null, sheet: null, row: null, col: null, headerAbove: [], labelsLeft: [] };
    }
    const sheet = wb.sheet(parsed.sheet);
    const headerAbove: string[] = [];
    const labelsLeft: string[] = [];
    if (sheet) {
      // 表头在锚点上方一行、行标签在锚点左方一列 —— 本项目的模板约定
      for (let c = parsed.col, n = 0; n < MAX_SCAN_COLS; n++, c++) {
        const t = textAt(sheet, parsed.row - 1, c);
        if (t === null) break;
        headerAbove.push(t);
      }
      for (let r = parsed.row, n = 0; n < MAX_SCAN_ROWS; n++, r++) {
        const t = textAt(sheet, r, parsed.col - 1);
        if (t === null) break;
        labelsLeft.push(t);
      }
    }
    return {
      name,
      refersTo,
      cell: `${parsed.letters}${parsed.row}`,
      sheet: parsed.sheet,
      row: parsed.row,
      col: parsed.col,
      headerAbove,
      labelsLeft,
    };
  });

  return { template, sheets, anchors };
}

// ---------------- 数据区识别 ----------------

export interface RegionRow {
  row: number;
  label: string | null;
  /** 该行是否至少有一个数据格带公式（合计行等）—— 必须排除出 rows.order */
  computed: boolean;
  formulas: string[];
}

export interface Region {
  sheet: string;
  anchor: { ref: string; row: number; col: number };
  colLabels: string[];
  rowLabels: string[];
  rows: RegionRow[];
  /** 模板数据区第一个数据格的数字格式（非 General 时才值得写进 spec） */
  format: string | null;
  /**
   * 撞到安全上限的轴（空数组 = 读到了自然边界）。
   * ★ 非空意味着"下面/右边还有内容没读" —— 调用方必须变成 error，不得静默继续。
   */
  clip: Array<{ axis: 'rows' | 'cols'; limit: number }>;
  /**
   * 数据区里「有值但不是文本」的格子坐标（脏模板信号）。
   * 只给坐标、不给值 —— 铁律 1 在读取层就由 textAt 的返回类型保证。
   */
  strayDataCells: string[];
}

/**
 * 从一个锚点向下/向右读到底，识别数据区形状。
 *
 * 关键信号：**公式行**。真实报送模板末尾几乎都有「合计 =SUM(...)」行，
 * 若把它的标签也放进 rows.order，渲染时就会用查询结果覆盖掉模板里的公式。
 * 这里把它识别出来单独标记，由调用方排除。
 */
export function readRegion(wb: Workbook, sheetName: string, row: number, col: number): Region {
  const sheet = wb.sheet(sheetName);
  if (!sheet) throw new Error(`模板中没有 sheet: ${sheetName}`);

  const colLabels: string[] = [];
  let colClip = false;
  for (let c = col, n = 0; ; n++, c++) {
    if (n >= MAX_SCAN_COLS) { colClip = true; break; }
    const t = textAt(sheet, row - 1, c);
    if (t === null) break;
    colLabels.push(t);
  }
  const width = Math.max(colLabels.length, 1);

  const rows: RegionRow[] = [];
  const strayDataCells: string[] = [];
  let rowClip = false;
  for (let r = row, n = 0; ; n++, r++) {
    if (n >= MAX_SCAN_ROWS) { rowClip = true; break; }
    const label = textAt(sheet, r, col - 1);
    const formulas: string[] = [];
    let hasData = false;
    for (let c = col; c < col + width; c++) {
      const f = formulaAt(sheet, r, c);
      if (f) formulas.push(f);
      const v = sheet.cell(r, c).value();
      if (v !== null && v !== undefined && v !== '') {
        hasData = true;
        // 模板应当是空表：有值却不是文本 → 残留了数字/日期，渲染时会被覆盖，
        // 更糟的是它可能被当成本期实际数看。只记坐标（铁律 1），且不堆长列表。
        if (typeof v !== 'string' && strayDataCells.length < 20) strayDataCells.push(toRef(r, c));
      }
    }
    // 标签、公式、数据三者皆无 → 数据区到此为止
    if (label === null && formulas.length === 0 && !hasData) break;
    rows.push({ row: r, label, computed: formulas.length > 0, formulas });
  }

  let format: string | null = null;
  try {
    const fmt = readNumberFormat(wb, sheet.cell(row, col));
    if (fmt && fmt !== 'General') format = fmt;
  } catch {
    format = null;
  }

  const clip: Region['clip'] = [];
  if (rowClip) clip.push({ axis: 'rows', limit: MAX_SCAN_ROWS });
  if (colClip) clip.push({ axis: 'cols', limit: MAX_SCAN_COLS });

  return {
    sheet: sheetName,
    anchor: { ref: toRef(row, col), row, col },
    colLabels,
    rowLabels: rows.map((r) => r.label).filter((l): l is string => l !== null),
    rows,
    format,
    clip,
    strayDataCells,
  };
}

/**
 * 模板里**写着的期数**（如 B 列「期数」= 2026-06）。
 *
 * 报送模板几乎都会把"这张表是哪一期"印在表头上，而它正是 spec 里 params 的来源。
 * 不读它的后果实测过：推断器把 year/month 硬编码成 2026/6，模板写 2026-05 也照填 6 月。
 *
 * 只认两种确定性布局，认不出就返回 null（不猜）：
 *   ① 一整列期数（表头「期数/期间/会计期间/报告期/年月」），列内取值一致
 *   ② 分开的「年份」列 + 「月份」列
 */
export interface PeriodHint {
  year: number;
  month: number;
  /** 证据：表头格坐标 + 取值格坐标（只给坐标，不给值 —— 铁律 1） */
  evidence: string;
}

const PERIOD_HEADER = /^(期数|期间|会计期间|报告期|所属期|年月|期间数)$/;
const YEAR_HEADER = /^(年份|年度|年)$/;
const MONTH_HEADER = /^(月份|月)$/;

/**
 * 期数文本 → {year, month}；认不出返回 null。
 *
 * 认这些写法（含真实导出里最常见的**完整日期**）：
 *   `2026-06` / `2026/6` / `2026.6` / `2026年6月` / `202606`
 *   `2026-06-01` / `2026/6/1` / `2026年6月30日` / `2026-06-01T00:00:00Z` / `2026-06-01 08:00`
 *
 * ★ **为什么必须认完整日期**：集团导出的「财务期」常常就是**一个具体日子**（月初/月末），
 *   而不是 `2026-06`。旧的长表路径用 `s.match(/^(\d{4})[-/年]?(\d{1,2})/)`（**无 `$` 锚点**）
 *   也能读它，于是两条路在这一列上的行为必须一致 —— 否则"新路径取代旧路径"这句话不成立。
 *   但这里**加了 `$` 锚点与年月范围校验**：旧路那种写法会把
 *   `46173`（Excel 日期序列号，见 §11.6）解析成 `4617-03-01`，静默写错年份。
 *
 * ★ 日与时都被**读掉但不使用**：事实表的粒度是月（`fact_finance.fin_month` 记月初）。
 *   多读一位日，是为了不让"2026-06-01"这类最常见的写法被拒。
 */
export function parsePeriodText(s: string): { year: number; month: number } | null {
  // 先切掉时间部分（`2026-06-01T00:00:00Z` / `2026-06-01 08:00:00`）—— 期数是月，时刻没有意义
  const t = s.trim().split(/[T\s]+/)[0]!;
  const m =
    /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*月?(?:\s*[-/.]?\s*\d{1,2}\s*日?)?$/.exec(t) ??
    /^(\d{4})(\d{2})$/.exec(t);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!(year >= 1900 && year <= 2200) || !(month >= 1 && month <= 12)) return null;
  return { year, month };
}

/**
 * 从表头行（锚点上一行）的**左侧上下文列**里读期数。
 * 只看 col-2 往左（col-1 是行标签列本身），取值须落在数据区的行范围内且保持一致。
 */
export function readPeriodHint(
  wb: ReadableWorkbook,
  sheetName: string,
  row: number,
  col: number,
  rowCount: number,
): PeriodHint | null {
  const sheet = wb.sheet(sheetName);
  if (!sheet || col - 2 < 1 || rowCount < 1) return null;

  const headerAt = (c: number) => textAt(sheet, row - 1, c) ?? '';
  const valuesIn = (c: number): string[] => {
    const out: string[] = [];
    for (let i = 0; i < rowCount; i++) {
      const t = textAt(sheet, row + i, c);
      if (t !== null) out.push(t);
    }
    return out;
  };
  const uniform = (vs: string[]) => (vs.length > 0 && vs.every((v) => v === vs[0]) ? vs[0] : null);

  let periodCol = -1;
  let yearCol = -1;
  let monthCol = -1;
  for (let c = 1; c <= col - 2; c++) {
    const h = headerAt(c);
    if (periodCol < 0 && PERIOD_HEADER.test(h)) periodCol = c;
    else if (yearCol < 0 && YEAR_HEADER.test(h)) yearCol = c;
    else if (monthCol < 0 && MONTH_HEADER.test(h)) monthCol = c;
  }

  // ① 一整列期数
  if (periodCol > 0) {
    const v = uniform(valuesIn(periodCol));
    const p = v === null ? null : parsePeriodText(v);
    if (p) {
      return {
        ...p,
        evidence: `表头 ${toRef(row - 1, periodCol)}「${headerAt(periodCol)}」整列为同一期，取 ${toRef(row, periodCol)}`,
      };
    }
  }

  // ② 年份列 + 月份列
  if (yearCol > 0 && monthCol > 0) {
    const yv = uniform(valuesIn(yearCol));
    const mv = uniform(valuesIn(monthCol));
    const year = yv === null ? NaN : Number(yv.trim());
    // 「月份」写 "6" 或 "06" 或 "2026-06" 都要认
    const mvParsed = mv === null ? null : parsePeriodText(mv);
    const month = mvParsed ? mvParsed.month : mv === null ? NaN : Number(mv.trim());
    if (year >= 1900 && year <= 2200 && month >= 1 && month <= 12) {
      return {
        year,
        month,
        evidence: `表头 ${toRef(row - 1, yearCol)}「${headerAt(yearCol)}」+ ${toRef(row - 1, monthCol)}「${headerAt(monthCol)}」给出年份与月份`,
      };
    }
  }

  return null;
}

/** 已知的轴名（"指标"/"公司"/"口径"/"月份"/"年份"）—— 用于识别表头角格 */
export interface HeaderHint {
  /** 轴的取值集合（指标名/公司名/口径名 的并集） */
  values: Set<string>;
  /** 轴的名称集合（"指标"/"公司"/"口径"…） */
  axisNames: Set<string>;
}

/**
 * 在 sheet 里猜表头位置：找到「某行以若干个已知轴取值连续排开」的位置。
 * 表头行左侧应当为空或是轴名（"公司 | 本年累计" 这种两列布局）。
 * 返回表头下一行、第一个取值列 —— 即数据区锚点。
 */
export function findHeader(ws: Sheet, hint: HeaderHint): { row: number; col: number } | null {
  const ur = ws.usedRange();
  if (!ur) return null;
  const maxR = ur.endCell().rowNumber();
  const maxC = ur.endCell().columnNumber();

  let best: { row: number; col: number; n: number } | null = null;
  for (let r = 1; r <= maxR; r++) {
    for (let c = 1; c <= maxC; c++) {
      const left = c === 1 ? null : textAt(ws, r, c - 1);
      if (!(c === 1 || left === null || hint.axisNames.has(left))) continue;
      let n = 0;
      while (n < MAX_SCAN_COLS && hint.values.has(textAt(ws, r, c + n) ?? '')) n++;
      if (n === 0) continue;
      // 取取值最多的；同样多时取更靠上的（表头通常在数据区上方）
      if (!best || n > best.n) best = { row: r, col: c, n };
    }
  }
  return best ? { row: best.row + 1, col: best.col } : null;
}

/** 打开模板并返回 workbook（供推断与 schema 读取共用） */
// ★ 这一句必须在 openTemplate() **之后**调用（那时文件已确认是合法 xlsx）。
// 读 xlsx 文件的日期系统 —— 只做这一件事，不解读任何格。
export async function usesDate1904(absPath: string): Promise<boolean> {
  const zip = await JSZip.loadAsync(await readFile(absPath));
  const xml = await zip.file('xl/workbook.xml')?.async('string');
  // 实测：exceljs 写 properties.date1904 = true 会得到 <workbookPr date1904="1" ...>
  return !!xml && /<workbookPr[^>]*\bdate1904="(1|true)"/i.test(xml);
}

export async function openTemplate(template: string): Promise<Workbook> {
  try {
    return await XLSXPopulate.fromFileAsync(template);
  } catch (e) {
    // 底层是 jszip，非 .xlsx 时会抛出 "Can't find end of central directory" 这类
    // 对用户毫无意义的报错。这里翻译成能指导行动的说明。
    const raw = (e as Error).message;
    if (/zip file|end of central directory|Invalid HTML|Unexpected/i.test(raw)) {
      throw new Error(
        `无法读取模板 ${template}：它不是有效的 .xlsx 文件（可能是 .xls 旧格式、CSV，或文件已损坏）。` +
          `请用 Excel 另存为 .xlsx 后重试。`,
      );
    }
    throw e;
  }
}
