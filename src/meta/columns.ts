/**
 * 列契约：**物理层向语义层与 Agent 自省自己**的那一份声明（架构 §7.2）。
 *
 * 用户 2026-10-01 曾拍板"不建生成器"、由接入层落库时顺带登记；**2026-10-02 重新拍板重新开工**。
 * 现在两层都在，而且不冲突：**生成器 apply 时登记一次**（结构建好那一刻），
 * **接入层落库时再登记一次**（数据与元数据同一事务）—— 两处投影的是**同一份 IR**（`metaOf`）。
 * 表不再是常数：`fact_business_line` 这类新表由声明长出来，不再是手写 DDL。
 *
 * ★ 那么这份"声明"跟"第二份人工维护的真相"有什么区别？区别只有一条，而它是硬的：
 *   **声明必须能被 `information_schema` 校验。** `metaProblems()` 会把声明与实际库结构对拍，
 *   多一列、少一列、表没声明、声明了不存在的表 —— 全部报出来（e2e 有断言）。
 *   做不到这条，它就是第二个真相；做到了，它是一份**可证伪**的契约。
 *
 * ⚠️ 本模块只描述**语义表**（`dim_*` / `fact_*` / `map_*` / `agg_*`）。着陆层（`raw_*`）、
 *   批次与别名（`import_batch` / `dim_alias`）是**运营侧**的表，不进这份契约 ——
 *   它们的角色对"有哪些维度和指标"没有贡献，混进来只会把 catalog 撑大。
 */
import { createHash } from 'node:crypto';
import { execute, query } from '../db/index.ts';
import { metaOf, type MetaObject } from '../gen/ir.ts';
import { loadModels, MODEL_API_VERSION } from '../gen/parse.ts';

/**
 * 列契约的**内容**不再手写在这里 —— 它现在投影自 `models/*.yml`（P2 生成器的声明层，
 * 用户 2026-10-02 重新拍板重新开工）。本文件保留三件只有它该知道的事：
 *   ① **运营侧**的表不进契约（`raw_*` / `import_batch` / `dim_alias` —— 见文件头）；
 *   ② 把声明写进 `_meta_*`（`registerMeta`）；
 *   ③ 把声明与真实库结构对拍（`metaProblems`）与结构指纹（`schemaFingerprint`）。
 *
 * ★ 判据只有一份：`META` 是 `metaOf(loadModels())` 的**投影**，不是第二份声明。
 *   谁要改列角色，改的是 `models/<表>.yml`，然后 `bilite plan` / `bilite apply`。
 */
export type { MetaRole, MetaColumn, MetaObject } from '../gen/ir.ts';

/** **唯一一份**列契约：模型声明的投影（见上） */
export const META: readonly MetaObject[] = metaOf(loadModels());

/** SQL 字符串字面量转义。⚠️ 本仓库另有几份同功能实现，待收拢 */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** 语义表的表名前缀 —— 只有这些表进契约（agg_* 是聚合表：声明在 models/，数据由 rebuild 重算） */
const SEMANTIC_PREFIX = /^(dim|fact|map|agg)_/;

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
export async function registerMeta(meta: readonly MetaObject[] = META): Promise<void> {
  for (const obj of meta) {
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

/** 契约的版本号 = **模型声明的口径版本**（`gen/parse.ts` 的 MODEL_API_VERSION）。
 *  catalog 靠它判断"agent 手里那份是不是旧的" —— 所以它跟着声明走，不手写第二份。 */
export const API_VERSION = MODEL_API_VERSION;

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
