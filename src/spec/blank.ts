import XLSXPopulate from 'xlsx-populate';
import type { Workbook } from 'xlsx-populate';

const STOP = 'TEMPLATE_DATA_BLOCKED: 文件包含数值、疑似数值文本或无法确认安全的内容。已停止，不返回单元格内容。请勿向聊天上传含数据文件；请在本机制作空白结构模板后重新提供，业务源文件仅在 Web 页面由用户手动导入。';

export class TemplateCheckError extends Error {
  code: 'TEMPLATE_DATA_BLOCKED' | 'TEMPLATE_PARSE_FAILED';
  constructor(code: TemplateCheckError['code']) {
    super(code === 'TEMPLATE_DATA_BLOCKED' ? STOP : 'TEMPLATE_PARSE_FAILED: 无法读取该文件，请提供有效的空白 .xlsx 模板。');
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
  try {
    const workbook = await XLSXPopulate.fromFileAsync(file);
    checkBlankWorkbook(workbook);
  } catch {
    // Preserve the conservative error contract of external agent tools.
    throw new TemplateCheckError('TEMPLATE_DATA_BLOCKED');
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
            if (typeof value !== 'string' || /\p{N}/u.test(value)) throw new Error(STOP);
          }
          // References contain row numbers; other numeric literals may be embedded data.
          const formula = cell.formula();
          if (formula && /\p{N}/u.test(formula.replace(/\$?[A-Z]{1,3}\$?[1-9][0-9]*/gi, ''))) {
            throw new Error(STOP);
          }
        }
      }
    }
  } catch {
    // Parser errors can include source contents; never forward them to the agent.
    throw new TemplateCheckError('TEMPLATE_DATA_BLOCKED');
  }
}
