/** 六个主链路节点。在临时副本中运行；不读取或改写项目 data/。 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFile } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] !== '--isolated') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-lite-e2e-'));
  try {
    for (const dir of ['assets/presets/finance', 'bin', 'src', 'models', 'ingest', 'specs', 'skills']) {
      fs.cpSync(path.join(root, dir), path.join(tmp, dir), { recursive: true });
    }
    fs.cpSync(path.join(root, 'test/config/metrics'), path.join(tmp, 'metrics'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'test'));
    for (const file of ['e2e.ts', 'make-fixtures.ts']) {
      fs.copyFileSync(path.join(root, 'test', file), path.join(tmp, 'test', file));
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(tmp, 'package.json'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, ['test/e2e.ts', '--isolated'], {
      cwd: tmp, stdio: 'inherit', env: { ...process.env, BILITE_DB: path.join(tmp, 'data/bi.duckdb') },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else {
  await verify();
}

async function verify() {
  const { makeFixtures } = await import('./make-fixtures.ts');
  await makeFixtures();
  const db = await import('../src/db/index.ts');
  const { loadModels, declaredFactsOf } = await import('../src/gen/parse.ts');
  const { planModels } = await import('../src/gen/plan.ts');
  const { masterCatalog } = await import('../src/ingest/master.ts');
  const { parseIngestSpec } = await import('../src/ingest/types.ts');
  const { runIngest } = await import('../src/ingest/run.ts');
  const { replaySpec } = await import('../src/ingest/replay.ts');
  const { queryMetrics, QueryRefused } = await import('../src/semantic/query.ts');
  const { parseSpec } = await import('../src/spec/types.ts');
  const { compileBlock, runCompiled } = await import('../src/spec/compile.ts');
  const { renderTemplate, readNumberFormat } = await import('../src/render/excel.ts');
  const { callTool, TOOLS, findAmountLike } = await import('../src/mcp/tools.ts');
  const { skillProblems } = await import('../src/skill/export.ts');
  const { default: XLSX } = await import('xlsx-populate');
  const facts = declaredFactsOf();
  const passed = (name: string) => console.log(`✓ ${name}`);
  const count = async (table: string) => Number((await db.query(`SELECT count(*) AS n FROM ${table}`))[0].n);
  let stop: (() => void) | undefined;
  try {
    // 1. 模型声明能够引导空库，并与库结构一致。
    // 首次接管已有指标须保留物理 ID；后续入口正常启动时复用同一同步函数。
    fs.renameSync('metrics', 'metrics-pending');
    try { await db.open(); } finally { fs.renameSync('metrics-pending', 'metrics'); }
    await db.execute("INSERT INTO dim_metric (id, name) VALUES ('legacy_revenue', '营业收入')");
    const { writeFirstVersion } = await import('../src/db/scd2.ts');
    await writeFirstVersion('metric', 'legacy_revenue', '2025-01-01');
    const { syncMetrics } = await import('../src/metrics/sync.ts');
    await syncMetrics();
    await syncMetrics();
    assert.deepEqual(await db.query("SELECT id, unit FROM dim_metric WHERE name = '营业收入'"), [{ id: 'legacy_revenue', unit: '元' }]);
    const { loadMetrics } = await import('../src/metrics/definitions.ts');
    const metricYaml = fs.readFileSync('metrics/finance.yml', 'utf8');
    try {
      fs.writeFileSync('metrics/finance.yml', metricYaml.replace('revenue - operating_cost', 'gross_margin * revenue'));
      assert.throws(() => loadMetrics(), /循环引用/);
    } finally { fs.writeFileSync('metrics/finance.yml', metricYaml); }
    const plan = await planModels(loadModels());
    assert.equal(plan.structural.length + plan.blocking.length, 0);
    assert.equal(await count('fact_finance'), 0);
    passed('模型声明 → 空库启动');

    const cat = await masterCatalog();
    const ingest = parseIngestSpec(fs.readFileSync('ingest/万元经营接入.yaml', 'utf8'), {
      facts: cat.facts, periodTypes: cat.periodTypes,
    });
    // 2. 试运行给出可执行结论、无写入，也不返回金额。
    const dry = await runIngest(ingest, { catalog: cat, planOnly: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.errors.length, 0);
    assert.deepEqual(findAmountLike(dry), []);
    assert.equal(dry.candidateRows, 80);
    assert.deepEqual(dry.shape.blocks[0].transforms.map((t) => t.cells), [64, 16]);
    assert.equal(await count('ingest_snapshot'), 0);
    assert.equal(await count('raw_file') + await count('stg_fact_rows') + await count('dim_company'), 0);
    assert.equal(await count('dim_metric'), 7);
    const derivedSource = await XLSX.fromFileAsync(ingest.source);
    derivedSource.sheet('月报').cell('E2').value(null);
    await derivedSource.toFileAsync('test/fixtures/空值输入.xlsx');
    const emptySpec = { ...ingest, source: 'test/fixtures/空值输入.xlsx' };
    assert.equal((await runIngest(emptySpec, { catalog: cat, planOnly: true })).candidateRows, 79);
    const nullPlan = await runIngest({ ...emptySpec, onEmptyMeasure: 'null' }, { catalog: cat, planOnly: true });
    assert.equal(nullPlan.candidateRows, 80);
    assert.equal(nullPlan.shape.spec.onEmptyMeasure, 'null');
    derivedSource.sheet('月报').cell('E2').value(1.1);
    derivedSource.sheet('月报').cell('C2').value('毛利润');
    await derivedSource.toFileAsync('test/fixtures/派生输入.xlsx');
    const refusedInput = await runIngest({ ...ingest, source: 'test/fixtures/派生输入.xlsx' }, { catalog: cat, planOnly: true });
    assert.equal(refusedInput.ok, false);
    assert.equal(refusedInput.errors[0].code, 'METRIC_INPUT_INVALID');
    derivedSource.sheet('月报').cell('C2').value('营业收入');
    derivedSource.sheet('月报').cell('D2').value(0.0000001);
    await derivedSource.toFileAsync('test/fixtures/精度输入.xlsx');
    const refusedPrecision = await runIngest({ ...ingest, source: 'test/fixtures/精度输入.xlsx' }, { catalog: cat, planOnly: true });
    assert.equal(refusedPrecision.ok, false);
    assert.equal(refusedPrecision.errors[0].code, 'TRANSFORM_VALUE_INVALID');
    assert.deepEqual(findAmountLike(refusedPrecision), []);
    const { transformValue } = await import('../src/ingest/transform.ts');
    assert.equal(transformValue(-0.0000015, { fromUnit: '万元', toUnit: '元', sign: 'negate', rounding: 'half-up' }, '元', 'DECIMAL(18,2)'), 0.02);
    // 人工归并到成本指标时，同样必须选择成本专属的反号规则。
    derivedSource.sheet('月报').cell('C2').value('来源成本');
    derivedSource.sheet('月报').cell('D2').value(-6.6);
    await derivedSource.toFileAsync('test/fixtures/归并输入.xlsx');
    const costId = (await db.query<{ id: string }>("SELECT id FROM dim_metric WHERE name = '营业成本'"))[0].id;
    const mergedPlan = await runIngest({ ...ingest, source: 'test/fixtures/归并输入.xlsx' }, { catalog: cat, planOnly: true,
      decisions: [{ kind: 'metric', raw: '来源成本', action: 'merge', targetId: costId }] });
    assert.equal(mergedPlan.shape.blocks[0].transforms[1].cells, 20);
    passed('接入试运行 → 不写库、不返回金额');

    // 3. 事实、标准化与归档完整；重复默认拒绝；源文件删除后仍可重放。
    const imported = await runIngest(ingest, { catalog: cat });
    assert.equal(imported.ok, true);
    assert.equal(imported.inserted, 80);
    assert.equal(imported.archived, true);
    assert.equal(await count('fact_finance'), 80);
    assert.equal(await count('stg_fact_rows'), 80);
    const again = await runIngest(ingest, { catalog: await masterCatalog() });
    assert.equal(again.ok, false);
    assert.equal(await count('fact_finance'), 80);
    const sourceBytes = fs.readFileSync(ingest.source);
    fs.unlinkSync(ingest.source);
    const changedSpec = structuredClone(ingest);
    changedSpec.sheets[0].blocks[0].values.transforms![0].fromUnit = '元';
    try {
      fs.writeFileSync('metrics/finance.yml', metricYaml.replaceAll('unit: 元', 'unit: 万元'));
      const replayed = await replaySpec(changedSpec);
      assert.equal(replayed.ok, true);
      assert.equal(replayed.specSource, 'batch-snapshot');
    } finally {
      fs.writeFileSync('metrics/finance.yml', metricYaml);
      fs.writeFileSync(ingest.source, sourceBytes);
    }
    const { DuckDBInstance } = await import('@duckdb/node-api');
    // 跨数据块复制须保留大额小数、日期与空值，归档前后主库连接和访问限制不变。
    const writerBeforeArchive = db.writer();
    const archiveSelect = `SELECT i, DATE '2026-06-01' AS day,
      CASE WHEN i % 2 = 0 THEN '9999999999999999.99'::DECIMAL(18,2) ELSE NULL END AS amount
      FROM range(4097) AS t(i)`;
    const archivePath = "data/parquet/精度'验证.parquet";
    await db.exportParquet(archiveSelect, { path: archivePath, rows: 4097 });
    const archiveCheck = await DuckDBInstance.create(':memory:');
    const archiveConn = await archiveCheck.connect();
    try {
      const checked = await archiveConn.runAndReadAll(`SELECT count(*)::INTEGER AS n,
        (count(*) FILTER (WHERE amount IS NULL))::INTEGER AS nulls,
        min(amount)::VARCHAR AS amount, min(day)::VARCHAR AS day
        FROM read_parquet('data/parquet/精度''验证.parquet')`);
      assert.deepEqual(checked.getRowObjectsJson(), [{ n: 4097, nulls: 2048, amount: '9999999999999999.99', day: '2026-06-01' }]);
    } finally { archiveConn.closeSync(); archiveCheck.closeSync(); }
    assert.equal(db.writer(), writerBeforeArchive);
    assert.deepEqual(await db.query("SELECT current_setting('enable_external_access') AS enabled"), [{ enabled: false }]);
    passed('导入 → 事实/标准化/归档、重复拒绝、库内重放');

    // 4. 一组独立合成数据验证口径，不扩展成参数排列。
    const instance = await DuckDBInstance.create(':memory:', { enable_external_access: 'false' });
    const con = await instance.connect();
    try {
      await con.run(`CREATE TABLE dim_metric(id VARCHAR, name VARCHAR);
        CREATE TABLE dim_fx_rate(rate_month DATE, ccy VARCHAR, rate DOUBLE);
        CREATE TABLE fact_finance(fin_month DATE, period_from DATE, metric_id VARCHAR, scenario VARCHAR, ccy VARCHAR, amount DOUBLE);
        INSERT INTO dim_metric VALUES ('m','测试指标');
        INSERT INTO fact_finance VALUES
          ('2026-02-01','2026-01-01','m','实际','人民币',100),
          ('2026-03-01','2026-01-01','m','实际','人民币',200),
          ('2026-02-01','2026-01-01','m','预算','人民币',50),
          ('2026-02-01','2026-01-01','m','实际','美元',20);
        INSERT INTO dim_fx_rate VALUES ('2026-02-01','人民币',1),('2026-02-01','美元',7);`);
      const run = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson();
      const base = { measures: [{ metric: '测试指标', periodType: '本年累计' }], filter: { month: '2026-02' }, audience: 'human' as const };
      assert.equal((await queryMetrics(base, run, facts)).groups[0].cells[0], 100);
      assert.equal((await queryMetrics({ ...base, ccy: '人民币' }, run, facts)).groups[0].cells[0], 240);
      await assert.rejects(() => queryMetrics({ ...base, filter: { year: '2026' } }, run, facts),
        (e) => e instanceof QueryRefused && e.reason === 'CUMULATIVE_TIME_UNPINNED');
      await assert.rejects(() => queryMetrics({ ...base, filter: { year: '2026' }, groupBy: ['month'], ccy: '人民币', limit: 1 }, run, facts),
        (e) => e instanceof QueryRefused && e.reason === 'FX_RATE_MISSING');
    } finally { con.closeSync(); instance.closeSync(); }
    passed('查询 → 期末/场景/币种正确，缺汇率拒绝');

    // 5. 真实规格编译并填入模板，金额用独立公式对拍，保留格式/合并/公式/批注。
    const specFile = 'specs/月度保送表.yaml';
    const spec = parseSpec(fs.readFileSync(specFile, 'utf8'), { facts });
    const block = spec.sheets[0].blocks[0];
    const result = await runCompiled(compileBlock(block, spec.params ?? {}, { facts }), db.query);
    const expected = Array.from({ length: 5 }, (_, mi) => [6, 5, 1, 10].map((factor) => (100000 + (mi + 1) * 4000) * factor));
    assert.deepEqual(result.matrix.map((row) => row.values), expected);
    const derivedSpec = parseSpec(fs.readFileSync('specs/盈利指标表.yaml', 'utf8'), { facts });
    const derivedResult = await runCompiled(compileBlock(derivedSpec.sheets[0].blocks[0], derivedSpec.params ?? {}, { facts }), db.query);
    const margin = (expected[0][2] - expected[2][2]) / expected[0][2];
    assert.deepEqual(derivedResult.matrix.map((r) => r.values), [
      expected[0].map((v, i) => v - expected[2][i]), expected[0].map(() => margin),
    ]);
    const derivedQuery = await queryMetrics({ measures: [{ metric: 'gross_margin', periodType: '单月' }],
      filter: { month: '2026-06' }, audience: 'human' }, db.query, facts);
    assert.equal(derivedQuery.groups[0].cells[0], margin);
    assert.throws(() => compileBlock({ ...block, scope: {} }, {}, { facts }), /CUMULATIVE_TIME_UNPINNED/);
    const output = 'output/已填.xlsx';
    const rendered = await renderTemplate(spec.template!, output, [{
      sheet: spec.sheets[0].name, anchor: block.anchor, colLabels: result.colLabels,
      rows: result.matrix, format: block.value.format, writeRowLabels: false, writeColLabels: false,
    }]);
    assert.equal(rendered.cellsWritten, 20);
    const wb = await XLSX.fromFileAsync(output);
    const sheet = wb.sheet('主要指标');
    assert.deepEqual(sheet.range('B4:E8').value(), expected);
    assert.equal(sheet.cell('B9').formula(), 'SUM(B4:B8)');
    assert.equal(sheet.range('A1:E1').merged(), true);
    assert.equal(readNumberFormat(wb, sheet.cell('B4')), '#,##0.00;[Red]-#,##0.00');
    const { default: JSZip } = await import('jszip');
    const before = await JSZip.loadAsync(fs.readFileSync(spec.template!));
    const after = await JSZip.loadAsync(fs.readFileSync(output));
    for (const name of Object.keys(before.files).filter((name) => /comments.*\.xml$/.test(name))) {
      assert.equal(await after.file(name)!.async('string'), await before.file(name)!.async('string'));
    }
    const styleCount = async (zip: any) => ((await zip.file('xl/styles.xml').async('string')).match(/<xf\b/g) ?? []).length;
    assert.equal(await styleCount(after), await styleCount(before));
    await renderTemplate(derivedSpec.template!, 'output/派生指标.xlsx', [{ sheet: '盈利指标', anchor: 'B4',
      rows: derivedResult.matrix, colLabels: derivedResult.colLabels, writeRowLabels: false, writeColLabels: false }]);
    const derivedWorkbook = await XLSX.fromFileAsync('output/派生指标.xlsx');
    assert.equal(derivedWorkbook.sheet('盈利指标').cell('D5').value(), margin);
    assert.equal(derivedWorkbook.sheet('盈利指标').cell('A5').value(), '毛利率');
    assert.equal(readNumberFormat(derivedWorkbook, derivedWorkbook.sheet('盈利指标').cell('D5')), '0.00%');
    // 同一份指标定义服务公司列示与固定指标的两种布局，不在模板复制公式。
    const comparisonSpec = parseSpec(fs.readFileSync('specs/公司盈利对比表.yaml', 'utf8'), { facts });
    const comparisonBlock = comparisonSpec.sheets[0].blocks[0];
    const companyResult = await runCompiled(compileBlock(comparisonBlock, comparisonSpec.params!, { facts }), db.query);
    const companyValues = Array.from({ length: 4 }, (_, i) => {
      const revenue = (i + 1) * 10000 + 1000, cost = (i + 1) * 10000 + 3000;
      return [revenue * 6, cost * 6, (revenue - cost) * 6, (revenue - cost) / revenue];
    });
    assert.deepEqual(companyResult.matrix.map((r) => r.values), companyValues);
    const byPeriod = await runCompiled(compileBlock(comparisonSpec.sheets[1].blocks[0], comparisonSpec.params!, { facts }), db.query);
    assert.deepEqual(byPeriod.matrix.map((r) => r.values), companyValues.map((v) => [v[3], v[3], v[3]]));
    const lastYear = await runCompiled(compileBlock(comparisonBlock, { ...comparisonSpec.params, periodType: '去年同期累计' }, { facts }), db.query);
    assert.equal(lastYear.matrix[0].values[0], 55000);
    assert.throws(() => compileBlock({ ...comparisonBlock, scope: {} }, comparisonSpec.params!, { facts }), /CUMULATIVE_TIME_UNPINNED/);
    assert.throws(() => compileBlock({ ...comparisonBlock, value: { ...comparisonBlock.value, metric: 'gross_margin' } }, comparisonSpec.params!, { facts }), /VALUE_BINDING_BAD/);
    passed('报表规格 → 正确矩阵、模板保真导出');

    // 6. MCP 只给结构；HTTP 由入口决定 human；CLI 在释放库后实际渲染。
    const sourceView = await callTool('look_at_source', { source: ingest.source });
    assert.equal(sourceView.ok, false);
    assert.match(sourceView.text, /TEMPLATE_DATA_BLOCKED/);
    const unsafeTemplate = await XLSX.fromFileAsync(spec.template!);
    unsafeTemplate.addSheet('隐藏明细').hidden(true).cell('ZZ2501').value('0.75%');
    await unsafeTemplate.toFileAsync('test/fixtures/含数据模板.xlsx');
    for (const tool of ['get_template_schema', 'generate_spec']) {
      const blocked = await callTool(tool, { template: 'test/fixtures/含数据模板.xlsx' });
      assert.equal(blocked.ok, false);
      assert.match(blocked.text, /TEMPLATE_DATA_BLOCKED/);
      assert.ok(!blocked.text.includes('0.75') && !blocked.text.includes('隐藏明细'));
    }
    for (const tool of ['dry_run_ingest', 'run_ingest']) {
      const refused = JSON.parse((await callTool(tool, { specFile: '不存在.yaml' })).text);
      assert.equal(refused.code, 'MANUAL_WEB_IMPORT_REQUIRED');
    }
    const blankTemplate = await callTool('get_template_schema', { template: spec.template });
    assert.equal(JSON.parse(blankTemplate.text).safety.policy, 'blank-only-v1');
    const { createTemplateTask, getAuthoringTask } = await import('../src/authoring/attachment.ts');
    const beforeMetrics = fs.readFileSync('metrics/finance.yml', 'utf8');
    const templateBook = await XLSX.fromFileAsync('test/fixtures/盈利指标表.xlsx');
    templateBook.sheet(0).cell('A4').value('尚未注册的业务指标');
    const authoring = await createTemplateTask('干净模板.xlsx', Buffer.from(await templateBook.outputAsync()));
    assert.equal(authoring.status, 'ready');
    assert.ok(authoring.projection?.sheets[0].cells.some((cell) => cell.text === '本年累计'));
    assert.ok(authoring.projection?.sheets[0].cells.some((cell) => cell.text === '尚未注册的业务指标'));
    assert.ok(!JSON.stringify(authoring.projection).includes('template.xlsx'));
    assert.equal(fs.readFileSync('metrics/finance.yml', 'utf8'), beforeMetrics);
    assert.equal(getAuthoringTask(authoring.id)?.template.sha256, authoring.template.sha256);
    const brokenTask = await createTemplateTask('损坏.xlsx', Buffer.from('invalid workbook'));
    assert.equal(brokenTask.status, 'template-unsupported');
    assert.match(brokenTask.refusal!, /TEMPLATE_PARSE_FAILED/);
    const dirtyTask = await createTemplateTask('含数据模板.xlsx', fs.readFileSync('test/fixtures/含数据模板.xlsx'));
    assert.equal(dirtyTask.status, 'template-rejected');
    assert.match(dirtyTask.refusal ?? '', /TEMPLATE_DATA_BLOCKED/);
    assert.equal(dirtyTask.projection, null);
    const toolRender = await callTool('render_report', { specFile, output: 'output/mcp.xlsx' });
    assert.equal(toolRender.ok, true);
    assert.deepEqual(findAmountLike(JSON.parse(toolRender.text)), []);
    const { main } = await import('../src/cli.ts');
    const showCliError = (message: string) => console.error(message);
    let cliOutput = '';
    const cliIO = { out: (message: string) => { cliOutput = message; }, err: showCliError };
    assert.equal(await main(['validate', 'metrics/finance.yml'], cliIO), 0);
    assert.equal(JSON.parse(cliOutput).kind, 'metrics');
    assert.equal(await main(['agent', 'look', 'test/fixtures/月度保送表.xlsx'], cliIO), 0);
    assert.equal(await main(['agent', 'template', '--template', 'test/fixtures/月度保送表.xlsx'], cliIO), 0);
    assert.equal(await main(['agent', 'preview', specFile], cliIO), 0);
    const preview = JSON.parse(cliOutput);
    assert.equal(preview.blocks[0].dataRange, 'B4:E8');
    assert.equal(preview.plan.sheets[0].anchor, 'B4');
    assert.equal(preview.params.month, 6);
    assert.deepEqual(findAmountLike(preview), []);
    assert.equal(await main(['agent', 'preview', 'specs/公司盈利对比表.yaml'], cliIO), 0);
    const comparisonPreview = JSON.parse(cliOutput);
    assert.equal(comparisonPreview.blocks[0].selection.periodType, '本年累计');
    assert.equal(comparisonPreview.blocks[1].selection.metric, 'gross_margin');
    assert.deepEqual(comparisonPreview.blocks[0].cols.labels, ['营业收入', '营业成本', '毛利润', '毛利率']);
    assert.deepEqual(findAmountLike(comparisonPreview), []);
    assert.equal(await main(['agent', 'diff', specFile, specFile], cliIO), 0);
    for (const file of ['SKILL.md', 'AGENT-PROMPT.md']) {
      assert.deepEqual(skillProblems(fs.readFileSync(`skills/bi-lite-ingest/${file}`, 'utf8'), TOOLS.map((tool) => tool.name)), []);
    }
    const server = await import('../src/server.ts');
    stop = () => server.stop();
    const port = await server.start(0);
    const queryCatalog = await (await fetch(`http://127.0.0.1:${port}/api/catalog`)).json();
    assert.equal(queryCatalog.query.fact, 'fact_finance');
    assert.ok(queryCatalog.query.months.includes('2026-06'));
    // Child CLI processes must use the live owner's queue, preserving output and locks.
    const sharedCli = (args: string[]) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [path.join(root, 'bin/bilite.mjs'), ...args], { encoding: 'utf8', timeout: 15000 },
        (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve({ stdout, stderr }));
    });
    fs.writeFileSync('test/fixtures/共享接入.yaml', JSON.stringify({ ...ingest, onConflict: 'replace' }));
    const importedViaService = JSON.parse((await sharedCli(['ingest', 'run', 'test/fixtures/共享接入.yaml'])).stdout);
    assert.equal(importedViaService.inserted, 80);
    assert.equal(importedViaService.archived, true);
    assert.deepEqual(findAmountLike(importedViaService), []);
    const [sharedRender] = await Promise.all([
      sharedCli(['render', specFile, '--out', 'shared.xlsx']), sharedCli(['catalog', 'dump']),
    ]);
    assert.equal(JSON.parse(sharedRender.stdout).cellsWritten, 20);
    assert.deepEqual((await XLSX.fromFileAsync('output/shared.xlsx')).sheet('主要指标').range('B4:E8').value(), expected);
    assert.equal(JSON.parse(fs.readFileSync('.bilite/db.lock', 'utf8')).pid, process.pid);
    const runtimeState = JSON.parse(fs.readFileSync('.bilite/service.json', 'utf8'));
    const operationId = crypto.randomUUID();
    const request = { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + runtimeState.token },
      body: JSON.stringify({ operationId, workspace: runtimeState.workspace, instanceId: runtimeState.instanceId, argv: ['catalog', 'dump'] }) };
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/operations`, { ...request, headers: { 'content-type': 'application/json' } })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/operations`, request)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/operations`, request)).status, 409);
    assert.equal(JSON.parse((await sharedCli(['operation', 'status', operationId])).stdout).status, 'completed');
    const response = await fetch(`http://127.0.0.1:${port}/api/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ measures: [{ metric: '营业收入', periodType: '单月' }], filter: { month: '2026-06' }, audience: 'agent' }),
    });
    assert.equal(response.status, 200);
    const human = await response.json();
    assert.equal(human.meta.audience, 'human');
    assert.equal(human.groups[0].cells[0], expected[0][2]);
    const reportList = await (await fetch(`http://127.0.0.1:${port}/api/specs`)).json();
    assert.deepEqual(reportList.find((s) => s.id === '公司盈利对比表').params, { year: 2026, month: 6, periodType: '本年累计' });
    const requestReport = { specFile: 'specs/公司盈利对比表.yaml', params: { year: 2026, month: 6, periodType: '去年同期累计' } };
    const webPreview = await (await fetch(`http://127.0.0.1:${port}/api/report/preview`, {
      method: 'POST', body: JSON.stringify(requestReport),
    })).json();
    const webBlock = webPreview.sheets[0].blocks[0];
    assert.equal(webBlock.matrix[0].values[0], 55000);
    assert.deepEqual(webBlock.scope.periods, ['去年同期累计']);
    assert.deepEqual(webBlock.scope.filters, [
      { dimension: 'scenario', field: 'scenario', members: ['实际'] }, { dimension: 'ccy', field: 'ccy', members: ['人民币'] },
    ]);
    const webExport = await (await fetch(`http://127.0.0.1:${port}/api/report/render`, {
      method: 'POST', body: JSON.stringify({ ...requestReport, output: '页面参数.xlsx' }),
    })).json();
    const webWorkbook = await XLSX.fromFileAsync(webExport.outputPath);
    assert.equal(webWorkbook.sheet('公司盈利对比').cell('B4').value(), webBlock.matrix[0].values[0]);
    await stop(); stop = undefined;
    assert.equal(fs.existsSync('.bilite/service.json'), false);
    assert.equal(fs.existsSync('.bilite/db.lock'), false);
    await db.close();
    const cli = spawnSync(process.execPath, [root + '/bin/bilite.mjs', 'render', specFile, '--out', 'output/cli.xlsx'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(fs.existsSync('output/cli.xlsx'), true);
    const derivedCli = spawnSync(process.execPath, [root + '/bin/bilite.mjs', 'render', 'specs/盈利指标表.yaml', '--out', 'output/盈利分析.xlsx'], { encoding: 'utf8' });
    assert.equal(derivedCli.status, 0, derivedCli.stderr);
    const comparisonCli = spawnSync(process.execPath, [root + '/bin/bilite.mjs', 'render', 'specs/公司盈利对比表.yaml', '--out', 'output/公司对比.xlsx'], { encoding: 'utf8' });
    assert.equal(comparisonCli.status, 0, comparisonCli.stderr);
    const comparisonWorkbook = await XLSX.fromFileAsync('output/公司对比.xlsx');
    assert.deepEqual(comparisonWorkbook.sheet('公司盈利对比').range('B4:E7').value(), companyValues);
    assert.equal(comparisonWorkbook.sheet('公司毛利率').cell('B4').value(), companyValues[0][3]);
    assert.equal(readNumberFormat(comparisonWorkbook, comparisonWorkbook.sheet('公司盈利对比').cell('E4')), '0.00%');
    fs.writeFileSync('test/fixtures/重放标识.yaml', `id: ${ingest.id}\n`);
    const replayCli = spawnSync(process.execPath, [root + '/bin/bilite.mjs', 'replay', 'test/fixtures/重放标识.yaml'], { encoding: 'utf8' });
    assert.equal(replayCli.status, 0, replayCli.stderr);
    assert.equal(JSON.parse(replayCli.stdout).specSource, 'batch-snapshot');
    // 安装入口从其他目录启动，必须先选择工作区，且初始化不能覆盖既有模型。
    const caller = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-lite-cli-'));
    try {
      const entry = path.join(root, 'bin/bilite.mjs');
      const newWorkspace = path.join(caller, '独立工作区');
      const init = spawnSync(process.execPath, [entry, 'init', newWorkspace, '--preset', 'finance'], { cwd: caller, encoding: 'utf8' });
      assert.equal(init.status, 0, init.stderr);
      assert.equal(fs.existsSync(path.join(newWorkspace, 'models/fact_finance.yml')), true);
      assert.deepEqual(fs.readdirSync(path.join(newWorkspace, 'metrics')), []);
      assert.equal(fs.existsSync(path.join(newWorkspace, 'data/bi.duckdb')), false);
      assert.equal(spawnSync(process.execPath, [entry, 'init', newWorkspace], { cwd: caller }).status, 2);
      const fromElsewhere = spawnSync(process.execPath, [entry, '--workspace', root, 'agent', 'preview', specFile], { cwd: caller, encoding: 'utf8' });
      assert.equal(fromElsewhere.status, 0, fromElsewhere.stderr);
      assert.equal(JSON.parse(fromElsewhere.stdout).blocks[0].dataRange, 'B4:E8');
      assert.equal(spawnSync(process.execPath, [entry, '--version'], { cwd: caller }).status, 0);
      const emptyWorkspace = path.join(caller, '空工作区');
      assert.equal(spawnSync(process.execPath, [entry, 'init', emptyWorkspace], { cwd: caller }).status, 0);
      assert.deepEqual(fs.readdirSync(path.join(emptyWorkspace, 'models')), []);
      const emptyPlan = spawnSync(process.execPath, [entry, '--workspace', emptyWorkspace, 'plan', '--check'], {
        cwd: caller, encoding: 'utf8', env: { ...process.env, BILITE_DB: path.join(emptyWorkspace, 'data/bi.duckdb') },
      });
      assert.equal(emptyPlan.status, 0, emptyPlan.stderr);
    } finally { fs.rmSync(caller, { recursive: true, force: true }); }
    passed('MCP / Web / CLI → 共用引擎与受众边界');
    console.log('6 个核心节点通过；临时数据将清理。');
  } finally {
    if (stop) await stop();
    await db.close();
  }
}
