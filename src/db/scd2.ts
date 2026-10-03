/**
 * 维度版本行（SCD2 之二的 **类型 2**）—— `docs/需求与架构.md` §4.1、`docs/开发计划.md` §1.3。
 *
 * ★ 形状：**历史挂在侧表**（`dim_company_hist` / `dim_metric_hist`），`dim_company` / `dim_metric`
 *   仍然是**当前态的唯一真相**。为什么不把版本行塞进维表本身（PK 改成 `(id, valid_from)`）：
 *   那样**每一处 join 都必须补 `is_current`** —— 少写一处，同一家公司在结果里出现两次，
 *   数字翻倍而报表看起来完全正常。侧表把这份成本关在一处：**既有查询一个字都不用改**，
 *   历史查询必须显式说"我要 as-of"（`dimAsOf`）。
 *   ⚠️ 已知边界（写在 `models/*_hist.yml` 里，别当漏做）：事实行只记业务键，
 *      "按事实期自动取当时那一版"需要一次显式 as-of join。
 *
 * ★ 三条纪律（都是这个仓库反复踩出来的）：
 *   ① **`valid_from` 用期的首日，不用 `now()`** —— 重放要确定性。同一份 raw 重跑两次，
 *      "这一版从哪天生效"必须一样；用 now() 会让重放得出不同答案（`AGENTS.md` §4 备忘 12 的同族）。
 *   ② **半开区间** `[valid_from, valid_to)`：`valid_to` = 下一版生效日，NULL = 生效中。
 *      闭合区间会让"同一天换属性"变成两版都有效。
 *   ③ **本模块不开事务**：它由调用方（`runIngest` 的阶段 2、或人/脚本）在**已有事务或裸连接**下调用，
 *      自己 BEGIN 会把调用方的事务撕开（与 `registerAlias` 同一条纪律）。
 */
import { execute, query, queryWriter } from './index.ts';
import type { DimKind } from '../ingest/resolve.ts';

export interface Scd2Dim {
  kind: DimKind;
  /** 当前态维表 */
  table: string;
  /** 历史侧表 */
  hist: string;
  /** 被版本化的属性列（其余列是键/系统列） */
  attrs: string[];
}

/** SCD2 覆盖的维度 —— 只有真的"属性会变"的维度才进来 */
export const SCD2_DIMS: Record<DimKind, Scd2Dim> = {
  company: {
    kind: 'company',
    table: 'dim_company',
    hist: 'dim_company_hist',
    attrs: ['name', 'parent_id', 'level', 'group_name'],
  },
  metric: {
    kind: 'metric',
    table: 'dim_metric',
    hist: 'dim_metric_hist',
    attrs: ['name', 'category', 'unit', 'direction'],
  },
};

export function scdOf(kind: DimKind): Scd2Dim {
  const d = SCD2_DIMS[kind];
  if (!d) throw new Error(`这个维度没有 SCD2 版本化：${kind}`);
  return d;
}

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** `2026-06` → `2026-06-01`（期的首日 —— 版本生效日只用它，不用 now()） */
export function firstDayOf(period: string): string {
  return /^\d{4}-\d{2}/.test(period) ? `${period.slice(0, 7)}-01` : period;
}

/** 今天是哪一天 —— **只给"人改属性"用**；落库那条路一律用期的首日（见文件头纪律 ①） */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 当前态属性（从维表读；维表里没有这条 id → null）。
 *
 * ⚠️ 走 **queryWriter**（写连接）：这两个 helper 会在 `runIngest` 的事务里被调用，
 *   而**读连接看不到本事务尚未提交的写** —— 用 query() 会得到"刚建好的维行不存在"
 *   （实测：写首版时直接抛"dim_company 里没有 c_xxx"）。与 `runIngest` 数自己刚写的行同一个理由。
 */
async function currentAttrs(dim: Scd2Dim, id: string): Promise<Record<string, unknown> | null> {
  const rows = await queryWriter<Record<string, unknown>>(
    `SELECT ${dim.attrs.join(', ')} FROM ${dim.table} WHERE id = ${lit(id)}`,
  );
  return rows[0] ?? null;
}

async function openVersion(dim: Scd2Dim, id: string): Promise<Record<string, unknown> | null> {
  const rows = await queryWriter<Record<string, unknown>>(
    `SELECT valid_from, ${dim.attrs.join(', ')} FROM ${dim.hist}
     WHERE id = ${lit(id)} AND valid_to IS NULL ORDER BY valid_from DESC`,
  );
  return rows[0] ?? null;
}

/**
 * 给**刚建出来的**维行写首版（`runIngest` 建公司/指标时调）。
 *
 * ★ 为什么建维就写首版：不写的话，"当前态有这行、历史里没有"就是一个**结构性**的不一致
 *   （`scdProblems()` 会报）。让两件事在**同一个事务**里发生，是它不漂的前提
 *   （与"数据与元数据同一事务"同一个理由）。
 * ★ 幂等：同一个 `(id, valid_from)` 重复写是 no-op（重放会走到这里）。
 */
export async function writeFirstVersion(kind: DimKind, id: string, period: string): Promise<void> {
  const dim = scdOf(kind);
  const cur = await currentAttrs(dim, id);
  if (!cur) throw new Error(`写首版失败：${dim.table} 里没有 ${id}（先建维，再写版本行）`);
  const cols = dim.attrs;
  await execute(
    `INSERT INTO ${dim.hist} (id, valid_from, valid_to, is_current, ${cols.join(', ')})
     VALUES (${lit(id)}, ${lit(firstDayOf(period))}::DATE, NULL, TRUE, ${cols
       .map((c) => (cur[c] === null || cur[c] === undefined ? 'NULL' : lit(String(cur[c]))))
       .join(', ')})`,
  );
}

export interface SetAttrsResult {
  changed: boolean;
  kind: DimKind;
  id: string;
  validFrom: string;
  /** 关掉的那一版从哪天起（没关就是 null） */
  closedFrom: string | null;
  /** 没变时给出原因，别让人以为"写了没生效" */
  note: string;
}

/**
 * 改一个维度的属性（**属性真的变了**才产生新版本）。
 *
 * 三件事在调用方的事务里一起做：关旧版（`valid_to` = 新版生效日）→ 开新版 → 把**当前态维表**更新成新值。
 * 顺序不能颠倒：先开新版再关旧版，中间那一刻会有两版同时"生效中"。
 *
 * @param attrs 只给要改的列（其余保持当前值）
 * @param opts.effectiveFrom 新版从哪天生效；默认今天。**落库路径请显式给期的首日**
 */
export async function setDimAttributes(
  kind: DimKind,
  id: string,
  attrs: Record<string, string | number | null>,
  opts: { effectiveFrom?: string } = {},
): Promise<SetAttrsResult> {
  const dim = scdOf(kind);
  const cur = await currentAttrs(dim, id);
  if (!cur) throw new Error(`改属性失败：${dim.table} 里没有 ${id}（不新建维度 —— 那是接入层的两阶段流程）`);
  const from = opts.effectiveFrom ?? today();

  const next: Record<string, string | null> = {};
  const curNorm: Record<string, string | null> = {};
  for (const c of dim.attrs) {
    const given = Object.hasOwn(attrs, c) ? attrs[c] : (cur[c] as string | null);
    next[c] = given === null || given === undefined ? null : String(given);
    // ⚠️ 比较前**两边都归一成字符串**：DuckDB 把 INTEGER 取回来是 number（level = 2），
    //    而 `String(2) !== 2` —— 不归一的话"没变"会被判成"变了"，于是每次调用都造一个新版本（踩过一次）。
    curNorm[c] = cur[c] === null || cur[c] === undefined ? null : String(cur[c]);
  }
  const same = dim.attrs.every((c) => curNorm[c] === next[c]);
  if (same) {
    return { changed: false, kind, id, validFrom: from, closedFrom: null, note: `属性没有变化（${dim.table}.${id}）—— 不产生新版本` };
  }
  // 生效日不能早于/等于当前开放版本的起点（那会造出重叠区间，scdProblems() 会报）
  const open = await openVersion(dim, id);
  const openFrom = open ? String(open.valid_from).slice(0, 10) : null;
  if (openFrom !== null && from <= openFrom) {
    throw new Error(
      `改属性的生效日 ${from} 不晚于当前版本起点 ${openFrom} —— 那会让两个版本同时"生效中"（区间重叠）。` +
        ` 换一个更晚的生效日，或先修历史。`,
    );
  }

  // ① 关旧版：valid_to = 新版生效日（半开区间）
  await execute(
    `UPDATE ${dim.hist} SET valid_to = ${lit(from)}::DATE, is_current = FALSE ` +
      `WHERE id = ${lit(id)} AND valid_to IS NULL`,
  );
  // ② 开新版
  await execute(
    `INSERT INTO ${dim.hist} (id, valid_from, valid_to, is_current, ${dim.attrs.join(', ')})
     VALUES (${lit(id)}, ${lit(from)}::DATE, NULL, TRUE, ${dim.attrs
       .map((c) => (next[c] === null ? 'NULL' : lit(next[c]!)))
       .join(', ')})`,
  );
  // ③ 当前态维表跟上（它才是"现在长什么样"的真相）
  await execute(
    `UPDATE ${dim.table} SET ${dim.attrs.map((c) => `${c} = ${next[c] === null ? 'NULL' : lit(next[c]!)}`).join(', ')} ` +
      `WHERE id = ${lit(id)}`,
  );
  return { changed: true, kind, id, validFrom: from, closedFrom: openFrom, note: `新版本自 ${from} 起生效；上一版已关闭` };
}

/** 一个维度的全部版本（按生效日升序；给人看"这家公司变过哪些次"） */
export async function dimHistory(kind: DimKind, id: string): Promise<Array<Record<string, unknown>>> {
  const dim = scdOf(kind);
  return query<Record<string, unknown>>(
    `SELECT strftime(valid_from, '%Y-%m-%d') AS valid_from, ` +
      `CASE WHEN valid_to IS NULL THEN NULL ELSE strftime(valid_to, '%Y-%m-%d') END AS valid_to, ` +
      `is_current, ${dim.attrs.join(', ')} FROM ${dim.hist} WHERE id = ${lit(id)} ORDER BY valid_from`,
  );
}

/**
 * **时点查询**：`on` 这天生效的那一版（半开区间 `[valid_from, valid_to)`）。
 *
 * ★ 这是"类型 2"真正买到的东西：`dim_company` 只有现在，而这里能回答
 *   "2026-06 那期报表里的板块是什么" —— 属性后来变了也不会把历史报表改掉。
 */
export async function dimAsOf(kind: DimKind, id: string, on: string): Promise<Record<string, unknown> | null> {
  const dim = scdOf(kind);
  const rows = await query<Record<string, unknown>>(
    `SELECT valid_from, valid_to, is_current, ${dim.attrs.join(', ')} FROM ${dim.hist}
     WHERE id = ${lit(id)} AND valid_from <= ${lit(on)}::DATE
       AND (valid_to IS NULL OR ${lit(on)}::DATE < valid_to)
     ORDER BY valid_from DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * **不变量对拍**（空数组 = 历史与当前态一致）。
 *
 * 这是让"两份表示"（`dim_company` vs `dim_company_hist`）免于漂移的唯一机制 ——
 * 与 `metaProblems()` 同一个套路：守卫必须能**证明自己会抓**（e2e 会喂一份坏数据进来）。
 * 五类问题：
 *   ① 当前维行没有开放版本（历史里查不到"现在这一版"）
 *   ② 当前维行的属性与开放版本不一致（有人只改了维表、没走 setDimAttributes）
 *   ③ 开放版本在维表里找不到同 id（历史里有、现在没有 —— 孤儿版本）
 *   ④ 同一个 id 有多条开放版本（区间重叠）
 *   ⑤ `is_current` 与 `valid_to IS NULL` 互相矛盾，或 `valid_to <= valid_from`
 */
export async function scdProblems(): Promise<string[]> {
  const problems: string[] = [];
  for (const dim of Object.values(SCD2_DIMS)) {
    const openRows = await query<Record<string, unknown> & { id: string; n: number }>(
      `SELECT id, count(*) AS n FROM ${dim.hist} WHERE valid_to IS NULL OR is_current GROUP BY id`,
    );
    // ④ 一个 id 多条开放版本
    for (const r of openRows) {
      if (Number(r.n) > 1) problems.push(`④ ${dim.hist} 里 ${r.id} 有 ${r.n} 条开放版本（区间重叠）`);
    }
    // ⑤ is_current 与 valid_to 矛盾
    const contradictions = await query<{ id: string; valid_from: string; valid_to: unknown; is_current: unknown }>(
      `SELECT id, strftime(valid_from, '%Y-%m-%d') AS valid_from, valid_to, is_current FROM ${dim.hist}
       WHERE (is_current AND valid_to IS NOT NULL) OR (NOT is_current AND valid_to IS NULL)`,
    );
    for (const r of contradictions) {
      problems.push(`⑤ ${dim.hist} 的 ${r.id}（自 ${r.valid_from}）is_current 与 valid_to 互相矛盾`);
    }
    const badInterval = await query<Record<string, unknown>>(
      `SELECT id FROM ${dim.hist} WHERE valid_to IS NOT NULL AND valid_to <= valid_from`,
    );
    for (const r of badInterval) problems.push(`⑤ ${dim.hist} 的 ${String(r.id)} 区间不合法（valid_to <= valid_from）`);

    // ①②③ 当前维行 ⇄ 开放版本
    const tbl = await query<{ id: string }>(`SELECT id FROM ${dim.table}`);
    for (const t of tbl) {
      const open = await openVersion(dim, t.id);
      if (!open) {
        problems.push(`① ${dim.table}.${t.id} 没有开放版本（历史里查不到"现在这一版"）`);
        continue;
      }
      const cur = await currentAttrs(dim, t.id);
      const diff = dim.attrs.filter((c) => (cur?.[c] ?? null) !== (open[c] ?? null));
      if (diff.length > 0) {
        problems.push(`② ${dim.table}.${t.id} 与它的开放版本不一致：${diff.join('、')}（改属性要走 setDimAttributes）`);
      }
    }
    // ③ 孤儿版本：开放版本指向一个已经不存在的当前维行
    const ids = new Set(tbl.map((r) => r.id));
    for (const r of await query<{ id: string }>(`SELECT DISTINCT id FROM ${dim.hist}`)) {
      if (!ids.has(r.id)) problems.push(`③ ${dim.hist}.${r.id} 在 ${dim.table} 里已经不存在（孤儿版本）`);
    }
  }
  return problems;
}

/** 仅供测试观察：本条 id 在历史里有几版（e2e 用它断言"没变就不该涨版本"） */
export async function versionCount(kind: DimKind, id: string): Promise<number> {
  const dim = scdOf(kind);
  const r = await queryWriter<{ n: number }>(
    `SELECT count(*) AS n FROM ${dim.hist} WHERE id = ${lit(id)}`,
  );
  return Number(r[0]?.n ?? 0);
}
