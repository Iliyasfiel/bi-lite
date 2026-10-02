/**
 * 列契约：**物理层向语义层与 Agent 自省自己**的那一份声明（架构 §7.2）。
 *
 * 用户 2026-10-01 拍板的方向：**不建生成器**，`_meta_columns` 由**接入层在落库时顺带登记**。
 * 理由是——表已经是常数（bi-lite 只有 8 张），生成器最主要的那个价值（表不随模板增长）
 * 在这儿用不上；而"哪些列是什么角色"本来就是接入层知道的事，
 * 让它在**同一个事务**里把数据与元数据一起写下，两者天然同源。
 *
 * ★ 那么这份"声明"跟"第二份人工维护的真相"有什么区别？区别只有一条，而它是硬的：
 *   **声明必须能被 `information_schema` 校验。** `metaProblems()` 会把声明与实际库结构对拍，
 *   多一列、少一列、表没声明、声明了不存在的表 —— 全部报出来（e2e 有断言）。
 *   做不到这条，它就是第二个真相；做到了，它是一份**可证伪**的契约。
 *
 * ⚠️ 本模块只描述**语义表**（`dim_*` / `fact_*` / `map_*`）。着陆层（`raw_*`）、
 *   批次与别名（`import_batch` / `dim_alias`）是**运营侧**的表，不进这份契约 ——
 *   它们的角色对"有哪些维度和指标"没有贡献，混进来只会把 catalog 撑大。
 */
import { createHash } from 'node:crypto';
import { execute, query } from '../db/index.ts';

/** 列在语义层扮演的角色 —— 与架构 §7.2 的五个取值一一对应 */
export type MetaRole = 'pk' | 'dim_fk' | 'measure' | 'degenerate' | 'provenance';

export interface MetaColumn {
  column: string;
  role: MetaRole;
  /** 语义类型：period / org / metric / money / …（给人和 agent 看的，不参与 SQL） */
  semantic?: string;
  unit?: string;
  /** role='dim_fk' 时：指向哪张维表 */
  refTable?: string;
}

export interface MetaObject {
  name: string;
  kind: 'dimension' | 'fact' | 'bridge';
  /** 事实表的粒度（列名）；维度表留空 */
  grain?: string[];
  columns: MetaColumn[];
}

const PK = (column: string, semantic?: string): MetaColumn => ({ column, role: 'pk', semantic });
const FK = (column: string, refTable: string, semantic?: string): MetaColumn => ({
  column,
  role: 'dim_fk',
  refTable,
  semantic,
});
const MEASURE = (column: string, unit?: string, semantic = 'money'): MetaColumn => ({
  column,
  role: 'measure',
  unit,
  semantic,
});
const DEG = (column: string, semantic?: string): MetaColumn => ({ column, role: 'degenerate', semantic });
const PROV = (column: string): MetaColumn => ({ column, role: 'provenance' });

/**
 * **唯一一份**列契约。
 *
 * 加列、改名、换角色时只改这里 —— `metaProblems()` 会立刻告诉你是不是忘了同步别处。
 */
export const META: readonly MetaObject[] = [
  {
    name: 'dim_company',
    kind: 'dimension',
    columns: [
      PK('id', 'org'),
      DEG('name', 'org'),
      FK('parent_id', 'dim_company', 'org'),
      DEG('level'),
      DEG('group_name'),
      PROV('alias'),
    ],
  },
  {
    name: 'dim_metric',
    kind: 'dimension',
    columns: [
      PK('id', 'metric'),
      DEG('name', 'metric'),
      DEG('category'),
      DEG('unit'),
      DEG('direction'),
      PROV('alias'),
    ],
  },
  {
    name: 'dim_period',
    kind: 'dimension',
    columns: [PK('fin_month', 'period'), DEG('year', 'period'), DEG('month', 'period'), DEG('is_audited')],
  },
  {
    name: 'fact_finance',
    kind: 'fact',
    grain: ['fin_month', 'company_id', 'metric_id', 'period_type'],
    columns: [
      PK('fin_month', 'period'),
      FK('company_id', 'dim_company', 'org'),
      FK('metric_id', 'dim_metric', 'metric'),
      PK('period_type', 'period_type'),
      MEASURE('amount', '元'),
      PROV('batch_id'),
    ],
  },
  {
    name: 'fact_contract',
    kind: 'fact',
    grain: ['fin_month', 'company_id', 'metric_id'],
    columns: [
      PK('fin_month', 'period'),
      FK('company_id', 'dim_company', 'org'),
      FK('metric_id', 'dim_metric', 'metric'),
      MEASURE('amount', '元'),
      PROV('batch_id'),
    ],
  },
];

/** SQL 字符串字面量转义。⚠️ 本仓库另有几份同功能实现，待收拢 */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** 语义表的表名前缀 —— 只有这些表进契约 */
const SEMANTIC_PREFIX = /^(dim|fact|map)_/;

/**
 * 名字像语义表、其实属于**运营侧**的表 —— 显式列出来，不进契约。
 *
 * ★ 为什么要显式列、而不靠"前缀自然就对"：`dim_alias` 名字带 `dim_`，
 *   但它装的是"哪个写法归并到哪家"的映射，对"有哪些维度和指标"没有贡献。
 *   靠前缀猜会把这类表误判成"没登记的语义表"（守卫第一次跑就是这么报的）。
 *   列在这里的每一张都要能说清"为什么它不是语义表"。
 */
const NON_SEMANTIC = new Set([
  'dim_alias', // 别名映射：人拍板过的写法 → 主数据 id，运营侧
]);

/**
 * 把声明写进 `_meta_columns` / `_meta_objects`（幂等）。
 *
 * ★ 由 `runIngest` 在**阶段 2 的事务里**调用：数据与元数据同一时刻落库。
 *   这样"元数据漂移"只可能来自**声明写错**，而那种漂移会被 `metaProblems()` 当场抓住。
 */
export async function registerMeta(): Promise<void> {
  for (const obj of META) {
    await execute(
      `INSERT INTO _meta_objects (object_name, kind, grain, api_version) VALUES ` +
        `(${lit(obj.name)}, ${lit(obj.kind)}, ${obj.grain ? lit(obj.grain.join(',')) : 'NULL'}, ${lit(API_VERSION)}) ` +
        `ON CONFLICT (object_name) DO UPDATE SET kind = EXCLUDED.kind, grain = EXCLUDED.grain, api_version = EXCLUDED.api_version`,
    );
    for (const c of obj.columns) {
      await execute(
        `INSERT INTO _meta_columns (table_name, column_name, role, semantic, unit, ref_table) VALUES ` +
          `(${lit(obj.name)}, ${lit(c.column)}, ${lit(c.role)}, ${c.semantic ? lit(c.semantic) : 'NULL'}, ` +
          `${c.unit ? lit(c.unit) : 'NULL'}, ${c.refTable ? lit(c.refTable) : 'NULL'}) ` +
          `ON CONFLICT (table_name, column_name) DO UPDATE SET role = EXCLUDED.role, ` +
          `semantic = EXCLUDED.semantic, unit = EXCLUDED.unit, ref_table = EXCLUDED.ref_table`,
      );
    }
  }
}

/** 契约的版本号。改 `META` 的结构时手动递增 —— catalog 靠它判断"agent 手里那份是不是旧的" */
export const API_VERSION = '2026-10-01';

/**
 * **声明 vs 实际库结构**：把漂移全部找出来。
 *
 * 这是让那份"手写声明"免于沦为第二份真相的唯一机制（见文件头）。四类问题：
 *   ① 声明里的表在库里不存在
 *   ② 声明里的列在库里不存在
 *   ③ 库里的语义表**没有**被声明（新加了 `fact_*` 却忘了登记）
 *   ④ 库里某张已声明表的**真实列**没被声明（加了一列却忘了登记）
 *
 * @param meta 要校验的声明。默认就是本模块的 `META`；**参数化是为了让 e2e 能喂一份错的进来**，
 *             证明这个守卫真的会抓（否则"守卫存在"跟"守卫有用"是两回事）。
 * @returns 问题清单（空数组 = 声明与真实结构一致）
 */
export async function metaProblems(meta: readonly MetaObject[] = META): Promise<string[]> {
  const actual = await query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'main'`,
  );
  const liveTables = new Set(actual.map((r) => r.table_name));
  const liveColumns = new Set(actual.map((r) => `${r.table_name}.${r.column_name}`));
  const problems: string[] = [];

  const declaredTables = new Set(meta.map((o) => o.name));
  const declaredColumns = new Set(meta.flatMap((o) => o.columns.map((c) => `${o.name}.${c.column}`)));

  for (const obj of meta) {
    if (!liveTables.has(obj.name)) problems.push(`① 声明了 ${obj.name}，但库里没有这张表`);
    for (const c of obj.columns) {
      if (!liveColumns.has(`${obj.name}.${c.column}`)) {
        problems.push(`② 声明了 ${obj.name}.${c.column}，但库里没有这一列`);
      }
    }
  }
  for (const t of liveTables) {
    if (!SEMANTIC_PREFIX.test(t) || NON_SEMANTIC.has(t)) continue;
    if (!declaredTables.has(t)) {
      problems.push(`③ 库里有一张语义表 ${t} 没进契约（新表必须在 src/meta/columns.ts 声明）`);
      continue;
    }
    for (const row of actual.filter((r) => r.table_name === t)) {
      if (!declaredColumns.has(`${t}.${row.column_name}`)) {
        problems.push(`④ ${t}.${row.column_name} 在库里存在但没被声明（加列要同步契约）`);
      }
    }
  }
  return problems;
}

/** 结构指纹：声明 + 实际列的形状。给 catalog 的 `ddlHash` 用（agent 手里那份是不是旧的） */
export async function schemaFingerprint(): Promise<string> {
  const actual = await query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'main' ORDER BY table_name, column_name`,
  );
  const declared = META.map((o) => `${o.name}(${o.columns.map((c) => `${c.column}:${c.role}`).join(',')})`).join(';');
  const live = actual.map((r) => `${r.table_name}.${r.column_name}`).join(',');
  return createHash('sha256').update(`${API_VERSION}|${declared}|${live}`).digest('hex').slice(0, 12);
}
