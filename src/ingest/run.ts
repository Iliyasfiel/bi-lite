/**
 * 接入规格的**执行器**：源 Excel → 星型表。
 *
 * 与旧 `src/import/longtable.ts` 的唯一区别是**形状不再写死**：
 * 哪几列是行键、哪几列是值列、每个值列什么口径、网格里没有的键从哪来、哪些行要丢掉，
 * 全部来自 `IngestSpec`。其余语义 —— 两阶段落库、主数据归并两档、全有或全无、批次留痕 ——
 * 原样搬过来（`longtable.ts` 随之退场，所以这是"搬家"不是"抄一份"：
 * 同一份判据只允许存在一处，见铁律 17）。
 *
 * ★ 校验与落库是**同一条路径**：先跑 `dryRunIngest`（结构 lint + 文件级判据），
 *   只要有一条 error 就一行都不写。旧实现的漏洞正在这里 ——
 *   `/api/import/commit` 重读盘直接落库，唯一的强制力是浏览器那个 `disabled` 按钮，
 *   于是"校验"只活在可被绕过的一层（`src/server.ts:162-166`）。
 *
 * ★ 铁律 1：金额只在本文件的局部变量与 SQL 字面量里出现。
 *   返回的 `shape`（形状）可以原样给 agent；`IngestRunResult` 里没有任何金额字段。
 */
import { existsSync, mkdirSync } from 'node:fs';
import { PARQUET_ROOT, PART_FILE } from '../db/compact.ts';
import { execute, exportParquet, query, queryWriter } from '../db/index.ts';
import { findRawFile, landRawFile } from '../land/raw.ts';
import { rawWorkbook } from '../land/read.ts';
import { registerMeta } from '../meta/columns.ts';
import { writeFirstVersion } from '../db/scd2.ts';
import { resolveSource } from '../paths.ts';
import type { ReadableWorkbook } from '../spec/template.ts';
import {
  buildResolver,
  registerAlias,
  normalizeName,
  type DimKind,
  type UnresolvedName,
} from './resolve.ts';
import { dryRunIngest, type IngestFactRow, type IngestShape, type MasterCatalog } from './dryrun.ts';
import { DEFAULT_TARGET, type DimDecision, type IngestIssue, type IngestSpec } from './types.ts';
import { nameHash } from '../gen/ir.ts';

export interface IngestRunOptions {
  /** 主数据快照（来自 `catalog()`，调用方注入 → 本模块可脱库测试） */
  catalog: MasterCatalog;
  /**
   * **源文件（执行参数）**—— 覆盖规格里的 `source:`（架构 §8.1）。
   * 传给 dryRunIngest 的是同一个值，所以干跑与落库不会各读各的源。
   */
  source?: string;
  /** 人对未识别名称的处置决定（覆盖自动判定；merge 的会写进 dim_alias） */
  decisions?: DimDecision[];
  /** 是否允许为新实体建维（默认 true）。"看起来像已有实体"的名字不受它保护，照样要人拍板 */
  autoCreateDims?: boolean;
  /** 有歧义时直接抛错（界面先预览再确认时用得到）；默认 false → 返回结论让人拍板 */
  strict?: boolean;
  maxRows?: number;
  /** 只走到"判定完成"就停下（写库之前），用于"先看结论、再点确认"的两步界面 */
  planOnly?: boolean;
}

export interface IngestRunResult {
  ok: boolean;
  batchId: string | null;
  /** 真正写进 fact_finance 的行数 */
  inserted: number;
  createdCompanies: string[];
  createdMetrics: string[];
  /** Tier 1 自动归并且留痕的写法（"我的公司名怎么不见了"要查得到） */
  merged: Array<{ kind: DimKind; raw: string; target: string; rows: number }>;
  /** Tier 2：疑似已有实体但没有人工决定 —— **这些名字的行不会写库**，必须人拍板后重提 */
  needsDecision: Array<{ kind: DimKind; raw: string; rows: number; candidates: UnresolvedName['candidates'] }>;
  /** 因 needsDecision 而被跳过的行数 */
  skippedRows: number;
  /** 源里**空**的值格数。空不是 0，也不是一条事实 —— 这些格子不落库 */
  emptyMeasureCells: number;
  /** 读取/结构层的 error。非空 = 一行都没写 */
  errors: IngestIssue[];
  /** 形状（可原样给 agent：里面没有任何金额） */
  shape: IngestShape;
  /** Parquet 归档是否成功（失败不影响落库，但要说出来） */
  archived: boolean;
  /** 本次落库**同事务重建**的聚合表名（以本次 target 为 source 的那些；空 = 没有聚合管这张表） */
  rebuiltAggregates: string[];
  /** 只会有值于 planOnly：按当前规格与快照，这次会**新建**哪些主数据 */
  willCreate?: Array<{ kind: DimKind; raw: string }>;
  /** 一句话结论（planOnly 用：会不会被拒、为什么） */
  note?: string;
}

/** 新建实体的 id 是名字的纯函数（阶段 1 无需写库即可算出）。哈希本体在 IR 层（`nameHash`），
 *  与 sync 的声明行 id 同源 —— 两处存量 id 一起绑在这一个函数上，谁也别想单独改。 */
function entityId(kind: DimKind, raw: string): string {
  return `${kind === 'company' ? 'c' : 'm'}_${nameHash(raw)}`;
}
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
const day = (period: string) => `${period}-01`;

let batchSeq = 0;
function newBatchId(): string {
  return `b${Date.now().toString(36)}${(batchSeq++).toString(36)}`;
}

/** 先探查"能不能着陆"（白名单内 + 文件存在）。**不吞错** —— 探不通时不在这儿报，
 *  而是让 dryRunIngest 产出**结构化**的 SOURCE_NOT_FOUND / SOURCE_OUTSIDE_ROOTS，
 *  那是它与 agent / 人约定的错误形状，不能因为多了着陆这一步就变成抛出。 */
function landableSource(source: string | undefined): string | null {
  if (!source) return null;
  try {
    const abs = resolveSource(source);
    return existsSync(abs) ? abs : null;
  } catch {
    return null; // 白名单判据在 src/paths.ts，这里只是探一下；真正的拒绝由 dryRunIngest 给出
  }
}

/**
 * 落库的**串行队列**：DuckDB 的事务是挂在**连接**上的状态，而下面这段有 `BEGIN`/`COMMIT`。
 * 两个落库并发进来（两个标签页、连点两次、将来某个批量任务），后一个的 `BEGIN` 会撞进
 * 前一个还没提交的事务里 —— **实测**：`cannot start a transaction within a transaction`，
 * 而且因为共享一条连接，前者的 `ROLLBACK` 会把后者连坐成 `Current transaction is aborted`：
 * 五个并发请求**全灭**，错误信息还是 DuckDB 的内部黑话。
 * （数据没坏 —— 回滚是原子的、批次一行不多，但用户动作一个都没成。）
 * 所以同一进程内一次只跑一个落库，其余的排队。
 *
 * ★ 干跑（`planOnly`）**不进队列**：它一次库都不写，排队只会把只读操作也白白串行化。
 * ★ 队列自己不能被一次失败卡死 —— "一个 rejected 的 promise 污染整条链"是这里最容易踩的坑。
 */
let ingestQueue: Promise<unknown> = Promise.resolve();

export function runIngest(spec: IngestSpec, opts: IngestRunOptions): Promise<IngestRunResult> {
  if (opts.planOnly) return runIngestInner(spec, opts);
  const run = () => runIngestInner(spec, opts);
  // `then(run, run)`：前一个无论成功还是失败，都接着跑下一个
  const next = ingestQueue.then(run, run);
  ingestQueue = next.catch(() => undefined);
  return next;
}

async function runIngestInner(spec: IngestSpec, opts: IngestRunOptions): Promise<IngestRunResult> {
  const rows: IngestFactRow[] = [];
  const onEmptyMeasure = spec.onEmptyMeasure ?? 'skip';

  // ---- 关卡 0：值从哪来 ----
  //  · 真落库且源文件还在 → 先 landRawFile()（同一份文件幂等），再统一从 raw 读 ——
  //    于是"以后还重放得了吗"在数据进库**之前**就已经有了答案。
  //  · 干跑**一次库都不写**：已着陆就读 raw，没着陆就读工作簿。
  //  · **源文件不在了也照样能从 raw 重放**：raw 按内容 hash 定位，而 `raw_source`
  //    记着"这个路径上次对应哪份 raw"（`findRawFile` 的 ②）。源文件是最容易丢的东西，
  //    重放不该依赖它还在。
  //  · source 是执行参数：调用方给的覆盖规格里写的，干跑与落库用同一个值。
  const effSource = opts.source ?? spec.source;
  let openBook: ((absPath: string) => Promise<ReadableWorkbook>) | undefined;
  let landedHash: string | undefined; // 本批实际读的那份 raw（stg 影子的 file_hash）
  if (landableSource(effSource) && !opts.planOnly) {
    const landed = await landRawFile(effSource);
    landedHash = landed.fileHash;
    openBook = () => rawWorkbook(landed.fileHash);
  } else {
    const hash = effSource ? await findRawFile(effSource) : undefined;
    landedHash = hash;
    if (hash) openBook = () => rawWorkbook(hash);
  }

  const shape = await dryRunIngest(spec, {
    catalog: opts.catalog,
    source: opts.source,
    maxRows: opts.maxRows,
    openBook,
    // ★ 只有这里传 onRow：金额在这条路径上唯一一次离开读取循环
    onRow: (r) => rows.push(r),
    writeEmptyMeasures: onEmptyMeasure === 'null',
  });

  const emptyMeasureCells = shape.blocks.reduce((n, b) => n + b.measureCells.empty, 0);
  const errors = shape.issues.filter((i) => i.level === 'error');
  const base: IngestRunResult = {
    ok: false,
    batchId: null,
    inserted: 0,
    createdCompanies: [],
    createdMetrics: [],
    merged: [],
    needsDecision: [],
    skippedRows: 0,
    emptyMeasureCells,
    errors,
    shape,
    archived: false,
    rebuiltAggregates: [],
  };

  // ---- 关卡 1：形状不对，一行都不写 ----
  if (errors.length > 0) {
    // 干跑也要把"为什么跑不了"说成一句话（agent 与人都只需要这一行）
    return opts.planOnly
      ? { ...base, note: `规格/源里有 ${errors.length} 个 error（${errors.map((e) => e.code).join('、')}），现在跑进去也只会一行不落地被拒。先按 issues 改。` }
      : base;
  }

  // ---- 关卡 2：没有可落库的格子 ----
  if (rows.length === 0) {
    const total = shape.blocks.reduce((n, b) => n + b.measureCells.total, 0);
    const incomplete = shape.blocks.reduce((n, b) => n + b.coordinates.incomplete, 0);
    const allEmpty = total > 0 && emptyMeasureCells === total;
    return {
      ...base,
      errors: [
        allEmpty
          ? {
              level: 'error',
              code: 'NO_WRITABLE_ROWS',
              at: 'source',
              message: `没有可落库的事实行：${total} 个值格**全是空的** —— 这份源文件还没有填数（或填数的列没被接进来）。`,
              hint:
                '空值不是 0，也不是一条事实，所以默认（onEmptyMeasure: skip）不写它们。' +
                ' 填上数字再跑一次；确实要把"空"记成 NULL 就写 onEmptyMeasure: null。只想看形状就用 dry-run。',
            }
          : {
              level: 'error',
              code: 'NO_WRITABLE_ROWS',
              at: 'source',
              message: `没有可落库的事实行：${incomplete} 个坐标缺了公司/指标/期数/口径中的某一项，凑不成一条事实。`,
              hint: '看 shape.coordinates.incomplete 与 shape.emptyKeys：行键空、期数读不到、口径没映射，都会让每个格都落不下去。',
            },
      ],
    };
  }

  // ---- 关卡 3：主数据归并（两阶段的第一阶段：只判断，一次库都不写）----
  // 规格里的 unknownMaster 决定「库里没有的名字」怎么办：
  //   confirm（默认）= 一律交人拍板，连维都不建；create = 确认是新实体就直接建。
  // ★ 无论选哪个，「看起来像已有实体」（Tier 2 有候选）的名字都必须人拍板 —— 那条不在这个开关的保护范围。
  const unknownMaster = spec.unknownMaster ?? 'confirm';
  const autoCreateDims = opts.autoCreateDims !== undefined ? opts.autoCreateDims : unknownMaster === 'create';
  const strict = opts.strict === true;
  const resolvers = {
    company: await buildResolver('company'),
    metric: await buildResolver('metric'),
  };

  // 人的决定优先于一切自动判定 —— 人拍过板的事不该被算法再推翻
  const decided = new Map<string, DimDecision>();
  for (const d of opts.decisions ?? []) decided.set(`${d.kind}|${normalizeName(d.raw)}`, d);

  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(`company|${r.company}`, (counts.get(`company|${r.company}`) ?? 0) + 1);
    counts.set(`metric|${r.metric}`, (counts.get(`metric|${r.metric}`) ?? 0) + 1);
  }

  /** `kind|raw` → 目标 id（已确定）；新建的目标 id 也在阶段 1 就算好 */
  const assigned = new Map<string, string>();
  /** 阶段 1 判定要新建的实体（阶段 2 才写） */
  const toCreate = new Map<string, { kind: DimKind; raw: string }>();
  /** 阶段 1 判定要登记的别名（阶段 2 才写） */
  const toAlias: Array<{ kind: DimKind; raw: string; targetId: string; note?: string }> = [];
  const needsDecision: IngestRunResult['needsDecision'] = [];
  const merged: IngestRunResult['merged'] = [];
  const pending = new Set<string>();

  function plan(kind: DimKind, raw: string): string | null {
    const key = `${kind}|${raw}`;
    const known = assigned.get(key);
    if (known) return known;
    if (pending.has(key)) return null;

    const resolver = resolvers[kind];
    const n = normalizeName(raw);
    const nrows = counts.get(key) ?? 0;

    // ① 人的决定最高优先
    const dec = decided.get(`${kind}|${n}`);
    if (dec) {
      if (dec.action === 'merge') {
        if (!dec.targetId) throw new Error(`决定「并入已有」但没给 targetId: ${kind} ${raw}`);
        // 目标是否存在留到阶段 2 校验 —— 那时才知道本批新建了哪些实体，
        // 而"把变体并进本批同时新建的实体"是合法且常见的操作。
        toAlias.push({ kind, raw, targetId: dec.targetId, note: dec.note ?? '接入时人工确认' });
        assigned.set(key, dec.targetId);
        return dec.targetId;
      }
      const id = entityId(kind, raw);
      toCreate.set(key, { kind, raw });
      assigned.set(key, id);
      return id;
    }

    // ② Tier 1：规范化后命中（含 dim_alias 里人确认过的映射）—— 纯格式差异，自动归并
    const hit = resolver.resolve(raw);
    if (hit) {
      assigned.set(key, hit);
      const ent = resolver.entityOf(raw);
      if (ent && raw !== ent.name) merged.push({ kind, raw, target: ent.name, rows: nrows });
      return hit;
    }

    // ③ Tier 2：像已有实体但不确定 → 交给人（绝不自动归并）
    const cands = resolver.candidates(raw);
    if (cands.length) {
      pending.add(key);
      needsDecision.push({ kind, raw, rows: nrows, candidates: cands });
      return null;
    }

    // ④ 完全不像任何已有实体
    if (!autoCreateDims) {
      pending.add(key);
      needsDecision.push({ kind, raw, rows: nrows, candidates: [] });
      return null;
    }
    const id = entityId(kind, raw);
    toCreate.set(key, { kind, raw });
    assigned.set(key, id);
    return id;
  }

  for (const r of rows) {
    plan('company', r.company);
    plan('metric', r.metric);
  }

  // ---- 干跑（planOnly）：判定做完就停，一次库都不写 ----
  // ★ 必须排在下面 needsDecision 的早退之前：干跑的用处正是"先看清楚哪些名字要人拍板"，
  //   放在早退之后它永远只回空清单（那时它就不是干跑，是坏掉的干跑）。
  if (opts.planOnly) {
    const willCreate = [...toCreate.values()].map((v) => ({ kind: v.kind, raw: v.raw }));
    return {
      ...base,
      ok: errors.length === 0,
      needsDecision,
      willCreate,
      skippedRows: 0,
      merged,
      errors,
      note:
        needsDecision.length === 0
          ? `可以落库：新建 ${willCreate.length} 条主数据，自动归并 ${merged.length} 条写法，其余命中已有主数据。`
          : `有 ${needsDecision.length} 个名称要人拍板，直接 run 会整批拒绝（一行都不写）。` +
            `先给出 decisions（merge + targetId 或 create）再跑。`,
    };
  }

  // ★ 有歧义 → 一行都不写，连维度都不建。
  //   "写一半"会让库进入既不是旧状态也不是新状态的中间态，比拒绝提交难排查得多。
  if (needsDecision.length) {
    const detail = needsDecision
      .map(
        (d) =>
          `${d.raw}（${d.rows} 行${d.candidates.length ? `，疑似 ${d.candidates.map((c) => c.name).join(' / ')}` : '，无相近主数据'}）`,
      )
      .join('；');
    const msg =
      `有 ${needsDecision.length} 个名称需要人工确认后才能提交: ${detail}。` +
      `合并两家不同的公司会把它们的钱静默加在一起（报表看起来完全正常，没人会来查），所以这一步不自动做。` +
      `请对每个名称二选一：并入已有（action='merge' + targetId）或确认是新建（action='create'）。`;
    if (strict) throw new Error(msg);
    return { ...base, needsDecision, skippedRows: rows.length };
  }

  // ---- 阶段 2：判断已全部通过，这才开始写 ----

  const onConflict = spec.onConflict ?? 'reject';
  // ★ 目标表由**声明**决定（铁律 18）：列序、主键、期数列、退化列全部来自它 ——
  //   接入层不再认识 "fact_finance" 这个名字（运营事实表就是这么才填得进去的）。
  const target = spec.target ?? DEFAULT_TARGET;
  const fact = (opts.catalog.facts ?? []).find((f) => f.name === target) ?? null;
  if (!fact) {
    return {
      ...base,
      errors: [
        {
          level: 'error',
          code: 'TARGET_NOT_DECLARED',
          at: 'target',
          message: `target 指向的表 ${target} 没有声明（models/*.yml）。`,
          hint: '目标表也是声明：先 `bilite plan` / `bilite apply` 把它建出来，或者改回默认的 fact_finance。',
        },
      ],
    };
  }
  /**
   * 一条事实行的**主键元组**（与 `queryHits` 里 SELECT 出来的列序一致）——
   * 撞库预检拿它跟库里的已有坐标比。
   */
  const pkKeyOf = (r: IngestFactRow): string =>
    fact.primaryKey
      .map((col) => {
        if (col === fact.periodColumn) return day(r.period);
        if (col === fact.periodTypeColumn) return r.periodType ?? '';
        if (col === fact.companyColumn) return assigned.get(`company|${r.company}`) ?? '';
        if (col === fact.metricColumn) return assigned.get(`metric|${r.metric}`) ?? '';
        if (fact.degenerateColumns.includes(col)) return r.deg[col] ?? '';
        return '';
      })
      .join('|');

  // 撞库检查（只在 'reject' 下做）：同一坐标已存在 → 拒绝整批，而不是静默覆盖。
  // 旧实现是 `ON CONFLICT DO UPDATE`，"后写赢"这件事没有任何人看得见。
  if (onConflict === 'reject') {
    const periods = [...new Set(rows.map((r) => r.period))];
    // 期数列拿出来时统一成 `YYYY-MM-DD`（与 pkKeyOf 的 day(period) 对齐）——
    // 不这么做的话，'2026-06-01' 与 '2026-06' 看起来就是两个坐标，撞库预检会漏。
    const selectPk = fact.primaryKey
      .map((c) => (c === fact.periodColumn ? `strftime(${c}, '%Y-%m-%d') AS ${c}` : c))
      .join(', ');
    const sql =
      `SELECT ${selectPk} FROM ${target} ` +
      `WHERE ${fact.periodColumn} IN (${periods.map((p) => `${lit(day(p))}::DATE`).join(', ')})`;
    const hits = await queryHits(sql, fact.primaryKey);
    const collide = rows.filter((r) => hits.has(pkKeyOf(r)));
    if (collide.length > 0) {
      // 同一行可能有两个值列撞库，示例只按行去重（人要看的是"哪几行"）
      const sample = [...new Set(collide.map((r) => r.row))].slice(0, 5).map((r) => `第 ${r} 行`).join('、');
      return {
        ...base,
        errors: [
          {
            level: 'error',
            code: 'CONFLICT_WITH_EXISTING',
            at: 'source',
            message: `本批有 ${collide.length} 个坐标在库里已经有数了（${sample}…）。`,
            hint:
              '规格默认 onConflict: reject —— 同一坐标出现两次必须由人决定是"这次是修订"还是"文件给错了"。' +
              ' 确认要覆盖就写 onConflict: replace（会逐行覆盖 amount 与 batch_id，旧批次的数据会被掏空）。',
          },
        ],
      };
    }
  }

  const batchId = newBatchId();

  // ★ 阶段 2 的**全部库写**包在一个事务里 —— 这才配得上"全有或全无"那句承诺。
  //   在此之前，「写维度 → 写事实 → 改批次状态」是几条独立的 execute：关卡把它们拦在写之前，
  //   但一旦开始写，中途失败就会留下**半个批次**（批次行停在 pending、维度建了、事实没写）。
  //   半个批次比整批拒绝难查得多 —— 它看起来像"导过了"。
  //   ⚠️ Parquet 归档必须留在 COMMIT **之后**：`exportParquet()` 另开短命只读实例，
  //      事务未提交时它拿不到锁（DuckDB 单写者锁，见 AGENTS.md §4 备忘 5）。
  // ⚠️ 这几个必须在**事务外**声明：事务里赋值，事务结束后（return 时）还要用。
  //    放进 try 里会变成块级作用域 —— 编译器不报，运行时才炸（踩过一次）。
  const createdCompanies: string[] = [];
  const createdMetrics: string[] = [];
  let inserted = 0;
  let archived = true;
  let rebuiltAggregates: string[] = [];

  await execute('BEGIN');
  try {
    await execute(
      `INSERT INTO import_batch (batch_id, source_file, row_count, imported_at, status, note)
       VALUES (${lit(batchId)}, ${lit(effSource ?? '')}, ${rows.length}, now(), 'pending', ${lit(`接入规格 ${spec.id}`)})`,
    );

    // ★ 版本行的生效日 = **本批最早的期数**（不是 now()）：重放要确定性 ——
    //   同一份 raw 今天跑与下个月跑，"这一版从哪天生效"必须一样（db/scd2.ts 文件头纪律 ①）。
    const batchFrom = [...new Set(rows.map((r) => r.period))].sort()[0]!;

    // 先建维度，再登记别名 —— 别名可以指向**本批同时新建**的实体
    for (const { kind, raw } of toCreate.values()) {
      const id = entityId(kind, raw);
      if (kind === 'company') {
        await execute(
          `INSERT INTO dim_company (id, name, parent_id, level, group_name, alias) VALUES (${lit(id)}, ${lit(raw)}, NULL, 2, NULL, ARRAY[]::VARCHAR[])`,
        );
        createdCompanies.push(raw);
        // ★ 建维的**同一个事务**里写首版：否则"当前态有这行、历史里没有"是个结构性不一致
        //   （scdProblems() ① 会报）。两件事一起发生，才有"不漂"的前提。
        await writeFirstVersion('company', id, batchFrom);
      } else {
        await execute(
          `INSERT INTO dim_metric (id, name, category, unit, direction, alias) VALUES (${lit(id)}, ${lit(raw)}, NULL, NULL, 'positive', ARRAY[]::VARCHAR[])`,
        );
        createdMetrics.push(raw);
        await writeFirstVersion('metric', id, batchFrom);
      }
    }

    // 登记人的决定（写 dim_alias）。此时才校验目标存在 —— 错过这一步会造出一条指向虚空、
    // 却从此自动命中的别名：所有带这个写法的行都被静默归并到不存在的公司上。
    // （这里的读走的是读连接，读的是**此前已提交**的别名，所以不受本事务影响。）
    const createdIds = new Set([...toCreate.keys()].map((k) => assigned.get(k)!));
    for (const a of toAlias) {
      const exists = resolvers[a.kind].ents.some((e) => e.id === a.targetId) || createdIds.has(a.targetId);
      if (!exists) throw new Error(`决定「并入已有」但目标主数据不存在: ${a.kind} ${a.raw} → ${a.targetId}`);
      await registerAlias(a.kind, a.raw, a.targetId, a.note);
    }

    // 期间维度（与公司/指标无关，逐行幂等）
    for (const p of [...new Set(rows.map((r) => r.period))]) {
      const [y, m] = p.split('-');
      await execute(
        `INSERT INTO dim_period (fin_month, year, month, is_audited)
         SELECT ${lit(day(p))}::DATE, ${Number(y)}, ${Number(m)}, FALSE
         WHERE NOT EXISTS (SELECT 1 FROM dim_period WHERE fin_month = ${lit(day(p))}::DATE)`,
      );
    }

    // 分批插入（避免单条 SQL 过长）；口径与金额都按行带下去
    const CHUNK = 500;

    /**
     * 取维度 id —— **取不到当场炸**。
     *
     * ★ 为什么不沿用 `assigned.get(...)!`：取不到时 `lit(undefined)` 会拼出字符串 `'undefined'`，
     *   于是事实行**指向一个不存在的主数据**，而且一个错都不报。这正是架构 §6.1 点名的
     *   "最经典的静默故障"——那边是丢行，这边是写脏 id，**更难发现**：丢行至少行数会少，脏 id 连行数都对。
     *   今天 `assigned` 一定是全的（有 `needsDecision` 就整批早退），但那是**没人守的不变式**。
     */
    function dimIdOf(kind: DimKind, raw: string, row: IngestFactRow): string {
      const id = assigned.get(`${kind}|${raw}`);
      if (!id) {
        throw new Error(
          `装载顺序错了：第 ${row.row} 行的${kind === 'company' ? '公司' : '指标'}「${raw}」没有对应的维度 id。` +
            `事实行必须等维度全部合并完再写 —— 否则会写出一条指向不存在主数据的行，且**不报错**。`,
        );
      }
      return id;
    }

    /**
     * 一条事实行的某个**声明列**取什么值。
     *
     * ★ 列序就是声明的列序（`fact.columns`）—— 三个来源：
     *   期数/公司/指标/口径/度量/溯源 各自读声明里的角色，行内退化列读 `r.deg`。
     *   声明里有、而接入层没有来源的列（例如 P3 之后加的外键列）**当场抛**，
     *   不写 NULL 糊过去 —— "这一行缺一块"必须响亮。
     */
    function valueOfColumn(col: string, r: IngestFactRow, batch: string): string {
      if (col === fact.periodColumn) return `${lit(day(r.period))}::DATE`;
      if (col === fact.companyColumn) return lit(dimIdOf('company', r.company, r));
      if (col === fact.metricColumn) return lit(dimIdOf('metric', r.metric, r));
      if (fact.periodTypeColumn && col === fact.periodTypeColumn) {
        return r.periodType === null ? 'NULL' : lit(r.periodType);
      }
      if (fact.provenanceColumn && col === fact.provenanceColumn) return lit(batch);
      if (col === fact.measureColumn) return r.amount === null ? 'NULL' : String(r.amount);
      if (fact.degenerateColumns.includes(col)) return lit(r.deg[col] ?? '');
      throw new Error(
        `目标表 ${fact.name} 的列 ${col} 没有来源：接入层填不了它（声明里的列必须有来源，否则这一行会缺一块）。`,
      );
    }

    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values = chunk
        .map((r) => `(${fact.columns.map((c) => valueOfColumn(c.name, r, batchId)).join(', ')})`)
        .join(',\n');
      // ★ 冲突子句也由**声明**生成：主键 + 度量列（换一张表就换一套，不再是写死的 fact_finance）
      const pk = fact.primaryKey.join(', ');
      const conflictClause =
        onConflict === 'replace'
          ? `ON CONFLICT (${pk}) DO UPDATE SET ${fact.measureColumn} = EXCLUDED.${fact.measureColumn}` +
            (fact.provenanceColumn ? `, ${fact.provenanceColumn} = EXCLUDED.${fact.provenanceColumn}` : '')
          : `ON CONFLICT (${pk}) DO NOTHING`;
      await execute(
        `INSERT INTO ${target} (${fact.columns.map((c) => c.name).join(', ')})
         VALUES ${values} ${conflictClause}`,
      );
    }

    // ★ 报**真正落库的行数**，不是"尝试插入的行数"。
    //   `ON CONFLICT DO NOTHING` 会安静地少写几行，而"尝试数"会把它们算成写成功 ——
    //   那正是本仓库最讨厌的那种"看起来对了"。两者不一致说明**撞库预检漏了**，
    //   也就是有坐标在本批之外已经存在却没人发现：直接抛，不许安静地少写。
    //   ⚠️ 必须走 `queryWriter`：读连接**看不到本事务尚未提交的写**，会数出 0 → 守卫误报，
    //      而一个会误报的守卫比没有守卫更糟（人会开始不信它）。
    const counted = await queryWriter<{ n: number }>(
      `SELECT count(*) AS n FROM ${target} WHERE ${fact.provenanceColumn ?? fact.periodColumn} = ${
        fact.provenanceColumn ? lit(batchId) : lit(day(rows[0]!.period))
      }`,
    );
    inserted = Number(counted[0]?.n ?? 0);
    if (inserted !== rows.length) {
      throw new Error(
        `事实装载少写了：本批 ${rows.length} 行，库内只见到 ${inserted} 行。` +
          `多半是撞库预检漏掉了一个坐标（ON CONFLICT DO NOTHING 会安静吞掉它）。` +
          `批次 ${batchId} 已整体回滚，没有留下半个批次。`,
      );
    }

    // ★ 标准化层影子（架构 §4.7）：同一批展开行**同事务**物化进 stg_fact_rows ——
    //   存归并前的原名与值格坐标，"raw + 接入规格 → 标准行"从此有落盘落点，
    //   `bilite replay`（重展对拍）据此验证可重放性（源文件删了也能从 raw 重展）。
    //   stg 与 fact 从同一批内存行双写：落库成功 ⇔ stg 有影子；整体回滚 ⇔ stg 零残留。
    //   ⚠️ 行数守卫必须走 queryWriter（理由同上：读连接看不到本事务未提交的写）。
    {
      const degJsonOf = (r: IngestFactRow): string | null => {
        const keys = Object.keys(r.deg).sort();
        return keys.length > 0 ? JSON.stringify(Object.fromEntries(keys.map((k) => [k, r.deg[k]!]))) : null;
      };
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const values = chunk
          .map((r) => {
            const degJson = degJsonOf(r);
            return (
              `(${lit(batchId)}, ${lit(target)}, ${lit(spec.id)}, ${lit(landedHash!)}, ${lit(r.sheet)}, ${r.block}, ${r.row}, ${lit(r.col)}, ` +
              `${lit(r.period)}, ${lit(r.company)}, ${lit(r.metric)}, ` +
              `${r.periodType === null ? 'NULL' : lit(r.periodType)}, ${r.amount === null ? 'NULL' : String(r.amount)}, ` +
              `${degJson === null ? 'NULL' : lit(degJson)}, now())`
            );
          })
          .join(',\n');
        await execute(
          `INSERT INTO stg_fact_rows (batch_id, target, spec_id, file_hash, sheet, block, row_no, value_col, period, company_raw, metric_raw, period_type, amount, deg, loaded_at)
           VALUES ${values}`,
        );
      }
      const stgCounted = await queryWriter<{ n: number }>(
        `SELECT count(*) AS n FROM stg_fact_rows WHERE batch_id = ${lit(batchId)}`,
      );
      const stgWritten = Number(stgCounted[0]?.n ?? 0);
      if (stgWritten !== rows.length) {
        throw new Error(
          `标准化层少写了：本批 ${rows.length} 行，stg 只见到 ${stgWritten} 行。` +
            `批次 ${batchId} 已整体回滚，没有留下半个批次。`,
        );
      }
    }

    // ★ 列契约与数据**同一个事务**：元数据不可能是"上次同步的"。
    //   它写的是 src/meta/columns.ts 那份声明，而 `metaProblems()` 会把声明与真实结构对拍 ——
    //   所以这里唯一可能的错法是"声明写错了"，那种错会被当场抓住（e2e 有断言）。
    await registerMeta();

    // ★ 聚合表与数据**同一个事务**重建（P3）：以本次落库的 target 为 source 的聚合，
    //   落库完立刻重算 —— 聚合表不存在"事实已提交、聚合还是旧的"那段窗口
    //   （那种窗口里出的报表对不上账，而且没人知道为什么）。
    //   声明坏了就在这里抛：整个批次连同聚合一起回滚，不留半批（fail-closed）。
    const { loadModels } = await import('../gen/parse.ts');
    const { aggregateTablesOf, executeRebuilds } = await import('../gen/rebuild.ts');
    const models = loadModels();
    const aggs = aggregateTablesOf(models, target);
    if (aggs.length > 0) await executeRebuilds(aggs, models);
    rebuiltAggregates = aggs.map((t) => t.name);

    await execute(`UPDATE import_batch SET status = 'committed' WHERE batch_id = ${lit(batchId)}`);
    await execute('COMMIT');
  } catch (e) {
    try {
      await execute('ROLLBACK');
    } catch (rollbackErr) {
      // 回滚本身也失败时要喊出来（铁律 12），但**不能让它的消息盖过真正的原错**
      console.error(`[ingest] ROLLBACK 失败（原错误随后抛出）: ${(rollbackErr as Error).message}`);
    }
    throw e;
  }

  // Parquet 归档：留着溯源（铁律 11 —— 主实例 enable_external_access=false，只能走 exportParquet 的短命只读实例）
  // ★ 放在 COMMIT **之后**：归档要另开实例拿库的锁，事务未提交时拿不到。
  try {
    const dir = `${PARQUET_ROOT}/${target}/batch=${batchId}`;
    mkdirSync(dir, { recursive: true });
    await exportParquet(
      `COPY (SELECT * FROM ${target} WHERE ${fact.provenanceColumn ?? fact.periodColumn} = ${
        fact.provenanceColumn ? lit(batchId) : lit(day(rows[0]!.period))
      }) TO '${dir}/${PART_FILE}' (FORMAT parquet)`,
      // ★ 写完读回来数一遍：归档曾经"静默写出空文件"而 archived 还报 true（§4 备忘 13）。
      { path: `${dir}/${PART_FILE}`, rows: inserted },
    );
  } catch (e) {
    // 归档失败**不影响落库**（查询不依赖 Parquet），但绝不静默 —— 回传 archived=false 并留痕
    archived = false;
    const msg = `归档写入失败（数据已落库，不影响查询）：${(e as Error).message}`;
    await execute(`UPDATE import_batch SET note = ${lit(msg)} WHERE batch_id = ${lit(batchId)}`);
  }

  return {
    ok: true,
    batchId,
    inserted,
    createdCompanies,
    createdMetrics,
    merged,
    needsDecision: [],
    skippedRows: 0,
    emptyMeasureCells,
    errors: [],
    shape,
    archived,
    rebuiltAggregates,
  };
}

/**
 * 查"这些期间里已经存在哪些坐标"（**只取坐标，不取金额**）。
 * 主键列由调用方按声明传进来 —— 判据不写死任何列名（铁律 18：目标表是声明）。
 */
async function queryHits(sql: string, pk: string[]): Promise<Set<string>> {
  const hits = await query<Record<string, unknown>>(sql);
  return new Set(hits.map((r) => pk.map((c) => String(r[c] ?? "")).join("|")));
}
