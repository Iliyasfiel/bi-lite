/**
 * IR + 现有库结构 → **人可读的变更清单**（P2 的"先见 diff 再决定落地"）。
 *
 * ★ plan 与 apply 的分工（`docs/开发计划.md` §1.2 的验收）：
 *   「plan 与 apply 必须是**两条命令**：先见 diff 再决定落地」——
 *   所以这里只算，不写一个字；apply 拿同一份清单去执行。
 *
 * ★ 两类变更分得很清楚，因为它们的风险完全不同：
 *   - **可自动**（`blocking: false`）：建表、加列、刷新列契约。加列在 DuckDB 里是纯元数据操作，
 *     不重写数据（e2e 有断言：加列前后行数与值都不变）。
 *   - **阻塞**（`blocking: true`）：**删列**、**改类型**、**加 NOT NULL 列**。
 *     这三件事都可能悄悄丢数据或让旧数据不合约束 —— 生成器**绝不自动做**，
 *     只报出来让人决定（`apply` 一看到阻塞项就整体不动，连能做的也不做：
 *     半个落地比整体不动更难查）。
 */
import { query } from '../db/index.ts';
import { addColumnSql, createTableSql, depsOf } from './ddl.ts';
import { ddlHashOf, metaOf, type Ir } from './ir.ts';

export type ChangeKind =
  | 'create-table'
  | 'add-column'
  | 'drop-column'
  | 'type-changed'
  | 'undeclared-table'
  | 'register-meta';

export interface ModelChange {
  kind: ChangeKind;
  table: string;
  column?: string;
  detail: string;
  /** true = apply 不会动它，必须人先决定 */
  blocking: boolean;
  /** 真正会被执行的 SQL（plan 给人看、apply 照着跑）—— register-meta 没有 SQL */
  sql?: string;
}

export interface ModelPlan {
  /** 声明的表数 */
  tables: number;
  changes: ModelChange[];
  blocking: ModelChange[];
  /** 有没有任何要落地的变更（结构变更 + 契约刷新） */
  pending: boolean;
  /** 只要**结构变更**（带 SQL、且不阻塞的那些）——
   *  它们一律要人点一次 `bilite apply`，启动时不许自动做（见 `db/index.ts` 的启动策略） */
  structural: ModelChange[];
  /** 当前 IR 的指纹 */
  irHash: string;
  /** `_model` 里记着的"上次 apply 落地了哪些表的哪一版"；从没 apply 过就是 null（只作信息，不参与 diff） */
  appliedHash: string | null;
}

interface LiveColumn {
  table_name: string;
  column_name: string;
  data_type: string;
}

/** 读现有库结构 + 已登记的模型指纹 + 列契约现状 */
async function readCurrent(): Promise<{
  live: LiveColumn[];
  modelRows: Map<string, { kind: string; ddl_hash: string }>;
  metaObjects: Map<string, string>;
  metaColumns: Set<string>;
}> {
  const live = await query<LiveColumn>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'main'`,
  );
  const modelRows = new Map<string, { kind: string; ddl_hash: string }>();
  for (const r of await query<{ name: string; kind: string; ddl_hash: string }>(
    `SELECT name, kind, ddl_hash FROM _model`,
  )) {
    modelRows.set(r.name, { kind: r.kind, ddl_hash: r.ddl_hash });
  }
  const metaObjects = new Map<string, string>();
  for (const r of await query<{ object_name: string; sig: string }>(
    `SELECT object_name, kind || '|' || coalesce(grain, '') AS sig FROM _meta_objects`,
  )) {
    metaObjects.set(r.object_name, r.sig);
  }
  const metaColumns = new Set<string>();
  for (const r of await query<{ sig: string }>(
    `SELECT table_name || '.' || column_name || '|' || role || '|' || coalesce(semantic,'') || '|' ||
            coalesce(unit,'') || '|' || coalesce(ref_table,'') AS sig FROM _meta_columns`,
  )) {
    metaColumns.add(r.sig);
  }
  return { live, modelRows, metaObjects, metaColumns };
}

/** 契约投影的比较签名（与 `_meta_objects` / `_meta_columns` 里存的那两份对齐） */
function metaSignatures(o: ReturnType<typeof metaOf>[number]): { object: string; columns: string[] } {
  return {
    object: `${o.kind}|${o.grain ? o.grain.join(',') : ''}`,
    columns: o.columns.map(
      (c) => `${o.name}.${c.column}|${c.role}|${c.semantic ?? ''}|${c.unit ?? ''}|${c.refTable ?? ''}`,
    ),
  };
}

/** 一张表的行数（只在"要加 NOT NULL 列"时用得到，那时表小不了，但也不该全表扫） */
async function rowCount(table: string): Promise<number> {
  const r = await query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(r[0]?.n ?? 0);
}

/**
 * 算 diff。**只读**，不写一个字。
 *
 * @param ir 声明的 IR（`loadModels()` 的产物）
 */
export async function planModels(ir: Ir): Promise<ModelPlan> {
  const cur = await readCurrent();
  const liveTables = new Set(cur.live.map((c) => c.table_name));
  const liveCols = new Map<string, string>(); // table.column → data_type（大写归一）
  for (const c of cur.live) liveCols.set(`${c.table_name}.${c.column_name}`, c.data_type.toUpperCase());

  const changes: ModelChange[] = [];
  for (const t of ir.tables) {
    if (!liveTables.has(t.name)) {
      changes.push({
        kind: 'create-table',
        table: t.name,
        detail: `建表 ${t.name}（${t.columns.length} 列 / 主键 ${t.primaryKey.join(',')}）`,
        blocking: false,
        sql: createTableSql(t),
      });
      // 新建的表连契约一起登记（否则"表在了、契约还没"那段窗口里，catalog 会说瞎话）
      changes.push({
        kind: 'register-meta',
        table: t.name,
        detail: `登记 ${t.name} 的列契约`,
        blocking: false,
      });
      continue;
    }
    // 声明里有、库里没有 → 加列
    for (const c of t.columns) {
      if (liveCols.has(`${t.name}.${c.name}`)) continue;
      // 新列要 NOT NULL 且没默认值：库里有数据时 DuckDB 会直接失败 —— 交给人数，不擅自改声明
      const risky = c.notNull && !c.default && (await rowCount(t.name)) > 0;
      changes.push({
        kind: 'add-column',
        table: t.name,
        column: c.name,
        detail: risky
          ? `加列 ${t.name}.${c.name}（${c.type} NOT NULL）—— 表里已经有数据，这一列没有值可填`
          : `加列 ${t.name}.${c.name}（${c.type}${c.default ? ` DEFAULT ${c.default}` : ''}）`,
        blocking: risky,
        sql: addColumnSql(t.name, c),
      });
    }
    // 类型不一致 → 阻塞（改类型可能丢精度、也可能让旧值不合约束）
    for (const c of t.columns) {
      const liveType = liveCols.get(`${t.name}.${c.name}`);
      if (liveType && liveType !== c.type) {
        changes.push({
          kind: 'type-changed',
          table: t.name,
          column: c.name,
          detail: `${t.name}.${c.name} 的类型不一致：声明 ${c.type} / 库里 ${liveType}`,
          blocking: true,
        });
      }
    }
    // 库里有、声明里没有 → 阻塞（**永不自动删列**：那是丢数据）
    for (const live of cur.live.filter((c) => c.table_name === t.name)) {
      if (!t.columns.some((c) => c.name === live.column_name)) {
        changes.push({
          kind: 'drop-column',
          table: t.name,
          column: live.column_name,
          detail: `${t.name}.${live.column_name} 在库里存在、声明里没有 —— 生成器**不删列**`,
          blocking: true,
        });
      }
    }
    // 列契约是否该刷新
    const meta = metaOf({ apiVersion: ir.apiVersion, tables: [t] })[0]!;
    const sig = metaSignatures(meta);
    // ★ 只在**契约真的不一致**时报变更（不拿 `_model.ddl_hash` 当依据）：
    //   ddl_hash 是 apply 的账本；拿账本当触发条件，会在"结构早就对了、只是没 apply 过"的库上
    //   永远报一堆假变更（第一版就是这样，plan 在空库上永远 pending）。
    const metaOk =
      cur.metaObjects.get(t.name) === sig.object && sig.columns.every((s) => cur.metaColumns.has(s));
    if (!metaOk) {
      changes.push({
        kind: 'register-meta',
        table: t.name,
        detail: `刷新 ${t.name} 的列契约（声明层的投影与库里登记的那份不一致）`,
        blocking: false,
      });
    }
  }
  // 声明里没有、库里有的**语义表**（新建了表却没声明）—— 列到"阻塞"这一侧，因为生成器不管无主的表
  for (const t of liveTables) {
    if (!/^(dim|fact|map)_/.test(t) || t === 'dim_alias') continue;
    if (!ir.tables.some((d) => d.name === t)) {
      changes.push({
        kind: 'undeclared-table',
        table: t,
        detail: `库里有语义表 ${t}，但没有任何声明管它 —— 生成器不会去动它`,
        blocking: true,
      });
    }
  }

  const blocking = changes.filter((c) => c.blocking);
  const structural = changes.filter((c) => typeof c.sql === 'string' && !c.blocking);
  return {
    tables: ir.tables.length,
    changes,
    blocking,
    pending: changes.length > 0,
    structural,
    irHash: ir.tables.map(ddlHashOf).sort().join(','),
    appliedHash:
      cur.modelRows.size === 0
        ? null
        : [...cur.modelRows.entries()]
            .map(([n, r]) => `${n}:${r.ddl_hash}`)
            .sort()
            .join(','),
  };
}

/** 人话摘要（CLI 的 stderr / 给人看的那一行） */
export function summarizePlan(plan: ModelPlan): string {
  if (!plan.pending) return `模型声明与库结构一致（${plan.tables} 张表，无变更）`;
  const auto = plan.changes.filter((c) => !c.blocking);
  const lines = auto.map((c) => `  · ${c.detail}`);
  if (plan.blocking.length > 0) {
    lines.push(`  ⚠️ ${plan.blocking.length} 项**不会自动做**（要先由人决定）：`);
    lines.push(...plan.blocking.map((c) => `     ! ${c.detail}`));
  }
  return `${plan.tables} 张表：${auto.length} 项可落地 / ${plan.blocking.length} 项阻塞\n${lines.join('\n')}`;
}

export { depsOf };
