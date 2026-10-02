/**
 * 主数据对齐（对应 docs/需求与架构.md §10 R1）
 *
 * 问题：集团导出的 Excel 里，同一个实体每月的写法可能不同 ——
 * 「集团有限公司」/「集团公司」/「集团公司(本部)」都指同一家公司。
 * 若不归并，第二个月就会新建一条主数据，于是**同一家公司的钱被拆到两条主数据上**，
 * 汇总时看着像少了一半。文档原话：**不做则三个月后数据全是孤儿行。**
 *
 * ★ 核心安全立场：**合并两家公司比不合并危险得多。**
 *   不合并 → 数字明显不对，人会来查；
 *   错合并 → 两家公司的钱被静默加在一起，报表看起来完全正常。
 *   因此本模块把匹配分成两档，界线划在「规范化是否会改变语义」：
 *
 *   | 档 | 判据 | 处理 | 为什么安全 |
 *   |---|---|---|---|
 *   | **Tier 1 自动** | `normalizeName()` 后完全相同 | 直接归并 | 规范化只去**格式噪音**（全角/空格/括号/大小写），不碰语义 |
 *   | **Tier 2 需确认** | 去壳（「华东子公司」→「华东」）、互相包含、编辑距离 | 只**给候选**，人拍板 | 去壳会改变语义：「有限公司」vs「集团」剥掉后可能撞在一起 |
 *
 *   人确认一次之后，这个写法就被记进 `dim_alias`，**下个月自动命中 Tier 1** ——
 *   一次人工投入换来永久自动化，这才是把"每月都要人认一遍"变成一次性成本的关键。
 */
import { execute, query } from '../db/index.ts';

export type DimKind = 'company' | 'metric';

// ★ 规范化的唯一实现已搬到 src/ingest/normalize.ts ——
//   接入层判重与主数据归并必须共用同一份判据（旧实现两处不一致，出过静默覆盖）。
//   这里**import 进来再转出**：本文件内部多处还在用它们，只 `export ... from`
//   不会把名字带进本地作用域（那样会变成运行时 ReferenceError）。
import { normalizeName, stemCompany } from '../ingest/normalize.ts';
export { normalizeName, stemCompany };

/** 编辑距离（用于"写法相近"的候选；短字符串足够快） */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

export interface Candidate {
  id: string;
  name: string;
  /** 0~1，越大越像 */
  score: number;
  /** 为什么觉得像 —— 给人看的，不给人看依据的推荐等于猜 */
  why: string;
}

export interface UnresolvedName {
  /**
   * 这是公司名还是指标名。
   *
   * ★ 必须带上：候选清单是「公司」和「指标」两个 Resolver 分别产出的，
   *   汇总给前端后就再也分不出谁是谁了。缺了它前端只能瞎猜标签，
   *   而人拍板时回传的 `DimDecision.kind` 也会变成 `undefined` ——
   *   服务端按 `kind|normalized` 查决定表，永远匹配不上，
   *   于是「确认」按钮点了等于没点，提交被无限次拦下。
   */
  kind: DimKind;
  raw: string;
  normalized: string;
  /** 这个名字出现在多少行数据里（越多的越该先处理） */
  rows: number;
  /** 建议并入的已有主数据；为空 = 看起来确实是个新实体 */
  candidates: Candidate[];
}

/** 已注册的主数据（dim_company / dim_metric 一行） */
export interface KnownEntity {
  id: string;
  name: string;
  /** 兼容既有的 `alias VARCHAR[]` 列，与 dim_alias 表合并使用 */
  aliases: string[];
}

export async function loadEntities(kind: DimKind): Promise<KnownEntity[]> {
  const table = kind === 'company' ? 'dim_company' : 'dim_metric';
  const rows = await query<{ id: string; name: string; alias: string[] | null }>(
    `SELECT id, name, alias FROM ${table}`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, aliases: r.alias ?? [] }));
}

/** dim_alias 表里的映射（kind, normalized）→ target_id */
export async function loadAliases(kind: DimKind): Promise<Map<string, string>> {
  const rows = await query<{ normalized: string; target_id: string }>(
    `SELECT normalized, target_id FROM dim_alias WHERE kind = '${kind}'`,
  );
  return new Map(rows.map((r) => [r.normalized, r.target_id]));
}

export interface Resolver {
  kind: DimKind;
  /** Tier 1：规范化后命中 → 返回 id；未命中 → undefined */
  resolve(raw: string): string | undefined;
  /** 命中时返回归并到的那条主数据（用来告诉人"这个写法被并进了谁"） */
  entityOf(raw: string): KnownEntity | undefined;
  /** 这个名字的 Tier 2 候选（需要人拍板的） */
  candidates(raw: string): Candidate[];
  ents: KnownEntity[];
}

/**
 * 建索引。Tier 1 的命中源有三处，全部走 `normalizeName`：
 * 主名、`dim_company.alias` 数组（历史遗留）、`dim_alias` 表（人确认过的、带来源）。
 */
export async function buildResolver(kind: DimKind): Promise<Resolver> {
  const ents = await loadEntities(kind);
  const byId = new Map(ents.map((e) => [e.id, e]));
  const byNormalized = new Map<string, string>();
  for (const e of ents) {
    byNormalized.set(normalizeName(e.name), e.id);
    for (const a of e.aliases) byNormalized.set(normalizeName(a), e.id);
  }
  // dim_alias 表是"人确认过的映射"，优先级最高 —— 后写覆盖先写。
  // 若一条别名表记录把人确认过的写法指向某主数据，主名/alias 数组不该再把它掰回去。
  for (const [norm, target] of await loadAliases(kind)) byNormalized.set(norm, target);

  const stemmed = new Map<string, KnownEntity[]>();
  if (kind === 'company') {
    for (const e of ents) {
      const s = stemCompany(e.name);
      if (!s) continue;
      // 同名竞争（两家公司剥壳后同为「华东」）→ 不能给"就并到这个"的建议，
      // 但候选列表仍要展示出来，让"确实撞车了"这件事可见
      stemmed.set(s, [...(stemmed.get(s) ?? []), e]);
    }
  }

  const resolve = (raw: string): string | undefined => byNormalized.get(normalizeName(raw));
  const entityOf = (raw: string): KnownEntity | undefined => {
    const id = resolve(raw);
    return id === undefined ? undefined : byId.get(id);
  };

  const candidates = (raw: string): Candidate[] => {
    const n = normalizeName(raw);
    if (!n) return [];
    const out: Candidate[] = [];

    if (kind === 'company') {
      const s = stemCompany(raw);
      for (const e of stemmed.get(s) ?? []) {
        if (e.id === resolve(raw)) continue;
        out.push({ id: e.id, name: e.name, score: 0.9, why: '字号相同（剥掉「有限公司」「集团」等形式后缀后一致）' });
      }
      // ★ 字号是公司名的权威标识（华东 / 华南 / 华北 / 集团），字号一旦对上就无需再猜。
      //   继续用编辑距离补候选只会引入噪音：「华东分公司」与「华南子公司」仅差 2 字、
      //   相似度 0.6，但它们显然是两家公司。**有强信号时就不要弱信号。**
      if (out.length) return out.sort((a, b) => b.score - a.score).slice(0, 3);
    }

    for (const e of ents) {
      if (e.id === resolve(raw)) continue;
      if (out.some((c) => c.id === e.id)) continue;
      const en = normalizeName(e.name);
      if (!en) continue;
      if (en.includes(n) || n.includes(en)) {
        out.push({ id: e.id, name: e.name, score: 0.75, why: '名称互相包含' });
        continue;
      }
      // ★ 「写法相近」必须要求**首字相同**。中文名字的开头才是区分度所在，
      //   否则共享公司形式后缀的名字会互相误报。
      if (n[0] !== en[0]) continue;
      const ratio = 1 - editDistance(n, en) / Math.max(n.length, en.length);
      if (ratio >= 0.6) {
        out.push({ id: e.id, name: e.name, score: ratio * 0.7, why: '写法相近' });
      }
    }

    return out.sort((a, b) => b.score - a.score).slice(0, 3);
  };

  return { kind, resolve, entityOf, candidates, ents };
}

/**
 * 把一批"未识别名称"整理成给人确认的清单。
 *
 * `values` 传**原始数组**（含重复），内部统计出现行数 ——
 * 出现 800 行的名字和出现 2 行的名字该有不同的处理优先级，
 * 所以清单按 `rows` 降序排。**人来核对时最该先看的是前者。**
 */
export function describeUnresolved(r: Resolver, values: string[]): UnresolvedName[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, rows]) => ({
      kind: r.kind,
      raw: value,
      normalized: normalizeName(value),
      rows,
      candidates: r.candidates(value),
    }));
}

/**
 * 登记一条别名：`raw` 这个写法以后都归 `targetId`。
 *
 * 幂等。若这个规范化键此前指向**另一个**目标，返回 `previousTarget` 让人知道改动了什么
 * （这是一次"纠错"，值得留下痕迹，但不阻止 —— 人是有意改的）。
 */
export async function registerAlias(
  kind: DimKind,
  raw: string,
  targetId: string,
  note?: string,
): Promise<{ created: boolean; previousTarget: string | null }> {
  const normalized = normalizeName(raw);
  if (!normalized) throw new Error(`别名不能为空（原值: ${JSON.stringify(raw)}）`);

  const prev = await query<{ target_id: string }>(
    `SELECT target_id FROM dim_alias WHERE kind = '${kind}' AND normalized = '${esc(normalized)}'`,
  );
  const previousTarget = prev[0]?.target_id ?? null;

  await execute(
    `INSERT INTO dim_alias (kind, normalized, alias, target_id, note, created_at)
     VALUES ('${kind}', '${esc(normalized)}', '${esc(String(raw))}', '${esc(targetId)}', ${note ? `'${esc(note)}'` : 'NULL'}, now())
     ON CONFLICT (kind, normalized) DO UPDATE SET target_id = EXCLUDED.target_id, alias = EXCLUDED.alias`,
  );

  return { created: previousTarget === null, previousTarget: previousTarget === targetId ? null : previousTarget };
}

export async function listAliases(kind?: DimKind): Promise<
  Array<{ kind: string; alias: string; normalized: string; targetId: string; targetName: string | null; note: string | null }>
> {
  const where = kind ? `WHERE kind = '${kind}'` : '';
  const rows = await query<{ kind: string; alias: string; normalized: string; target_id: string; note: string | null }>(
    `SELECT kind, alias, normalized, target_id, note FROM dim_alias ${where} ORDER BY kind, alias`,
  );
  // 目标名单独查，避免在 SQL 里拼两张不同维表的 join
  const names = new Map<string, string>();
  for (const e of await loadEntities('company')) names.set(e.id, e.name);
  for (const e of await loadEntities('metric')) names.set(e.id, e.name);
  return rows.map((r) => ({
    kind: r.kind, alias: r.alias, normalized: r.normalized,
    targetId: r.target_id, targetName: names.get(r.target_id) ?? null, note: r.note,
  }));
}

function esc(v: string): string {
  return v.replace(/'/g, "''");
}
