/**
 * Parquet 归档的**小文件合并**（compaction）—— 架构 §10 R8 与 §4.4「小文件陷阱」。
 *
 * 背景（实测值）：1000 行 parquet ≈ 5KB、本项目的 960 行批次 ≈ 7.7KB。按每月一批算，
 * 两年 ≈ 24 个文件 ≈ 185KB —— 单独看无所谓，但它是**只增不减**的：一年后目录里
 * 全是 KB 级碎片，灾难恢复时要逐个拼。这就是 R8，本来就是「低优先级、不在查询关键路径上」，
 * 所以它是一条**人工触发**的命令，不是归档时的自动动作。
 *
 * ★ 为什么它能安全地做（与 `exportParquet()` 形成对照）：
 *   归档目录**不是库**。合并只碰 `data/parquet/<表>/<目录>/part.parquet`，用一个
 *   **内存实例**（`:memory:` + `enable_external_access: true`）去读它们 —— 它既不打开
 *   `.duckdb` 文件、也不碰库锁，所以**服务端正在跑的时候也能合并**。
 *   （`exportParquet()` 必须碰主库，所以它才要那套「新建只读实例 → 写完读回来数一遍 → reattach」
 *   的锁舞蹈；这里根本不需要 —— 这两种操作的性质不同，别把那条推理抄过来。）
 *
 * ★ 三条纪律（都是本仓库踩过的坑换来的）：
 *   ① **先验证、再删**：合并出来的行数必须与各源文件**逐 batch_id** 对上，否则抛错、
 *      **一个源文件都不删**。对齐 R13 的教训 —— 归档层曾经安静地写出 0 行文件，而 `archived` 还报 true。
 *   ② **收敛**：候选 = 小于 `maxBytes` 的归档目录，且**候选数 ≥ 2 才动手**。
 *      没有这条，每次跑都会把刚合并出来的文件再合并一遍（纯重写，毫无收益）。
 *   ③ **不满意的输入不动它**：0 行的源文件（过去某次归档失败的残骸）**不参与合并**、
 *      也不删，单独报出来让人看见 —— 它们是证据，不是垃圾。
 */
import { DuckDBInstance } from '@duckdb/node-api';
import fs from 'node:fs';
import path from 'node:path';

/** 归档根目录 —— **唯一的来源**（`db/index.ts` 建它、`ingest/run.ts` 往里写、本文件读它）。 */
export const PARQUET_ROOT = 'data/parquet';

/** 归档文件在目录里的固定名字（run.ts 写的就是它） */
export const PART_FILE = 'part.parquet';

/** 默认「小文件」判据：小于 128KB 就算小。见文件头「收敛」那条。 */
export const DEFAULT_MAX_BYTES = 128 * 1024;

export interface ArchiveDir {
  /** 目录名，如 `batch=bmuqh...` / `compacted=...` */
  name: string;
  /** 仓库相对路径 */
  dir: string;
  file: string;
  bytes: number;
  kind: 'batch' | 'compacted';
}

export interface CompactionPlan {
  table: string;
  maxBytes: number;
  minFiles: number;
  /** 这个表的全部归档目录 */
  all: ArchiveDir[];
  /** 会被合并的那些 */
  candidates: ArchiveDir[];
  /** 看见了但不动它的（附理由） */
  skipped: Array<{ dir: string; reason: string }>;
  /** 候选文件大小之和（合并后的量级下限估计） */
  candidateBytes: number;
}

export interface CompactionResult {
  table: string;
  /** 合并产物目录（没有候选时为 null —— 这是**正常**结果，不是失败） */
  merged: string | null;
  /** 被合并掉并删除的源目录 */
  sources: string[];
  /** 合并后的总行数（0 表示只做了 dry-run 或没有候选） */
  rows: number;
  /** 逐 batch_id 行数（合并后读回来的，独立于源文件的读法） */
  perBatch: Record<string, number>;
  bytes: number;
  /** 不动它的输入（0 行残骸、达标的文件、候选不足时的全部） */
  skipped: Array<{ dir: string; reason: string }>;
  dryRun: boolean;
  /** 人话结论 */
  note: string;
}

/**
 * 表名白名单。**唯一实现**，与铁律 2 同一条思路：表名会进**文件路径**与 SQL，
 * 未注册/形状不对的名字必须当场拒绝，绝不拼进路径。
 */
export function assertSafeTableName(name: string): void {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(
      `表名不合法：${name} —— 归档合并只认 [a-z_][a-z0-9_]*（表名会进路径与 SQL，不做任何猜测）。`,
    );
  }
}

/** 归档里有哪些表（就是 `data/parquet/` 下的目录名，仍然逐个过白名单判据） */
export function listArchiveTables(): string[] {
  if (!fs.existsSync(PARQUET_ROOT)) return [];
  return fs
    .readdirSync(PARQUET_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => /^[a-z_][a-z0-9_]*$/i.test(n))
    .sort();
}

/** 扫一个表的归档目录（只读 `stat`，不开 DuckDB） */
export function listArchiveDirs(table: string): ArchiveDir[] {
  assertSafeTableName(table);
  const root = path.join(PARQUET_ROOT, table);
  if (!fs.existsSync(root)) return [];
  const out: ArchiveDir[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, PART_FILE);
    if (!fs.existsSync(file)) continue;
    out.push({
      name: e.name,
      dir: path.join(root, e.name),
      file,
      bytes: fs.statSync(file).size,
      kind: e.name.startsWith('compacted=') ? 'compacted' : 'batch',
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * 只按**文件大小**与**目录数**决定合并谁 —— 纯函数式的一步，不开库、不写盘。
 * 于是 `--dry-run` 与真正执行计划的是同一份判据（铁律 17 的"判据只有一份"）。
 */
export function planCompaction(
  table: string,
  opts: { maxBytes?: number; minFiles?: number } = {},
): CompactionPlan {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const minFiles = opts.minFiles ?? 2;
  const all = listArchiveDirs(table);
  const skipped: CompactionPlan['skipped'] = [];
  const small = all.filter((d) => {
    if (d.bytes >= maxBytes) {
      skipped.push({
        dir: d.dir,
        reason: `${(d.bytes / 1024).toFixed(1)}KB ≥ 阈值 ${(maxBytes / 1024).toFixed(0)}KB，已经不小了`,
      });
      return false;
    }
    return true;
  });
  const candidates = small.length >= minFiles ? small : [];
  if (small.length > 0 && small.length < minFiles) {
    for (const d of small) {
      skipped.push({ dir: d.dir, reason: `小文件只有 ${small.length} 个（< ${minFiles}）—— 合并无收益，且会来回重写` });
    }
  }
  return {
    table,
    maxBytes,
    minFiles,
    all,
    candidates,
    skipped,
    candidateBytes: candidates.reduce((n, d) => n + d.bytes, 0),
  };
}

/** SQL 里的路径字面量（单引号双写）—— 路径是我们自己拼的，但转义仍然走这一处 */
function q(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * 打开一个**内存**实例：只读归档文件、写合并产物。
 *
 * ★ 为什么是 `:memory:` 而不是像 `exportParquet()` 那样开库文件的只读实例：
 *   这里一个字节都不需要从库里读。开内存实例的收益是**不碰库锁**
 *   （见 AGENTS.md §4 备忘 13：关掉开在库文件上的实例会把主实例的锁一起丢掉）——
 *   所以服务端正在跑时也能合并归档。
 */
async function withMemoryInstance<T>(fn: (run: (sql: string) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
  const inst = await DuckDBInstance.create(':memory:', { enable_external_access: 'true' });
  try {
    const conn = await inst.connect();
    try {
      return await fn(async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[]);
    } finally {
      conn.closeSync();
    }
  } finally {
    inst.closeSync();
  }
}

/** 读一组文件里每条事实落在哪个批次上（这是"源里有几行"的**唯一依据**） */
export async function countPerBatch(files: string[]): Promise<Record<string, number>> {
  if (files.length === 0) return {};
  return withMemoryInstance(async (run) => {
    const rows = await run(
      `SELECT batch_id, count(*) AS n FROM read_parquet([${files.map(q).join(', ')}]) GROUP BY 1`,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.batch_id)] = Number(r.n);
    return out;
  });
}

/**
 * 把若干归档目录合并成一个新的归档目录。
 *
 * ★ **这一步是带守卫的**：合并写完立刻**从产物里读回来**，逐 batch_id 与 `expect` 对拍；
 *   对不上就删掉半个产物、抛错 —— 调用方据此**一个源文件都不删**。
 *   为什么要按 batch_id 而不是只比总数：总数相等而批次张冠李戴是不可能的，但
 *   "某个源文件本来就是 0 行"会被总数掩盖（R13 那个安静的空归档）。逐批次对拍能把它显出来。
 *
 * @param outDir 产物目录（不存在则创建；失败时会被删掉，不留半个产物）
 * @param expect 期望的 `batch_id → 行数`
 */
export async function mergeArchives(
  outDir: string,
  sources: ArchiveDir[],
  expect: Record<string, number>,
): Promise<{ rows: number; perBatch: Record<string, number>; bytes: number }> {
  if (sources.length < 2) throw new Error(`归档合并不值得为 ${sources.length} 个文件动手（至少要 2 个）`);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, PART_FILE);
  const wantRows = Object.values(expect).reduce((n, v) => n + v, 0);
  try {
    const perBatch = await withMemoryInstance(async (run) => {
      await run(
        `COPY (SELECT * FROM read_parquet([${sources.map((s) => q(s.file)).join(', ')}])) TO ${q(outFile)} (FORMAT parquet)`,
      );
      const back = await run(`SELECT batch_id, count(*) AS n FROM read_parquet(${q(outFile)}) GROUP BY 1`);
      const got: Record<string, number> = {};
      for (const r of back) got[String(r.batch_id)] = Number(r.n);
      return got;
    });

    // —— 守卫：逐 batch_id 对拍（不是只比总数）——
    const batches = [...new Set([...Object.keys(expect), ...Object.keys(perBatch)])].sort();
    const bad = batches.filter((b) => (expect[b] ?? 0) !== (perBatch[b] ?? 0));
    if (bad.length > 0) {
      throw new Error(
        `合并产物与源对不上，判为失败（源文件一个都不会删）：` +
          bad.map((b) => `${b} 期望 ${expect[b] ?? 0} 行 / 产物 ${perBatch[b] ?? 0} 行`).join('；'),
      );
    }
    const rows = Object.values(perBatch).reduce((n, v) => n + v, 0);
    if (rows !== wantRows) {
      throw new Error(`合并产物总行数不对：期望 ${wantRows}，产物 ${rows}`); // 理论上到不了，留作最后一道
    }
    return { rows, perBatch, bytes: fs.statSync(outFile).size };
  } catch (e) {
    fs.rmSync(outDir, { recursive: true, force: true }); // 不留半个产物
    throw e;
  }
}

let seq = 0;
/** 产物目录名：时间戳 + 进程内序号（同毫秒两次也不会撞 —— 与 `newBatchId()` 同一条纪律） */
function newCompactedName(n: number): string {
  return `compacted=${Date.now().toString(36)}${(seq++).toString(36)}-of${n}`;
}

/**
 * 合并一个表的小文件归档。**没有候选是正常结果**（`merged: null`），不是失败。
 *
 * @param opts.maxBytes / opts.minFiles 见 `planCompaction()`
 * @param opts.dryRun 只出计划，一个字节都不写
 */
export async function compactParquet(
  table = 'fact_finance',
  opts: { maxBytes?: number; minFiles?: number; dryRun?: boolean } = {},
): Promise<CompactionResult> {
  const plan = planCompaction(table, opts);
  const skipped = [...plan.skipped];
  const base = {
    table,
    merged: null,
    sources: [] as string[],
    rows: 0,
    perBatch: {} as Record<string, number>,
    bytes: 0,
    dryRun: opts.dryRun === true,
  };

  if (plan.candidates.length === 0) {
    const why = [...new Set(plan.skipped.map((s) => s.reason))];
    return {
      ...base,
      skipped,
      note:
        plan.all.length === 0
          ? `${table} 还没有任何 Parquet 归档 —— 没有可合并的东西。`
          : `没有可合并的候选（阈值 ${(plan.maxBytes / 1024).toFixed(0)}KB、至少 ${plan.minFiles} 个）：` +
            (why.join('；') || '没有小文件'),
    };
  }

  // —— 逐个文件读一遍：既得到期望行数，也能把"0 行的那个文件"单独挑出来 ——
  //    ★ 逐个读（而不是把候选拼成一个列表读一次）：拼起来读会让 0 行的个别文件被总数掩盖，
  //      而"某个归档文件是 0 行"恰恰是 R13 那个失败形态的残留，必须能被看见。
  const expect: Record<string, number> = {};
  const usable: ArchiveDir[] = [];
  const zeroRows: ArchiveDir[] = [];
  for (const c of plan.candidates) {
    const per = await countPerBatch([c.file]);
    const n = Object.values(per).reduce((a, b) => a + b, 0);
    if (n === 0) {
      zeroRows.push(c);
      skipped.push({ dir: c.dir, reason: '这个归档文件是 0 行（过去某次归档失败的残骸）—— 不动它，留着当证据' });
      continue;
    }
    for (const [b, v] of Object.entries(per)) expect[b] = (expect[b] ?? 0) + v;
    usable.push(c);
  }
  if (usable.length < plan.minFiles) {
    return {
      ...base,
      skipped,
      note: `剔除 ${zeroRows.length} 个 0 行残骸后只剩 ${usable.length} 个可合并的小文件（< ${plan.minFiles}）—— 这次不动手。`,
    };
  }

  const outDir = path.join(PARQUET_ROOT, table, newCompactedName(usable.length));
  if (opts.dryRun) {
    return {
      ...base,
      sources: usable.map((c) => c.dir),
      rows: Object.values(expect).reduce((n, v) => n + v, 0),
      perBatch: expect,
      bytes: usable.reduce((n, c) => n + c.bytes, 0),
      skipped,
      note: `dry-run：会把 ${usable.length} 个小文件（${(usable.reduce((n, c) => n + c.bytes, 0) / 1024).toFixed(1)}KB）合并成 ${outDir}，一个字节都还没写。`,
    };
  }

  const merged = await mergeArchives(outDir, usable, expect);
  // ★ 验证已经通过（mergeArchives 内部对拍过），这才允许删源文件。
  for (const c of usable) fs.rmSync(c.dir, { recursive: true, force: true });

  return {
    ...base,
    merged: outDir,
    sources: usable.map((c) => c.dir),
    rows: merged.rows,
    perBatch: merged.perBatch,
    bytes: merged.bytes,
    skipped,
    note:
      `${usable.length} 个小文件 → ${merged.rows} 行 / ${(merged.bytes / 1024).toFixed(1)}KB` +
      `（逐批次对拍通过，源文件已删）。` +
      (zeroRows.length ? ` ⚠️ 另有 ${zeroRows.length} 个 0 行残骸没动，见 skipped。` : ''),
  };
}

/** 给调用方（CLI / 人）判断"有没有需要留意的输入"：0 行残骸就是需要留意的。 */
export function suspectInputs(r: CompactionResult): string[] {
  return r.skipped.filter((s) => s.reason.includes('0 行')).map((s) => s.dir);
}

