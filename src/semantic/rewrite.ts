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
import { queryMetrics, type MetricsQuery } from './query.ts';

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
  /** 受众由调用入口钉死（铁律 10），不给默认值 */
  audience: 'human' | 'agent';
}

/** 业务形状 → 引擎形状。纯函数。 */
export function compileSemanticQuery(sq: SemanticQuery): MetricsQuery {
  return {
    fact: sq.fact,
    measures: sq.metrics.map((metric) => ({ metric, periodType: sq.caliber })),
    groupBy: sq.by ?? [],
    filter: sq.filter,
    audience: sq.audience,
  };
}

/** 改写 + 执行一步到位；参数透传 queryMetrics（run 供 e2e 注入独立连接）。 */
export function runSemanticQuery(
  sq: SemanticQuery,
  run?: Parameters<typeof queryMetrics>[1],
  facts?: Parameters<typeof queryMetrics>[2],
): ReturnType<typeof queryMetrics> {
  return queryMetrics(compileSemanticQuery(sq), run, facts);
}
