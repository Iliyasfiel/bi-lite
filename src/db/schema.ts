/**
 * 数据模型（对应 docs/需求与架构.md §4）
 *
 * ★ 本文件现在只放**基础元数据 DDL**（手写、不由声明生成）—— 见 `docs/开发计划.md` §1.2：
 *   - 运营侧：`raw_*`（着陆层）、`import_batch`（批次）、`dim_alias`（别名映射）
 *   - 控制面：`_meta_objects` / `_meta_columns`（列契约）、`_model` / `_model_dep`（模型指纹与依赖）
 *
 * ★ **业务表（`dim_*` / `fact_*`）的 DDL 不在这里** —— 它们在 `models/*.yml` 里声明，
 *   由生成器（`src/gen/`）算 diff 后落地：`bilite plan` 看变更，`bilite apply` 执行。
 *   为什么要分开：业务表会随业务增长（`fact_business_line` 就是下一张），
 *   手写 DDL 每加一张表就要人肉保证"表、列契约、依赖图"三处一致 —— 那就是漂移的温床。
 *   不变的运营侧表留在这里，因为它们**不是**声明层管的（它们的角色对"有哪些维度和指标"没有贡献）。
 */

export const DDL = `
-- ---------- 主数据别名映射（§10 R1）----------
-- 人确认过一次的写法记在这里，下个月自动命中，不再问第二遍。
-- normalized 是 normalizeName() 的结果（只去格式噪音，不改语义）——
-- 见 src/ingest/resolve.ts 的注释：合并比不合并危险得多，所以只有规范化相等才自动归并。
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

-- ---------- 标准化层：raw + 接入规格 → 标准行（架构 §4.7）----------
-- 一张通用表（不按事实表分表：退化列差异用 deg JSON 承载）。
-- 与 fact 同级安全面：含金额，不进 catalog / MCP / Web / skill 物料（e2e 钉着）。
-- 边界：stg 之前是纯函数（raw + 规格 → 标准行，可独立重放）；主数据归并与 id 解析
-- 都发生在 stg → fact 的一步 —— 所以 company/metric 存的是归并前的**原名**。
CREATE TABLE IF NOT EXISTS stg_fact_rows (
  batch_id    VARCHAR NOT NULL,      -- → import_batch.batch_id（同事务写入）
  target      VARCHAR NOT NULL,      -- 目标事实表名（fact_finance 等）
  spec_id     VARCHAR NOT NULL,      -- 接入规格 id（spec.id）
  file_hash   VARCHAR NOT NULL,      -- 着陆源（raw_file.file_hash）
  sheet       VARCHAR NOT NULL,
  block       INTEGER NOT NULL,
  row_no      INTEGER NOT NULL,      -- 源行号（1-based，与 raw_cell 一致）
  value_col   VARCHAR NOT NULL,      -- 值格 Excel 列字母（如 "F"）
  period      VARCHAR NOT NULL,      -- 标准化后 YYYY-MM
  company_raw VARCHAR NOT NULL,      -- 归并前原名
  metric_raw  VARCHAR NOT NULL,
  period_type VARCHAR,
  amount      DOUBLE,
  deg         VARCHAR,               -- 退化列 JSON（键排序规范化）；无退化列 = NULL
  loaded_at   TIMESTAMP,
  PRIMARY KEY (batch_id, target, block, row_no, value_col)
);

-- ---------- 控制面元数据：物理层向语义层 / Agent 自省自己的契约（架构 §7.2）----------
-- ⚠️ 这段注释里**不能出现反引号** —— 整个 DDL 是一个模板字符串，
--    写一个反引号进去就会把它提前闭合，报错却是"Expected a semicolon"，指在毫不相干的下一行（踩过一次）。
-- ★ 内容由 src/meta/columns.ts 的 registerMeta() 写入，而它的**唯一来源**是 models/*.yml
--   （投影自 IR，见 src/gen/ir.ts 的 metaOf）；那份投影必须能被 information_schema 校验
--   （metaProblems()，e2e 有断言）—— 否则它就退化成"第二份人工维护的真相"。

CREATE TABLE IF NOT EXISTS _meta_objects (
  object_name VARCHAR PRIMARY KEY,
  kind        VARCHAR NOT NULL,      -- dimension / fact / bridge / aggregate
  grain       VARCHAR,               -- 事实表与聚合表的粒度（逗号分隔的列名）
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

-- ---------- 生成器的账本（P2）----------
-- 为什么需要它（而不是直接看 information_schema）：**声明变了、结构恰好没变**是最常见的一种变更
-- （改一个列角色、改 title）。那种时候 diff 是空的，但列契约必须重登一次 ——
-- ddl_hash 就是"我上次落地的是哪一版声明"的凭证。
CREATE TABLE IF NOT EXISTS _model (
  name        VARCHAR PRIMARY KEY,   -- 表名
  kind        VARCHAR NOT NULL,      -- dimension / fact / bridge / aggregate
  title       VARCHAR,
  ddl_hash    VARCHAR NOT NULL,      -- 该表声明的结构指纹（src/gen/ir.ts 的 ddlHashOf）
  declared_at TIMESTAMP
);

-- 表之间的声明式依赖（列 → 它引用的表）。整份投影，每次 apply 按声明重写。
CREATE TABLE IF NOT EXISTS _model_dep (
  name        VARCHAR NOT NULL,
  depends_on  VARCHAR NOT NULL,
  column_name VARCHAR NOT NULL,
  PRIMARY KEY (name, depends_on, column_name)
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
