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

// ============ 3. 接入路径的源夹具（新接入层：任意形态的 Excel → 星型表）============
// ★ 为什么它必须由 fixtures 生成：接入层的全链路（源文件 → raw → 事实行）**需要一个真的
//   存在、且在白名单内的源文件**，而 e2e 此前借用了 `data/` 下的一份探针文件 ——
//   `data/` 是真实数据目录、又被 `.gitignore` 掉，于是
//   「洁净 clone → npm run fixtures → npm run e2e」在接入这一段必挂。
//   **测试不该借生产规格的源**：生产规格（`ingest/月度经营接入.yaml`）指向真实数据，
//   本来就该在 `data/` 里；夹具是测试自己的，落 `test/fixtures/`。
//
// ★ 规格与源在**同一个地方**写出来：两者的路径与几何只有一个来源，不会各自漂。
const INGEST_SRC = 'test/fixtures/月度经营接入源.xlsx';
const INGEST_SPEC = 'test/fixtures/月度经营接入.yaml';

const wb3 = new ExcelJS.Workbook();
const is = wb3.addWorksheet('月报');
is.addRow(['单位', '期数', '指标', '本年累计', '本月数', '同比%']);
/** 行键 = (A 列公司, C 列指标)；B 列期数；D/E 两个值列；F 是派生列（规格里跳过） */
const INGEST_ROWS: Array<[company: string, metric: string, cumulative: number, month: number]> = [
  ['华东子公司', '营业收入', 1234.5, 56.75],
  ['华东子公司', '净利润', 200.25, 20.125],
  ['华南子公司', '营业收入', 9876.5, 432.25],
  ['华南子公司', '净利润', 500.75, 50.375],
];
for (const [company, metric, cumulative, month] of INGEST_ROWS) {
  is.addRow([company, '2026-06', metric, cumulative, month, 0]);
}
// 「合计」行刻意留着：规格里的 drop 就是为它写的，夹具必须能真的验到那条规则
is.addRow(['合计', '2026-06', '合计', null, null, 0]);
for (let c = 1; c <= 6; c++) is.getColumn(c).width = 16;
await wb3.xlsx.writeFile(INGEST_SRC);

// 夹具规格：形状与 `ingest/月度经营接入.yaml` 一致，只有 source 指向夹具自己。
// ★ 不要为了测试去改生产规格的 source —— 那会把"测试依赖"伪装成"生产配置"。
fs.writeFileSync(
  INGEST_SPEC,
  `# 由 \`npm run fixtures\` 生成（test/make-fixtures.ts）—— **接入路径的测试夹具，不是生产规格**。
# 生产那份在 ingest/ 下，指向 data/ 里的真实数据；这一份的源就在 test/fixtures/ 里，
# 于是「洁净 clone → npm run fixtures → npm run e2e」不依赖任何不在版本库里的东西。
id: 月度经营接入-夹具
source: ${INGEST_SRC}
onConflict: reject
unknownMaster: create
onEmptyMeasure: skip
sheets:
  - name: 月报
    blocks:
      - anchor: D2
        rows:
          - col: A
            dim: company
          - col: C
            dim: metric
        values:
          columns: [D, E, F]
          skip:
            - columns: [F]
              why: 同比% 是派生列
          periodTypes: [本年累计, 单月]
        keys:
          - col: B
            as: period
        drop:
          labels: [合计]
`,
);

const factRows = INGEST_ROWS.length * 2; // 4 行数据 × 2 个接入的值列
console.log(`✅ 接入源: ${INGEST_SRC}  (${INGEST_ROWS.length} 行数据 → ${factRows} 条事实 + 1 行「合计」被 drop)`);
console.log(`✅ 接入规格: ${INGEST_SPEC}`);

// ============ 4. 长表的接入规格（"新路径能表达长表"的夹具）============
// ★ 为什么要它：要删掉旧长表路径（src/import/longtable.ts），先得让新路径能**表达**长表。
//   长表和宽表在接入规格里的写法完全不同：宽表的期数整块同值（keys 列每行重复），
//   而长表**每一行有自己的期数**，四个坐标全在列里：
//       行键 = B 公司 / C 指标 / D 口径，期数 = A 列（keys），值列 = E 金额。
//   这一段同时也是 e2e 第 26 阶段「新旧接入路径对拍」的输入（见 test/e2e.ts）。
const LONG_SPEC = 'test/fixtures/集团导出长表.yaml';
fs.writeFileSync(
  LONG_SPEC,
  `# 由 \`npm run fixtures\` 生成（test/make-fixtures.ts）—— **长表的测试夹具，不是生产规格**。
# 四个坐标全在列里：期数在 A 列（逐行不同），公司/指标/口径在 B/C/D，金额在 E。
# 与宽表（月度经营接入.yaml）的差别就在期数：这边每行一个期，那边整块同一个期。
id: 集团导出长表-夹具
source: ${LONG}
onConflict: reject
unknownMaster: create
onEmptyMeasure: skip
sheets:
  - name: 财务快报
    blocks:
      - anchor: E2
        rows:
          - col: B
            dim: company
          - col: C
            dim: metric
          - col: D
            dim: period_type
        keys:
          - col: A
            as: period
        values:
          columns: [E]
`,
);
console.log(`✅ 长表接入规格: ${LONG_SPEC}  (与旧长表路径同一份源，供对拍)`);

// ============ 5. 主数据对齐的场景源（e2e 第 15 阶段用）============
// 每个场景 = 一份 xlsx + 一份规格。长表形状（一行一条事实，四个坐标全在列里）。
//
// ★ 为什么规格用 `onConflict: replace`：这些场景刻意落在**种子数据已有的坐标**上
//   （2026-01..06 × 营业收入 × 本年累计），而旧路（longtable）的语义就是 upsert。
//   新路默认是 `reject` —— 用默认值会先撞库拒绝，把"主数据对齐"验成"撞库拒绝"，
//   场景就偏了。顺带这也头一次把 `onConflict: replace` 这条分支纳入门禁。
//
// ★ 为什么不用同一份源：每个场景要**独立成批**（Tier 1 自动归并 → Tier 2 交人拍板 →
//   人拍板后落库 → 下月自动命中），批次不能混。
const ALIGN_SCENARIOS: Array<{ id: string; rows: Array<[company: string, month: string, amount: number]> }> = [
  { id: '接入-对齐1', rows: [['（集团公司）', '2026-01', 100], ['（集团公司）', '2026-02', 200]] },
  { id: '接入-对齐2', rows: [['华东分公司', '2026-03', 300], ['西北子公司', '2026-03', 400]] },
  { id: '接入-对齐3', rows: [['华东分公司', '2026-04', 500]] },
  { id: '接入-对齐4', rows: [['华南分公司', '2026-05', 1]] },
  { id: '接入-对齐5', rows: [['华北分公司', '2026-06', 1]] },
];

for (const s of ALIGN_SCENARIOS) {
  const src = `test/fixtures/${s.id}.xlsx`;
  const wbA = new ExcelJS.Workbook();
  const wsA = wbA.addWorksheet('财务快报');
  wsA.addRow(['财务期', '公司名称', '指标名称', '口径', '金额']);
  for (const [company, month, amount] of s.rows) {
    wsA.addRow([`${month}-01`, company, '营业收入', '本年累计', amount]);
  }
  for (let c = 1; c <= 5; c++) wsA.getColumn(c).width = 16;
  await wbA.xlsx.writeFile(src);

  fs.writeFileSync(
    `test/fixtures/${s.id}.yaml`,
    `# 由 \`npm run fixtures\` 生成（test/make-fixtures.ts）—— 主数据对齐的场景夹具。
# onConflict: replace 是刻意的：这些坐标在种子数据里已有值，场景要验的是"归并/拍板"，
# 不是"撞库拒绝"（旧长表路径的语义本来就是 upsert）。
id: ${s.id}-夹具
source: ${src}
onConflict: replace
unknownMaster: create
onEmptyMeasure: skip
sheets:
  - name: 财务快报
    blocks:
      - anchor: E2
        rows:
          - col: B
            dim: company
          - col: C
            dim: metric
          - col: D
            dim: period_type
        keys:
          - col: A
            as: period
        values:
          columns: [E]
`,
  );
}
console.log(`✅ 主数据对齐场景源: ${ALIGN_SCENARIOS.length} 组（${ALIGN_SCENARIOS.map((s) => s.id).join(', ')}）`);
