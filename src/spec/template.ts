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
import { parseRef, toRef, readNumberFormat } from '../render/excel.ts';

/** 标签扫描上限（防止一个畸形模板把整张表灌进上下文） */
export const TEXT_SCAN_LIMIT = 40;

/**
 * 只取**文本**单元格。模板里若残留数字（脏模板），一律返回 null ——
 * 这是 "模板必须为空表"（AGENTS.md 铁律 3 注）在读取侧的对应防线。
 */
export function textAt(sheet: Sheet, row: number, col: number): string | null {
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
      for (let c = parsed.col, n = 0; n < TEXT_SCAN_LIMIT; n++, c++) {
        const t = textAt(sheet, parsed.row - 1, c);
        if (t === null) break;
        headerAbove.push(t);
      }
      for (let r = parsed.row, n = 0; n < TEXT_SCAN_LIMIT; n++, r++) {
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
  for (let c = col, n = 0; n < TEXT_SCAN_LIMIT; n++, c++) {
    const t = textAt(sheet, row - 1, c);
    if (t === null) break;
    colLabels.push(t);
  }
  const width = Math.max(colLabels.length, 1);

  const rows: RegionRow[] = [];
  for (let r = row, n = 0; n < TEXT_SCAN_LIMIT; n++, r++) {
    const label = textAt(sheet, r, col - 1);
    const formulas: string[] = [];
    let hasData = false;
    for (let c = col; c < col + width; c++) {
      const f = formulaAt(sheet, r, c);
      if (f) formulas.push(f);
      const v = sheet.cell(r, c).value();
      if (v !== null && v !== undefined && v !== '') hasData = true;
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

  return {
    sheet: sheetName,
    anchor: { ref: toRef(row, col), row, col },
    colLabels,
    rowLabels: rows.map((r) => r.label).filter((l): l is string => l !== null),
    rows,
    format,
  };
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
      while (n < TEXT_SCAN_LIMIT && hint.values.has(textAt(ws, r, c + n) ?? '')) n++;
      if (n === 0) continue;
      // 取取值最多的；同样多时取更靠上的（表头通常在数据区上方）
      if (!best || n > best.n) best = { row: r, col: c, n };
    }
  }
  return best ? { row: best.row + 1, col: best.col } : null;
}

/** 打开模板并返回 workbook（供推断与 schema 读取共用） */
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
