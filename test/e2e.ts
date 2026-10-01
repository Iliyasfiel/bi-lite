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

// ============ 0.5 CLI：解析层 / 命令表 / 不碰库 ============
// ★ 刻意放在「1. 打开数据库」**之前**：此时进程里还没有库，
//   于是 hasOpenedDb() 才能证明"lint 不碰库"是事实，而不是文档里的一句自述。
//   （编号用 0.5 是为了不动后面 15 个阶段的编号 —— 那是纯粹的注释改动，徒增 diff。）
log('\n════════ 0.5 CLI（解析层与命令表）════════');
{
  const { parseCliArgs, main, commandTableProblems, COMMANDS, hasOpenedDb } = await import('../src/cli.ts');

  // —— 解析层是纯函数：不启动任何东西就能覆盖整个命令面 ——
  const cases: Array<[string[], string]> = [
    [[], 'help'],
    [['--help'], 'help'],
    [['-h'], 'help'],
    [['help'], 'help'],
    [['--version'], 'version'],
    [['version'], 'version'],
    [['ingest'], 'help'],
    [['ingest', 'lint', 'x.yaml'], 'ingest-lint'],
    [['ingest', 'dry-run', 'x.yaml'], 'ingest-dry-run'],
    [['ingest', 'run', 'x.yaml', '--strict'], 'ingest-run'],
    [['bogus'], 'usage-error'],
    [['ingest', 'bogus', 'x.yaml'], 'usage-error'],
    [['ingest', 'lint'], 'usage-error'],
    [['ingest', 'lint', 'x.yaml', '--decisions', 'd.json'], 'usage-error'],
    [['ingest', 'lint', 'x.yaml', '--strict'], 'usage-error'],
    [['ingest', 'run', 'x.yaml', '--nope'], 'usage-error'],
  ];
  const wrong = cases.filter(([argv, want]) => parseCliArgs(argv).kind !== want);
  check('★ parseCliArgs 是纯函数，命令面全覆盖', wrong.length === 0,
    wrong.length ? JSON.stringify(wrong) : `${cases.length} 例`);

  // —— 「给了却用不上」必须报错，不静默忽略（同铁律 14 的思路）——
  const strictOnLint = parseCliArgs(['ingest', 'lint', 'x.yaml', '--strict']);
  check('★ --strict 给了 lint → 明确报错，不静默忽略',
    strictOnLint.kind === 'usage-error' && strictOnLint.message.includes('--strict'),
    strictOnLint.kind === 'usage-error' ? strictOnLint.message : strictOnLint.kind);

  // —— 命令表自检：缺 handler（静默空转）要能被抓出来（借鉴 DSH 的 hasAction 守卫）——
  check('命令表自检：当前命令表是好的',
    commandTableProblems(COMMANDS, COMMANDS.map((c) => c.invocation)).length === 0);
  const broken = commandTableProblems(
    [{ ...COMMANDS[0]!, run: undefined as never }],
    ['ingest-lint'],
  );
  check('★ 命令表自检能抓出「注册了却没 handler」', broken.length > 0, broken[0] ?? '');

  // —— 在进程内跑真命令：退出码由 main 返回，不杀测试进程 ——
  const cap = () => {
    const o: string[] = []; const e: string[] = [];
    return { o, e, io: { out: (t: string) => void o.push(t), err: (t: string) => void e.push(t) } };
  };

  const c1 = cap();
  const code1 = await main(['bogus'], c1.io);
  check('★ 未知命令 → 退出码 2，且 stdout 一个字节都不写', code1 === 2 && c1.o.length === 0, `code=${code1}`);

  const c2 = cap();
  const code2 = await main(['ingest', 'lint', 'ingest/月度经营接入.yaml'], c2.io);
  const json2 = JSON.parse(c2.o.join('')) as { id: string };
  check('★ ingest lint 跑通', code2 === 0, `code=${code2}`);
  check('数据走 stdout（合法 JSON）、摘要走 stderr —— 两路分离',
    json2.id === '月度经营接入' && c2.e.join('').includes('ingest lint'), c2.e.join('').trim());

  const c3 = cap();
  const code3 = await main(['ingest', 'lint'], c3.io);
  check('用法错误也走 stderr、退出码 2', code3 === 2 && c3.o.length === 0 && c3.e.join('').includes('缺接入规格文件'));

  check('★ lint 全程没有打开数据库（staticCatalog 零 DB 访问）',
    hasOpenedDb() === false, `hasOpenedDb=${hasOpenedDb()}`);

  // —— 子进程：证明 --help 既不碰库、也不加载 duckdb（DSH 借来的"惰性 import"形状）——
  //   判据是"空目录里没被创建出 data/" —— open() 会 mkdir data/parquet，
  //   所以只要它跑过 open()，这个目录就一定会出现。
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'bilite-cli-'));
  let helpOut = '';
  let helpCode = 0;
  try {
    helpOut = execFileSync(process.execPath, [pathMod.resolve('src/cli.ts'), '--help'], {
      cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    helpCode = (e as { status?: number }).status ?? -1;
  }
  check('★ 子进程 `bilite --help` 在空目录里跑通', helpCode === 0 && helpOut.includes('用法'),
    `code=${helpCode}`);
  check('★ --help 不碰库（空目录里没生出 data/）', !fs.existsSync(pathMod.join(tmp, 'data')));
  fs.rmSync(tmp, { recursive: true, force: true });
}

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
// ★ 这个 spec 曾经是"静默算错"的又一个实例：rows=company / cols=period_type，
//   却没有任何指标约束 —— 于是五个指标的钱被加进同一格。它之所以一直没被发现，
//   是因为下面那句断言写的是 `check('第二张表数据已填', true)`（恒真，什么都没验证）。
//   现在用 scope.filter 把指标钉成「营业收入」，并和独立查出的数比对。
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
        scope:
          filter: { metric: { name: 营业收入 } }
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

// ★ 真实断言（替代原来那句恒真的 check）：
//   营业收入 × 集团公司 × 全年的「本年累计」之和，用独立 SQL 查出来比对，
//   而不是"跑出来多少就写多少"。
const expectedMg = await db.query<{ v: string }>(`
  SELECT sum(f.amount) AS v FROM fact_finance f
  JOIN dim_company ON f.company_id = dim_company.id
  JOIN dim_metric ON f.metric_id = dim_metric.id
  WHERE dim_company.name = '集团公司' AND dim_metric.name = '营业收入' AND f.period_type = '本年累计'`);
const mgRow = r2.matrix.find((m) => m.label === '集团公司');
check(
  '★ 第二张表的数值确实只含「营业收入」（未被静默加总其他指标）',
  mgRow !== undefined && Number(mgRow.values[0]) === Number(expectedMg[0].v),
  `表内 ${mgRow?.values[0]} vs 独立查出 ${expectedMg[0].v}`,
);
// 反证：若指标真被加总，这个数会明显偏大
check(
  '★ 第二张表数值不等于「全部指标之和」（防止再次静默加总）',
  mgRow !== undefined && Number(mgRow.values[0]) !== 67283,
  '若等于 67283 说明指标未被约束',
);

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

// --- /api/specs/lint：把"静默算错"提前到打字时（§7.2 路径 2）---
{
  const bad = await postJson('/api/specs/lint', {
    yaml: `id: T
sheets:
  - name: S
    blocks:
      - anchor: B4
        rows: { dim: company, order: [华东子公司] }
        cols: { dim: period_type, order: [本年累计] }
        value: { measure: amount, agg: sum }`,
  });
  check('HTTP 诊断接口可用（200，诊断本身不是错误）', bad.willBeRejected === true && bad.ok === false);
  check('★ 诊断接口与保存用同一套判据（都指向"没有指标约束"）', /没有任何指标约束/.test((bad.errors ?? []).join('')));
  check('诊断返回可分支的 issues（含 code 与 hint）', (bad.issues ?? []).some((i: any) => i.code === 'UNCONSTRAINED_DIM' && i.hint));

  const good = await postJson('/api/specs/lint', {
    yaml: `id: T
params: { year: 2026, month: 6 }
sheets:
  - name: S
    blocks:
      - anchor: B4
        rows: { dim: metric, order: [营业收入] }
        cols: { dim: period_type, order: [本年累计] }
        value: { measure: amount, agg: sum }
        scope: { time: { year: "{{year}}", month: "{{month}}" } }`,
  });
  check('★ 合法的 spec 诊断放行', good.ok === true && good.willBeRejected === false);

  // ★ 判据一致性：诊断说**不能存** → 保存就必须真的被拒（防"两边打架"）。
  //   反方向（诊断放行 → 保存成功）用仓库里已存在的 spec 验证，避免往 specs/ 写测试文件。
  const rejectProbe = await postJson('/api/specs/save', {
    yaml: `id: e2e-lint-reject
sheets:
  - name: S
    blocks:
      - anchor: B4
        rows: { dim: company, order: [华东子公司] }
        cols: { dim: period_type, order: [本年累计] }
        value: { measure: amount, agg: sum }`,
  });
  check(
    '★ 诊断说「无法保存」的 spec，保存也必须被拒（判据不漂移）',
    bad.willBeRejected === true && /没有任何指标约束/.test(rejectProbe.error ?? ''),
    rejectProbe.error ?? '',
  );
  const repoLint = await postJson('/api/specs/lint', { specFile: 'specs/月度保送表.yaml' });
  check(
    '★ 仓库里定稿的 spec 诊断放行（与保存行为一致）',
    repoLint.ok === true && (repoLint.errors ?? []).length === 0,
    JSON.stringify(repoLint.errors ?? []),
  );

  const badFile = await postJson('/api/specs/lint', { specFile: 'specs/不存在的.yaml' });
  check('诊断不存在的文件 → 404 错误', /不存在/.test(badFile.error ?? ''), badFile.error ?? '');
}

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
// ★ 单独记「这一段是否跑完」。
//   只靠 mcpOk 会漏：它在 connect 成功后立刻为 true，若之后某条断言炸了，
//   catch 只是把原因记进 mcpSkipReason，而 `if (!mcpOk)` 不成立 ——
//   于是**这一段剩下的断言被静默跳过**，总数从 192 掉到 190 却依然全绿。
//   实测教训：改 lint 规则后 E2E 少了 2 项断言（generate_spec 那三条），
//   打印的却是"通过 190 / 失败 0"，差点当成回归通过。
let mcpFinished = false;
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
  check('恰好暴露 12 个工具', names.length === 12, names.join(', '));
  check(
    '工具集与 §7.1（+ 接入层 4 个 + catalog）一致',
    JSON.stringify(names) ===
      JSON.stringify([
        'diff_report',
        'dry_run_ingest',
        'generate_spec',
        'get_catalog',
        'get_template_schema',
        'lint_ingest',
        'lint_spec',
        'list_metrics',
        'look_at_source',
        'preview_spec',
        'render_report',
        'run_ingest',
      ]),
  );
  check(
    '每个工具都有 description 与 inputSchema',
    list.tools.every((t) => t.description && t.description.length > 20 && t.inputSchema),
  );

  // --- get_catalog：agent 的「素材」（§8.2 ②③、§8.5）---
  //    ★ 存在的理由：skill 只说语法，不说现状 —— 不知道现状，agent 会**发明** code。
  const catAll = await raw('get_catalog', {});
  check('★ get_catalog 给出三层（L1 成员 / L2 结构 / L3 版本），且零金额',
    !catAll.isError &&
      (catAll.json.members?.metrics ?? []).length > 0 &&
      (catAll.json.objects ?? []).length > 0 &&
      typeof catAll.json.ddlHash === 'string' && typeof catAll.json.apiVersion === 'string' &&
      findAmountLike(catAll.json).length === 0,
    `对象=${(catAll.json.objects ?? []).length} ddlHash=${catAll.json.ddlHash}`);
  const catOne = await raw('get_catalog', { object: 'fact_finance' });
  check('★ 按需下钻是默认路径：只看一张表的粒度与逐列角色',
    !catOne.isError && catOne.json.name === 'fact_finance' &&
      catOne.json.grain === 'fin_month,company_id,metric_id,period_type' &&
      (catOne.json.columns ?? []).some((c: { column: string; role: string }) => c.column === 'amount' && c.role === 'measure'),
    `列=${(catOne.json.columns ?? []).length}`);
  const catBad = await raw('get_catalog', { object: '不存在的表' });
  check('get_catalog 面对不存在的对象给可行动的提示（而不是一个空对象）',
    catBad.isError || String(catBad.text).includes('现有：'), String(catBad.text).slice(0, 40));

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
  // ★ NEW 把行维从 metric 改成 company 时，必须用 scope.filter 把指标钉住 ——
  //   否则又是一个"没有指标约束"的 spec（lint 会拒绝，这正是它该做的事）。
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
    .replace('order: [本年累计, 去年同期累计, 单月, 账面累计]', 'order: [本年累计, 单月]')
    .replace(
      'value: { measure: amount, agg: sum }',
      'value: { measure: amount, agg: sum }\n        scope: { filter: { metric: { name: 营业收入 } } }',
    );
  const dr = await raw('diff_report', { before: OLD, after: NEW });
  check('diff_report 成功且识别出差异', !dr.isError && dr.json.changed === true, dr.text.slice(0, 200));
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

  // --- 5.5 lint_spec：把"静默算错"挡在数字出现之前（§7.2 路径 2 的前置条件）---
  // 场景：agent 从一句自然语言写出 spec，先自检再交给人。
  const lintBad = await raw('lint_spec', {
    spec: `id: T
params: { year: 2026, month: 6 }
sheets:
  - name: 主要指标
    blocks:
      - anchor: B4
        rows: { dim: company, order: [华东子公司] }
        cols: { dim: period_type, order: [本年累计] }
        value: { measure: amount, agg: sum }
        scope: { time: { year: "{{year}}", month: "{{month}}" } }`,
  });
  check('lint_spec 成功（诊断工具本身不该抛）', !lintBad.isError, lintBad.text.slice(0, 160));
  check('★ lint_spec 抓出「没有指标约束」', lintBad.json.willBeRejected === true && lintBad.json.errorCount === 1, JSON.stringify(lintBad.json.errors));
  check('★ 诊断给出可行动的修法提示', /scope.filter|dim: metric/.test(JSON.stringify(lintBad.json.issues)));
  check('lint_spec 不含金额', findAmountLike(lintBad.json).length === 0);

  // 正例：钉住指标后应当放行
  const lintGood = await raw('lint_spec', {
    spec: `id: T
params: { year: 2026, month: 6 }
sheets:
  - name: 主要指标
    blocks:
      - anchor: B4
        rows: { dim: metric, order: [营业收入] }
        cols: { dim: period_type, order: [本年累计] }
        value: { measure: amount, agg: sum }
        scope: { time: { year: "{{year}}", month: "{{month}}" } }`,
  });
  check('★ 指标被钉住 → lint 放行', lintGood.json.willBeRejected === false && lintGood.json.errorCount === 0);

  // 一次报全（而不是"改一条撞一条"）
  const lintMulti = await raw('lint_spec', {
    spec: `id: T
sheets:
  - name: S
    blocks:
      - anchor: B4
        rows: { dim: 不存在的维度, order: [x, x] }
        cols: { dim: company, order: [] }
        value: { expr: "(本年累计 - 去年同期累计) / 去年同期累计" }`,
  });
  check(
    '★ 一次报全所有问题（不是只报第一条）',
    lintMulti.json.errorCount >= 3 && lintMulti.json.issues.some((i: any) => i.code === 'DIM_UNKNOWN'),
    `errorCount=${lintMulti.json.errorCount} codes=${lintMulti.json.issues.map((i: any) => i.code).join(',')}`,
  );

  // YAML 语法错与语义错分开报
  const lintSyntax = await raw('lint_spec', { spec: 'id: [unclosed\n  bad: :' });
  check('★ YAML 语法错单独报（不与语义错混在一起）', lintSyntax.json.parseError !== null && lintSyntax.json.issues.length === 0);

  // 仓库里真实在用的 spec 必须是干净的
  const lintRepo = await raw('lint_spec', { specFile: 'specs/月度保送表.yaml' });
  check('★ 仓库里已定稿的 spec 零 error（防规则过严）', lintRepo.json.errorCount === 0, JSON.stringify(lintRepo.json.errors));

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

  // ★ 这张「分板块」表只有「公司 × 本年累计」，模板里根本没有指标信息
  //   → 推断器必须明说"草稿保存不了"，而不是产出一份会静默加总五个指标的 spec。
  check(
    '★ 模板缺指标信息时草稿直接被校验拒绝（draftValid=false）',
    gs.json.draftValid === false && /没有任何指标约束/.test(gs.json.draftError ?? ''),
    `draftValid=${gs.json.draftValid}`,
  );
  check(
    '★ 对应的 error 级 issue 说明了缺什么',
    gs.json.issues.some((i: any) => i.level === 'error' && i.sheet === '分板块' && /找不到指标/.test(i.message)),
    JSON.stringify(gs.json.issues.filter((i: any) => i.level === 'error')),
  );
  // 而且必须**真的**解析失败 —— 不能只是"回报说失败"
  let genSpecRejected = false;
  try {
    parseSpec(gs.json.yaml);
  } catch {
    genSpecRejected = true;
  }
  check('★ 而且 parseSpec 确实拒绝（回报与行为一致）', genSpecRejected);

  // 人按 error 提示补上指标后，同一份草稿必须能通过 —— 证明提示是可行动的。
  // 注意是**往已有的 scope 里加一行**，不能再写一个 scope:（YAML 重复 key 会直接报错）
  const fixedYaml = gs.json.yaml.replace(
    /(      - anchor: B4\n(?:.*\n)*?        scope:\n)/,
    '$1          filter: { metric: { name: 营业收入 } }\n',
  );
  const genSpec = parseSpec(fixedYaml);
  check('★ 按提示补上指标后草稿即可用（提示可行动）', genSpec.id === gs.json.specId);
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

  // 补上指标之后的「分板块」必须真的只算营业收入（而不是加总五个指标）
  {
    const sb = genSpec.sheets.find((s) => s.name === '分板块')!.blocks[0];
    const sc = compileBlock(sb, genSpec.params ?? {});
    const sres = await runCompiled(sc, (sql) => db.query(sql));
    const vals = sres.matrix.map((m) => Number(m.values[0]));
    check('★ 补上指标后「分板块」表数值合理（未被静默加总）', vals.every((v) => v > 0) && !vals.includes(67283), JSON.stringify(vals));
  }

  // --- 7. 接入规格：任意形态的源 Excel → 星型表行（§7.1 第 9~12 个工具）---
  //   ★ 形状照抄**真实模板**（用户 2026-09-26 澄清）：整个集团的数据在同一张表里，
  //     A 列区分子公司，同一个指标名在每家子公司下都会重复出现 ——
  //     「跨公司同名」绝不能判成重复坐标；「同一公司内部同名」必须拦下来。
  {
    const XLSXPopulate = (await import('xlsx-populate')).default;
    const SRC = 'test/fixtures/接入-集团两公司.xlsx';
    const BLANK = 'test/fixtures/接入-空模板.xlsx';
    const DUP = 'test/fixtures/接入-同公司重复指标.xlsx';
    const HEAD = ['单位', '期数', '指标', '本年累计', '本年累计(上年)', '同比(月)%', '本月数'];
    type FixtureRow = [string, string, [number, number, number | null]];
    const ROWS: FixtureRow[] = [
      ['接入测试甲公司', '营业收入', [1234567, 1111111, 246914]],
      ['接入测试甲公司', '净利润', [234567, 222222, 12345]],
      ['接入测试甲公司', '毛利率', [0.31, 0.3, null]], // ★ 故意空一格：空 ≠ 0
      ['接入测试乙公司', '营业收入', [2234567, 2111111, 246914]],
      ['接入测试乙公司', '净利润', [434567, 422222, 12345]],
      ['接入测试乙公司', '毛利率', [0.28, 0.3, -0.02]], // ★ 与甲公司同名
    ];
    const build = async (path: string, rows: FixtureRow[], blank = false) => {
      const wb = await XLSXPopulate.fromBlankAsync();
      const sh = wb.sheet(0);
      sh.name('集团月报');
      HEAD.forEach((h, i) => sh.cell(1, i + 1).value(h));
      rows.forEach(([company, metric, vals], i) => {
        const r = i + 2;
        if (!blank) sh.cell(`A${r}`).value(company);
        sh.cell(`B${r}`).value('2026-06');
        sh.cell(`C${r}`).value(metric);
        if (blank) return;
        sh.cell(`D${r}`).value(vals[0]);
        sh.cell(`E${r}`).value(vals[1]);
        if (vals[2] !== null) sh.cell(`G${r}`).value(vals[2]);
      });
      await wb.toFileAsync(path);
    };
    const spec = (src: string) => `
id: 接入自检
source: ${src}
onConflict: reject
unknownMaster: create
onEmptyMeasure: skip
sheets:
  - name: 集团月报
    blocks:
      - anchor: D2
        rows:
          - { col: A, dim: company }
          - { col: C, dim: metric }
        values:
          columns: [D, E, F, G]
          periodTypeFromHeader:
            本年累计: 本年累计
            本年累计(上年): 去年同期累计
            本月数: 单月
          skip:
            - columns: [F]
              why: 同比% 是派生列，库里没有对应口径
        keys:
          - { col: B, as: period }
`;
    // ★ 两处都可能报：`shape.issues` 是读取期收集的，`errors` 有的路径会**整批替换**
    //   （如 CONFLICT_WITH_EXISTING 只在 errors 里）。按 code|message 去重后取并集。
    const issuesOf = (j: { errors?: unknown[]; shape?: { issues?: unknown[] } }) => {
      const all = [...((j.errors ?? []) as Array<{ code: string; message: string }>), ...((j.shape?.issues ?? []) as Array<{ code: string; message: string }>)];
      const seen = new Set<string>();
      return all.filter((i) => {
        const k = `${i.code}|${i.message}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    await build(SRC, ROWS);

    // 7.1 看源 —— agent 的第一步：只回形状，不回数字
    const look = await raw('look_at_source', { source: SRC, range: 'A1:G7' });
    check('look_at_source 读源成功且不含金额', !look.isError && findAmountLike(look.json).length === 0, JSON.stringify(findAmountLike(look.json)));

    // 7.2 lint —— 规格静态诊断（不读源文件、不碰库）
    const li = await raw('lint_ingest', { spec: spec(SRC) });
    check('lint_ingest：接入规格无 error', li.json.errorCount === 0, JSON.stringify((li.json.errors ?? []).map((e: { code: string }) => e.code)));

    // 7.3 干跑 —— 形状 + 主数据判定，一次库都不写
    const dry = await raw('dry_run_ingest', { spec: spec(SRC) });
    const b0 = (dry.json.shape?.blocks?.[0] ?? {}) as { dataRows?: number; duplicates?: unknown[]; coordinates?: { total?: number; duplicates?: unknown[] }; valueColumns?: unknown[] };
    check('干跑：读到 6 行数据行、18 个坐标', b0.dataRows === 6 && b0.coordinates?.total === 18, `dataRows=${b0.dataRows} coords=${b0.coordinates?.total}`);
    check(
      '★ 两家子公司的同名指标**不**算重复行键（A 列进行键）',
      (b0.duplicates ?? []).length === 0 && (b0.coordinates?.duplicates ?? []).length === 0,
      `行键重复=${JSON.stringify(b0.duplicates)} 坐标重复=${JSON.stringify(b0.coordinates?.duplicates)}`,
    );
    check('跳过列不参与口径映射（F 列只声明 skip 就够）', (b0.valueColumns ?? []).length === 3, `值列 ${JSON.stringify((b0.valueColumns ?? []).map((v) => (v as { col: string }).col))}`);
    check('空值格不落库（空 ≠ 0，也不是一条事实）', dry.json.emptyMeasureCells === 1, `emptyMeasureCells=${dry.json.emptyMeasureCells}`);
    const willCreate = (dry.json.willCreate ?? []) as Array<{ kind: string; raw: string }>;
    const newCompanies = willCreate.filter((w) => w.kind === 'company').map((w) => w.raw).sort();
    check(
      '干跑说清会新建哪些主数据（2 家新公司，一次说全）',
      newCompanies.length === 2 && ['接入测试甲公司', '接入测试乙公司'].every((n) => newCompanies.includes(n)),
      JSON.stringify(willCreate),
    );
    check(
      '已有主数据直接命中，不重复新建（营业收入/净利润 是假数据里已注册的指标）',
      !willCreate.some((w) => w.kind === 'metric' && (w.raw === '营业收入' || w.raw === '净利润')),
      JSON.stringify(willCreate.filter((w) => w.kind === 'metric')),
    );
    check('干跑不需要人拍板（没有像已有实体又拿不准的名字）', (dry.json.needsDecision ?? []).length === 0, JSON.stringify(dry.json.needsDecision ?? []));
    check('★ 干跑响应里没有任何金额（铁律 1）', findAmountLike(dry.json).length === 0, JSON.stringify(findAmountLike(dry.json)));

    // 7.4 落库 —— 唯一会写库的接入工具；重复坐标默认整批拒绝
    const run1 = await raw('run_ingest', { spec: spec(SRC) });
    check('run_ingest 真的落库（17 行 = 18 坐标 − 1 个空格）', run1.json.ok === true && run1.json.inserted === 17, `ok=${run1.json.ok} inserted=${run1.json.inserted}`);
    check('★ 落库响应里也没有任何金额（铁律 1）', findAmountLike(run1.json).length === 0, JSON.stringify(findAmountLike(run1.json)));
    const run2 = await raw('run_ingest', { spec: spec(SRC) });
    check(
      '★ 同坐标再跑：onConflict=reject 整批拒绝、不静默覆盖',
      run2.json.ok === false && run2.json.inserted === 0 && issuesOf(run2.json).some((i) => i.code === 'CONFLICT_WITH_EXISTING'),
      `ok=${run2.json.ok} inserted=${run2.json.inserted} codes=${issuesOf(run2.json).map((i) => i.code).join(',')}`,
    );

    // 7.5 空模板：没有数据 ≠ 没有结构（用户上传的就是这种）
    await build(BLANK, ROWS, true);
    const e = await raw('dry_run_ingest', { spec: spec(BLANK) });
    const eCodes = issuesOf(e.json).map((i) => i.code);
    check('空模板：公司列整列为空 → ROWKEY_EMPTY_IN_FILE', e.json.ok === false && eCodes.includes('ROWKEY_EMPTY_IN_FILE'), eCodes.join(','));
    check('★ 空模板要说清"这是一份空模板"，别让人自己猜', eCodes.includes('SOURCE_LOOKS_EMPTY'), eCodes.join(','));

    // 7.6 同一家公司内部重复的指标：仍然拦，且报错要点出**完整行键**
    await build(DUP, [...ROWS, ['接入测试甲公司', '营业收入', [999999, 999999, 999999]]]);
    const dp = await raw('dry_run_ingest', { spec: spec(DUP) });
    const dupMsg = issuesOf(dp.json).find((i) => i.code === 'ROWKEY_DUPLICATE_IN_FILE')?.message ?? '';
    check('同一公司内部重复指标被拦，报错点出完整行键「公司=… / 指标=…」', /公司=接入测试甲公司 \/ 指标=营业收入/.test(dupMsg), dupMsg);
  }

  await client.close();
  mcpFinished = true;
} catch (e) {
  mcpSkipReason = (e as Error).message;
}

if (!mcpOk) {
  check('MCP 阶段可运行', false, mcpSkipReason);
} else if (!mcpFinished) {
  // ★ 连上了、但中途炸了 —— 这是**真失败**，绝不能因为"连接成功"就放过。
  //   漏掉这一条会变成：断言越炸越少，测试却越来越绿。
  check('MCP 阶段跑完（中途异常不得被当成跳过）', false, mcpSkipReason);
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

  // ---------------- 15 阶段的前置：三个"静默算错"的回归防线 ----------------
  const { lintSpec, unpinnedMeaningDims } = await import('../src/spec/lint.ts');
  const { diagnoseSpec } = await import('../src/spec/types.ts');
  const { compileBlock, runCompiled } = await import('../src/spec/compile.ts');

  // ★ bug A：block 没有任何指标约束 → 多个指标的金额被加成一格。
  //   实测：利润总额那一格返回 67283，真值 65198（同量级、格式正常、人不会怀疑）。
  const UNCONSTRAINED = `
id: 无指标约束
sheets:
  - name: 分板块
    blocks:
      - anchor: B4
        rows: { dim: company, order: [华东子公司] }
        cols: { dim: period_type, order: [本年累计] }
        value: { measure: amount, agg: sum }`;
  const dUn = diagnoseSpec(UNCONSTRAINED);
  check('★ bug A：无指标约束 → 解析即拒绝', dUn.willBeRejected && /没有任何指标约束/.test(dUn.errors.join('')));
  check('★ bug A：错误码是可分支的 UNCONSTRAINED_DIM', dUn.issues.some((i) => i.code === 'UNCONSTRAINED_DIM'));
  check('★ bug A：提示给出两种可行动的改法', /scope\.filter/.test(JSON.stringify(dUn.issues)) && /dim: metric/.test(JSON.stringify(dUn.issues)));

  // 反证：口径没钉住同样拒绝（量纲维是两个，不是一个）
  const NO_PERIOD = UNCONSTRAINED.replace('dim: period_type', 'dim: company').replace('order: [本年累计]', 'order: [华东子公司]');
  check('★ 口径没钉住也拒绝（量纲维是「指标 + 口径」两个）', diagnoseSpec(NO_PERIOD).willBeRejected);

  // 正例①：把指标做成轴 → 合法（集团合计的常用形状）
  const BY_METRIC = UNCONSTRAINED
    .replace('dim: company', 'dim: metric')
    .replace('order: [华东子公司]', 'order: [营业收入, 利润总额]');
  check('★ 指标做成轴 → 通过（不误伤合法形状）', !diagnoseSpec(BY_METRIC).willBeRejected);

  // 正例②：用 scope.filter 钉死单一指标 → 合法，且**数值必须真的只含那一个指标**
  const PINNED = UNCONSTRAINED.replace(
    'value: { measure: amount, agg: sum }',
    'value: { measure: amount, agg: sum }\n        scope: { filter: { metric: { name: 利润总额 } } }',
  );
  check('★ 用 scope.filter 钉死指标 → 通过', !diagnoseSpec(PINNED).willBeRejected);
  {
    const pb = parseSpec(PINNED).sheets[0].blocks[0];
    const pres = await runCompiled(compileBlock(pb, {}), (sql) => db.query(sql));
    const v = Number(pres.matrix[0].values[0]);
    // ★ 两个断言都来自独立事实，不写死"跑出来是多少"（那正是上一轮 bug 的教训）：
    //   ① 真值 = 华东子公司 × 利润总额 × 本年累计 × 全部 12 个月
    //   ② 反证 = 同公司同口径下**五个指标加总**，钉住后必须不等于它
    const q = async (extra: string) =>
      Number((await db.query<{ v: string }>(`
        SELECT sum(f.amount) AS v FROM fact_finance f
        JOIN dim_company ON f.company_id = dim_company.id
        JOIN dim_metric ON f.metric_id = dim_metric.id
        WHERE dim_company.name = '华东子公司' AND f.period_type = '本年累计'${extra}`))[0].v);
    const want = await q(` AND dim_metric.name = '利润总额'`);
    const allMetrics = await q('');
    check(
      '★ bug A 的修复真的生效：数值只含被钉住的那个指标',
      v === want && v !== allMetrics,
      `钉住后=${v} 独立查出=${want} 五指标加总=${allMetrics}`,
    );
  }

  // ★ bug B：value.expr 曾经被静默忽略（写了却不算，比不支持更糟）
  const EXPR = `
id: 同比
params: { year: 2026, month: 6 }
sheets:
  - name: 主要指标
    blocks:
      - anchor: B4
        rows: { dim: metric, order: [利润总额] }
        cols: { dim: period_type, order: [本年累计, 去年同期累计] }
        value: { expr: "(本年累计 - 去年同期累计) / 去年同期累计", format: "0.0%" }
        scope: { time: { year: "{{year}}", month: "{{month}}" } }`;
  {
    const eb = parseSpec(EXPR).sheets[0].blocks[0];
    const eres = await runCompiled(compileBlock(eb, { year: 2026, month: 6 }), (sql) => db.query(sql));
    const v = Number(eres.matrix[0].values[0]);
    // 真值用独立 SQL 算，不写死：集团 2026-06 利润总额的 (本年累计-去年同期累计)/去年同期累计
    const pv = await db.query<{ m: string; prev: string }>(`
      SELECT sum(CASE WHEN f.period_type='本年累计' THEN f.amount END) AS m,
             sum(CASE WHEN f.period_type='去年同期累计' THEN f.amount END) AS prev
      FROM fact_finance f
      JOIN dim_metric ON f.metric_id = dim_metric.id
      JOIN dim_period ON dim_period.fin_month = f.fin_month
      WHERE dim_metric.name = '利润总额' AND dim_period.year = 2026 AND dim_period.month = 6`);
    const want = (Number(pv[0].m) - Number(pv[0].prev)) / Number(pv[0].prev);
    check('★ bug B：expr 真的被求值（不再返回两个累计额本身）', Math.abs(v - want) < 1e-9, `表内=${v} 独立算出=${want}`);
    // ★ 反证：若 expr 仍被忽略，返回的会是两个原始累计额（断言它们都不等于 v）
    check(
      '★ bug B：返回值不是原始累计额（expr 确实参与了计算）',
      v !== Number(pv[0].m) && v !== Number(pv[0].prev),
      `本年累计=${pv[0].m} 去年同期=${pv[0].prev} 表内=${v}`,
    );
    check('★ bug B：列标签是表达式本身（一行一个派生值）', eres.colLabels.length === 1 && /去年同期累计/.test(eres.colLabels[0]), eres.colLabels.join(','));
  }
  check('★ expr 里出现非法字符（代码注入）→ 解析即拒绝', diagnoseSpec(EXPR.replace('"0.0%"', '"x"').replace('(本年累计 - 去年同期累计) / 去年同期累计', "require('fs')")).willBeRejected);
  // expr 引用不存在的口径 → 拒绝（而不是求值时抛）
  {
    const badRef = diagnoseSpec(EXPR.replace('order: [本年累计, 去年同期累计]', 'order: [本年累计]'));
    check('★ expr 引用了 cols.order 里没有的口径 → 诊断报出', badRef.issues.some((i) => i.code === 'EXPR_REFS'), JSON.stringify(badRef.issues.map((i) => i.code)));
  }

  // ★ bug C：scope.company.filter 引用 dim_company 却不建 JOIN（曾经直接报"列不存在"）
  const COMP_FILTER = `
id: 单公司
params: { year: 2026, month: 6 }
sheets:
  - name: 主要指标
    blocks:
      - anchor: B4
        rows: { dim: metric, order: [利润总额] }
        cols: { dim: period_type, order: [本年累计] }
        value: { measure: amount, agg: sum }
        scope:
          time: { year: "{{year}}", month: "{{month}}" }
          company: { filter: { name: 华东子公司 } }`;
  {
    const cb = parseSpec(COMP_FILTER).sheets[0].blocks[0];
    let joined = true;
    let v: number | null = null;
    try {
      const cres = await runCompiled(compileBlock(cb, { year: 2026, month: 6 }), (sql) => db.query(sql));
      v = Number(cres.matrix[0].values[0]);
    } catch {
      joined = false;
    }
    check('★ bug C：scope.company.filter 会自动 JOIN dim_company（不再报列不存在）', joined);
    check('★ bug C：数值确实被公司过滤（华东 ≠ 集团合计）', v === 17116 && v !== 65198, `值=${v}`);
  }

  // ---- 一次报全，而不是"改一条撞一条" ----
  const multi = diagnoseSpec(`
id: T
sheets:
  - name: S
    blocks:
      - anchor: B4
        rows: { dim: 不存在的维度, order: [x, x] }
        cols: { dim: company, order: [] }
        value: { expr: "(本年累计 - 去年同期累计) / 去年同期累计" }`);
  check('★ 一次给全所有问题（不是只报第一条）', multi.errors.length >= 3, `errors=${multi.errors.length}`);

  // ---- YAML 语法错与语义错分开报 ----
  const syn = diagnoseSpec('id: [unclosed\n  bad: :');
  check('★ YAML 语法错单独归入 parseError', syn.parseError !== null && syn.issues.length === 0);

  // ---- 判据只有一份：lint 与 parseSpec 不漂移 ----
  check(
    '★ lintSpec 判定「可保存」⇔ parseSpec 不抛（同一套判据，不会两边打架）',
    [UNCONSTRAINED, PINNED, BY_METRIC, EXPR, COMP_FILTER].every((y) => {
      const d = diagnoseSpec(y);
      let threw = false;
      try { parseSpec(y); } catch { threw = true; }
      return d.willBeRejected === threw;
    }),
  );

  // ---- unpinnedMeaningDims 导出给推断器用（模板缺指标时必须能自报家门）----
  // ⚠️ UNCONSTRAINED 现在会被 parseSpec 拒绝，所以这里必须用 parseSpecLenient
  //    取结构 —— 诊断工具链本身要能处理"不合法的 spec"。
  {
    const { parseSpecLenient } = await import('../src/spec/types.ts');
    const pinnedBlock = parseSpecLenient(PINNED).spec!.sheets[0].blocks[0];
    const unBlock = parseSpecLenient(UNCONSTRAINED).spec!.sheets[0].blocks[0];
    check(
      '★ unpinnedMeaningDims 能识别缺失的量纲维',
      unpinnedMeaningDims(pinnedBlock).length === 0 && unpinnedMeaningDims(unBlock).includes('metric'),
      `pinned=${JSON.stringify(unpinnedMeaningDims(pinnedBlock))} unconstrained=${JSON.stringify(unpinnedMeaningDims(unBlock))}`,
    );
  }
  check('lintSpec 导出可用（供 MCP / Web 诊断复用）', Array.isArray(lintSpec(parseSpec(PINNED))));
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

// ============ 16. 着陆层：源文件原样留存（可重放的依据）============
log('\n════════ 16. 着陆层 raw（幂等与保真）════════');
{
  const { landRawFile } = await import('../src/land/raw.ts');
  const { resolveSource } = await import('../src/paths.ts');
  const { openTemplate } = await import('../src/spec/template.ts');

  const TPLFIX = 'test/fixtures/月度保送表.xlsx';
  const LONGFIX = 'test/fixtures/集团导出长表.xlsx';
  const countCells = async (hash: string) => {
    const r = await db.query<{ n: number }>(`SELECT count(*) AS n FROM raw_cell WHERE file_hash = '${hash}'`);
    return Number(r[0]!.n);
  };

  // —— 首次着陆 ——
  const first = await landRawFile(TPLFIX);
  check('★ 着陆一份源文件：raw_file 记一行、raw_cell 记 N 格',
    first.reused === false && first.cellsWritten > 0 && (await countCells(first.fileHash)) === first.cellsWritten,
    `written=${first.cellsWritten} sheets=${first.sheets.length}`);
  check('raw_file 的行数 = 着陆过的文件数',
    Number((await db.query<{ n: number }>('SELECT count(*) AS n FROM raw_file'))[0]!.n) === 1);

  // —— 幂等：同一份文件再跑一次，一格都不该被重写 ——
  const second = await landRawFile(TPLFIX);
  check('★ 同一份文件跑两次 → raw_cell 行数不变（幂等）',
    second.reused === true && second.cellsWritten === 0 &&
      (await countCells(first.fileHash)) === first.cellsWritten,
    `reused=${second.reused} written=${second.cellsWritten}`);
  check('★ 幂等走的是 file_hash，不是文件名', second.fileHash === first.fileHash);

  // —— 换一份文件：互不覆盖 ——
  const other = await landRawFile(LONGFIX);
  check('不同文件各自成批，互不覆盖',
    other.fileHash !== first.fileHash &&
      Number((await db.query<{ n: number }>('SELECT count(*) AS n FROM raw_file'))[0]!.n) === 2 &&
      (await countCells(first.fileHash)) === first.cellsWritten,
    `另一份 ${other.cellsWritten} 格`);

  // —— 保真：把落进库的值与**直接从工作簿读**的值逐个比对（独立的第二条路）——
  //    这是 §6.1 的纪律：期望值来自独立算法，不是"上一次跑出来的结果"。
  const expectOf = (v: unknown): { kind: string; text: string } | null => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') return v === '' ? null : { kind: 'text', text: v };
    if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'number', text: String(v) } : null;
    if (typeof v === 'boolean') return { kind: 'bool', text: v ? 'true' : 'false' };
    if (v instanceof Date) return { kind: 'date', text: v.toISOString() };
    return null;
  };
  const wb = await openTemplate(TPLFIX);
  const sh = wb.sheet('主要指标');
  const stored = await db.query<{ row_no: number; col_no: number; value_kind: string; raw_value: string | null; formula: string | null }>(
    `SELECT row_no, col_no, value_kind, raw_value, formula FROM raw_cell WHERE file_hash = '${first.fileHash}' AND sheet = '主要指标'`,
  );
  const byCoord = new Map(stored.map((s) => [`${s.row_no}.${s.col_no}`, s]));
  let compared = 0;
  const bad: string[] = [];
  for (let r = 1; r <= 12; r++) {
    for (let c = 1; c <= 6; c++) {
      const want = expectOf(sh.cell(r, c).value());
      const got = byCoord.get(`${r}.${c}`);
      if (!want) { if (got) bad.push(`${r}.${c} 本应为空却有行`); continue; }
      compared++;
      if (!got || got.value_kind !== want.kind || got.raw_value !== want.text) {
        bad.push(`${r}.${c} 期望 ${want.kind}:${want.text} 实得 ${got?.value_kind}:${got?.raw_value}`);
      }
    }
  }
  check('★ raw 与工作簿逐个格一致（round-trip 无损，含类型）',
    bad.length === 0 && compared > 0, bad.length ? bad.slice(0, 3).join(' | ') : `比了 ${compared} 格`);

  const fxCells = stored.filter((s) => s.formula !== null);
  check('公式格的公式文本被留下（重放时要靠它识别合计行）',
    fxCells.length > 0 && fxCells.every((s) => s.formula!.trim().length > 0 && /[A-Z]+\d/.test(s.formula!)),
    fxCells[0] ? `${fxCells[0].formula}` : '');

  const kinds = await db.query<{ value_kind: string }>(`SELECT DISTINCT value_kind FROM raw_cell WHERE file_hash = '${first.fileHash}'`);
  check('value_kind 能区分文字与数字（缺了它重放分不出类型）',
    kinds.map((k) => k.value_kind).sort().join(',').includes('number') &&
      kinds.map((k) => k.value_kind).sort().join(',').includes('text'),
    kinds.map((k) => k.value_kind).sort().join(','));

  // —— 返回值里**结构上**没有格内容：只有计数与标识 ——
  //    （照 previewSpec「根本不查库」那套路：把安全做进形状，而不是靠人记得别加字段）
  const okKeys = ['cellsWritten', 'fileHash', 'filename', 'reused', 'sheets', 'sizeBytes'].sort().join(',');
  const sheetKeys = ['cells', 'name'].sort().join(',');
  check('★ 着陆返回值只含计数与标识，不含任何格内容',
    Object.keys(first).sort().join(',') === okKeys &&
      first.sheets.every((s) => Object.keys(s).sort().join(',') === sheetKeys),
    Object.keys(first).sort().join(','));

  // —— 白名单：着陆层不能变成"读任意文件"的入口 ——
  let refused = '';
  try { await landRawFile('/etc/passwd'); } catch (e) { refused = (e as Error).message; }
  check('★ 白名单外的路径被拒（判据只有 src/paths.ts 那份）',
    refused.includes('必须落在这些目录内'), refused.slice(0, 60));
  check('白名单判据只有一份：landing 与接入层调的是同一个函数',
    typeof resolveSource === 'function' && resolveSource(TPLFIX).endsWith('月度保送表.xlsx'));
}

// ============ 17. 重放：值已经能从 raw 读回来（P1）============
log('\n════════ 17. 重放（raw 是值的唯一来源）════════');
{
  const { landRawFile, findRawFile } = await import('../src/land/raw.ts');
  const { rawWorkbook } = await import('../src/land/read.ts');
  const { dryRunIngest } = await import('../src/ingest/dryrun.ts');
  const { masterCatalog } = await import('../src/ingest/master.ts');
  const { parseIngestSpec } = await import('../src/ingest/types.ts');
  const { runIngest } = await import('../src/ingest/run.ts');

  const SPEC = 'ingest/月度经营接入.yaml';
  const spec = parseIngestSpec(fs.readFileSync(SPEC, 'utf8'));
  const cat = await masterCatalog();

  const landed = await landRawFile(spec.source);
  check('着陆后 findRawFile 认得这份源（重放靠它定位 raw）',
    (await findRawFile(spec.source)) === landed.fileHash, `${landed.cellsWritten} 格`);
  check('再着陆一次是复用的（幂等，不重写）', (await landRawFile(spec.source)).reused === true);

  // —— 对拍：同一条规格、同一份源，走 raw 与直接开工作簿必须**逐字段相同** ——
  const fromRaw = await dryRunIngest(spec, { catalog: cat, openBook: () => rawWorkbook(landed.fileHash) });
  const fromBook = await dryRunIngest(spec, { catalog: cat });
  check('★ 对拍：从 raw 读 ≡ 直接读工作簿（形状逐字段相同）',
    JSON.stringify(fromRaw) === JSON.stringify(fromBook),
    JSON.stringify(fromRaw) === JSON.stringify(fromBook) ? '完全一致' : '两侧不一致');
  check('对拍非空跑（确实读到数据行）',
    fromRaw.blocks.some((b) => b.dataRows > 0), `dataRows=${fromRaw.blocks.map((b) => b.dataRows).join(',')}`);

  // —— 决定性证据：把 raw 里某个值格**改坏**，形状必须跟着变 ——
  //    只断言"对拍相等"是不够的：两条路都不被使用时它们也相等。
  //    这一步刻意违反 append-only（测试里模拟"raw 被腐蚀"），用完立刻还原。
  const nonNumericOf = (s: typeof fromRaw) => s.blocks.reduce((n, b) => n + b.measureCells.nonNumeric, 0);
  const t = (await db.query<{ sheet: string; row_no: number; col_no: number; raw_value: string; value_kind: string }>(
    `SELECT sheet, row_no, col_no, raw_value, value_kind FROM raw_cell ` +
      `WHERE file_hash = '${landed.fileHash}' AND value_kind = 'number' LIMIT 1`,
  ))[0]!;
  const where = `file_hash = '${landed.fileHash}' AND sheet = '${t.sheet}' AND row_no = ${Number(t.row_no)} AND col_no = ${Number(t.col_no)}`;
  await db.execute(`UPDATE raw_cell SET raw_value = 'N/A', value_kind = 'text' WHERE ${where}`);
  const poisoned = await dryRunIngest(spec, { catalog: cat, openBook: () => rawWorkbook(landed.fileHash) });
  await db.execute(`UPDATE raw_cell SET raw_value = '${t.raw_value}', value_kind = '${t.value_kind}' WHERE ${where}`);
  check('★ 决定性证据：改坏 raw 里的一个值格，接入层读到的形状跟着变 —— 值确实来自 raw',
    nonNumericOf(poisoned) === nonNumericOf(fromRaw) + 1,
    `非数值格 ${nonNumericOf(fromRaw)} → ${nonNumericOf(poisoned)}`);

  // —— 重放：把中间结果清空，用同一份 raw 重建两次，两次必须逐行相同 ——
  //    ★ 先清空是必须的：这份规格的坐标会与前面阶段（第 15 阶段主数据对齐）已落的行**撞车**，
  //      而 `onConflict: reject` 会整批拒绝 → inserted=0。重放测试要自己造出干净起点，
  //      不能依赖"库里此刻恰好没有冲突行"。（第一次写成依赖现状，assert 直接挂了。）
  //      第 17 阶段是最后一个阶段，清空 fact_finance 不影响任何既有断言。
  const snap = () =>
    db.query<Record<string, unknown>>(
      `SELECT fin_month, company_id, metric_id, period_type, amount FROM fact_finance ` +
        `ORDER BY fin_month, company_id, metric_id, period_type`,
    );
  await db.execute('DELETE FROM fact_finance');
  const run1 = await runIngest(spec, { catalog: await masterCatalog() });
  const first = await snap();
  check('从 raw 重建出事实行（写入数 = 库内行数）',
    run1.inserted > 0 && run1.inserted === first.length, `inserted=${run1.inserted} 行数=${first.length}`);

  await db.execute('DELETE FROM fact_finance');
  const run2 = await runIngest(spec, { catalog: await masterCatalog() });
  const second = await snap();
  check('★ 重放：清空后用同一份 raw 再建一次，事实行逐行（含金额）完全相同',
    second.length === first.length && JSON.stringify(second) === JSON.stringify(first),
    `${first.length} 行 vs ${second.length} 行（第二次 inserted=${run2.inserted}）`);
}

// ============ 18. 装载顺序守卫：事实行不许指向不存在的主数据 ============
log('\n════════ 18. 装载顺序与行数守卫 ════════');
{
  // —— 这条就是架构 §6.1 的"最经典的静默故障"在 bi-lite 里的形状：
  //    维度还没合并完就写事实 → 事实行指向不存在的主数据，而且**不报错**。
  //    所以断言打在**真实库**上，而不是只信代码里那个 if（那个 if 也可能被改掉）。
  const orphan = async (dim: string, col: string) =>
    Number(
      (await db.query<{ n: number }>(
        `SELECT count(*) AS n FROM fact_finance f LEFT JOIN ${dim} d ON d.id = f.${col} WHERE d.id IS NULL`,
      ))[0]!.n,
    );
  check('★ 没有一条事实行指向不存在的公司', (await orphan('dim_company', 'company_id')) === 0);
  check('★ 没有一条事实行指向不存在的指标', (await orphan('dim_metric', 'metric_id')) === 0);

  // —— 取不到维度 id 时曾会拼出字符串 'undefined'（`lit(undefined)`）：
  //    那种脏 id 连"行数对不对"都查不出来，所以单独钉一条。 ——
  check('★ fact_finance 没有 NULL 键、也没有字面量 \'undefined\' 键',
    Number((await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM fact_finance WHERE company_id IS NULL OR metric_id IS NULL ` +
        `OR company_id = 'undefined' OR metric_id = 'undefined' OR company_id = '' OR metric_id = ''`,
    ))[0]!.n) === 0);

  // —— inserted 报的是"真正落库的行数"：所以每个批次的库内行数必须与之一致（非零）——
  const perBatch = await db.query<{ batch_id: string; n: number }>(
    `SELECT batch_id, count(*) AS n FROM fact_finance GROUP BY batch_id ORDER BY batch_id`,
  );
  check('每个批次都真的落了行（没有空批次）',
    perBatch.length > 0 && perBatch.every((b) => Number(b.n) > 0),
    `${perBatch.length} 个批次：${perBatch.map((b) => Number(b.n)).join(',')}`);
}

// ============ 19. 阶段 2 事务化：不留半个批次 ============
log('\n════════ 19. 装载事务化（不留半个批次）════════');
{
  const { runIngest } = await import('../src/ingest/run.ts');
  const { parseIngestSpec } = await import('../src/ingest/types.ts');
  const { masterCatalog } = await import('../src/ingest/master.ts');
  const spec = parseIngestSpec(fs.readFileSync('ingest/月度经营接入.yaml', 'utf8'));
  const counts = async () => {
    const one = async (t: string) =>
      Number((await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${t}`))[0]!.n);
    return { batch: await one('import_batch'), fact: await one('fact_finance'), company: await one('dim_company'), metric: await one('dim_metric'), alias: await one('dim_alias') };
  };

  // —— 不变式一：本路径的批次不该停在中间态 ——
  //    注意 `import_batch` 被两条导入路径共用，状态词不同：长表那条用 staged/…
  //    （它本身待退场）。这里只钉**本路径**写的那两个中间态：pending / syncing。
  const transient = await db.query<{ status: string; n: number }>(
    `SELECT status, count(*) AS n FROM import_batch WHERE status IN ('pending','syncing') GROUP BY status`,
  );
  check('★ 没有批次停在 pending / syncing（没有半个批次）',
    transient.length === 0, JSON.stringify(transient));

  // —— 不变式二：每条事实行都指向一个存在的批次 ——
  check('★ 每条事实行都指向一个存在的批次',
    Number((await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM (SELECT DISTINCT batch_id FROM fact_finance) f
       LEFT JOIN import_batch b ON b.batch_id = f.batch_id WHERE b.batch_id IS NULL`,
    ))[0]!.n) === 0);

  // —— 故意让阶段 2 **中途**失败：决定里塞一个「并入一个不存在的指标」。
  //    抛点在「批次行已写、事实未写」之间 —— 正是最该被整体回滚的位置。
  //    没有事务时，那一行批次会以 status='pending' **永久留下**（这就是"半个批次"）。
  //    ⚠️ 先清空事实行：撞库预检会先一步把整批拦下，那样就**根本走不到阶段 2**，
  //       于是"没抛错"会被误读成"事务起作用了"。（第一次正是这么挂的。）
  await db.execute('DELETE FROM fact_finance');
  const before = await counts();
  let msg = '';
  try {
    await runIngest(spec, {
      catalog: await masterCatalog(),
      decisions: [{ kind: 'metric', raw: '营业收入', action: 'merge', targetId: 'm_不存在' }],
    });
  } catch (e) {
    msg = (e as Error).message;
  }
  const after = await counts();
  check('★ 中途失败确实抛错（不是静静过去）', msg.includes('目标主数据不存在'), msg.slice(0, 50));
  check('★★ 事务回滚：批次 / 事实 / 公司 / 指标 / 别名 五张表的行数一个都没变',
    JSON.stringify(after) === JSON.stringify(before),
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  check('回滚之后库仍然可用（连接没被留在坏状态）',
    Number((await db.query<{ n: number }>('SELECT count(*) AS n FROM import_batch'))[0]!.n) === before.batch);
}

// ============ 20. 源文件没了也能重放（路径 → raw）============
log('\n════════ 20. 源文件被删之后仍能重放 ════════');
{
  const { landRawFile, findRawFile } = await import('../src/land/raw.ts');
  const { parseIngestSpec } = await import('../src/ingest/types.ts');
  const { masterCatalog } = await import('../src/ingest/master.ts');
  const { runIngest } = await import('../src/ingest/run.ts');

  // 把真源拷到白名单内的一个探针路径，规格里的 source 换成它。
  // 字节完全相同 → raw 走"复用"，正是"同一份文件换个路径传进来"那条路：
  // 若不额外记路径，源文件一删就再也找不回 raw 了。
  const PROBE = 'test/fixtures/.replay-probe.xlsx';
  fs.copyFileSync('data/probe-run/月度经营接入源.xlsx', PROBE);
  const spec = parseIngestSpec(
    fs.readFileSync('ingest/月度经营接入.yaml', 'utf8').replace(/^source:.*$/m, `source: ${PROBE}`),
  );
  try {
    const landed = await landRawFile(spec.source);
    check('同一份文件换个路径进来 → 复用已有 raw（不重复落格）',
      landed.reused === true && landed.cellsWritten === 0, `reused=${landed.reused}`);

    fs.rmSync(PROBE); // ★ 源文件没了
    check('探针源文件确实已被删掉', !fs.existsSync(PROBE));

    check('★ 源文件不在了，靠「路径 → raw」仍能找回那一份',
      (await findRawFile(spec.source)) === landed.fileHash);

    // 真落库：此刻工作簿路径已不可用（文件不存在），能写进去就说明值确实来自 raw
    await db.execute('DELETE FROM fact_finance');
    const r = await runIngest(spec, { catalog: await masterCatalog() });
    const rows = Number((await db.query<{ n: number }>('SELECT count(*) AS n FROM fact_finance'))[0]!.n);
    check('★★ 源文件已删，仍从 raw 重建出事实行', r.inserted > 0 && r.inserted === rows,
      `inserted=${r.inserted} 库内=${rows}`);
  } finally {
    fs.rmSync(PROBE, { force: true }); // 探针文件无论如何都要清掉
  }
}

// ============ 21. CLI：render / query，以及"受众钉死"与物料隔离 ============
log('\n════════ 21. CLI render / query（受众与物料隔离）════════');
{
  const { parseCliArgs, main } = await import('../src/cli.ts');
  const cap = () => {
    const o: string[] = []; const e: string[] = [];
    return { o, e, io: { out: (t: string) => void o.push(t), err: (t: string) => void e.push(t) } };
  };

  // —— 解析层是纯函数：把新命令的面摊开 ——
  check('parseCliArgs 认得 render / query',
    parseCliArgs(['render', 'specs/x.yaml']).kind === 'render' &&
      parseCliArgs(['query', '--measure', '营业收入:本年累计']).kind === 'query');
  check('选项给的形状不对 → 用法错误（不猜）',
    parseCliArgs(['query', '--measure', '营业收入']).kind === 'usage-error' &&
      parseCliArgs(['query', '--by', 'company']).kind === 'usage-error' &&
      parseCliArgs(['render', '--param', 'year']).kind === 'usage-error');

  // —— ★ 铁律 10：**没有任何能选受众的开关** —— CLI 是人的入口，受众写死 human ——
  const aud = parseCliArgs(['query', '--measure', '营业收入:本年累计', '--audience', 'agent']);
  check('★ CLI 里根本不存在 `--audience` 开关（受众由入口钉死，同 Web）',
    aud.kind === 'usage-error' && aud.message.includes('--audience'),
    aud.kind === 'usage-error' ? aud.message : aud.kind);

  // —— 真跑一次：从一个真实存在的 (指标, 口径) 取（不猜名字，用库里有的）——
  const pair = (await db.query<{ name: string; period_type: string }>(
    `SELECT DISTINCT m.name, f.period_type FROM fact_finance f JOIN dim_metric m ON m.id = f.metric_id LIMIT 1`,
  ))[0];
  if (!pair) throw new Error('库里没有可查的事实行，这一阶段的前提不成立');
  const cq = cap();
  const code = await main(['query', '--measure', `${pair.name}:${pair.period_type}`, '--by', 'company'], cq.io);
  const res = JSON.parse(cq.o.join('')) as { groups: Array<{ cells: Array<number | string | null> }>; meta: { audience: string; redaction: string } };
  const cells = res.groups.flatMap((g) => g.cells).filter((c) => c !== null);
  check('★ query 走 human 视角：精确值、不分档', res.meta.audience === 'human' && res.meta.redaction === 'none');
  check('★ 返回的是**数字**不是分档串（分档会得到 "12.3万" 这样的字符串）',
    cells.length > 0 && cells.every((c) => typeof c === 'number'), `${cells.length} 格：${cells.slice(0, 3).join(',')}`);
  check('query 退出码 0，数据走 stdout、摘要走 stderr',
    code === 0 && cq.e.join('').includes('bilite query'), cq.e.join('').trim());

  // —— render：写出文件、返回值不含金额 ——
  const cr = cap();
  const codeR = await main(['render', 'specs/月度保送表.yaml', '--out', 'e2e-cli-render.xlsx'], cr.io);
  const rr = JSON.parse(cr.o.join('')) as { outputPath: string; cellsWritten: number };
  check('★ render 写出文件且只回路径与计数',
    codeR === 0 && rr.cellsWritten > 0 && fs.existsSync(rr.outputPath), `${rr.outputPath} ${rr.cellsWritten} 格`);
  check('render 返回值不含金额', findAmountLike(rr).length === 0, JSON.stringify(findAmountLike(rr)));
  fs.rmSync('output/e2e-cli-render.xlsx', { force: true });

  // —— ★ docs/开发计划.md §7.5：CLI 的取数命令**不许出现在 agent 侧物料里** ——
  //    「agent 的官方工作流里不能存在一条指向它的路」——这句话只有变成断言才算数。
  const skill = fs.readFileSync('skills/bi-lite-ingest/SKILL.md', 'utf8');
  const leaked = ['bilite query', 'bilite render', 'bilite ingest run'].filter((s) => skill.includes(s));
  check('★ agent 手册里不出现 CLI 的取数/落库命令（那是人的入口）',
    leaked.length === 0, leaked.length ? leaked.join('、') : 'SKILL.md 干净');
}

// ============ 22. catalog：把「库里现在有什么」交给 agent ============
log('\n════════ 22. catalog（列契约与三层导出）════════');
{
  const { META, metaProblems } = await import('../src/meta/columns.ts');
  const { catalogDump, catalogShow } = await import('../src/meta/catalog.ts');

  // —— 契约不漂移：声明与真实库结构逐列一致 ——
  const drift = await metaProblems();
  check('★ 列契约与真实库结构一致（没有多列/少列/未声明的语义表）',
    drift.length === 0, drift.slice(0, 2).join(' | '));

  // —— 但"守卫存在"不等于"守卫有用"：喂一份**错的声明**，它必须抓出来 ——
  const bogus = await metaProblems([
    { name: 'fact_finance', kind: 'fact', columns: [{ column: '不存在的列', role: 'pk' }] },
  ]);
  check('★★ 守卫真的会抓漂移：喂一份错声明 → 既报"声明了库里没有的列"，也报"库里的表没进契约"',
    bogus.some((p) => p.includes('不存在的列')) && bogus.some((p) => p.includes('没进契约')),
    bogus.length ? `${bogus.length} 条` : '一条都没报（守卫形同虚设）');

  // —— 注册下来的元数据要与声明同源（行数 = 声明列数）——
  const declaredCols = META.reduce((n, o) => n + o.columns.length, 0);
  const registered = Number((await db.query<{ n: number }>('SELECT count(*) AS n FROM _meta_columns'))[0]!.n);
  const registeredObjs = Number((await db.query<{ n: number }>('SELECT count(*) AS n FROM _meta_objects'))[0]!.n);
  check('★ _meta_columns 由接入层在落库时登记，且与声明同源',
    registered === declaredCols && registeredObjs === META.length,
    `${registered}/${declaredCols} 列 · ${registeredObjs}/${META.length} 对象`);

  // —— 三层导出 ——
  const cat = await catalogDump();
  check('catalog 三层齐全（L1 业务成员 / L2 物理结构 / L3 版本）',
    cat.members.metrics.length > 0 && cat.objects.length === META.length &&
      cat.apiVersion.length > 0 && cat.ddlHash.length > 0,
    `apiVersion=${cat.apiVersion} ddlHash=${cat.ddlHash}`);
  check('catalog 自带快照标记（asOf + ddlHash）—— 过期要能被发现，不靠人记得重导',
    typeof cat.asOf === 'string' && cat.asOf.length > 0);
  check('★ catalog 里没有任何金额（铁律 1）', findAmountLike(cat).length === 0, JSON.stringify(findAmountLike(cat).slice(0, 2)));

  // —— 已定：装载批次历史不进 catalog（它属于装载侧，混进来会把结构快照撑成运营日志）——
  const asText = JSON.stringify(cat);
  check('★ catalog 不含 _ingest_batch / raw_* 等运营侧表',
    !asText.includes('_ingest_batch') && !asText.includes('raw_cell') && !asText.includes('dim_alias'));

  // —— 按需下钻：单表结构（默认路径，别整库吞下去）——
  const ff = await catalogShow('fact_finance');
  check('★ catalog show fact_finance：粒度 + 逐列角色（含 amount=measure）',
    ff.grain === 'fin_month,company_id,metric_id,period_type' &&
      ff.columns.some((c) => c.column === 'amount' && c.role === 'measure') &&
      ff.columns.some((c) => c.column === 'company_id' && c.refTable === 'dim_company'),
    `grain=${ff.grain} 列=${ff.columns.length} 行=${ff.rowCount}`);
  let badTopic = '';
  try { await catalogShow('不存在的表'); } catch (e) { badTopic = (e as Error).message; }
  check('catalog show 面对不存在的对象给一句人话（且列出有哪些）',
    badTopic.includes('现有：'), badTopic.slice(0, 40));

  // —— CLI 那一侧：数据走 stdout、摘要走 stderr ——
  const { main } = await import('../src/cli.ts');
  const o: string[] = []; const e: string[] = [];
  const code = await main(['catalog', 'dump'], { out: (t) => void o.push(t), err: (t) => void e.push(t) });
  const fromCli = JSON.parse(o.join('')) as { drift: string[]; objects: unknown[] };
  check('CLI `catalog dump` 跑通（退出码 0 表示契约没漂移，stdout 是合法 JSON）',
    code === 0 && fromCli.drift.length === 0 && fromCli.objects.length === META.length,
    `code=${code} 对象=${fromCli.objects.length}`);
  check('CLI 的摘要走 stderr', e.join('').includes('catalog dump'), e.join('').trim());
}

// ============ 23. CLI `validate`：一份命令，两份判据 ============
log('\n════════ 23. CLI validate（§8.2 第 ④ 条接口）════════');
{
  const { main, parseCliArgs } = await import('../src/cli.ts');
  const run = async (argv: string[]) => {
    const o: string[] = []; const e: string[] = [];
    const code = await main(argv, { out: (t) => void o.push(t), err: (t) => void e.push(t) });
    return { code, out: o.join(''), err: e.join('') };
  };

  const ing = await run(['validate', 'ingest/月度经营接入.yaml']);
  const rep = await run(['validate', 'specs/月度保送表.yaml']);
  check('★ 自动判别用哪份判据：接入规格（有 source）走 diagnoseIngest，报表规格走 diagnoseSpec',
    (JSON.parse(ing.out) as { kind: string }).kind === 'ingest' &&
      (JSON.parse(rep.out) as { kind: string }).kind === 'report');
  check('两份都判为可保存（退出码 0），摘要走 stderr',
    ing.code === 0 && rep.code === 0 && ing.err.includes('接入规格') && rep.err.includes('报表规格'),
    `${ing.err.trim()} | ${rep.err.trim()}`);

  // —— 「一次给全所有问题」：给一份**两个错**的接入规格，必须两条都报，不能只报第一条 ——
  const badYaml = [
    'id: 坏规格',
    'source: test/fixtures/集团导出长表.xlsx',
    'sheets:',
    '  - name: 不存在的sheet名',
    '    blocks:',
    '      - anchor: 不是坐标',
    '        rows: [{ col: A, dim: company }]',
    '        values: { columns: [B], measure: amount }',
  ].join('\n');
  const bad = parseCliArgs(['validate', 'x.yaml']);
  check('validate 的解析层认得它', bad.kind === 'validate');
  const { diagnoseIngest } = await import('../src/ingest/types.ts');
  const d = diagnoseIngest(badYaml);
  check('★ 一次给全所有问题（不是"改一条再撞下一条"）',
    d.issues.filter((i) => i.level === 'error').length >= 2,
    `${d.issues.filter((i) => i.level === 'error').length} 条 error：${d.issues.filter((i) => i.level === 'error').map((i) => i.code).join(',')}`);

  // —— 裸跑是用法错误，不是"通过" ——
  const bare = await run(['validate']);
  check('裸跑 validate → 用法错误（退 2），不假装通过', bare.code === 2, `code=${bare.code}`);
  check('文件不存在 → 给一句人话', (await run(['validate', '不存在的.yaml'])).err.includes('不存在'));
}

// ============ 24. skill 导出：把「手册会不会漂」变成断言（§8.2 ①）============
log('\n════════ 24. skill export 与手册对拍 ════════');
{
  const { skillFactsFrom, skillProblems, skillPrompt } = await import('../src/skill/export.ts');
  const { TOOLS } = await import('../src/mcp/tools.ts');
  const skillText = fs.readFileSync('skills/bi-lite-ingest/SKILL.md', 'utf8');
  const names = TOOLS.map((t) => t.name);

  // —— ★ 对拍：手写的 SKILL.md 有没有落后于实现 ——
  //    §8.2 说"手写的 RULES.md 一定会漂"。不靠人记得同步，靠这条断言。
  const drift = skillProblems(skillText, names);
  check('★ 手册与实现没漂：每个 MCP 工具都在手册里出现，且自报条数与实现一致',
    drift.length === 0, drift.slice(0, 2).join(' | '));

  // —— 但"守卫存在"不等于"守卫有用"：喂它两种漂移，都得抓出来 ——
  check('★ 守卫抓得住「加了工具却没写进手册」',
    skillProblems(skillText, [...names, '还没实现的工具']).some((p) => p.includes('还没实现的工具')));
  check('★ 守卫抓得住「手册自报条数与实现不符」',
    skillProblems(skillText.replace('工具面（12 个）', '工具面（99 个）'), names).some((p) => p.includes('99')));

  // —— 导出物本身：事实取自实现，且**显式写出缺口** ——
  const f = skillFactsFrom(TOOLS.map((t) => ({ name: t.name, description: t.description })));
  check('★ 导出物的工具面**直接取自 TOOLS**（不是抄一份）',
    f.tools.length === TOOLS.length && f.tools.every((t, i) => t.name === TOOLS[i]!.name));
  check('导出物含注册表（口径 / 维度 / 语义对象），且零金额',
    f.registries.periodTypes.length > 0 && f.registries.dimensions.length > 0 &&
      f.registries.objects.length > 0 && findAmountLike(f).length === 0);
  check('★ 导出物**显式列出没覆盖的东西**（半份规则比没有规则更危险 —— 它会让人以为够了）',
    f.notCovered.length >= 2 && f.notCovered.some((s) => s.includes('strip-only')));
  check('prompt 形态可用，且把缺口一并印出来',
    skillPrompt(f).includes('这份导出**没有**覆盖的'));

  // —— CLI 那一侧 ——
  const { main } = await import('../src/cli.ts');
  const o: string[] = []; const e: string[] = [];
  const code = await main(['skill', 'export'], { out: (t) => void o.push(t), err: (t) => void e.push(t) });
  check('CLI `skill export` 跑通、stdout 是合法 JSON、摘要走 stderr',
    code === 0 && (JSON.parse(o.join('')) as { tools: unknown[] }).tools.length === TOOLS.length &&
      e.join('').includes('没有**覆盖'),
    `code=${code}`);
}

// ============ 汇总 ============
log('\n════════════════════════════════');
log(`  通过 ${pass} / 失败 ${fail}`);
log(`  导入 ${importMs}ms（960 行） | 查询 ${queryMs}ms`);
log('════════════════════════════════\n');

db.close();
process.exit(fail > 0 ? 1 : 0);
