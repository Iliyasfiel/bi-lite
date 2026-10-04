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
import { DIMENSIONS, dimAvailableOn, isRegisteredDim, type DimName } from '../spec/compile.ts';
import { PERIOD_TYPES } from '../db/schema.ts';
import { query } from '../db/index.ts';
import { DEFAULT_TARGET, type DeclaredFact } from '../gen/ir.ts';

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
  business_line: '业务线',
  scenario: '场景',
  ccy: '币种',
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
  /** 口径 —— 只有带口径列的事实表需要（fact_finance）；运营事实表没有口径体系（铁律 8） */
  periodType?: string;
  agg?: 'sum' | 'avg' | 'max' | 'min' | 'count';
}

export interface MetricsQuery {
  measures: MeasureRef[];
  /**
   * 目标事实表 —— 省略 = 缺省表（gen/ir.ts 的 DEFAULT_TARGET）。
   * 必须已在 models/*.yml 声明（kind: fact），compileMetrics 白名单硬校验：
   * 表名会原样拼进 SQL（铁律 2），能进 FROM 的名字永远来自声明，不是调用方的裸字符串。
   */
  fact?: string;
  groupBy?: string[];                                           // 只能取 DIMENSIONS 的键
  filter?: Record<string, string | string[]>;
  /**
   * 币种 selector（正交维度，P5 刀 22）：把金额按**行落窗期**换算成该币种
   * （f.amount × fx_s.rate / fx_u.rate，fx_rate 按月取率）。省略 = 原样返回记账币种金额。
   * 只对声明了 ccy 列的表有意义 —— 否则 CCY_NOT_ON_FACT（静默忽略 = 以为在换算其实没有）。
   */
  ccy?: string;
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
 *
 * 目标表声明化（与 compile.ts 同一堵墙）：
 *   - `mq.fact` 省略 = 缺省表；有值就必须在 `facts`（declaredFactsOf() 注入）里，否则 FACT_UNKNOWN；
 *   - 能进 FROM 的表名永远来自声明（fact.name），不是调用方的裸字符串（铁律 2）；
 *   - 维度（groupBy/filter）必须真的长在目标表上（dimAvailableOn），否则 DIM_NOT_ON_FACT；
 *   - 目标表没有口径列时：measures 只要 metric（periodType 可选）；
 *     多给的 periodType 报 PERIOD_TYPE_NOT_ON_FACT —— 与接入侧 TARGET_NO_PERIOD_TYPE 同一个理由：
 *     静默忽略会让写的人以为条件在起作用。
 */
export function compileMetrics(
  mq: MetricsQuery,
  facts?: DeclaredFact[],
): { sql: string; columns: MetricsResult['columns'] } {
  if (!Array.isArray(mq.measures) || mq.measures.length === 0) {
    throw new QueryRefused('measures 不能为空', 'EMPTY_MEASURES');
  }

  // ---- 目标表解析 ----
  const factName = mq.fact && mq.fact.trim() !== '' ? mq.fact : undefined;
  // 缺省表也按声明解析（口径白名单 = 声明的 calibers，窗口谓词要 windowFrom ——
  // 不查声明，查询就悄悄退回旧路 period_type，判据从这里开始漂）；
  // 调用方没注入 facts 时保持 null（表名仍落 DEFAULT_TARGET，旧行为不变）。
  const fact: DeclaredFact | null = (facts ?? []).find(
    (f) => f.name === (factName ?? DEFAULT_TARGET),
  ) ?? null;
  if (factName && !fact) {
    throw new QueryRefused(
      `目标表未声明: ${factName} —— 表名会原样拼进 SQL（铁律 2），只接受 models/*.yml 里声明过的事实表（kind: fact）。`,
      'FACT_UNKNOWN',
    );
  }
  const tableName = fact?.name ?? DEFAULT_TARGET;
  // ★ 刀 23：口径窗口的判据长在**声明**里（calibers）。调用方没注入声明 = 引擎不知道
  //   这张表的窗口规则 —— 没声明就不出数（fail-closed；67283 判例的查询侧终点）。
  if (!fact) {
    throw new QueryRefused(
      `查询  必须注入 models 声明（declaredFactsOf()）—— 口径窗口的判据长在声明的 calibers 里（铁律 5），没声明就不出数。`,
      "FACT_NOT_DECLARED",
    );
  }
  const calibers = fact.calibers;

  const groupBy = mq.groupBy ?? [];
  for (const d of groupBy) {
    if (!isRegisteredDim(d)) {
      throw new QueryRefused(`未注册的维度: ${d}（只允许 ${Object.keys(DIMENSIONS).join(' / ')}）`, 'UNKNOWN_DIMENSION');
    }
    if (!dimAvailableOn(d as DimName, fact)) {
      throw new QueryRefused(`目标表  没有「」这个维度。`, "DIM_NOT_ON_FACT");
    }
    // 口径不是行上的列（刀 23）：自由查询的口径钉在每个度量上（measures[].periodType），
    // 不支持按口径分组 / 过滤 —— 那会跨窗口加总或把窗口当标签用（铁律 5）。
    if (d === "period_type") {
      throw new QueryRefused(
        "自由查询不支持按口径分组/过滤 —— 口径钉在 measures[].periodType 上（铁律 5：口径是窗口声明，不是行上的列）。",
        "PERIOD_TYPE_NOT_GROUPABLE",
      );
    }
  }

  // ---- 口径白名单 = 该表**声明的 calibers**（铁律 5：口径是窗口声明，不是全局注册表）----
  const caliberOfName = (n: string) => calibers.find((c) => c.name === n);
  const allowedPeriods = new Set<string>(calibers.map((c) => c.name));

  // ---- 窗口平移（铁律 5）：as-of 期间是平移前的 ---- 过滤值要平回去、标签要平出来。
  //   同一查询混不同 shift 是口径错配（一半的月份轴对不上 x 轴），直接拒，不猜。
  const shiftOf = (m: MeasureRef): number => (m.periodType ? (caliberOfName(m.periodType)?.shift ?? 0) : 0);
  const shifts = new Set(mq.measures.filter((m) => m.periodType).map(shiftOf));
  if (shifts.size > 1) {
    throw new QueryRefused(
      `一个查询里混了不同窗口平移的口径（shift ${[...shifts].join(' / ')}）—— 月份轴对不齐（铁律 5）。`,
      'CALIBER_SHIFT_CONFLICT',
    );
  }
  const shift = shifts.values().next().value ?? 0;

  // ---- 币种 selector（正交维度，P5 刀 22）：按**行落窗期**取率换算 ----
  //   fx_s = 行的记账币种当月率，fx_u = selector 币种当月率；比率在 CASE 内逐行做再聚合，
  //   同表混存多币种也正确。JOIN 用 f.fin_month（原始落窗月，不是 +1y 平移标签）——
  //   去年同期累计行落在 2025-06 就用 2025-06 的率，历史汇率不跟着 as-of 期走。
  //   目标表没有 ccy 列 → 拒绝（静默忽略 = 写的人以为在换算其实没有）。
  const ccySel = mq.ccy && mq.ccy.trim() !== '' ? mq.ccy : undefined;
  if (ccySel && !dimAvailableOn('ccy', fact)) {
    throw new QueryRefused(
      `目标表 ${tableName} 没有「ccy」维度，不能按币种换算 —— 运营事实表没有币种体系。`,
      'CCY_NOT_ON_FACT',
    );
  }

  // 分组表达式：shift ≠ 0 时 month/year 的标签平移 -shift 年（落窗在去年，报的是今年）
  const periodCol = shift === 0 ? 'f.fin_month' : `f.fin_month + INTERVAL ${-shift} YEAR`;
  const groupExprs = groupBy.map((d) => {
    const dim = DIMENSIONS[d as DimName];
    if (dim.table) return `${dim.table}.${dim.labelCol}`;
    if (d === 'month') return `strftime(${periodCol}, '%Y-%m')`;
    if (d === 'year') return `CAST(year(${periodCol}) AS VARCHAR)`;
    return dim.labelCol;
  });

  // 度量列：条件聚合，别名用序号避免中文别名问题。
  // 同时输出每格的**支撑事实行数** n{i} —— 这才是反推保护该看的指标（见文件头与 §6.2）。
  const columns: MetricsResult['columns'] = [];
  const colExprs = mq.measures.map((m, i) => {
    const agg = m.agg ?? 'sum';
    if (!AGGS.has(agg)) throw new QueryRefused(`不支持的聚合: ${agg}`, 'BAD_AGG');
    if (!m.metric) throw new QueryRefused(`measures[${i}] 需要 metric`, 'BAD_MEASURE');
    if (calibers.length === 0 && m.periodType) {
      throw new QueryRefused(
        `目标表  没有口径体系（声明的 calibers 为空），measures[].periodType 无处安放 —— 运营事实表没有口径体系（铁律 8）。`,
        "PERIOD_TYPE_NOT_ON_FACT",
      );
    }
    if (calibers.length > 0 && !m.periodType) {
      throw new QueryRefused(`measures[] 需要 periodType（口径）—— 口径是窗口声明，混窗口加总是无声错（铁律 8）`, "BAD_MEASURE");
    }
    if (m.periodType && !allowedPeriods.has(m.periodType)) {
      throw new QueryRefused(
        `未注册的口径: ${m.periodType}（只允许 ${[...allowedPeriods].join(' / ')}）`,
        'UNKNOWN_PERIOD_TYPE',
      );
    }
    const cal = m.periodType ? caliberOfName(m.periodType) : undefined;
    columns.push({
      key: `m${i}`,
      label: m.periodType
        ? m.periodType === '单月' || m.periodType === '单月同比'
          ? `${m.metric}·${m.periodType}`
          : `${m.metric}（${m.periodType}）`
        : m.metric,
      metric: m.metric,
      periodType: m.periodType ?? '',
      agg,
    });
    // calculator 口径（单月同比）不占事实表列 —— SQL 里根本没有这种行，钉住就是死查询。
    // 它在改写器里组合两个单月子查询算出来（铁律 5 第三件）。
    if (cal?.calculator) {
      throw new QueryRefused(
        `口径「${m.periodType}」是 calculator 口径，不落事实表（铁律 5）—— 在语义层计算，不进 SQL。`,
        'CALIBER_IS_CALCULATOR',
      );
    }
    // 窗口谓词：口径钉住 → **声明展开**（铁律 5 的判据就落在这一段）。
    // 累计是水平量 —— 窗口必须精确匹配，跨窗口求和结构性不可能；
    // 同一 fin_month 下三种窗口互斥（单月 period_from=当月 / 本年累计=年首 / 账面累计=固定起点）。
    let cond: string;
    if (fact?.windowFrom && cal) {
      const w = fact.windowFrom; // 声明来的列名（NAME_OK 白名单验过），不是用户输入
      const p = fact.periodColumn;
      const rule =
        cal.from === 'same'
          ? `f.${w} = f.${p}`
          : cal.from === 'year_start'
            ? `f.${w} = date_trunc('year', f.${p})`
            : `f.${w} = DATE '${cal.since}-01'`;
      cond = `dim_metric.name = ${q(m.metric)} AND ${rule}`;
    } else if (m.periodType) {
      // 口径有声明、表却没有窗口列 = 声明与窗口列不自洽（声明了 calibers 就必须有 windowFrom）
      throw new QueryRefused(
        `目标表 ${tableName} 声明了口径「${m.periodType}」却没有窗口列（windowFrom）—— 声明不自洽，拒绝出数（铁律 5）。`,
        'CALIBER_UNRESOLVABLE',
      );
    } else {
      // 没有口径体系的表（运营事实）：只按指标取数
      cond = `dim_metric.name = ${q(m.metric)}`;
    }
    const measureCol = fact?.measureColumn ?? 'amount';
    const valueExpr = ccySel ? `(f.${measureCol} * fx_s.rate / fx_u.rate)` : `f.${measureCol}`;
    return `${agg}(CASE WHEN ${cond} THEN ${valueExpr} END) AS m${i},\n  count(CASE WHEN ${cond} THEN 1 END) AS n${i}`;
  });

  // join（去重）
  const joins = new Set<string>(['JOIN dim_metric ON f.metric_id = dim_metric.id']);
  for (const d of groupBy) {
    const j = DIMENSIONS[d as DimName].joinOn;
    if (j) joins.add(`JOIN ${DIMENSIONS[d as DimName].table} ON ${j}`);
  }
  // 币种 selector 的取率 join（fx_rate 行唯一于 rate_month × ccy —— 模型声明里的承诺）
  if (ccySel) {
    joins.add('JOIN dim_fx_rate fx_s ON fx_s.rate_month = f.fin_month AND fx_s.ccy = f.ccy');
    joins.add(`JOIN dim_fx_rate fx_u ON fx_u.rate_month = f.fin_month AND fx_u.ccy = ${q(ccySel)}`);
  }

  // WHERE
  const where: string[] = [];
  for (const [col, val] of Object.entries(mq.filter ?? {})) {
    // 过滤的键是个「维度名.字段名」或裸字段名？统一按已注册维度处理：键必须是维度名
    if (!isRegisteredDim(col)) {
      throw new QueryRefused(`过滤字段未注册: ${col}（只允许 ${Object.keys(DIMENSIONS).join(' / ')}）`, 'UNKNOWN_FILTER');
    }
    if (!dimAvailableOn(col as DimName, fact)) {
      throw new QueryRefused(`目标表 ${tableName} 没有「${col}」这个维度。`, 'DIM_NOT_ON_FACT');
    }
    // 口径不是行上的列（刀 23）：过滤窗口用 measures[].periodType 钉，不过滤 period_type
    if (col === 'period_type') {
      throw new QueryRefused(
        '自由查询不支持按口径过滤 —— 口径钉在 measures[].periodType 上（铁律 5：口径是窗口声明，不是行上的列）。',
        'PERIOD_TYPE_NOT_GROUPABLE',
      );
    }
    const dim = DIMENSIONS[col as DimName];
    const ref = dim.table ? `${dim.table}.${dim.labelCol}` : dim.labelCol;
    // filter 用到维表也要补 join —— 只给 groupBy 补的话，"按公司过滤但不分组"直接炸 binder
    // （spec/expr 的 needJoin 同一判例：引用了维表列，就要把维表带进来）
    if (dim.table) joins.add(`JOIN ${dim.table} ON ${dim.joinOn}`);
    // 窗口平移：as-of 期间（filter 值）要**平回去**找落窗行 —— 查 2026-06 的去年同期累计，
    // 行落在 2025-06。只有 period 承载维（month/year）平移，其余维度不动。
    const shiftValue = (v: string): string => {
      if (shift === 0) return v;
      if (col === 'month' && /^\d{4}-\d{2}$/.test(v)) return `${Number(v.slice(0, 4)) + shift}${v.slice(4)}`;
      if (col === 'year' && /^\d{4}$/.test(v)) return String(Number(v) + shift);
      return v;
    };
    if (Array.isArray(val)) {
      if (val.length === 0) throw new QueryRefused(`过滤条件 ${col} 是空数组`, 'EMPTY_FILTER');
      where.push(`${ref} IN (${val.map((v) => q(shiftValue(String(v)))).join(', ')})`);
    } else {
      where.push(`${ref} = ${q(shiftValue(String(val)))}`);
    }
  }

  const limits = THRESHOLDS[mq.audience];
  const maxRows = Math.min(mq.limit ?? limits.maxRows, limits.maxRows);

  const sql = [
    groupExprs.length ? `SELECT ${groupExprs.join(', ')},` : 'SELECT',
    '  ' + colExprs.join(',\n  '),
    'FROM ' + tableName + ' f',
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
  facts?: DeclaredFact[],
): Promise<MetricsResult> {
  const limits = THRESHOLDS[mq.audience];
  const { sql, columns } = compileMetrics(mq, facts);

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
