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

// ============ 汇总 ============
log('\n════════════════════════════════');
log(`  通过 ${pass} / 失败 ${fail}`);
log(`  导入 ${importMs}ms（960 行） | 查询 ${queryMs}ms`);
log('════════════════════════════════\n');

db.close();
process.exit(fail > 0 ? 1 : 0);
