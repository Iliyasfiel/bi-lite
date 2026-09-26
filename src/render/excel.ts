/**
 * Excel 渲染器（docs/需求与架构.md §5.3）
 *
 * 决定性要求：打开原模板、只往数据格填值，其余（样式/合并/公式/图表/宏）全部保留。
 *
 * 方案选择（本机实测）：
 *   主选 xlsx-populate —— 它 "just manipulates the XML data"，实测 9/9 部件全保
 *   排除 exceljs     —— 对真实模板读入即崩，写出还会静默删 8 类部件
 */
import XLSXPopulate from 'xlsx-populate';
import type { Workbook, Sheet, Cell } from 'xlsx-populate';
import fs from 'node:fs';
import path from 'node:path';

export interface RenderBlock {
  /** 目标 sheet 名 */
  sheet: string;
  /** 写入位置："B4" 或定义名称 "DATA_AREA" */
  anchor: string | { name: string };
  /** 列口径标签（写到 anchor 的上一行） */
  colLabels?: string[];
  /** 行列：每行 label + 数值 */
  rows: Array<{ label: string; values: (number | null)[] }>;
  /** Excel 数字格式串（同时管展示，§12.4.2） */
  format?: string;
  /** 行标签是否写（有些模板已预置行标签，只填数值格） */
  writeRowLabels?: boolean;
  /** 列标签是否写（有些模板已预置列标签） */
  writeColLabels?: boolean;
}

export interface RenderResult {
  outputPath: string;
  cellsWritten: number;
  blocks: number;
  warnings: string[];
  /** 因模板已有自定义格式而被保留、未被 spec 覆盖的格数 */
  formatKept: number;
}

/** 把 "B4" 拆成 {row, col} */
export function parseRef(ref: string): { row: number; col: number } {
  const m = ref.match(/^\$?([A-Za-z]+)\$?(\d+)$/);
  if (!m) throw new Error(`非法单元格引用: ${ref}`);
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.codePointAt(0)! - 64);
  return { row: Number(m[2]), col };
}

export function toRef(row: number, col: number): string {
  let s = '';
  while (col > 0) {
    const r = (col - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    col = Math.floor((col - 1) / 26);
  }
  return `${s}${row}`;
}

/**
 * 无副作用地读取某个单元格的数字格式。
 *
 * ⚠️ 不能用 `cell.style('numberFormat')` —— 实测它会在 styles.xml 里**追加**
 * 一整套 font/fill/border/xf（该方法内部走 createStyle()，是写路径）：
 *   模板              2839 字节 / 4 fonts / 8 cellXfs
 *   只写值            2788 字节 / 4 fonts / 8 cellXfs   ← 干净
 *   写值 + 读 .style() 7947 字节 / 24 fonts / 28 cellXfs ← 仅"读"就污染了
 * 所以改为从 cellXfs 节点直接取 numFmtId，再查格式码。
 */
function readNumberFormat(wb: Workbook, cell: Cell): string {
  const styleId = (cell as unknown as { _styleId?: number })._styleId;
  if (styleId === undefined || styleId === null) return 'General';
  const ss = wb.styleSheet();
  const node = (ss as unknown as { _cellXfsNode?: { children: Array<{ attributes: Record<string, string> }> } })
    ._cellXfsNode?.children?.[styleId];
  if (!node) return 'General';
  const numFmtId = Number(node.attributes?.numFmtId ?? 0);
  if (!numFmtId) return 'General';
  try {
    return ss.getNumberFormatCode(numFmtId) ?? 'General';
  } catch {
    return 'General';
  }
}

/**
 * 主入口：加载模板 → 填数据格 → 另存。
 * 保真，因为 xlsx-populate 只改目标单元格的 XML 节点。
 */
export async function renderTemplate(
  templatePath: string,
  outputPath: string,
  blocks: RenderBlock[],
): Promise<RenderResult> {
  if (!fs.existsSync(templatePath)) throw new Error(`模板不存在: ${templatePath}`);

  const wb: Workbook = await XLSXPopulate.fromFileAsync(templatePath);
  const warnings: string[] = [];
  let cellsWritten = 0;
  let formatKept = 0;

  for (const block of blocks) {
    const sheet: Sheet | undefined = wb.sheet(block.sheet);
    if (!sheet) throw new Error(`模板中没有 sheet: ${block.sheet}`);

    // 锚点：优先用定义名称（模板改版式时命名区域跟着走，spec 不用改）
    //
    // 注意 xlsx-populate 的 API 细节（实测）：
    //   - Sheet.cell() 只接受 "B4" 或 (row, col)，传定义名称会崩在 addressConverter
    //   - 定义名称要用 Workbook.definedName(name)，它返回的是**解析后的 Cell 对象**
    //     （不是地址字符串），可直接 rowNumber()/columnNumber()
    //   - 名称不存在时返回 undefined（不抛错）
    let start: { row: number; col: number };
    if (typeof block.anchor === 'object' && 'name' in block.anchor) {
      const named = wb.definedName(block.anchor.name) as Cell | undefined;
      if (!named) throw new Error(`模板中找不到定义名称: ${block.anchor.name}`);
      start = { row: named.rowNumber(), col: named.columnNumber() };
      const namedSheet = named.sheet()?.name();
      if (namedSheet && namedSheet !== block.sheet) {
        warnings.push(`定义名称 ${block.anchor.name} 指向 sheet「${namedSheet}」，与 block.sheet「${block.sheet}」不一致，已按名称所在位置写入`);
      }
    } else {
      start = parseRef(block.anchor);
    }

    // 列标签（默认不写 —— 模板一般已预置）
    if (block.writeColLabels && block.colLabels) {
      block.colLabels.forEach((label, i) => {
        sheet.cell(start.row - 1, start.col + i).value(label);
        cellsWritten++;
      });
    }

    // 数据格
    block.rows.forEach((row, ri) => {
      if (block.writeRowLabels) {
        sheet.cell(start.row + ri, start.col - 1).value(row.label);
        cellsWritten++;
      }
      row.values.forEach((v, ci) => {
        if (v === null) return; // 空值不覆盖模板原有内容
        const cell = sheet.cell(start.row + ri, start.col + ci);
        cell.value(v);
        // 数字格式：**模板优先**。
        // 实测教训：模板数据格已有 s=6 → numFmtId 164 "#,##0.00;[Red]-#,##0.00"，
        // 早先无条件用 spec 里的 format 覆盖，会丢掉模板设计的红色负数格式。
        // 只有当模板该格是 General（未显式设置）时才写入 spec 的 format。
        if (block.format) {
          const existing = readNumberFormat(wb, cell);
          if (!existing || existing === 'General') {
            cell.style('numberFormat', block.format);
          } else {
            formatKept++;
          }
        }
        cellsWritten++;
      });
    });
  }

  const dir = path.dirname(outputPath);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
  await wb.toFileAsync(outputPath);

  return { outputPath, cellsWritten, blocks: blocks.length, warnings, formatKept };
}

/**
 * 兜底路径：定向 XML 替换（§5.3.3）。
 * 当 xlsx-populate 不适用（如需保留公式缓存值）时使用。
 * 这里提供最小实现：只替换指定单元格的 <v>，保留 s= 样式索引。
 */
export function setNumericCellXml(sheetXml: string, ref: string, value: number): { xml: string; ok: boolean } {
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const m = sheetXml.match(re);
  if (!m) return { xml: sheetXml, ok: false };
  const attrs = m[1].replace(/\s+t="[^"]*"/g, '');
  return { xml: sheetXml.replace(re, `<c r="${ref}"${attrs}><v>${value}</v></c>`), ok: true };
}

/** 文本用 inline string，避免动 sharedStrings.xml */
export function setTextCellXml(sheetXml: string, ref: string, text: string): { xml: string; ok: boolean } {
  const re = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
  const m = sheetXml.match(re);
  if (!m) return { xml: sheetXml, ok: false };
  const attrs = m[1].replace(/\s+t="[^"]*"/g, '');
  const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    xml: sheetXml.replace(re, `<c r="${ref}"${attrs} t="inlineStr"><is><t>${esc}</t></is></c>`),
    ok: true,
  };
}

/** 公式注入防护（取自 Superset，§4.6.4） */
const FORMULA_PREFIXES = ['=', '+', '-', '@'];
export function quoteFormulas(v: unknown): unknown {
  if (typeof v === 'string' && v.length > 0 && FORMULA_PREFIXES.includes(v[0])) return `'${v}`;
  return v;
}
