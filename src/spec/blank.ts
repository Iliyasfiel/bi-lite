import fs from 'node:fs';
import XLSXPopulate from 'xlsx-populate';
import type { Workbook } from 'xlsx-populate';

export const BLANK_TEMPLATE_POLICY = 'blank-structure-v2';

const STOP = 'TEMPLATE_DATA_BLOCKED: 文件包含实存数值或金额样式的数字文本。已停止，不返回单元格内容。请勿向聊天上传含数据文件；请在本机制作空白结构模板后重新提供，业务源文件仅在 Web 页面由用户手动导入。';

export class TemplateCheckError extends Error {
  code: 'TEMPLATE_DATA_BLOCKED' | 'TEMPLATE_PARSE_FAILED' | 'TEMPLATE_NOT_FOUND' | 'TEMPLATE_PATH_INVALID';
  constructor(code: TemplateCheckError['code']) {
    super({
      TEMPLATE_DATA_BLOCKED: STOP,
      TEMPLATE_PARSE_FAILED: 'TEMPLATE_PARSE_FAILED: 无法读取该文件，请提供有效的空白 .xlsx 模板。',
      TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND: 模板文件不存在，请提供具体的 .xlsx 文件路径。',
      TEMPLATE_PATH_INVALID: 'TEMPLATE_PATH_INVALID: --template 需要具体的 .xlsx 文件路径，不能传目录。',
    }[code]);
    this.code = code;
  }
}

/** The upload and its projection are inspected from the same in-memory snapshot. */
export async function readCheckedTemplate(bytes: Buffer): Promise<Workbook> {
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new TemplateCheckError('TEMPLATE_PARSE_FAILED');
  let workbook: Workbook;
  try { workbook = await XLSXPopulate.fromDataAsync(bytes); }
  catch { throw new TemplateCheckError('TEMPLATE_PARSE_FAILED'); }
  checkBlankWorkbook(workbook);
  return workbook;
}

/** Agent preflight only. Inspect every sheet locally before returning any labels. */
export async function assertBlankWorkbook(file: string): Promise<void> {
  let entry: fs.Stats;
  try {
    entry = fs.statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TemplateCheckError('TEMPLATE_NOT_FOUND');
    throw new TemplateCheckError('TEMPLATE_PARSE_FAILED');
  }
  if (!entry.isFile()) throw new TemplateCheckError('TEMPLATE_PATH_INVALID');
  try {
    const workbook = await XLSXPopulate.fromFileAsync(file);
    checkBlankWorkbook(workbook);
  } catch (error) {
    if (error instanceof TemplateCheckError) throw error;
    throw new TemplateCheckError('TEMPLATE_PARSE_FAILED');
  }
}

function checkBlankWorkbook(workbook: Workbook): void {
  try {
    let scanned = 0;
    for (const sheet of workbook.sheets()) {
      const used = sheet.usedRange();
      if (!used) continue;
      const first = used.startCell(), last = used.endCell();
      const cells = (last.rowNumber() - first.rowNumber() + 1) * (last.columnNumber() - first.columnNumber() + 1);
      scanned += cells;
      if (scanned > 500000) throw new Error(STOP);
      for (let row = first.rowNumber(); row <= last.rowNumber(); row++) {
        for (let col = first.columnNumber(); col <= last.columnNumber(); col++) {
          const cell = sheet.cell(row, col);
          const value = cell.value();
          if (value !== undefined && value !== null && value !== '') {
            // A stored number is data. Formula constants are not: their text stays
            // local and the projection exposes only a formula marker.
            if (typeof value !== 'string') throw new Error(STOP);
            if (looksLikeNumericText(value)) throw new Error(STOP);
          }
        }
      }
    }
  } catch {
    // Parser errors can include source contents; never forward them to the agent.
    throw new TemplateCheckError('TEMPLATE_DATA_BLOCKED');
  }
}

/** Labels like "2026年" and "第18期" are allowed; standalone amounts and percentages are not. */
function looksLikeNumericText(value: string): boolean {
  const text = value.trim()
    .replace(/\u00a0|\u2007|\u202f/g, ' ')
    .replace(/^[（(]\s*/, '')
    .replace(/\s*[)）]$/, '')
    .replace(/^[+\-−]/, '')
    .replace(/^[¥￥$€£]\s*/, '')
    .replace(/\s*(?:%|％|元|万元|亿元|千元|人民币)$/, '');
  return /^\d{1,3}(?:,\d{3})*(?:\.\d+)?$|^\d+(?:\.\d+)?$/.test(text);
}
