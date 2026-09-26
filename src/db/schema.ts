/**
 * 数据模型（对应 docs/需求与架构.md §4）
 *
 * 采用 Kimball 星型模型：维度共享，事实表按业务域拆分。
 * 三维度：公司 × 指标 × 期间，口径是事实表的一个列（不是行）。
 */

export const DDL = `
-- ---------- 维度表 ----------

-- 公司维度：必须有层级，支撑"按板块汇总"这类保送需求
CREATE TABLE IF NOT EXISTS dim_company (
  id         VARCHAR PRIMARY KEY,
  name       VARCHAR NOT NULL,
  parent_id  VARCHAR,            -- 自引用，集团→子公司多层树
  level      INTEGER,            -- 层级深度，1=集团
  group_name VARCHAR,            -- 所属板块
  alias      VARCHAR[]           -- 导入时识别到的别名
);

-- 指标维度
CREATE TABLE IF NOT EXISTS dim_metric (
  id        VARCHAR PRIMARY KEY,
  name      VARCHAR NOT NULL,
  category  VARCHAR,             -- 主要指标 / 盈利指标 ... 用于 spec 的 filter
  unit      VARCHAR,             -- 元 / 万元 / %
  direction VARCHAR,             -- positive（越大越好）/ negative（成本类）
  alias     VARCHAR[]
);

-- 期间维度：财务期与自然月可能不一致
CREATE TABLE IF NOT EXISTS dim_period (
  fin_month  DATE PRIMARY KEY,
  year       INTEGER,
  month      INTEGER,
  is_audited BOOLEAN DEFAULT FALSE
);

-- ---------- 事实表 ----------

-- 财务事实：三维交点 × 口径
-- 口径是列不是行；账面累计含调整故必须实存（文档 §3.1.2）
CREATE TABLE IF NOT EXISTS fact_finance (
  fin_month   DATE    NOT NULL,
  company_id  VARCHAR NOT NULL,
  metric_id   VARCHAR NOT NULL,
  period_type VARCHAR NOT NULL,   -- 本年累计/去年同期累计/单月/单月同比/账面累计
  amount      DECIMAL(18,2),
  batch_id    VARCHAR,
  PRIMARY KEY (fin_month, company_id, metric_id, period_type)
);

-- 运营事实独立成表，共享 dim_company / dim_period
-- 不要塞进 fact_finance：量纲、频率、口径体系都不同
CREATE TABLE IF NOT EXISTS fact_contract (
  fin_month  DATE    NOT NULL,
  company_id VARCHAR NOT NULL,
  metric_id  VARCHAR NOT NULL,
  amount     DECIMAL(18,2),
  batch_id   VARCHAR,
  PRIMARY KEY (fin_month, company_id, metric_id)
);

-- ---------- 导入批次（可追溯）----------

CREATE TABLE IF NOT EXISTS import_batch (
  batch_id    VARCHAR PRIMARY KEY,
  source_file VARCHAR,
  row_count   INTEGER,
  imported_at TIMESTAMP,
  status      VARCHAR,        -- pending / validated / committed / rolled_back
  note        VARCHAR
);
`;

/** 口径的类型：哪些可由单月派生，哪些必须实存
 *
 * ⚠️ id 必须与集团导出 Excel 里「口径」列的**字面值**完全一致 ——
 * 它是 fact_finance.period_type 的实际取值，也是语义层校验的依据。
 * （曾误写为 '累计'，与数据里的 '本年累计' 不符，会导致合法数据被拒。）
 */
export const PERIOD_TYPES = [
  { id: '本年累计', label: '本年累计', derivable: false, note: '含审计调整，必须实存' },
  { id: '去年同期累计', label: '去年同期累计', derivable: false, note: '来自去年账，无法从本月派生' },
  { id: '单月', label: '单月', derivable: false, note: '最基础的事实值，实际值' },
  { id: '单月同比', label: '单月同比', derivable: true, note: '可由 (本月 - 去年同月)/去年同月 派生' },
  { id: '账面累计', label: '账面累计', derivable: false, note: '含审计调整，与单月累加不等' },
] as const;

export type PeriodType = (typeof PERIOD_TYPES)[number]['id'];
