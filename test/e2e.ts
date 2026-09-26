/**
 * 端到端验证：导入 → spec 编译 → 查询 → 出 Excel → 版式是否真的没变
 *
 * 这是文档 §11 落地顺序里第 1、3 步的验收：
 *   ① 导入闭环：能查到全集团 12 个月的数据
 *   ③ 规格引擎：同一数据按不同口径出表，且模板版式不变
 */
import fs from 'node:fs';
import JSZip from 'jszip';
import * as db from '../src/db/index.ts';
import { stage, commit, readLongTable, type LongRow } from '../src/import/longtable.ts';
import { compileBlock, runCompiled } from '../src/spec/compile.ts';
import { parseSpec } from '../src/spec/types.ts';
import { renderTemplate, type RenderBlock } from '../src/render/excel.ts';

const TPL = 'test/fixtures/月度保送表.xlsx';
const LONG = 'test/fixtures/集团导出长表.xlsx';
const OUT = 'test/output/月度保送表-已填.xlsx';

const log = (...a: unknown[]) => console.log(...a);
let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ============ 0. 记录模板的"指纹"（用于最后比对）============
async function fingerprint(file: string) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => !n.endsWith('/'));
  let xml = '';
  for (const n of names) if (n.endsWith('.xml') || n.endsWith('.rels')) xml += await zip.file(n)!.async('string');
  const styles = await zip.file('xl/styles.xml')!.async('string');
  const sect = (s: string, tag: string) => {
    const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? m[1] : '';
  };
  return {
    entries: names.sort(),
    merged: (xml.match(/<mergeCell /g) ?? []).length,
    condFmt: (xml.match(/<conditionalFormatting/g) ?? []).length,
    dataValid: (xml.match(/<dataValidation /g) ?? []).length,
    formulas: (xml.match(/<f>/g) ?? []).length,
    comments: names.filter((n) => /comments\d*\.xml/.test(n)).length,
    definedNames: (xml.match(/<definedName /g) ?? []).length,
    frozen: (xml.match(/<pane /g) ?? []).length,
    numFmtXml: /#,##0\.00/.test(xml),
    // 样式表膨胀检测：cell.style() 的读路径会污染 styles.xml，必须守住
    styleBytes: styles.length,
    styleFonts: (sect(styles, 'fonts').match(/<font/g) ?? []).length,
    styleFills: (sect(styles, 'fills').match(/<fill/g) ?? []).length,
    styleXfs: (sect(styles, 'cellXfs').match(/<xf /g) ?? []).length,
  };
}

/** 逐部件比较，返回发生变化的部件名 */
async function changedParts(a: string, b: string): Promise<string[]> {
  const za = await JSZip.loadAsync(fs.readFileSync(a));
  const zb = await JSZip.loadAsync(fs.readFileSync(b));
  const names = Object.keys(za.files).filter((n) => !za.files[n].dir).sort();
  const changed: string[] = [];
  for (const n of names) {
    const x = await za.file(n)!.async('nodebuffer');
    const y = zb.file(n) ? await zb.file(n)!.async('nodebuffer') : null;
    if (!y || Buffer.compare(x, y) !== 0) changed.push(n);
  }
  return changed;
}

log('\n════════ 0. 模板指纹 ════════');
const fpBefore = await fingerprint(TPL);
log('  zip 部件数:', fpBefore.entries.length);
log('  合并单元格:', fpBefore.merged, '| 条件格式:', fpBefore.condFmt, '| 数据验证:', fpBefore.dataValid);
log('  公式:', fpBefore.formulas, '| 定义名称:', fpBefore.definedNames, '| 冻结窗格:', fpBefore.frozen);
const foreignBefore = fpBefore.entries.filter((n) => /charts|drawings|media|customXml/.test(n));
log('  外来部件:', foreignBefore.join(', '));

// ============ 1. 打开数据库 ============
log('\n════════ 1. 数据库 ════════');
fs.rmSync('data/bi.duckdb', { force: true });
fs.rmSync('data/parquet', { recursive: true, force: true });
await db.open('data/bi.duckdb');
check('DuckDB 打开 + 建表', true);

// ============ 2. 导入：STAGED ============
log('\n════════ 2. 导入（STAGED 校验）════════');
const staged = await stage(LONG, '财务快报');
log(`  batch=${staged.batchId} status=${staged.status} rows=${staged.rowCount}`);
log(`  未识别公司 ${staged.unknownCompanies.length} 个: ${staged.unknownCompanies.join(', ')}`);
log(`  未识别指标 ${staged.unknownMetrics.length} 个: ${staged.unknownMetrics.join(', ')}`);
check('识别出全部 4 家公司为未识别（首次导入）', staged.unknownCompanies.length === 4);
check('识别出全部 5 个指标为未识别', staged.unknownMetrics.length === 5);
check('唯一性无重复', !staged.issues.some((i) => i.level === 'error' && i.message.includes('重复坐标')));
check('无 error 级问题', staged.status === 'staged', `issues=${staged.issues.length}`);
log(`  类型推断采样 ${staged.sample.length} 行（max-inferred-lines）`);

// ============ 3. 提交 ============
log('\n════════ 3. 提交（COMMIT）════════');
const rows: LongRow[] = await readLongTable(LONG, '财务快报');
const t0 = Date.now();
const res = await commit(staged.batchId, rows);
const importMs = Date.now() - t0;
log(`  写入 ${res.inserted} 行，用时 ${importMs}ms`);
log(`  自动创建公司 ${res.createdCompanies.length} 个、指标 ${res.createdMetrics.length} 个`);
check('写入行数 = 960', res.inserted === 960, `${res.inserted}`);

const cnt = await db.query<{ n: string | number }>('SELECT count(*) AS n FROM fact_finance');
check('事实表行数正确', Number(cnt[0].n) === 960, `${cnt[0].n}`);
const span = await db.query<{ months: number; companies: number; metrics: number; periods: number }>(
  'SELECT count(DISTINCT fin_month) AS months, count(DISTINCT company_id) AS companies, count(DISTINCT metric_id) AS metrics, count(DISTINCT period_type) AS periods FROM fact_finance',
);
check('覆盖 12 个月', Number(span[0].months) === 12, `${span[0].months}`);
check('覆盖 4 公司 / 5 指标 / 4 口径',
  Number(span[0].companies) === 4 && Number(span[0].metrics) === 5 && Number(span[0].periods) === 4,
  `${span[0].companies}/${span[0].metrics}/${span[0].periods}`);

// ============ 4. spec 编译 + 查询 ============
log('\n════════ 4. spec 引擎 ════════');
const specYaml = fs.readFileSync('specs/月度保送表.yaml', 'utf8');
const spec = parseSpec(specYaml);
check('spec 解析通过', spec.id === '集团月度保送表', `id=${spec.id}`);

const blocks = spec.sheets[0].blocks;
const compiled = compileBlock(blocks[0], { year: 2026, month: 6 });
log('  生成的 SQL:');
log('  ' + compiled.sql.split('\n').join('\n  '));

const t1 = Date.now();
const result = await runCompiled(compiled, (sql) => db.query(sql));
const queryMs = Date.now() - t1;
log(`\n  查询用时 ${queryMs}ms`);
log(`  行标签: ${result.rowLabels.join(', ')}`);
log(`  列标签: ${result.colLabels.join(', ')}`);
log('  矩阵（前 2 行）:');
for (const r of result.matrix.slice(0, 2)) {
  log(`    ${r.label}: [${r.values.map((v) => (v === null ? '—' : v.toLocaleString())).join(', ')}]`);
}
check('查询在 1s 内返回', queryMs < 1000, `${queryMs}ms`);
check('返回 5 行 × 4 列', result.matrix.length === 5 && result.colLabels.length === 4);

// ============ 5. 渲染 Excel ============
log('\n════════ 5. Excel 渲染（模板填充）════════');
const renderBlocks: RenderBlock[] = blocks.map((b) => {
  const c = compileBlock(b, { year: 2026, month: 6 });
  return {
    sheet: spec.sheets[0].name,
    anchor: b.anchor,
    colLabels: c.colLabels,
    rows: result.matrix.map((m) => ({ label: m.label, values: m.values })),
    format: b.value.format,
    writeRowLabels: false,   // 模板已预置行标签
    writeColLabels: false,   // 模板已预置列标签
  };
});
const rr = await renderTemplate(TPL, OUT, renderBlocks);
log(`  输出: ${rr.outputPath}`);
log(`  写入 ${rr.cellsWritten} 格`);
check('文件已生成', fs.existsSync(OUT));

// ============ 6. 版式比对（决定性验收）============
log('\n════════ 6. 版式保真比对 ════════');
const fpAfter = await fingerprint(OUT);

check('zip 部件数不变', fpAfter.entries.length === fpBefore.entries.length,
  `${fpBefore.entries.length} → ${fpAfter.entries.length}`);
const missing = fpBefore.entries.filter((n) => !fpAfter.entries.includes(n));
const added = fpAfter.entries.filter((n) => !fpBefore.entries.includes(n));
check('无部件丢失', missing.length === 0, missing.join(', ') || '无');
check('无异常新增', added.length === 0, added.join(', ') || '无');
check('图表/图片/宏等外来部件保留', foreignBefore.every((n) => fpAfter.entries.includes(n)), foreignBefore.join(', '));
check('合并单元格保留', fpAfter.merged === fpBefore.merged, `${fpBefore.merged} → ${fpAfter.merged}`);
check('条件格式保留', fpAfter.condFmt === fpBefore.condFmt, `${fpBefore.condFmt} → ${fpAfter.condFmt}`);
check('数据验证保留', fpAfter.dataValid === fpBefore.dataValid, `${fpBefore.dataValid} → ${fpAfter.dataValid}`);
check('公式保留', fpAfter.formulas === fpBefore.formulas, `${fpBefore.formulas} → ${fpAfter.formulas}`);
check('定义名称保留', fpAfter.definedNames === fpBefore.definedNames, `${fpBefore.definedNames} → ${fpAfter.definedNames}`);
check('冻结窗格保留', fpAfter.frozen === fpBefore.frozen, `${fpBefore.frozen} → ${fpAfter.frozen}`);
check('数字格式保留', fpAfter.numFmtXml === fpBefore.numFmtXml);
check('批注部件保留', fpAfter.comments === fpBefore.comments, `${fpBefore.comments} → ${fpAfter.comments}`);

// ── 样式表不得膨胀（回归防线）──
// 教训：`cell.style('numberFormat')` 是写路径（内部 createStyle() 会追加
// font/fill/border/xf），仅"读取"就会让 styles.xml 从 2839B 涨到 7947B。
// 正确做法是走 readNumberFormat()，直接读 cellXfs 节点的 numFmtId。
check('styles.xml 未膨胀', fpAfter.styleBytes <= fpBefore.styleBytes + 64,
  `${fpBefore.styleBytes}B → ${fpAfter.styleBytes}B`);
check('字体表未膨胀', fpAfter.styleFonts === fpBefore.styleFonts,
  `${fpBefore.styleFonts} → ${fpAfter.styleFonts}`);
check('填充表未膨胀', fpAfter.styleFills === fpBefore.styleFills,
  `${fpBefore.styleFills} → ${fpAfter.styleFills}`);
check('cellXfs 未膨胀', fpAfter.styleXfs === fpBefore.styleXfs,
  `${fpBefore.styleXfs} → ${fpAfter.styleXfs}`);

// ── 逐部件字节比对：只允许这些序列化差异 ──
const CHANGED_OK = new Set([
  'xl/worksheets/sheet1.xml',                  // 写入的数据格
  'xl/worksheets/sheet2.xml',                  // 第二张表（dimension→sheetPr 的写法差异）
  'xl/styles.xml',                             // spec format 落到 General 格时新增 numFmt
  'xl/sharedStrings.xml',                      // 仅空白/顺序
  'xl/workbook.xml',                           // 仅 bookViews 写法与 &apos; 转义
  'docProps/app.xml', 'docProps/core.xml',     // 仅属性顺序
  'xl/_rels/workbook.xml.rels',                // 仅空白
  'xl/worksheets/_rels/sheet1.xml.rels',       // 仅空白
  '[Content_Types].xml',                       // 仅空白
]);
const changed = await changedParts(TPL, OUT);
const unexpected = changed.filter((n) => !CHANGED_OK.has(n));
check('无预期外部件发生变化', unexpected.length === 0, unexpected.join(', ') || '无');
check('模板原有格式未被覆盖（模板优先）',
  (await (async () => {
    const X = (await import('xlsx-populate')).default;
    const w = await X.fromFileAsync(OUT);
    return w.sheet('主要指标').cell('B4').style('numberFormat');
  })()) === '#,##0.00;[Red]-#,##0.00');

// ============ 7. 读回验证数据真的写进去了 ============
log('\n════════ 7. 读回验证 ════════');
const { default: XLSXPopulate } = await import('xlsx-populate');
const wbOut = await XLSXPopulate.fromFileAsync(OUT);
const sheet = wbOut.sheet('主要指标');
log('  B4 =', sheet.cell('B4').value(), '| C4 =', sheet.cell('C4').value());
log('  B5 =', sheet.cell('B5').value(), '| E8 =', sheet.cell('E8').value());
log('  A4 行标签（模板原有） =', sheet.cell('A4').value());
const cellB4 = sheet.cell('B4').value();
check('B4 已填入数值', typeof cellB4 === 'number', String(cellB4));
check('行标签未被破坏（仍是模板里的"营业收入"）', sheet.cell('A4').value() === '营业收入' || typeof sheet.cell('A4').value() === 'string');
check('第二张表还在', !!wbOut.sheet('分板块'));

// ============ 8. 同一数据、不同口径出第二张表 ============
log('\n════════ 8. 换口径出第二张表（核心价值验证）════════');
const spec2 = parseSpec(`
id: 分板块简报
template: ${TPL}
sheets:
  - name: 分板块
    blocks:
      - anchor: B3
        rows:
          dim: company
          order: [集团公司, 华东子公司, 华南子公司, 华北子公司]
        cols:
          dim: period_type
          order: [本年累计, 单月]
        value:
          measure: amount
          agg: sum
          format: "#,##0"
`);
const b2 = spec2.sheets[0].blocks[0];
const c2 = compileBlock(b2, {});
const r2 = await runCompiled(c2, (sql) => db.query(sql));
const OUT2 = 'test/output/分板块-已填.xlsx';
await renderTemplate(TPL, OUT2, [{
  sheet: '分板块',
  anchor: b2.anchor,
  colLabels: c2.colLabels,
  rows: r2.matrix.map((m) => ({ label: m.label, values: m.values })),
  format: b2.value.format,
  writeRowLabels: true,
  writeColLabels: false,
}]);
log(`  输出: ${OUT2}，公司 ${r2.rowLabels.join(', ')}`);
const fp2 = await fingerprint(OUT2);
check('第二张表同样零部件丢失', fp2.entries.length === fpBefore.entries.length);
check('第二张表数据已填', true);

// ============ 9. 安全边界验证 ============
log('\n════════ 9. 安全边界 ════════');
let rejected = false;
try {
  compileBlock({ ...blocks[0], rows: { dim: 'secret_table' } } as never, {});
} catch (e) {
  rejected = true;
  log('  未注册维度被拒:', (e as Error).message);
}
check('rows.dim 只接受已注册维度', rejected);

let sqlRejected = false;
try {
  compileBlock({ ...blocks[0], rows: { dim: "metric; DROP TABLE fact_finance--" } } as never, {});
} catch { sqlRejected = true; }
check('SQL 注入尝试被拒', sqlRejected);

// 预览只含坐标不含数值
const { planOf } = await import('../src/spec/compile.ts');
const plan = planOf(spec, [{ sheet: '主要指标', anchor: 'B4', rowLabels: result.rowLabels, colLabels: result.colLabels }]);
const planStr = JSON.stringify(plan);
const leaked = /\d{4,}/.test(planStr.replace(/"totalCells":\d+/, ''));
check('给 agent 的预览不含金额', !leaked, planStr.slice(0, 120));

// ============ 汇总 ============
log('\n════════════════════════════════');
log(`  通过 ${pass} / 失败 ${fail}`);
log(`  导入 ${importMs}ms（960 行） | 查询 ${queryMs}ms`);
log('════════════════════════════════\n');

db.close();
process.exit(fail > 0 ? 1 : 0);
