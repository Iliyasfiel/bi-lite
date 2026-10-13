/** 六个主链路节点。在临时副本中运行；不读取或改写项目 data/。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[2] !== '--isolated') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-lite-e2e-'));
  try {
    for (const dir of ['src', 'models', 'ingest', 'specs', 'skills']) {
      fs.cpSync(path.join(root, dir), path.join(tmp, dir), { recursive: true });
    }
    fs.mkdirSync(path.join(tmp, 'test'));
    for (const file of ['e2e.ts', 'make-fixtures.ts']) {
      fs.copyFileSync(path.join(root, 'test', file), path.join(tmp, 'test', file));
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(tmp, 'package.json'));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
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
    await db.open();
    const plan = await planModels(loadModels());
    assert.equal(plan.structural.length + plan.blocking.length, 0);
    assert.equal(await count('fact_finance'), 0);
    passed('模型声明 → 空库启动');

    const cat = await masterCatalog();
    const ingest = parseIngestSpec(fs.readFileSync('ingest/月度经营接入.yaml', 'utf8'), {
      facts: cat.facts, periodTypes: cat.periodTypes,
    });
    // 2. 试运行给出可执行结论、无写入，也不返回金额。
    const dry = await runIngest(ingest, { catalog: cat, planOnly: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.errors.length, 0);
    assert.deepEqual(findAmountLike(dry), []);
    assert.equal(await count('raw_file') + await count('stg_fact_rows') + await count('dim_company'), 0);
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
    assert.equal((await replaySpec(ingest)).ok, true);
    fs.writeFileSync(ingest.source, sourceBytes);
    passed('导入 → 事实/标准化/归档、重复拒绝、库内重放');

    // 4. 一组独立合成数据验证口径，不扩展成参数排列。
    const { DuckDBInstance } = await import('@duckdb/node-api');
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
    passed('报表规格 → 正确矩阵、模板保真导出');

    // 6. MCP 只给结构；HTTP 由入口决定 human；CLI 在释放库后实际渲染。
    const sourceView = await callTool('look_at_source', { source: ingest.source });
    assert.equal(sourceView.ok, true);
    const view = JSON.parse(sourceView.text);
    assert.deepEqual(findAmountLike(view), []);
    assert.match(sourceView.text, /"num": true/);
    const toolRender = await callTool('render_report', { specFile, output: 'output/mcp.xlsx' });
    assert.equal(toolRender.ok, true);
    assert.deepEqual(findAmountLike(JSON.parse(toolRender.text)), []);
    const { main } = await import('../src/cli.ts');
    const cliIO = { out: () => {}, err: (message: string) => { if (message.includes('failed')) throw new Error(message); } };
    assert.equal(await main(['agent', 'look', ingest.source], cliIO), 0);
    assert.equal(await main(['agent', 'template', '--template', 'test/fixtures/月度保送表.xlsx'], cliIO), 0);
    assert.equal(await main(['agent', 'preview', specFile], cliIO), 0);
    assert.equal(await main(['agent', 'diff', specFile, specFile], cliIO), 0);
    for (const file of ['SKILL.md', 'AGENT-PROMPT.md']) {
      assert.deepEqual(skillProblems(fs.readFileSync(`skills/bi-lite-ingest/${file}`, 'utf8'), TOOLS.map((tool) => tool.name)), []);
    }
    const server = await import('../src/server.ts');
    stop = server.stop;
    const port = await server.start(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/query`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ measures: [{ metric: '营业收入', periodType: '单月' }], filter: { month: '2026-06' }, audience: 'agent' }),
    });
    assert.equal(response.status, 200);
    const human = await response.json();
    assert.equal(human.meta.audience, 'human');
    assert.equal(human.groups[0].cells[0], expected[0][2]);
    await stop(); stop = undefined;
    await db.close();
    const cli = spawnSync(process.execPath, ['src/cli.ts', 'render', specFile, '--out', 'output/cli.xlsx'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(fs.existsSync('output/cli.xlsx'), true);
    passed('MCP / Web / CLI → 共用引擎与受众边界');
    console.log('6 个核心节点通过；临时数据将清理。');
  } finally {
    if (stop) await stop();
    await db.close();
  }
}
