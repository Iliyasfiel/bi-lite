/** 可重建的主链路示例；ExcelJS 仅在测试生成器使用。 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';

export async function makeFixtures() {
  const dir = 'test/fixtures';
  fs.mkdirSync(dir, { recursive: true });
  const companies = ['集团公司', '华东子公司', '华南子公司', '华北子公司'];
  const metrics = ['营业收入', '利润总额', '营业成本', '净利润', '期间费用'];
  const source = new ExcelJS.Workbook();
  const input = source.addWorksheet('月报');
  input.addRow(['单位', '期数', '指标', '本年累计', '本月数', '同比%', '去年同期累计', '账面累计']);
  companies.forEach((company, ci) => metrics.forEach((metric, mi) => {
    const base = (ci + 1) * 10000 + (mi + 1) * 1000;
    input.addRow([company, '2026-06', metric, base * 6, base, 0.2, base * 5, base * 10]);
  }));
  input.columns.forEach((col) => { col.width = 18; });
  await source.xlsx.writeFile(`${dir}/月度经营接入源.xlsx`);

  const template = new ExcelJS.Workbook();
  const sheet = template.addWorksheet('主要指标');
  sheet.mergeCells('A1:E1');
  sheet.getCell('A1').value = '集团经营月报';
  sheet.getCell('A1').font = { bold: true, size: 16 };
  sheet.getCell('A3').value = '指标';
  ['本年累计', '去年同期累计', '单月', '账面累计'].forEach((name, i) => {
    sheet.getCell(3, i + 2).value = name;
  });
  metrics.forEach((name, i) => {
    sheet.getCell(i + 4, 1).value = name;
    for (let col = 2; col <= 5; col++) {
      sheet.getCell(i + 4, col).numFmt = '#,##0.00;[Red]-#,##0.00';
    }
  });
  sheet.getCell('A9').value = '合计';
  for (let col = 2; col <= 5; col++) {
    const letter = String.fromCharCode(64 + col);
    sheet.getCell(9, col).value = { formula: `SUM(${letter}4:${letter}8)` };
  }
  sheet.getCell('A1').note = '保留模板批注';
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
  sheet.columns.forEach((col) => { col.width = 20; });
  template.definedNames.add('主要指标!$B$4', 'DATA_START');
  await template.xlsx.writeFile(`${dir}/月度保送表.xlsx`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await makeFixtures();
  console.log('示例已生成到 test/fixtures/（源文件 + 空白模板）');
}
