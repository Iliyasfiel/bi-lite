/**
 * 查询改写器（架构 §7.1 改写面）：把业务形状的查询改写成 MetricsQuery。
 *
 * ★ 判据仍只有一份：本模块**只做形状翻译**，所有硬校验 —— 事实表白名单（FACT_UNKNOWN）、
 *   维度白名单（UNKNOWN_DIMENSION）、维度可用性（DIM_NOT_ON_FACT）、口径注册
 *   （UNKNOWN_PERIOD_TYPE）、量纲维钉住（BAD_MEASURE / PERIOD_TYPE_NOT_ON_FACT）、
 *   受众分级与反推防护 —— 全部在 compileMetrics / queryMetrics（semantic/query.ts），
 *   错误原样上抛，不复制一条判据、不吞一个错误。
 *
 * 语义形状与 MetricsQuery 的差别只有两点（对应人怎么说查询）：
 *   ① 口径是**查询级**的 —— 一句话只有一个口径（"IFRS 口径"），不用每个度量各写一遍；
 *   ② 指标是**成员名列表**（dim_metric.name，"税前利润"），度量列由目标表的声明决定。
 * 架构 §7.3 的 selector（场景/币种 → WHERE）与 calculator（后置计算）在 P5 接进这里：
 * 调用方形状不变，改写器内部扩（compileSemanticQuery 的输出仍是 MetricsQuery）。
 */
import {
  queryMetrics,
  THRESHOLDS,
  QueryRefused,
  type MetricsQuery,
  type MetricsResult,
} from './query.ts';
import { DEFAULT_TARGET } from '../gen/ir.ts';

export interface SemanticQuery {
  /** 目标事实表；省略 = 缺省表（DEFAULT_TARGET，compileMetrics 裁决） */
  fact?: string;
  /** 指标成员名（dim_metric.name）；空 = compileMetrics 报 EMPTY_MEASURES */
  metrics: string[];
  /** 口径（量纲维成员，PERIOD_TYPES）。目标表有口径列时必须给（铁律 17，compileMetrics 把关） */
  caliber?: string;
  /** 分组维度（DIMENSIONS 键） */
  by?: string[];
  /** 维度过滤（键 = DIMENSIONS 键，值 = 成员名） */
  filter?: Record<string, string | string[]>;
  /** 场景 selector（正交维度，P5 刀 22）：落地成 filter.scenario —— 与 filter 冲突时 selector 赢 */
  scenario?: string;
  /** 币种 selector（正交维度，刀 22）：透传 MetricsQuery.ccy —— fx_rate 按行落窗期取率换算 */
  ccy?: string;
  /** 受众由调用入口钉死（铁律 10），不给默认值 */
  audience: 'human' | 'agent';
}

/** 业务形状 → 引擎形状。纯函数。 */
export function compileSemanticQuery(sq: SemanticQuery): MetricsQuery {
  return {
    fact: sq.fact,
    measures: sq.metrics.map((metric) => ({ metric, periodType: sq.caliber })),
    groupBy: sq.by ?? [],
    // selector 赢过显式 filter：一个查询只有一个主场景，filter 里残留的 scenario 是旧形状
    filter: { ...sq.filter, ...(sq.scenario ? { scenario: sq.scenario } : {}) },
    ccy: sq.ccy,
    audience: sq.audience,
  };
}

// ---------------- calculator 口径（铁律 5 第三件）----------------
//
// 单月同比这类口径不落事实表行（SQL 里没有这种行），在语义层组合两条**正规查询**算出来：
//   腿 A = operand 口径 as-of 查询期间；腿 B = 同一查询、期间过滤平移 −1 年（去年同月）。
// 两条腿都过 compileMetrics 的全部防线（白名单 / 钉住 / 受众阈值），比率不是绕过而是复用。
// 输出是**比率**，不是金额：不进 band()；两条腿各自的 minSupport 约束仍然生效。

type Run = Parameters<typeof queryMetrics>[1];
type Facts = Parameters<typeof queryMetrics>[2];

/** 期间过滤值平移 −1 年（month: 2026-06 → 2025-06；year: 2026 → 2025），其余维度原样 */
function shiftFilterBack(
  filter?: Record<string, string | string[]>,
): Record<string, string | string[]> | undefined {
  if (!filter) return filter;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(filter)) {
    const back = (x: string): string => {
      if (k === 'month' && /^\d{4}-\d{2}$/.test(x)) return `${Number(x.slice(0, 4)) - 1}${x.slice(4)}`;
      if (k === 'year' && /^\d{4}$/.test(x)) return String(Number(x) - 1);
      return x;
    };
    out[k] = Array.isArray(v) ? v.map(back) : back(v);
  }
  return out;
}

/** 腿 B 的分组标签 +1 年对齐 x 腿（腿落在去年，报的是今年 —— 与 compileMetrics 同一约定） */
function labelForward(x: string | null): string | null {
  if (x === null) return null;
  if (/^\d{4}-\d{2}$/.test(x)) return `${Number(x.slice(0, 4)) + 1}${x.slice(4)}`;
  if (/^\d{4}$/.test(x)) return String(Number(x) + 1);
  return x;
}

async function runCalculator(
  sq: SemanticQuery,
  operand: string,
  run: Run,
  facts: Facts,
): Promise<MetricsResult> {
  const legA = await queryMetrics(compileSemanticQuery({ ...sq, caliber: operand }), run, facts);
  const legB = await queryMetrics(
    compileSemanticQuery({ ...sq, caliber: operand, filter: shiftFilterBack(sq.filter) }),
    run,
    facts,
  );

  const keyOf = (values: Array<string | null>): string => values.join('');
  // 空查询会从 queryMetrics 带回一个"幻影组"（零分组维度聚合空集 → 一行全 NULL）；
  // 对比前先把幻影组滤掉 —— 没有数据就是没有数据，不能当成一个分组参与配对。
  const isPhantom = (g: { values: Array<string | null>; cells: Array<number | null> }): boolean =>
    g.values.length === 0 && g.cells.every((c) => c === null);
  const legAReal = legA.groups.filter((g) => !isPhantom(g));
  const legBReal = legB.groups.filter((g) => !isPhantom(g));
  const byB = new Map(legBReal.map((g) => [keyOf(g.values.map(labelForward)), g]));

  // 缺去年腿的组：整体拒绝，不静默 —— 出数里混一个 null 比拒绝更危险（铁律 14 同一立场）。
  // 查询期间连今年腿都没有，同样是缺操作数（写错期间不该得到一表 0%）。
  const missing = legAReal.filter((g) => !byB.has(keyOf(g.values))).length;
  if (legAReal.length === 0 || missing > 0) {
    throw new QueryRefused(
      legAReal.length === 0
        ? `同比缺操作数：查询期间没有任何「${operand}」数据，拒绝出数（铁律 5：缺操作数不静默）。`
        : `同比缺去年腿：${missing} 个分组没有去年同月的「${operand}」数据，拒绝出数（铁律 5：缺操作数不静默）。`,
      'CALIBER_OPERAND_MISSING',
    );
  }

  const groups = legAReal.map((g) => {
    const b = byB.get(keyOf(g.values))!;
    const cells = g.cells.map((a, i) => {
      const bb = b.cells[i];
      // 操作数缺格或除零（去年 = 0）→ 该格无解；其余格照算 —— 组存在性已经把关
      if (typeof a !== 'number' || typeof bb !== 'number' || bb === 0) return null;
      return (a - bb) / bb;
    });
    return { values: g.values, cells };
  });

  return {
    columns: legA.columns.map((c) => ({
      ...c,
      label: sq.caliber ? `${c.metric}·${sq.caliber}` : c.label,
      periodType: sq.caliber ?? '',
    })),
    groups,
    meta: {
      audience: sq.audience,
      redaction: 'none', // 比率不是金额，不进 band；两条腿的受众阈值已在各自的 queryMetrics 里生效
      rowCount: groups.length,
      cellCount: groups.reduce((a, g) => a + g.cells.filter((c) => c !== null).length, 0),
      minSupport: Math.min(legA.meta.minSupport, legB.meta.minSupport),
      truncated: false,
      thresholds: THRESHOLDS[sq.audience],
    },
  };
}

/** 改写 + 执行一步到位；参数透传 queryMetrics（run 供 e2e 注入独立连接）。
 *  calculator 检测与 compileMetrics 同一解析规则（同一份 facts 注入，不另立判据）。 */
export async function runSemanticQuery(
  sq: SemanticQuery,
  run?: Run,
  facts?: Facts,
): Promise<MetricsResult> {
  // 缺省表也按声明解析（与 compileMetrics 同一规则）：calculator 是否、操作数是什么，
  // 都长在声明的 calibers 上 —— 不查声明，calculator 查询会漏到 SQL 路去。
  const fact = (facts ?? []).find((f) => f.name === (sq.fact ?? DEFAULT_TARGET)) ?? null;
  const cal = sq.caliber ? (fact?.calibers ?? []).find((c) => c.name === sq.caliber) : undefined;
  if (cal?.calculator) {
    return runCalculator(sq, cal.operand ?? '', run, facts);
  }
  return queryMetrics(compileSemanticQuery(sq), run, facts);
}
