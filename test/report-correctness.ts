/** 独立合成内存库：不读 data/，期望值来自下面的常量与手算。 */
import { DuckDBInstance } from '@duckdb/node-api';
import { declaredFactsOf, diagnoseModel } from '../src/gen/parse.ts';
import { queryMetrics, compileMetrics, QueryRefused, type MetricsQuery } from '../src/semantic/query.ts';
import { lintSpec } from '../src/spec/lint.ts';
import { compileBlock, runCompiled } from '../src/spec/compile.ts';
import { semanticFactOf } from '../src/semantic/introspect.ts';
import type { Block, Spec } from '../src/spec/types.ts';
import fs from 'node:fs';

export async function reportCorrectnessChecks(check: (name: string, ok: boolean) => void) {
  const facts = declaredFactsOf();
  const instance = await DuckDBInstance.create(':memory:', { enable_external_access: 'false' });
  const con = await instance.connect();
  try {
    await con.run(`CREATE TABLE dim_metric(id VARCHAR, name VARCHAR);
      CREATE TABLE dim_fx_rate(rate_month DATE, ccy VARCHAR, rate DOUBLE);
      CREATE TABLE fact_finance(fin_month DATE, period_from DATE, company_id VARCHAR, metric_id VARCHAR, scenario VARCHAR, ccy VARCHAR, amount DOUBLE);
      INSERT INTO dim_metric VALUES ('m', '测试指标');
      INSERT INTO fact_finance VALUES
        ('2026-02-01','2026-01-01','c','m','实际','人民币',100),
        ('2026-03-01','2026-01-01','c','m','实际','人民币',200),
        ('2026-02-01','2026-01-01','c','m','预算','人民币',50),
        ('2026-02-01','2026-01-01','c','m','实际','美元',20);
      INSERT INTO dim_fx_rate VALUES ('2026-02-01','人民币',1), ('2026-02-01','美元',7);`);
    const run = async (sql: string) => (await con.runAndReadAll(sql)).getRowObjectsJson();
    const base: MetricsQuery = { measures: [{ metric: '测试指标', periodType: '本年累计' }], filter: { month: '2026-02' }, audience: 'human' };
    const ask = (q: Partial<MetricsQuery> = {}) => queryMetrics({ ...base, ...q }, run, facts);
    const reason = async (q: Partial<MetricsQuery>) => {
      try { await ask(q); return 'accepted'; }
      catch (e) { if (e instanceof QueryRefused) return e.reason; throw e; }
    };
    check('A：默认场景/币种由模型投影到语义目录', semanticFactOf('fact_finance')?.queryDefaults.scenario === '实际');
    check('A：默认查询只取实际人民币，不混预算与美元', (await ask()).groups[0].cells[0] === 100);
    check('A：显式预算替代默认实际', (await ask({ filter: { month: '2026-02', scenario: '预算' } })).groups[0].cells[0] === 50);
    check('A：显式美元替代默认人民币', (await ask({ filter: { month: '2026-02', ccy: '美元' } })).groups[0].cells[0] === 20);
    check('A：场景轴保留实际与预算两组', (await ask({ groupBy: ['scenario'] })).groups.length === 2);
    check('A：币种轴保留人民币与美元两组', (await ask({ groupBy: ['ccy'] })).groups.length === 2);
    check('A：未分组的多场景选择拒绝', await reason({ filter: { month: '2026-02', scenario: ['实际', '预算'] } }) === 'DIM_MIXED_AGGREGATION');
    check('A：未换算/分组的多币种选择拒绝', await reason({ filter: { month: '2026-02', ccy: ['人民币', '美元'] } }) === 'DIM_MIXED_AGGREGATION');
    check('A：只筛年份不能加总累计快照', await reason({ filter: { year: '2026' } }) === 'CUMULATIVE_TIME_UNPINNED');
    check('A：按年分组仍不能加总累计快照', await reason({ filter: {}, groupBy: ['year'] }) === 'CUMULATIVE_TIME_UNPINNED');
    check('A：多月份筛选不能折成累计合计', await reason({ filter: { month: ['2026-02', '2026-03'] } }) === 'CUMULATIVE_TIME_UNPINNED');
    check('A：非法月份不能绕过期末约束', await reason({ filter: { month: '2026-99' } }) === 'CUMULATIVE_TIME_UNPINNED');
    const months = await ask({ filter: { year: '2026' }, groupBy: ['month'] });
    check('A：月份分组保留两个累计快照', JSON.stringify(months.groups.map((g) => g.cells[0]).sort()) === '[100,200]');
    check('A：统一换算包含所有记账币种，期望 100 + 20 × 7', (await ask({ ccy: '人民币' })).groups[0].cells[0] === 240);
    check('A：缺月份汇率拒绝部分合计', await reason({ filter: { year: '2026' }, groupBy: ['month'], ccy: '人民币' }) === 'FX_RATE_MISSING');
    check('A：LIMIT 不能藏住其他组的缺汇率', await reason({ filter: { year: '2026' }, groupBy: ['month'], ccy: '人民币', limit: 1 }) === 'FX_RATE_MISSING');
    await con.run("INSERT INTO dim_fx_rate VALUES ('2026-02-01','美元',7)");
    check('A：重复汇率键拒绝，不能倍增事实', await reason({ ccy: '人民币' }) === 'FX_RATE_MISSING');
    await con.run("DELETE FROM dim_fx_rate WHERE ccy = '美元'; INSERT INTO dim_fx_rate VALUES ('2026-02-01','美元',0)");
    check('A：零汇率拒绝而非静默丢值', await reason({ ccy: '人民币' }) === 'FX_RATE_MISSING');
    check('A：未参与当前口径的缺率不会误伤人民币原值查询', (await ask()).groups[0].cells[0] === 100);

    const block: Block = { anchor: 'B2', rows: { dim: 'metric', order: ['测试指标'] }, cols: { dim: 'period_type', order: ['本年累计'] }, value: { measure: 'amount' }, scope: { time: { year: 2026, month: 2 } } };
    const spec = (b: Block): Spec => ({ id: 'test', sheets: [{ name: 'test', blocks: [b] }] });
    const lint = (b: Block) => lintSpec(spec(b), { facts });
    const value = await runCompiled(compileBlock(block, {}, { facts }), run);
    check('A：报表与自由查询均默认实际人民币，期望 100', value.matrix[0].values[0] === 100);
    check('A：报表累计缺期末在 lint 拒绝', lint({ ...block, scope: {} }).some((i) => i.code === 'CUMULATIVE_TIME_UNPINNED'));
    let blocked = false;
    try { compileBlock({ ...block, scope: {} }, {}, { facts }); } catch (e) { blocked = String(e).includes('CUMULATIVE_TIME_UNPINNED'); }
    check('A：绕过 parse 的直接报表编译也拒绝缺期末', blocked);
    const multi = { ...block, scope: { ...block.scope, filter: { scenario: { scenario: ['实际', '预算'] } } } };
    check('A：报表混场景使用同一 lint 判据拒绝', lint(multi).some((i) => i.code === 'DIM_MIXED_AGGREGATION'));
    const symbolic = { ...block, scope: { time: { year: '{{year}}', month: '{{month}}' } } };
    blocked = false;
    try { compileBlock(symbolic, { year: 2026, month: 99 }, { facts }); } catch (e) { blocked = String(e).includes('CUMULATIVE_TIME_UNPINNED'); }
    check('A：参数替换后再次 lint，非法月份不能绕过', blocked);
    check('A：响应展示实际采用的默认范围', (await ask()).meta.appliedFilter?.ccy === '人民币');
    check('A：换汇不注入默认记账币种筛选', compileMetrics({ ...base, ccy: '人民币' }, facts).appliedFilter.ccy === undefined);
    const currencyMixed = { ...block, scope: { ...block.scope, filter: { ccy: { ccy: ['人民币', '美元'] } } } };
    check('A：报表混币种解析即拒绝', lint(currencyMixed).some((i) => i.code === 'DIM_MIXED_AGGREGATION'));
    const monthly = { ...block, rows: { dim: 'month', order: ['2026-02', '2026-03'] }, scope: { filter: { metric: { name: '测试指标' } } } };
    const monthlyResult = await runCompiled(compileBlock(monthly, {}, { facts }), run);
    check('A：报表月份轴逐月保留累计值', JSON.stringify(monthlyResult.matrix.map((r) => r.values[0])) === '[100,200]');
    check('A：平移累计不借物理月份轴错配报告期', lint({ ...monthly, cols: { dim: 'period_type', order: ['去年同期累计'] } }).some((i) => i.code === 'CUMULATIVE_TIME_UNPINNED'));
    await con.run("DELETE FROM dim_fx_rate WHERE ccy = '美元'; INSERT INTO dim_fx_rate VALUES ('2026-02-01','美元',NULL)");
    check('A：NULL 汇率拒绝部分换算', await reason({ ccy: '人民币' }) === 'FX_RATE_MISSING');
    await con.run("DELETE FROM dim_fx_rate WHERE ccy = '美元'; INSERT INTO dim_fx_rate VALUES ('2026-02-01','美元',-7)");
    check('A：负汇率拒绝部分换算', await reason({ ccy: '人民币' }) === 'FX_RATE_MISSING');
    await con.run("DELETE FROM dim_fx_rate WHERE ccy = '美元'; INSERT INTO dim_fx_rate VALUES ('2026-02-01','美元','NaN'::DOUBLE)");
    check('A：NaN 汇率拒绝而不是生成空格', await reason({ ccy: '人民币' }) === 'FX_RATE_MISSING');
    await con.run("DELETE FROM dim_fx_rate WHERE ccy = '美元'; INSERT INTO dim_fx_rate VALUES ('2026-02-01','美元','Infinity'::DOUBLE)");
    check('A：无穷汇率拒绝而不是生成空格', await reason({ ccy: '人民币' }) === 'FX_RATE_MISSING');
    const model = fs.readFileSync('models/fact_finance.yml', 'utf8');
    check('A：非法默认维度声明解析即拒绝', diagnoseModel(model.replace('scenario: 实际', 'amount: 实际'), 'fact_finance.yml').table === null);
    check('A：默认值不可夹带数值', diagnoseModel(model.replace('scenario: 实际', 'scenario: 100'), 'fact_finance.yml').table === null);
    check('A：编译默认过滤的字符串转义保持完整', compileMetrics({ ...base, filter: { month: '2026-02', scenario: "实'际" } }, facts).sql.includes("'实''际'"));
  } finally {
    con.closeSync();
    instance.closeSync();
  }
}
