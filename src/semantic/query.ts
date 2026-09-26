/**
 * 语义层：query_metrics（docs/需求与架构.md §6.2 第③④层、F6）
 *
 * 这是**唯一**的自由查询入口。所有查询都必须经过这里，理由有两个：
 *   1. 维度只能来自 compile.ts 的 DIMENSIONS 白名单 —— 没有第二条拼 SQL 的路
 *   2. 按「受众」决定脱敏与阈值 —— 同一条查询，给人和给 agent 的返回不同
 *
 * ★ 最重要的设计决定：聚合阈值与脱敏是「受众」的属性，不是「查询」的属性。
 *   威胁模型（§6.1）针对的是 **agent 能自由查询 → 逐维组合拼凑出单月明细**。
 *   人和 agent 的授权等级本来就不同：
 *     - audience='human'（Web 看板，已授权的财务人员）→ 精确值，无阈值
 *     - audience='agent'（LLM）→ 只返回分档值（"12.3亿"）+ 最小单元格阈值
 *   把阈值一刀切加在查询上会毁掉 Web 看板（人就是要看单月单指标的数）。
 */
import { DIMENSIONS, isRegisteredDim, type DimName } from '../spec/compile.ts';
import { PERIOD_TYPES } from '../db/schema.ts';
import { query } from '../db/index.ts';

// ---------------- 元数据（无金额，可安全给 agent 与前端） ----------------

export interface Catalog {
  dimensions: Array<{ name: string; label: string; kind: 'dimension' }>;
  periodTypes: Array<{ id: string; label: string; derivable: boolean }>;
  metrics: Array<{ id: string; name: string; category: string | null; unit: string | null }>;
  companies: Array<{ id: string; name: string; group_name: string | null; level: number | null }>;
}

/** 维度/口径的静态部分 —— 全部来自白名单与注册表，零 DB 访问 */
export function staticCatalog() {
  return {
    dimensions: (Object.keys(DIMENSIONS) as DimName[]).map((name) => ({
      name,
      label: DIM_LABELS[name],
      kind: 'dimension' as const,
    })),
    periodTypes: PERIOD_TYPES.map((p) => ({ id: p.id, label: p.label, derivable: p.derivable })),
  };
}

const DIM_LABELS: Record<DimName, string> = {
  metric: '指标',
  company: '公司',
  period_type: '口径',
  month: '月份',
  year: '年份',
};

/** 完整目录（含 DB 里的公司/指标主数据）—— 只有元数据，不含任何金额 */
export async function catalog(): Promise<Catalog> {
  const metrics = await query<{ id: string; name: string; category: string | null; unit: string | null }>(
    'SELECT id, name, category, unit FROM dim_metric ORDER BY name',
  );
  const companies = await query<{ id: string; name: string; group_name: string | null; level: number | null }>(
    'SELECT id, name, group_name, level FROM dim_company ORDER BY level NULLS LAST, name',
  );
  return { ...staticCatalog(), metrics, companies };
}

// ---------------- 查询定义 ----------------

export interface MeasureRef {
  metric: string;                                               // 指标名（值，非标识符）
  periodType: string;                                           // 口径
  agg?: 'sum' | 'avg' | 'max' | 'min' | 'count';
}

export interface MetricsQuery {
  measures: MeasureRef[];
  groupBy?: string[];                                           // 只能取 DIMENSIONS 的键
  filter?: Record<string, string | string[]>;
  limit?: number;
  audience: 'human' | 'agent';
}

export interface MetricsResult {
  columns: Array<{ key: string; label: string; metric: string; periodType: string; agg: string }>;
  groups: Array<{ values: Array<string | null>; cells: Array<number | string | null> }>;
  meta: {
    audience: 'human' | 'agent';
    redaction: 'none' | 'banded';
    rowCount: number;
    cellCount: number;
    /** 每格背后最少的明细行数 —— 反推保护的判据 */
    minSupport: number;
    truncated: boolean;
    thresholds: { minSupport: number; maxRows: number };
  };
}

export class QueryRefused extends Error {
  // ⚠️ Node 原生 TS 是 strip-only 模式，不支持构造函数参数属性（parameter property）
  reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = 'QueryRefused';
    this.reason = reason;
  }
}

/**
 * 阈值：只对 agent 生效。见文件头说明。
 *
 * minSupport 是**每格背后的明细行数**下限。取 3 的理由：
 * 财务口径里"累计"类通常覆盖多个月（1 格 ≥ 6 行），而"单月 × 单指标 × 单公司"恰好 = 1 行。
 * 阈值 3 恰好把后者挡住，同时不误伤正常的看板查询。
 */
export const THRESHOLDS = {
  human: { minSupport: 0, maxRows: 5000 },
  agent: { minSupport: 3, maxRows: 200 },
} as const;

// ---------------- SQL 编译 ----------------

function q(v: string | number): string {
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

const AGGS = new Set(['sum', 'avg', 'max', 'min', 'count']);

/**
 * 把 MetricsQuery 编译成参数化 SQL。
 * 标识符（维度名）走白名单，值（指标名/口径/过滤值）走 q() 转义。
 */
export function compileMetrics(mq: MetricsQuery): { sql: string; columns: MetricsResult['columns'] } {
  if (!Array.isArray(mq.measures) || mq.measures.length === 0) {
    throw new QueryRefused('measures 不能为空', 'EMPTY_MEASURES');
  }

  const groupBy = mq.groupBy ?? [];
  for (const d of groupBy) {
    if (!isRegisteredDim(d)) {
      throw new QueryRefused(`未注册的维度: ${d}（只允许 ${Object.keys(DIMENSIONS).join(' / ')}）`, 'UNKNOWN_DIMENSION');
    }
  }

  const allowedPeriods = new Set(PERIOD_TYPES.map((p) => p.id));

  // 分组表达式
  const groupExprs = groupBy.map((d) => {
    const dim = DIMENSIONS[d as DimName];
    return dim.table ? `${dim.table}.${dim.labelCol}` : dim.labelCol;
  });

  // 度量列：条件聚合，别名用序号避免中文别名问题。
  // 同时输出每格的**支撑事实行数** n{i} —— 这才是反推保护该看的指标（见文件头与 §6.2）。
  const columns: MetricsResult['columns'] = [];
  const colExprs = mq.measures.map((m, i) => {
    const agg = m.agg ?? 'sum';
    if (!AGGS.has(agg)) throw new QueryRefused(`不支持的聚合: ${agg}`, 'BAD_AGG');
    if (!m.metric || !m.periodType) {
      throw new QueryRefused(`measures[${i}] 需要 metric 与 periodType`, 'BAD_MEASURE');
    }
    if (!allowedPeriods.has(m.periodType)) {
      throw new QueryRefused(
        `未注册的口径: ${m.periodType}（只允许 ${[...allowedPeriods].join(' / ')}）`,
        'UNKNOWN_PERIOD_TYPE',
      );
    }
    columns.push({
      key: `m${i}`,
      label: m.periodType === '单月' || m.periodType === '单月同比' ? `${m.metric}·${m.periodType}` : `${m.metric}（${m.periodType}）`,
      metric: m.metric,
      periodType: m.periodType,
      agg,
    });
    const cond = `dim_metric.name = ${q(m.metric)} AND f.period_type = ${q(m.periodType)}`;
    return `${agg}(CASE WHEN ${cond} THEN f.amount END) AS m${i},\n  count(CASE WHEN ${cond} THEN 1 END) AS n${i}`;
  });

  // join（去重）
  const joins = new Set<string>(['JOIN dim_metric ON f.metric_id = dim_metric.id']);
  for (const d of groupBy) {
    const j = DIMENSIONS[d as DimName].joinOn;
    if (j) joins.add(`JOIN ${DIMENSIONS[d as DimName].table} ON ${j}`);
  }

  // WHERE
  const where: string[] = [];
  for (const [col, val] of Object.entries(mq.filter ?? {})) {
    // 过滤的键是个「维度名.字段名」或裸字段名？统一按已注册维度处理：键必须是维度名
    if (!isRegisteredDim(col)) {
      throw new QueryRefused(`过滤字段未注册: ${col}（只允许 ${Object.keys(DIMENSIONS).join(' / ')}）`, 'UNKNOWN_FILTER');
    }
    const dim = DIMENSIONS[col as DimName];
    const ref = dim.table ? `${dim.table}.${dim.labelCol}` : dim.labelCol;
    if (Array.isArray(val)) {
      if (val.length === 0) throw new QueryRefused(`过滤条件 ${col} 是空数组`, 'EMPTY_FILTER');
      where.push(`${ref} IN (${val.map((v) => q(String(v))).join(', ')})`);
    } else {
      where.push(`${ref} = ${q(String(val))}`);
    }
  }

  const limits = THRESHOLDS[mq.audience];
  const maxRows = Math.min(mq.limit ?? limits.maxRows, limits.maxRows);

  const sql = [
    groupExprs.length ? `SELECT ${groupExprs.join(', ')},` : 'SELECT',
    '  ' + colExprs.join(',\n  '),
    'FROM fact_finance f',
    ...[...joins],
    where.length ? 'WHERE ' + where.join(' AND ') : '',
    groupExprs.length ? 'GROUP BY ALL' : '',
    `LIMIT ${maxRows}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { sql, columns };
}

// ---------------- 脱敏（第④层） ----------------

/**
 * 金额分档 —— 只给 agent 用。
 * 保留约 2 位有效数字，让 agent 能判断量级与趋势，但无法还原精确账面值。
 */
export function band(value: number | null): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const sign = value < 0 ? '-' : '';
  const v = Math.abs(value);
  if (v >= 1e8) return `${sign}${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${sign}${(v / 1e4).toFixed(1)}万`;
  if (v >= 1e3) return `${sign}${(v / 1e3).toFixed(1)}千`;
  return `${sign}${v.toFixed(0)}`;
}

// ---------------- 执行 ----------------

/**
 * 执行自由查询。**这是唯一的查询出口。**
 *
 * 安全不变量：
 *   - 维度走白名单（compileMetrics 里校验）
 *   - audience='agent' 时返回分档值 + 最小单元格阈值
 *   - 所有调用都必须记审计（由调用方通过 audit 钩子记录）
 */
export async function queryMetrics(
  mq: MetricsQuery,
  run: (sql: string) => Promise<Record<string, unknown>[]> = query,
): Promise<MetricsResult> {
  const limits = THRESHOLDS[mq.audience];
  const { sql, columns } = compileMetrics(mq);

  const raw = await run(sql);
  const groupCount = (mq.groupBy ?? []).length;

  // 每个返回格的支撑事实行数（反推保护的真正依据，§6.2）
  const support: number[] = [];

  const groups = raw.map((r) => {
    const values: Array<string | null> = [];
    for (let i = 0; i < groupCount; i++) {
      // GROUP BY 的列在结果里按顺序排在最前，键名是维度表达式 —— 用序号取更稳
      const key = Object.keys(r)[i];
      const v = r[key];
      values.push(v === null || v === undefined ? null : String(v));
    }
    const cells = columns.map((c, i) => {
      const v = r[c.key];
      const n = Number(r[`n${i}`] ?? 0);
      if (v !== null && v !== undefined && Number.isFinite(n)) support.push(n);
      if (v === null || v === undefined) return null;
      const num = Number(v);
      if (!Number.isFinite(num)) return null;
      return mq.audience === 'agent' ? band(num) : num;
    });
    return { values, cells };
  });

  const cellCount = groups.reduce((a, g) => a + g.cells.filter((c) => c !== null).length, 0);
  const minSupport = support.length ? Math.min(...support) : 0;

  // 聚合阈值：只对 agent 生效（防逐维反推，R5）。
  // 判据是**每格背后的明细行数**，不是单元格个数 ——
  // 公司 × 指标 各取一格时单元格很多，但每格只有 1 行明细支撑，正是最该拒绝的探测式查询。
  if (mq.audience === 'agent' && minSupport < limits.minSupport) {
    throw new QueryRefused(
      `结果过于精细（每格仅 ${minSupport} 行明细支撑 < 阈值 ${limits.minSupport}），拒绝返回。` +
        `请放宽维度或改用累计口径以覆盖更多明细行。`,
      'TOO_FINE_GRAINED',
    );
  }

  return {
    columns,
    groups,
    meta: {
      audience: mq.audience,
      redaction: mq.audience === 'agent' ? 'banded' : 'none',
      rowCount: groups.length,
      cellCount,
      minSupport,
      truncated: raw.length >= limits.maxRows,
      thresholds: { minSupport: limits.minSupport, maxRows: limits.maxRows },
    },
  };
}
