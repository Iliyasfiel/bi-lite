/**
 * 生成一个"人工做的"复杂报送模板 + 假的长表 Excel，
 * 用于端到端验证：导入 → spec → 出表 → 版式是否真的没变。
 *
 * 刻意加入 xlsx-populate/exceljs 容易搞坏的部件：合并单元格、
 * 数字格式、条件格式、数据验证、公式、批注、冻结窗格、定义名称。
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import fs from 'node:fs';

const TPL = 'test/fixtures/月度保送表.xlsx';
const LONG = 'test/fixtures/集团导出长表.xlsx';
const COMPANIES = ['集团公司', '华东子公司', '华南子公司', '华北子公司'];
const METRICS = ['营业收入', '利润总额', '营业成本', '净利润', '期间费用'];
const PERIODS = ['本年累计', '去年同期累计', '单月', '账面累计'];
const MONTHS = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-01`);

// ============ 1. 报送模板（假装是财务同事手工做的）============
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('主要指标', { views: [{ state: 'frozen', xSplit: 1, ySplit: 3 }] });

ws.mergeCells('A1:F1');
ws.getCell('A1').value = '集团经营月报（2026年）';
ws.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF1F4E79' } };
ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
ws.getRow(1).height = 32;

ws.mergeCells('A2:A3');
ws.getCell('A2').value = '指标';
ws.getCell('A2').alignment = { horizontal: 'center', vertical: 'middle' };
ws.mergeCells('B2:E2');
ws.getCell('B2').value = '口径';
ws.getCell('B2').alignment = { horizontal: 'center' };
ws.getCell('B2').font = { bold: true };

PERIODS.forEach((p, i) => {
  const c = ws.getCell(3, 2 + i);
  c.value = p;
  c.font = { bold: true };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
  c.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
});

// 行标签预置（模拟真实模板）—— 数据从 B4 开始
METRICS.forEach((m, i) => {
  ws.getCell(4 + i, 1).value = m;
  ws.getCell(4 + i, 1).font = { bold: true };
});

// 数据区格式
for (let r = 4; r <= 4 + METRICS.length - 1; r++) {
  for (let c = 2; c <= 1 + PERIODS.length; c++) {
    const cell = ws.getCell(r, c);
    cell.numFmt = '#,##0.00;[Red]-#,##0.00';
    cell.alignment = { horizontal: 'right' };
  }
}

// 公式：合计行
const lastData = 3 + METRICS.length;
ws.getCell(lastData + 1, 1).value = '合计';
ws.getCell(lastData + 1, 1).font = { bold: true };
PERIODS.forEach((_, i) => {
  const col = String.fromCharCode(66 + i);
  ws.getCell(lastData + 1, 2 + i).value = { formula: `SUM(${col}4:${col}${lastData})`, result: 0 };
});

// 条件格式（负数标红）
ws.addConditionalFormatting({
  ref: `B4:E${lastData}`,
  rules: [
    { type: 'cellIs', operator: 'lessThan', formulae: [0], style: { font: { color: { argb: 'FFFF0000' } } } },
  ],
});

// 数据验证
ws.getCell('H1').dataValidation = { type: 'list', allowBlank: true, formulae: ['"是,否"'] };

// 批注
ws.getCell('A1').note = '数据来源：集团财务快报，报送前请核对勾稽关系';

// 列宽
ws.getColumn(1).width = 22;
[2, 3, 4, 5].forEach((c) => (ws.getColumn(c).width = 18));

// 定义名称 → 数据区锚点（推荐用它，模板改版式时跟着走）
wb.definedNames.add('主要指标!$B$4', 'DATA_START');

// 第二张表：分板块
const ws2 = wb.addWorksheet('分板块');
ws2.getCell('A1').value = '分板块汇总';
ws2.getCell('A1').font = { bold: true, size: 14 };
ws2.getCell('A3').value = '公司';
ws2.getCell('B3').value = '本年累计';
ws2.getCell('B3').font = { bold: true };
ws2.addConditionalFormatting({
  ref: 'B4:B10',
  rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [0], style: { font: { color: { argb: 'FF006100' } } } }],
});

fs.mkdirSync('test/fixtures', { recursive: true });
await wb.xlsx.writeFile(TPL);

// 往模板里注入"外来部件"（模拟真实模板带图表/图片/宏的情况）
{
  const zip = await JSZip.loadAsync(fs.readFileSync(TPL));
  zip.file('xl/charts/chart1.xml', '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart/></c:chartSpace>');
  zip.file('xl/drawings/drawing1.xml', '<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>');
  zip.file('xl/media/image1.png', Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  zip.file('customXml/item1.xml', '<?xml version="1.0"?><custom/>');
  fs.writeFileSync(TPL, await zip.generateAsync({ type: 'nodebuffer' }));
}

// ============ 2. 集团导出的长表（假的但形状真实）============
const wb2 = new ExcelJS.Workbook();
const ls = wb2.addWorksheet('财务快报');
ls.addRow(['财务期', '公司名称', '指标名称', '口径', '金额']);
let seed = 42;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
let n = 0;
for (const month of MONTHS) {
  for (const company of COMPANIES) {
    for (const metric of METRICS) {
      for (const period of PERIODS) {
        const base = metric === '营业成本' || metric === '期间费用' ? 6000 : 12000;
        const v = Math.round((base + rnd() * 3000) * (1 + MONTHS.indexOf(month) * 0.03));
        ls.addRow([month, company, metric, period, v]);
        n++;
      }
    }
  }
}
ls.getColumn(1).width = 14;
ls.getColumn(2).width = 18;
ls.getColumn(3).width = 14;
ls.getColumn(4).width = 16;
ls.getColumn(5).width = 14;
await wb2.xlsx.writeFile(LONG);

console.log(`✅ 模板: ${TPL}`);
console.log(`✅ 长表: ${LONG}  (${n} 行数据)`);
console.log(`   公司 ${COMPANIES.length} × 指标 ${METRICS.length} × 口径 ${PERIODS.length} × 月份 ${MONTHS.length} = ${n}`);
