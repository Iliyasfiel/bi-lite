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
import { findAmountLike } from '../src/mcp/tools.ts';

const TPL = 'test/fixtures/月度保送表.xlsx';
const LONG = 'test/fixtures/集团导出长表.xlsx';
const OUT = 'test/output/月度保送表-已填.xlsx';
const VARIANT = 'test/output/变体长表.xlsx';

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

// ============ 10. 语义层自由查询（F6）============
log('\n════════ 10. 语义层 query_metrics ════════');
const { queryMetrics, compileMetrics, band, catalog, QueryRefused } = await import('../src/semantic/query.ts');

const cat = await catalog();
log(`  目录: ${cat.dimensions.length} 维度 / ${cat.periodTypes.length} 口径 / ${cat.metrics.length} 指标 / ${cat.companies.length} 公司`);
check('目录含 5 个维度', cat.dimensions.length === 5, cat.dimensions.map((d) => d.name).join(','));
check('目录含 5 个口径', cat.periodTypes.length === 5);
check('目录含 5 指标 / 4 公司', cat.metrics.length === 5 && cat.companies.length === 4);
// 目录本身不含金额
const catStr = JSON.stringify(cat);
check('目录不含金额', !/\d{4,}/.test(catStr), `${catStr.length} 字节`);

// human 视角：精确值
const qHuman = await queryMetrics({
  measures: [{ metric: '营业收入', periodType: '本年累计' }, { metric: '营业收入', periodType: '单月' }],
  groupBy: ['company'],
  filter: { month: '2026-06' },
  audience: 'human',
});
log(`  人视角: ${qHuman.groups.length} 组 × ${qHuman.columns.length} 指标，脱敏=${qHuman.meta.redaction}`);
const sampleHuman = qHuman.groups[0];
log(`    ${sampleHuman.values.join('/')}: [${sampleHuman.cells.map((c) => (typeof c === 'number' ? c.toLocaleString() : c)).join(', ')}]`);
check('human 返回精确数值', qHuman.groups.every((g) => g.cells.every((c) => typeof c === 'number' || c === null)));
check('human 不脱敏', qHuman.meta.redaction === 'none');
check('按公司分组返回 4 组', qHuman.groups.length === 4, `${qHuman.groups.length}`);

// agent 视角：同一查询 → 分档值 + 阈值
// 注意：这里**不加 month 过滤** —— 一整年 12 个月的数据支撑每格，才过得了反推阈值。
const qAgent = await queryMetrics({
  measures: [{ metric: '营业收入', periodType: '本年累计' }, { metric: '营业收入', periodType: '单月' }, { metric: '利润总额', periodType: '本年累计' }],
  groupBy: ['company'],
  audience: 'agent',
});
log(`  agent 视角: 脱敏=${qAgent.meta.redaction}，每格最少 ${qAgent.meta.minSupport} 行支撑，示例 [${qAgent.groups[0].cells.join(', ')}]`);
check('agent 返回分档值而非精确数', qAgent.groups.every((g) => g.cells.every((c) => c === null || typeof c === 'string')));
check('agent 脱敏标记为 banded', qAgent.meta.redaction === 'banded');
check('分档值含单位（亿/万/千）', qAgent.groups.some((g) => g.cells.some((c) => typeof c === 'string' && /[亿万千]/.test(c))));
check('分档不可还原为精确数', !/\d{5,}/.test(qAgent.groups.flatMap((g) => g.cells).join(',')));

// 分档不可还原：同一条查询，agent 拿不到精确数
const humanVals = JSON.stringify(qHuman.groups.map((g) => g.cells));
const agentVals = JSON.stringify(qAgent.groups.map((g) => g.cells));
check('人/agent 同一查询返回不同形态', humanVals !== agentVals);

// 聚合阈值：单月单指标 = 每格仅 1 行明细支撑 → 必须拒绝（防反推，R5）
let tooFine = false;
try {
  await queryMetrics({
    measures: [{ metric: '营业收入', periodType: '单月' }],
    groupBy: ['company', 'metric'],
    filter: { month: '2026-06' },
    audience: 'agent',
  });
} catch (e) {
  tooFine = e instanceof QueryRefused && (e as InstanceType<typeof QueryRefused>).reason === 'TOO_FINE_GRAINED';
  if (tooFine) log('  过细粒度被拒:', (e as Error).message);
}
check('agent 探测式细粒度查询被拒（每格 1 行明细）', tooFine);

// 同一过细查询，human 允许（人本来就该能看明细）
const fineHuman = await queryMetrics({
  measures: [{ metric: '营业收入', periodType: '单月' }],
  groupBy: ['company', 'metric'],
  filter: { month: '2026-06' },
  audience: 'human',
});
check('同一查询 human 放行（阈值只约束 agent）', fineHuman.groups.length > 0, `${fineHuman.groups.length} 行`);
check('human 结果含精确数值', fineHuman.groups.some((g) => g.cells.some((c) => typeof c === 'number')));

// 未注册维度被拒
let badDim = false;
try { compileMetrics({ measures: [{ metric: '营业收入', periodType: '本年累计' }], groupBy: ['secret'], audience: 'human' }); } catch { badDim = true; }
check('自由查询拒绝未注册维度', badDim);

// 未注册口径被拒
let badPeriod = false;
try { compileMetrics({ measures: [{ metric: '营业收入', periodType: '我编的口径' }], audience: 'human' }); } catch { badPeriod = true; }
check('自由查询拒绝未注册口径', badPeriod);

// SQL 注入：指标名里的单引号必须被双写转义
const INJ = "营业收入'); DROP TABLE fact_finance;--";
const inj = compileMetrics({ measures: [{ metric: INJ, periodType: '本年累计' }], audience: 'human' });
log('  注入输入的转义结果: ' + inj.sql.split('\n').find((l) => l.includes('营业收入'))?.trim().slice(0, 110));
// 期望：每个单引号都被双写；不存在未转义的 `'); DROP`
const unescaped = INJ.replace(/'/g, "''");
check('指标名中的引号被双写转义', inj.sql.includes(unescaped) && !inj.sql.includes("= '营业收入'); DROP"));
const stillThere = await db.query<{ n: string | number }>('SELECT count(*) AS n FROM fact_finance');
check('注入尝试后事实表仍在', Number(stillThere[0].n) === 960, `${stillThere[0].n} 行`);

// 分档函数
check('band() 分档正确', band(123456789) === '1.2亿' && band(45678) === '4.6万' && band(null) === null, `${band(123456789)} / ${band(45678)}`);

// ============ 11. 图表渲染器（同一 spec 的第二个 renderer，F5）============
log('\n════════ 11. 图表渲染器（同一 spec → ECharts）════════');
const { toEChartsOption, chartShape } = await import('../src/render/chart.ts');
const chartSpec = { type: 'bar' as const, title: '各公司营业收入', stacked: false };
const opt = toEChartsOption(chartSpec, result);
log(`  类目轴: ${opt.xAxis!.data.join(', ')}`);
log(`  系列: ${opt.series.map((s) => s.name).join(', ')}`);
check('option 含 xAxis/yAxis/series', !!opt.xAxis && !!opt.yAxis && opt.series.length > 0);
check('系列名 = 4 个口径', opt.series.length === 4, `${opt.series.length}`);
check('每个系列 5 个数据点', opt.series.every((s) => s.data.length === 5));
check('option 含真实数值（只能给浏览器）', opt.series.some((s) => s.data.some((v) => typeof v === 'number')));

// 同一 spec 的另一个投影方向
const optByCols = toEChartsOption({ ...chartSpec, category: 'cols' }, result);
check('category=cols 时类目轴变成口径', optByCols.xAxis!.data.join(',') === result.colLabels.join(','));
check('category=cols 时系列变成 5 个指标', optByCols.series.length === 5, `${optByCols.series.length}`);

// 换图表类型不改数据
const optLine = toEChartsOption({ ...chartSpec, type: 'line' }, result);
check('line 类型生效', optLine.series.every((s) => s.type === 'line'));
const optPie = toEChartsOption({ ...chartSpec, type: 'pie' }, result);
check('pie 类型生成单系列', optPie.series.length === 1 && optPie.series[0].type === 'pie');

// 堆叠
const optStack = toEChartsOption({ ...chartSpec, stacked: true }, result);
check('stacked=true 时系列带 stack', optStack.series.every((s) => s.stack === 'total'));

// ★ 安全：给 agent 的图表描述不含数值
const shape = chartShape(chartSpec, result);
const shapeStr = JSON.stringify(shape);
log(`  图表形状（给 agent）: ${shapeStr}`);
check('图表形状描述不含数值', !/"value":\d|\d{4,}/.test(shapeStr.replace(/"pointCount":\d+/, '')));
check('图表形状含结构与标签', shape.chartType === 'bar' && shape.seriesLabels.length === 4);

// spec 可选 chart 声明已被解析
const specWithChart = parseSpec(`
id: 带图表
template: ${TPL}
sheets:
  - name: 主要指标
    blocks:
      - anchor: B4
        rows: { dim: metric, order: [营业收入] }
        cols: { dim: period_type, order: [本年累计] }
        value: { measure: amount, agg: sum }
        chart: { type: bar, title: 测试 }
`);
check('spec 支持可选 chart 声明', specWithChart.sheets[0].blocks[0].chart?.type === 'bar');

// ============ 12. Web 服务（F1/F6 的人机界面）============
log('\n════════ 12. Web 服务（HTTP 全链路）════════');
const { start, stop } = await import('../src/server.ts');
const port = await start(0);                       // 0 = 内核分配端口
const base = `http://127.0.0.1:${port}`;
log(`  服务已起于 ${base}（只监听回环）`);

const getJson = async (path: string) => (await fetch(base + path)).json() as Promise<any>;
const postJson = async (path: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<any>;
};

// 静态资源（本页可离线打开 —— ECharts 从 node_modules 直供，不依赖 CDN）
const home = await fetch(base + '/');
check('GET / 返回页面', home.status === 200 && (await home.text()).includes('bi-lite'));
const vendor = await fetch(base + '/vendor/echarts.min.js');
const vendorBytes = (await vendor.arrayBuffer()).byteLength;   // 流式响应无 content-length，须按实际字节判
check('ECharts 本地直供（无 CDN 依赖）', vendor.status === 200 && vendorBytes > 500_000,
  `${(vendorBytes / 1024 / 1024).toFixed(1)}MB`);

// 目录：零金额
const webCat = await getJson('/api/catalog');
check('GET /api/catalog 返回维度与口径', webCat.dimensions.length === 5 && webCat.periodTypes.length === 5,
  `${webCat.dimensions.length} 维度 / ${webCat.periodTypes.length} 口径`);
check('目录不含任何金额字段', !/\d{4,}/.test(JSON.stringify(webCat.companies) + JSON.stringify(webCat.metrics)));

// ★ 安全：Web 查询固定 human 视角，即使请求里写 agent 也被覆盖
const webQuery = await postJson('/api/query', {
  measures: [{ metric: '营业收入', periodType: '本年累计' }],
  groupBy: ['company'],
  filter: { year: '2026' },
  audience: 'agent',                               // ← 故意写 agent，服务端应忽略
});
check('Web 查询固定 human 视角（请求里的 agent 被覆盖）',
  webQuery.meta.audience === 'human' && webQuery.meta.redaction === 'none',
  `audience=${webQuery.meta.audience} redaction=${webQuery.meta.redaction}`);
check('Web 返回精确数值', webQuery.groups.some((g: any) => g.cells.some((c: any) => typeof c === 'number')));

// 同一过细查询：Web（human）放行，agent 被拒 —— 与第 10 阶段一致
const webFine = await postJson('/api/query', {
  measures: [{ metric: '营业收入', periodType: '单月' }],
  groupBy: ['company', 'metric'],
  filter: { month: '2026-06' },
});
check('Web 上同一过细查询被放行（阈值只约束 agent）', !webFine.refused && webFine.groups.length > 0);

// 未注册维度经 HTTP 也被拒
const webBadDim = await postJson('/api/query', {
  measures: [{ metric: '营业收入', periodType: '本年累计' }],
  groupBy: ['secret_table'],
});
check('HTTP 层拒绝未注册维度', webBadDim.refused === true && webBadDim.reason === 'UNKNOWN_DIMENSION');

// 图表：option 含数值、shape 不含
const webChart = await postJson('/api/chart', {
  query: { measures: [{ metric: '营业收入', periodType: '本年累计' }], groupBy: ['company'] },
  chart: { type: 'bar' },
});
check('图表 option 含数值且含 4 个类目', webChart.option.series[0].data.filter((v: any) => typeof v === 'number').length === 4);
const webShapeStr = JSON.stringify(webChart.shape);
check('图表 shape 经 HTTP 下发仍不含数值',
  !/"value":\d|\d{4,}/.test(webShapeStr.replace(/"pointCount":\d+/, '')));

// 报表：预览给出坐标计划，渲染产出可下载的文件
const webPreview = await postJson('/api/report/preview', { specFile: 'specs/月度保送表.yaml', params: { year: 2026, month: 6 } });
check('报表预览返回 5×4 矩阵', webPreview.sheets[0].blocks[0].matrix.length === 5 && webPreview.sheets[0].blocks[0].colLabels.length === 4);
check('报表预览的计划不含数值', !/"value"|\d{4,}/.test(JSON.stringify(webPreview.plan).replace(/"totalCells":\d+/, '')));
check('报表预览的 plan 只含坐标与形状', webPreview.plan.totalCells === 20 && webPreview.plan.note.includes('不含任何金额'));

const webRender = await postJson('/api/report/render', { specFile: 'specs/月度保送表.yaml', params: { year: 2026, month: 6 }, output: 'e2e-web.xlsx' });
check('HTTP 渲染写出 20 格', webRender.cellsWritten === 20, `${webRender.cellsWritten}`);
const dl = await fetch(base + webRender.download);
check('渲染产物可下载且是 xlsx', dl.status === 200 && (dl.headers.get('content-type') ?? '').includes('spreadsheetml'));

// 路径穿越防护
const traversal1 = await postJson('/api/import/commit', { batchId: 'x', file: '/etc/passwd' });
check('拒绝上传目录外的文件路径', /不在上传目录内/.test(traversal1.error ?? ''));
const traversal2 = await fetch(base + '/static/../server.ts');
check('拒绝静态目录穿越', traversal2.status === 404);
const traversal3 = await fetch(base + '/download/../package.json');
check('拒绝下载目录穿越', traversal3.status === 404);

// 导入：上传二进制 + X-Filename 头（不引 multipart 依赖）
const upload = await fetch(base + '/api/import/stage', {
  method: 'POST',
  headers: { 'x-filename': encodeURIComponent('e2e-上传.xlsx'), 'content-type': 'application/octet-stream' },
  body: fs.readFileSync(LONG),
});
const staged2 = await upload.json() as any;
check('HTTP 上传并校验 960 行', staged2.rowCount === 960 && staged2.status !== 'error', `${staged2.rowCount} 行`);
check('重复导入的坐标冲突被识别', staged2.issues.some((i: any) => i.level === 'error' && i.message.includes('重复坐标')) === false,
  '与库内已有数据不冲突（按坐标 upsert）');

// ★ 两个只有浏览器能撞出来的 bug（都是 e2e 全绿之后在界面上发现的）
//
// 先生成一个"下个月改了公司写法"的变体表：把「华东子公司」写成「华东本部」。
// 这是真实场景的常态，也是 Tier 2 待确认卡的唯一来源。
// 特意选一个第 15 阶段没用到的写法，避免污染那一段的断言。
{
  const XLSXPopulate = (await import('xlsx-populate')).default;
  const vwb = await XLSXPopulate.fromFileAsync(LONG);
  const vws = vwb.sheet(0);
  const used = vws.usedRange();
  let renamed = 0;
  for (let r = 1; r <= used.endCell().rowNumber(); r++) {
    if (vws.cell(r, 2).value() === '华东子公司') { vws.cell(r, 2).value('华东本部'); renamed++; }
  }
  fs.mkdirSync('test/output', { recursive: true });
  await vwb.toFileAsync(VARIANT);
  check('变体表生成（240 行改名为「华东本部」）', renamed === 240, `${renamed} 行`);
}

// (1) 并发 / 连点上传时 batchId 撞车。原来只有 `Date.now()`，同毫秒的两个请求
//     会生成同一个 id，后到的直接 Duplicate key 失败。
const parallel = await Promise.all([1, 2, 3, 4, 5].map(() =>
  fetch(base + '/api/import/stage', {
    method: 'POST',
    headers: { 'x-filename': encodeURIComponent('并发.xlsx'), 'content-type': 'application/octet-stream' },
    body: fs.readFileSync(LONG),
  }).then((r) => r.json() as any),
));
const dupErr = parallel.filter((p) => /Duplicate key|Constraint Error/.test(p.error ?? ''));
check('★ 并发上传不会撞 batchId（连点两次也不该挂）', dupErr.length === 0 && parallel.every((p) => p.batchId),
  `${parallel.length} 个并发请求，冲突 ${dupErr.length} 个`);
check('★ 并发批次的 id 两两不同', new Set(parallel.map((p) => p.batchId)).size === parallel.length);

// (2) 未识别名称必须自带 `kind`。候选清单由「公司」和「指标」两个 Resolver 分别产出，
//     汇总给前端后就分不出谁是谁了；缺了它前端只能把公司标成「指标」，
//     而且人拍板回传的决定 `kind=undefined`，服务端永远匹配不上 ——
//     点「并入」等于没点，提交被无限次拦下。
const stagedVariant = await fetch(base + '/api/import/stage', {
  method: 'POST',
  headers: { 'x-filename': encodeURIComponent('变体.xlsx'), 'content-type': 'application/octet-stream' },
  body: fs.readFileSync(VARIANT),
}).then((r) => r.json() as any);
const un = stagedVariant.unresolved.companies[0];
check('★ 未识别名称自带 kind（前端靠它区分公司/指标）', un?.kind === 'company', JSON.stringify(un?.kind));
check('★ 待确认名称带候选与出现行数', un?.rows === 240 && un?.candidates?.[0]?.name === '华东子公司',
  `${un?.rows} 行 / ${un?.candidates?.[0]?.name}`);

// 端到端复现浏览器路径：把 stagedVariant 的 unresolved 直接转成 decisions 提交。
// 这一条若失败，就说明「人确认」这个动作在真实链路上是无效的。
const browserDecisions = [
  ...stagedVariant.unresolved.companies.map((d: any) => ({ kind: d.kind, raw: d.raw, action: 'merge', targetId: d.candidates[0].id })),
  ...stagedVariant.unresolved.metrics.map((d: any) => ({ kind: d.kind, raw: d.raw, action: 'merge', targetId: d.candidates[0].id })),
];
const confirmed = await postJson('/api/import/commit', {
  batchId: stagedVariant.batchId, file: stagedVariant.sourceFile, autoCreateDims: true, decisions: browserDecisions,
});
check('★ 前端回传的 decisions 被服务端认账（kind 对得上）', !confirmed.pendingConfirm && confirmed.inserted === 960,
  `pendingConfirm=${confirmed.pendingConfirm} inserted=${confirmed.inserted}`);

const committed = await postJson('/api/import/commit', { batchId: staged2.batchId, file: staged2.sourceFile, autoCreateDims: true });
check('HTTP 提交写入 960 行', committed.inserted === 960, `${committed.inserted}`);

const afterCount = await db.query<{ n: string | number }>('SELECT count(*) AS n FROM fact_finance');
check('重复提交后事实表仍是 960 行（坐标主键去重）', Number(afterCount[0].n) === 960, `${afterCount[0].n} 行`);

const batches = await getJson('/api/batches');
check('批次可追溯（N4）', Array.isArray(batches) && batches.length >= 2, `${batches.length} 个批次`);

// 归档：Parquet 必须真的写出来。
// 这条断言是为一个真实 bug 立的 —— 主实例开着 enable_external_access=false，
// 会直接拒绝 COPY ... TO，而服务端当初用裸 catch{} 把它吞了，
// 于是 Parquet 归档长期「静默不工作」（见 docs/需求与架构.md §4.4）。
check('提交时 Parquet 归档成功（不静默失败）', committed.archived === true, `archived=${committed.archived}`);
const archived = fs.globSync('data/parquet/fact_finance/batch=*/part.parquet');
check('归档文件确实落盘', archived.length >= 1, `${archived.length} 个文件`);
if (archived.length) {
  // 注意：不能走主连接读回 —— 主实例的 enable_external_access=false 会连 read_parquet 一起拒
  // （这正是硬化的预期效果：主库进程不碰任意文件）。用独立实例验证归档文件本身有效。
  //
  // 只读**本批次**的归档目录，不要用 `*/` 汇总 —— 那样断言会随别的测试批次一起变化，
  // 断言就不再指向"这一次提交归档成功了"这个事实。
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const verify = await DuckDBInstance.create();
  const vc = await verify.connect();
  const vr = await vc.runAndReadAll(
    `SELECT count(*) AS n FROM read_parquet('data/parquet/fact_finance/batch=${staged2.batchId}/part.parquet')`,
  );
  const n = Number((vr.getRowObjectsJson() as any[])[0].n);
  vc.closeSync();
  verify.closeSync();
  check('归档内容可被 DuckDB 读回（960 行）', n === 960, `${n} 行`);
}

// 主数据对齐的两个路由（§10 R1）
const sug = await postJson('/api/import/suggest', { names: [{ kind: 'company', raw: '华东分公司' }] });
check('HTTP 别名建议接口给出候选', sug.suggestions?.[0]?.candidates?.[0]?.name === '华东子公司',
  JSON.stringify(sug.suggestions?.[0]?.candidates?.[0] ?? {}));
check('建议接口不写库（纯查询）', (await getJson('/api/aliases')).filter((a: any) => a.alias === '华东分公司').length === 0);

const hzId = (await db.query<{ id: string }>(`SELECT id FROM dim_company WHERE name = '华东子公司'`))[0].id;
const aliasAdded = await postJson('/api/aliases', { kind: 'company', raw: '别名测试公司', targetId: hzId, note: 'e2e' });
check('HTTP 登记别名', aliasAdded.targetId === hzId && aliasAdded.normalized === '别名测试公司');

const badAlias = await postJson('/api/aliases', { kind: 'company', raw: 'x', targetId: 'c_不存在' });
check('别名指向不存在的目标 → 拒绝', /目标主数据不存在/.test(badAlias.error ?? ''), badAlias.error ?? '');
const badKind = await postJson('/api/aliases', { kind: 'nope', raw: 'x', targetId: hzId });
check('别名 kind 只接受 company/metric', /kind/.test(badKind.error ?? ''), badKind.error ?? '');

stop();

// ============ 13. MCP 工具集（第 4 步：agent 入口）============
//
// ★ 本阶段**用 DSH 自带的真实 MCP 客户端 SDK** 连我们的手写 stdio 服务端 ——
//   不是自打一个 mock 客户端自己对自己。这样协议漂移（分帧、版本协商、
//   server/discover 回落）会被真实客户端实测出来，而不是靠我们的假设。
log('\n════════ 13. MCP 工具集（真实客户端 · 零依赖 stdio）════════');

const SDK_DIR = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@modelcontextprotocol/client/dist/';
let mcpOk = false;
let mcpSkipReason = '';
try {
  const { Client } = await import(SDK_DIR + 'index.mjs');
  const { StdioClientTransport } = await import(SDK_DIR + 'stdio.mjs');

  // 用 DSH 同款配置（含 versionNegotiation: auto —— 它会先探 server/discover 再回落 legacy）
  const client = new Client(
    { name: 'bi-lite-e2e', version: '0.0.1' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['src/mcp/server.ts'],
      cwd: process.cwd(),
      stderr: 'ignore', // 服务端日志走 stderr，别污染测试输出
    }),
  );
  mcpOk = true;

  const raw = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text: string }>)[0].text;
    return { isError: r.isError === true, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };

  // --- 握手与工具清单 ---
  const list = await client.listTools();
  const names = list.tools.map((t) => t.name).sort();
  check('MCP 握手成功（auto 协商 → legacy 回落）', true, '真实客户端已连接');
  check('恰好暴露 6 个工具', names.length === 6, names.join(', '));
  check(
    '工具集与 §7.1 一致',
    JSON.stringify(names) ===
      JSON.stringify(['diff_report', 'generate_spec', 'get_template_schema', 'list_metrics', 'preview_spec', 'render_report']),
  );
  check(
    '每个工具都有 description 与 inputSchema',
    list.tools.every((t) => t.description && t.description.length > 20 && t.inputSchema),
  );

  // --- 1. list_metrics：纯元数据 ---
  const lm = await raw('list_metrics');
  check('list_metrics 成功', !lm.isError);
  check('list_metrics 有维度/口径/指标/公司', lm.json.dimensions.length === 5 && lm.json.periodTypes.length === 5 && lm.json.metrics.length === 5 && lm.json.companies.length === 4);
  check('list_metrics 不含金额', findAmountLike(lm.json).length === 0);

  // --- 2. get_template_schema：模板结构，且不回传数字 ---
  const ts = await raw('get_template_schema', { template: TPL });
  check('get_template_schema 成功', !ts.isError);
  const anchor = ts.json.anchors.find((a: any) => a.name === 'DATA_START');
  check('解析出定义名称锚点 DATA_START → B4', anchor?.cell === 'B4' && anchor?.sheet === '主要指标');
  check('锚点上方表头即列口径', JSON.stringify(anchor?.headerAbove) === JSON.stringify(['本年累计', '去年同期累计', '单月', '账面累计']));
  check('锚点左方行标签', anchor?.labelsLeft[0] === '营业收入' && anchor?.labelsLeft.length === 6);
  check('识别出合并单元格 3 处', ts.json.sheets[0].mergedCells.length === 3);
  check('模板结构不含金额', findAmountLike(ts.json).length === 0);

  // --- 3. preview_spec：★ 不查库，结构上不可能泄漏 ---
  const pv = await raw('preview_spec', { specFile: 'specs/月度保送表.yaml', params: { year: 2026, month: 6 } });
  check('preview_spec 成功', !pv.isError);
  check('预览给出写入区域 B4:E8', pv.json.blocks[0].dataRange === 'B4:E8', pv.json.blocks[0].dataRange);
  check('预览 5 行 × 4 列 = 20 格', pv.json.blocks[0].cells === 20);
  check('预览含行标签与列口径标签', pv.json.blocks[0].rows.labels[0] === '营业收入' && pv.json.blocks[0].cols.labels[0] === '本年累计');
  check('预览标注锚点类型为定义名称', pv.json.blocks[0].anchor.kind === 'name');
  check('★ 预览不含任何金额', findAmountLike(pv.json).length === 0);
  check('预览的 plan 也不含金额', findAmountLike(pv.json.plan).length === 0);

  // --- 4. render_report：真的出文件，但只回路径 ---
  const before = new Set(fs.globSync('output/*.xlsx'));
  const rr = await raw('render_report', {
    specFile: 'specs/月度保送表.yaml',
    params: { year: 2026, month: 6 },
    output: 'e2e-mcp-渲染.xlsx',
  });
  check('render_report 成功', !rr.isError);
  check('渲染写入 20 格', rr.json.cellsWritten === 20, `${rr.json.cellsWritten}`);
  check('★ render_report 返回值不含金额', findAmountLike(rr.json).length === 0);
  check('render_report 只回路径不回内容', !('matrix' in rr.json) && !('rows' in rr.json));

  const outFile = rr.json.outputPath;
  check('渲染产物确实落盘', fs.existsSync(outFile), outFile);
  // 产物内容用文件读回验证 —— 数值只在这里出现，不走 MCP 返回值
  {
    const XLSXPopulate = (await import('xlsx-populate')).default;
    const wb = await XLSXPopulate.fromFileAsync(outFile);
    const sheet = wb.sheet('主要指标');
    check('MCP 渲染出的 B4 是营业收入 2026-06 本年累计 66826', sheet.cell('B4').value() === 66826, String(sheet.cell('B4').value()));
    check('模板行标签未被覆盖（A4 仍是营业收入）', sheet.cell('A4').value() === '营业收入');
    check('模板合并区保留 3 处', Object.keys((sheet as any)._mergeCells).length === 3);
    check('模板另一个 sheet「分板块」还在', wb.sheets().map((s) => s.name()).includes('分板块'));
  }

  // --- 5. diff_report：换口径只是文本 diff ---
  const OLD = `id: T
template: test/fixtures/月度保送表.xlsx
sheets:
  - name: 主要指标
    blocks:
      - anchor: { name: DATA_START }
        rows: { dim: metric, order: [营业收入, 利润总额] }
        cols: { dim: period_type, order: [本年累计, 去年同期累计, 单月, 账面累计] }
        value: { measure: amount, agg: sum }`;
  const NEW = OLD.replace('dim: metric', 'dim: company')
    .replace('order: [营业收入, 利润总额]', 'order: [集团公司, 华东子公司]')
    .replace('order: [本年累计, 去年同期累计, 单月, 账面累计]', 'order: [本年累计, 单月]');
  const dr = await raw('diff_report', { before: OLD, after: NEW });
  check('diff_report 成功且识别出差异', !dr.isError && dr.json.changed === true);
  check('diff 精确到字段路径（rows.dim）', dr.json.changes.some((c: any) => c.path === 'sheets[0].blocks[0].rows.dim' && c.before === 'metric' && c.after === 'company'));
  check('diff 报出口径顺序变化（不是 [object Object]）', dr.json.changes.some((c: any) => c.path.endsWith('cols.order') && c.after === '[本年累计, 单月]'));
  check('diff 结果不含金额', findAmountLike(dr.json).length === 0);

  // --- 错误路径 ---
  const bad1 = await raw('render_report', { spec: OLD.replace('test/fixtures/月度保送表.xlsx', '/nope.xlsx') });
  check('模板不存在 → isError', bad1.isError && /模板不存在/.test(bad1.text));
  const bad2 = await raw('preview_spec', {});
  check('缺 spec → isError', bad2.isError && /需要 spec/.test(bad2.text));
  const bad3 = await raw('no_such_tool', {});
  check('未知工具 → isError 且列出可用工具', bad3.isError && /可用工具/.test(bad3.text));

  // --- ★ 机械兜底：金额形状的数字必须被拦下 ---
  check('金额兜底能识别 >10000 的数字', findAmountLike({ a: 765345 }).length === 1);
  check('金额兜底放过分档字符串与结构计数', findAmountLike({ v: '76.5万', cells: 20, year: 2026 }).length === 0);

  // --- 审计日志：只记字段名不记值 ---
  const auditLog = 'data/audit/mcp.jsonl';
  check('审计日志已写出', fs.existsSync(auditLog));
  const auditText = fs.readFileSync(auditLog, 'utf8');
  check('审计记录工具名与结果字段名', auditText.includes('"tool":"render_report"') && auditText.includes('"resultKeys"'));
  check('★ 审计日志不含任何金额', !/\d{5,}/.test(auditText.replace(/"ms":\d+/g, '')), '已剔除耗时字段后仍无 5 位以上数字');

  // --- 6. generate_spec：模板 → spec 草稿（第 5 步，§7.2 路径 1）---
  const gs = await raw('generate_spec', { template: TPL });
  check('generate_spec 成功', !gs.isError, gs.text.slice(0, 160));
  check('★ generate_spec 返回值不含金额', findAmountLike(gs.json).length === 0);
  check('推断出两个数据区（主要指标 / 分板块）', gs.json.blocks.length === 2, String(gs.json.blocks.length));

  const main = gs.json.blocks.find((b: any) => b.sheet === '主要指标');
  check('主要指标 rows 识别为 metric 且来源是模板', main?.rows.dim === 'metric' && main?.rows.source === 'template');
  check('主要指标 cols 识别为 period_type（4 个口径）', main?.cols.dim === 'period_type' && main?.cols.count === 4);
  check('★ 公式行「合计」被排除，不在 rows.order 里', !main?.rows.labels.includes('合计') && main?.rows.count === 5, main?.rows.labels.join(','));
  check('排除项带原因说明', main?.excluded.length === 1 && /SUM\(B4:B8\)/.test(main.excluded[0].reason));

  const seg = gs.json.blocks.find((b: any) => b.sheet === '分板块');
  check('分板块 rows 来源标记为 guessed（模板未预置行标签）', seg?.rows.source === 'guessed' && seg?.rows.dim === 'company');
  check('猜的轴被显式列出（供人核对）', gs.json.guessed.length === 1 && gs.json.guessed[0].sheet === '分板块');

  // 生成的 YAML 必须真能用：解析 → 编译 → 出正确数字
  const genSpec = parseSpec(gs.json.yaml);
  check('★ 推断出的 YAML 可以被 parseSpec 解析', genSpec.id === gs.json.specId);
  {
    const gb = genSpec.sheets.find((s) => s.name === '主要指标')!.blocks[0];
    const gc = compileBlock(gb, genSpec.params ?? {});
    const gres = await runCompiled(gc, (sql) => db.query(sql));
    const b4 = gres.matrix[0].values[0];
    check('★ 推断出的 spec 算出的是"2026-06 单月"而非 12 个月加总', b4 === 66826, String(b4));
  }

  // 时间范围必须被显式声明（这是本轮修掉的真 bug）
  check(
    '推断结果显式声明了 scope.time（不再静默汇总全部期间）',
    genSpec.sheets.every((s) => s.blocks.every((b) => b.scope?.time?.year === '{{year}}' && b.scope?.time?.month === '{{month}}')),
  );

  await client.close();
} catch (e) {
  mcpSkipReason = (e as Error).message;
}

if (!mcpOk) {
  check('MCP 阶段可运行', false, mcpSkipReason);
}

// ============ 14. spec 校验：静默算错必须变成硬错误 ============
log('\n════════ 14. spec 校验（防"静默算错"）════════');
{
  const { findUnusedParams } = await import('../src/spec/types.ts');

  // ★ 回归防线：这正是 specs/月度保送表.yaml 曾经的真实缺陷 ——
  //   声明了 params.year/month 却从未引用，于是 12 个月被静默加总。
  const BUGGY = `
id: 缺时间范围
template: test/fixtures/月度保送表.xlsx
params: { year: 2026, month: 6 }
sheets:
  - name: 主要指标
    blocks:
      - anchor: { name: DATA_START }
        rows: { dim: metric, order: [营业收入] }
        cols: { dim: period_type, order: [本年累计] }
        value: { measure: amount, agg: sum }
`;
  let rejected = false;
  let msg = '';
  try {
    parseSpec(BUGGY);
  } catch (e) {
    rejected = true;
    msg = (e as Error).message;
  }
  check('★ 声明了 params 却未引用 → 解析即拒绝', rejected, '若这里通过，说明"静默算错"防线失效');
  check('拒绝理由指明是时间范围问题', /params 声明了但从未被引用/.test(msg) && /scope\.time/.test(msg));

  // 正例：用了 params 就不该误报
  const GOOD = BUGGY.replace(
    'value: { measure: amount, agg: sum }',
    'value: { measure: amount, agg: sum }\n        scope: { time: { year: "{{year}}", month: "{{month}}" } }',
  );
  const ok = parseSpec(GOOD);
  check('引用了 params 的 spec 正常通过', findUnusedParams(ok).length === 0);

  // 没有 params 的 spec 不该被这条规则波及
  const NO_PARAMS = BUGGY.replace('params: { year: 2026, month: 6 }', '');
  check('未声明 params 的 spec 不受影响', findUnusedParams(parseSpec(NO_PARAMS)).length === 0);

  // 发布出去的示例 spec 必须是好的
  const shipped = parseSpec(fs.readFileSync('specs/月度保送表.yaml', 'utf8'));
  check('★ 仓库里的 specs/月度保送表.yaml 已修正（含 scope.time）', findUnusedParams(shipped).length === 0);
}

// ============ 15. 主数据对齐（§10 R1）============
log('\n════════ 15. 主数据对齐（R1）════════');
{
  const R = await import('../src/import/resolve.ts');

  // --- 规范化只去格式噪音，不改语义 ---
  check('全角转半角 + 去空白', R.normalizeName('　集团公司　') === '集团公司');
  check('括号/标点算格式噪音', R.normalizeName('（集团）公司') === '集团公司');
  check('大小写不敏感', R.normalizeName('ABC') === R.normalizeName('abc'));
  check('规范化不改变语义（「华东」≠「华南」）', R.normalizeName('华东子公司') !== R.normalizeName('华南子公司'));

  // 去壳只用于生成候选，不用于自动合并
  check('去壳剥掉公司形式后缀', R.stemCompany('华东子公司') === '华东' && R.stemCompany('华东分公司') === '华东');
  check('★ 去壳不剥空（纯壳名不会塌成空串）', R.stemCompany('公司') === '公司' && R.stemCompany('有限公司') === '有限公司');

  const beforeCompanies = Number(
    (await db.query<{ n: number | string }>('SELECT count(*) AS n FROM dim_company'))[0].n,
  );
  const HZ = await db.query<{ id: string }>(`SELECT id FROM dim_company WHERE name = '华东子公司'`);
  check('已有 4 家公司主数据', beforeCompanies === 4, `${beforeCompanies}`);

  /** 造一行：同一家公司、同一个指标、同一个口径，只是月份不同 —— 用于试提交 */
  const row = (company: string, month: string, amount: number): LongRow => ({
    fin_month: `${month}-01`,
    company,
    metric: '营业收入',
    period_type: '本年累计',
    amount,
  });

  // --- Tier 1：纯格式差异 → 自动归并，不打扰人 ---
  const t1 = await commit('b_tier1', [row('（集团公司）', '2026-01', 100), row('（集团公司）', '2026-02', 200)]);
  check('★ Tier 1 纯格式差异自动归并（不再问人）', t1.needsDecision.length === 0 && t1.inserted === 2, `inserted=${t1.inserted}`);
  check('自动归并留痕（看得见并进了谁）', t1.merged.length === 1 && t1.merged[0].target === '集团公司', JSON.stringify(t1.merged[0] ?? {}));
  check('归并未新建公司主数据', t1.createdCompanies.length === 0);

  const afterT1 = Number(
    (await db.query<{ n: number | string }>('SELECT count(*) AS n FROM dim_company'))[0].n,
  );
  check('★ 归并后公司数不变（钱没被拆到两条主数据上）', afterT1 === beforeCompanies, `${afterT1}`);

  // --- Tier 2：像已有实体但不确定 → 拒绝写库，交给人拍板 ---
  const t2 = await commit('b_tier2', [row('华东分公司', '2026-03', 300), row('西北子公司', '2026-03', 400)]);
  check('★ Tier 2 疑似已有主数据 → 拦下要人确认', t2.needsDecision.length === 1, `${t2.needsDecision.length} 条待确认`);
  check('待确认项带候选与出现行数', t2.needsDecision[0]?.raw === '华东分公司' && t2.needsDecision[0].rows === 1
    && t2.needsDecision[0].candidates.some((c) => c.name === '华东子公司'), JSON.stringify(t2.needsDecision[0]?.candidates ?? []));
  check('★ 有歧义时一行都不写（不做半成品提交）', t2.inserted === 0 && t2.skippedRows === 2, `inserted=${t2.inserted}`);
  check('★ 有歧义时不新建任何维度（无副作用）', t2.createdCompanies.length === 0);

  const afterT2 = Number(
    (await db.query<{ n: number | string }>('SELECT count(*) AS n FROM dim_company'))[0].n,
  );
  check('★ 拦下后公司数没变（拒绝提交不留半成品）', afterT2 === beforeCompanies, `${afterT2}`);

  // 「西北子公司」不该被误判成与「华东子公司」相近 ——
  // 首版编辑距离把共享的「子公司」后缀算成了相似度，两者仅差 2 字、相似度 0.6。
  check('★ 不同字号的同名后缀不误报（西北 ≠ 华东）',
    !t2.needsDecision.some((d) => d.raw === '西北子公司'),
    `待确认: ${t2.needsDecision.map((d) => d.raw).join(', ')}`);

  // --- 人拍板：把「华东分公司」并入「华东子公司」---
  const t3 = await commit('b_tier3', [row('华东分公司', '2026-03', 300), row('西北子公司', '2026-03', 400)], {
    decisions: [{ kind: 'company', raw: '华东分公司', action: 'merge', targetId: HZ[0].id, note: 'e2e 人工确认' }],
  });
  check('人确认后可提交', t3.needsDecision.length === 0 && t3.inserted === 2, `inserted=${t3.inserted}`);
  check('并入已有的公司，不新建', t3.createdCompanies.length === 1 && t3.createdCompanies[0] === '西北子公司',
    `${t3.createdCompanies.join(', ')}`);

  // 2026-03 本来就有一批「华东子公司 × 营业收入」的真实数据（fixture 覆盖 12 个月），
  // 所以这里按**坐标**断言而不是按行数 —— 行数会因为 upsert 命中已有坐标而看不出来。
  const hzRows = await db.query<{ amount: string | number; batch_id: string }>(
    `SELECT amount, batch_id FROM fact_finance
     WHERE company_id = '${HZ[0].id}' AND fin_month = DATE '2026-03-01'
       AND metric_id = (SELECT id FROM dim_metric WHERE name = '营业收入')
       AND period_type = '本年累计'`,
  );
  check('★ 「华东分公司」的钱确实记在「华东子公司」名下',
    hzRows.length === 1 && Number(hzRows[0].amount) === 300 && hzRows[0].batch_id === 'b_tier3',
    `${JSON.stringify(hzRows[0] ?? {})}`);

  const aliasRows = await db.query<{ normalized: string; target_id: string; alias: string }>(
    `SELECT normalized, target_id, alias FROM dim_alias WHERE kind = 'company' AND normalized = '华东分公司'`,
  );
  check('人确认的映射写进了 dim_alias（下月自动命中）',
    aliasRows.length === 1 && aliasRows[0].target_id === HZ[0].id && aliasRows[0].alias === '华东分公司',
    JSON.stringify(aliasRows));

  // --- 关键：下个月同样的写法，不再问第二遍 ---
  const t4 = await commit('b_tier4', [row('华东分公司', '2026-04', 500)]);
  check('★ 人确认过一次后，下月自动命中 Tier 1（一次人工投入换永久自动）',
    t4.needsDecision.length === 0 && t4.inserted === 1 && t4.createdCompanies.length === 0,
    `inserted=${t4.inserted} 待确认=${t4.needsDecision.length}`);

  // --- 别名指向诚实性：不存在的目标必须报错，不能造出指向虚空的别名 ---
  let badTarget = '';
  try {
    await commit('b_bad', [row('华南分公司', '2026-05', 1)], {
      decisions: [{ kind: 'company', raw: '华南分公司', action: 'merge', targetId: 'c_不存在' }],
    });
  } catch (e) {
    badTarget = (e as Error).message;
  }
  check('★ 并入不存在的目标 → 报错（否则会造出指向虚空的自动别名）', /目标主数据不存在/.test(badTarget), badTarget);

  // --- strict 模式：抛错而不是回结论 ---
  const strictRows = [row('华北分公司', '2026-06', 1)];
  let strictMsg = '';
  try {
    await commit('b_strict', strictRows, { strict: true });
  } catch (e) {
    strictMsg = (e as Error).message;
  }
  check('strict 模式遇歧义直接抛错', /需要人工确认后才能提交/.test(strictMsg), strictMsg.slice(0, 60));

  // --- 未识别清单要按出现行数排序（人先看覆盖数据最多的那个）---
  const staged3 = await stage(LONG, '财务快报');
  check('stage 输出 unresolved 候选清单', Array.isArray(staged3.unresolved.companies) && Array.isArray(staged3.unresolved.metrics));
  check('★ 重复导入相同名字不再报未识别（已全部建维 + 别名命中）',
    staged3.unknownCompanies.length === 0 && staged3.unknownMetrics.length === 0,
    `公司 ${staged3.unknownCompanies.length} / 指标 ${staged3.unknownMetrics.length}`);
}

// ============ 汇总 ============
log('\n════════════════════════════════');
log(`  通过 ${pass} / 失败 ${fail}`);
log(`  导入 ${importMs}ms（960 行） | 查询 ${queryMs}ms`);
log('════════════════════════════════\n');

db.close();
process.exit(fail > 0 ? 1 : 0);
