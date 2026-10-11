/**
 +* catalog：把「库里现在有什么」导出给 **Agent**（架构 §8.2 的 ②③、§8.5）。
 *
 * 三层，各自回答一个不同的问题 —— 三种 YAML 要的不是同一份东西：
 *   L1 业务成员  「这个 code 已经有了吗？」  → 防止造出重复指标（`receivable_amount` vs `account.receivable`）
 *   L2 物理结构  「我要加的东西放在哪张表？」 → 防止对着一张不存在的表 / 已改名的列写声明
 *   L3 状态版本  「agent 手里那份是不是旧的？」 → 靠 `apiVersion` + `ddlHash`，而不是靠人记得重新导
 *
 * ★ **零金额**：只放结构与成员名。数字一概不出现在这里。
 * ★ **不含 `_ingest_batch`**（用户 2026-10-01 已定）：装载批次历史属于装载侧，
 *   混进来会把 catalog 从"结构快照"撑成"运营日志"。
 * ★ 这里**不是**给 agent 的唯一入口 —— MCP 侧要另接（且必须走 `callTool()` 过金额兜底）。
 */
import { query } from '../db/index.ts';
import { staticCatalog } from '../semantic/query.ts';
import { semanticFacts, type SemanticFact } from '../semantic/introspect.ts';
import { API_VERSION, metaProblems, schemaFingerprint } from './columns.ts';

export interface CatalogColumn {
  column: string;
  role: string;
  semantic: string | null;
  unit: string | null;
  refTable: string | null;
}

export interface CatalogObject {
  name: string;
  kind: string;
  grain: string | null;
  apiVersion: string | null;
  columns: CatalogColumn[];
}

export interface Catalog {
  apiVersion: string;
  /** 导出时刻。catalog 是快照，**一定会过期** —— 过期必须响亮（架构 §8.5.4） */
  asOf: string;
  /** 声明 + 实际列的形状指纹。与 agent 手里那份不一致 = 它该重新导 */
  ddlHash: string;
  members: {
    metrics: Array<{ name: string; category: string | null; unit: string | null }>;
    companies: Array<{ name: string; group_name: string | null; level: number | null }>;
    periodTypes: string[];
    dimensions: string[];
  };
  objects: CatalogObject[];
  /** 语义自省（架构 §7.1）：每张 fact/aggregate 表「能查什么」——从声明推导，零新登记 */
  semantic: { facts: SemanticFact[] };
  /** `metaProblems()` 的结果。非空 = 声明与真实结构漂移了，agent 不该信这份 catalog */
  drift: string[];
  note: string;
}

const NOTE =
  '这是结构与成员名，**不含任何金额**；也不含装载批次历史（那是装载侧的事）。' +
  'agent 手里这份是快照：写 YAML 前用 ddlHash / apiVersion 确认它没过期，写完让 validate 读**当下**的结构复核。';

/** L2+L3：从 `_meta_objects` / `_meta_columns` 读（那是接入层登记下来的契约，不是本模块的私有知识） */
async function objects(): Promise<CatalogObject[]> {
  const objs = await query<{ object_name: string; kind: string; grain: string | null; api_version: string | null }>(
    `SELECT object_name, kind, grain, api_version FROM _meta_objects ORDER BY object_name`,
  );
  const cols = await query<{ table_name: string; column_name: string; role: string; semantic: string | null; unit: string | null; ref_table: string | null }>(
    `SELECT table_name, column_name, role, semantic, unit, ref_table FROM _meta_columns ORDER BY table_name, column_name`,
  );
  return objs.map((o) => ({
    name: o.object_name,
    kind: o.kind,
    grain: o.grain,
    apiVersion: o.api_version,
    columns: cols
      .filter((c) => c.table_name === o.object_name)
      .map((c) => ({
        column: c.column_name,
        role: c.role,
        semantic: c.semantic,
        unit: c.unit,
        refTable: c.ref_table,
      })),
  }));
}

/** 完整导出（成三层）。给 `bilite catalog dump` 与将来的 MCP 工具用 */
export async function catalogDump(): Promise<Catalog> {
  const static_ = staticCatalog();
  return {
    apiVersion: API_VERSION,
    asOf: new Date().toISOString(),
    ddlHash: await schemaFingerprint(),
    members: {
      metrics: await query<{ name: string; category: string | null; unit: string | null }>(
        `SELECT name, category, unit FROM dim_metric ORDER BY name`,
      ),
      companies: await query<{ name: string; group_name: string | null; level: number | null }>(
        `SELECT name, group_name, level FROM dim_company ORDER BY level NULLS LAST, name`,
      ),
      periodTypes: static_.periodTypes.map((p) => p.id),
      dimensions: static_.dimensions.map((d) => d.name),
    },
    objects: await objects(),
    semantic: { facts: semanticFacts() },
    drift: await metaProblems(),
    note: NOTE,
  };
}

/** 按需下钻：单张表 / 单个对象的完整结构（架构 §8.5.3 的默认路径 —— 不要整个吞下去） */
export async function catalogShow(object: string): Promise<CatalogObject & { rowCount: number | null }> {
  const all = await objects();
  const hit = all.find((o) => o.name === object);
  if (!hit) {
    throw new Error(
      `catalog 里没有「${object}」。现有：${all.map((o) => o.name).join(' / ')} —— ` +
        `表名要写全（不是"财务表"这样的叫法）。`,
    );
  }
  // 只报**行数**（架构 §8.5.5 明确允许的"计数"），不查任何值
  const counted = await query<{ n: number }>(`SELECT count(*) AS n FROM ${hit.name}`);
  return { ...hit, rowCount: Number(counted[0]?.n ?? 0) };
}

/**
 * 人 / agent 读的紧凑文本形态。
 *
 * ★ 只做**投影**，不做二次加工 —— 任何"顺便算一下"都会让它与 JSON 版慢慢分家。
 */
export function catalogPrompt(c: Catalog): string {
  const line = (label: string, items: string[]) => `  ${label.padEnd(10)} ${items.join(' | ')}`;
  const out = [
    `bi-lite catalog · apiVersion ${c.apiVersion} · ddlHash ${c.ddlHash} · asOf ${c.asOf}`,
    'L1 业务成员',
    line('metrics', c.members.metrics.map((m) => `${m.name}${m.unit ? `(${m.unit})` : ''}`)),
    line('companies', c.members.companies.map((x) => x.name)),
    line('periodTypes', c.members.periodTypes),
    line('dimensions', c.members.dimensions),
    'L2 物理结构',
    ...c.objects.map(
      (o) => `  ${o.name}  ${o.kind}${o.grain ? `  grain: ${o.grain}` : ''}\n` +
        o.columns.map((col) => `      ${col.column.padEnd(14)} ${col.role}${col.refTable ? ` → ${col.refTable}` : ''}`).join('\n'),
    ),
    '语义自省（每张可查询表能查什么 —— 从声明推导）',
    ...c.semantic.facts.map(
      (f) => `  ${f.name}  度量 ${f.measures.map((m) => `${m.column}${m.unit ? `(${m.unit})` : ''}${m.agg ? `[${m.agg}]` : ''}`).join('/') || '—'}` +
        ` · 维度 ${[...f.dimRefs.map((d) => `${d.column}→${d.refTable}`), ...f.slicers.map((s) => s.column)].join('/') || '—'}` +
        ` · 口径 ${f.calibers.length ? `声明 ${f.calibers.length} 个（必须钉）` : '无'}` +
        (f.lineage.source ? ` · 派生 ← ${f.lineage.source}${f.lineage.via ? ` via ${f.lineage.via}` : ''}` : ''),
    ),
  ];
  if (c.drift.length) out.push('⚠️ 契约漂移（这份 catalog 不可信，先修声明）：', ...c.drift.map((d) => `  - ${d}`));
  return out.join('\n') + '\n';
}
