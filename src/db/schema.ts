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

-- ---------- 主数据别名映射（§10 R1）----------
-- 人确认过一次的写法记在这里，下个月自动命中，不再问第二遍。
-- normalized 是 normalizeName() 的结果（只去格式噪音，不改语义）——
-- 见 src/import/resolve.ts 的注释：合并比不合并危险得多，所以只有规范化相等才自动归并。
CREATE TABLE IF NOT EXISTS dim_alias (
  kind       VARCHAR NOT NULL,   -- company / metric
  normalized VARCHAR NOT NULL,   -- 规范化后的写法（命中键）
  alias      VARCHAR NOT NULL,   -- 原始写法（给人看）
  target_id  VARCHAR NOT NULL,   -- 归并到哪条主数据
  note       VARCHAR,
  created_at TIMESTAMP,
  PRIMARY KEY (kind, normalized)
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

-- ---------- 着陆层：源文件原样留存（架构 §4.1 ②、§6.1 ①②）----------
-- ★ append-only：**永不修改、永不复用**。它是"可重放"的唯一依据 ——
--   任何清洗 / 单位换算 / 符号处理都不许往回写 raw，否则 raw 就成了第二份真相。
-- ★ 只存**有值的格**：空格由"没有这一行"表达。这张表与源文件大小成正比，
--   是全库最大的表组，把空格也写进来纯属浪费。

CREATE TABLE IF NOT EXISTS raw_file (
  file_hash   VARCHAR PRIMARY KEY,   -- sha256(文件字节)：同一份文件重复上传天然幂等
  filename    VARCHAR,
  size_bytes  BIGINT,
  received_at TIMESTAMP
);

-- 源路径 → 最近一次着陆。
--   ★ 为什么单独一张表、而不是给 raw_file 加一列：**同一份文件可能被写到不同路径下**
--     （复制一份再传），而 raw 是按内容去重的 —— 于是"哪个路径对应哪份 raw"是多对一。
--     放在 raw_file 上只能记下第一个路径，别的路径在源文件被删后就找不回 raw 了。
--   ★ 有了它，"重放"才不依赖源文件还在 —— 而源文件恰恰是最容易丢的东西。
CREATE TABLE IF NOT EXISTS raw_source (
  source_path VARCHAR PRIMARY KEY,   -- 规格里写的那个路径（原样记下，不做规范化）
  file_hash   VARCHAR NOT NULL,
  seen_at     TIMESTAMP
);

CREATE TABLE IF NOT EXISTS raw_cell (
  file_hash  VARCHAR NOT NULL,
  sheet      VARCHAR NOT NULL,
  row_no     INTEGER NOT NULL,       -- 1-based（与 xlsx-populate 一致，不做换算）
  col_no     INTEGER NOT NULL,
  cell_ref   VARCHAR NOT NULL,       -- Excel 记法（"B4"）：给人看、给对账用
  value_kind VARCHAR NOT NULL,       -- text / number / bool / date
  raw_value  VARCHAR,                -- 原样保留，不 trim（与 textAt() 的语义刻意不同）
  formula    VARCHAR,                -- 该格带公式时的公式文本；NULL = 不是公式格
  loaded_at  TIMESTAMP,
  PRIMARY KEY (file_hash, sheet, row_no, col_no)
);

-- ---------- 控制面元数据：物理层向语义层 / Agent 自省自己的契约（架构 §7.2）----------
-- ⚠️ 这段注释里**不能出现反引号** —— 整个 DDL 是一个模板字符串，
--    写一个反引号进去就会把它提前闭合，报错却是"Expected a semicolon"，指在毫不相干的下一行（踩过一次）。
-- ★ 内容由 src/meta/columns.ts 的**唯一一份声明**写入，不是人手改表。
--   而那份声明必须能被 information_schema 校验（metaProblems()，e2e 有断言）——
--   否则它就退化成"第二份人工维护的真相"，正是本仓库反复判过的那种漂移源。
-- ★ 为什么不用生成器写它（用户 2026-10-01 拍板）：表已经是常数，
--   而"哪些列是什么角色"本来就是**接入层**在落库时知道的事 —— 让它在同一事务里顺手记下。

CREATE TABLE IF NOT EXISTS _meta_objects (
  object_name VARCHAR PRIMARY KEY,
  kind        VARCHAR NOT NULL,      -- dimension / fact / bridge
  grain       VARCHAR,               -- 事实表的粒度（逗号分隔的列名）
  api_version VARCHAR
);

CREATE TABLE IF NOT EXISTS _meta_columns (
  table_name VARCHAR NOT NULL,
  column_name VARCHAR NOT NULL,
  role       VARCHAR NOT NULL,       -- pk / dim_fk / measure / degenerate / provenance
  semantic   VARCHAR,                -- period / org / metric / money …
  unit       VARCHAR,
  ref_table  VARCHAR,                -- role=dim_fk 时指向哪张维表
  PRIMARY KEY (table_name, column_name)
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
