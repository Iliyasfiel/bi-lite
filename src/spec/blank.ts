import XLSXPopulate from 'xlsx-populate';

const STOP = 'TEMPLATE_DATA_BLOCKED: 文件包含数值、疑似数值文本或无法确认安全的内容。已停止，不返回单元格内容。请勿向聊天上传含数据文件；请在本机制作空白结构模板后重新提供，业务源文件仅在 Web 页面由用户手动导入。';

/** Agent preflight only. Inspect every sheet locally before returning any labels. */
export async function assertBlankWorkbook(file: string): Promise<void> {
  try {
    const workbook = await XLSXPopulate.fromFileAsync(file);
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
    throw new Error(STOP);
  }
}
