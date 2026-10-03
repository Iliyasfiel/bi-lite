/**
 * DuckDB 连接管理（单进程独占模型，见 docs/需求与架构.md §4.4）
 *
 * 纪律：整个进程只有一个 DuckDBInstance。
 * 导入与查询用**不同连接**，靠 MVCC 让读不被写阻塞。
 */
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { PARQUET_ROOT } from './compact.ts';
import { DDL } from './schema.ts';
import fs from 'node:fs';
import path from 'node:path';

let instance: DuckDBInstance | null = null;
let writeConn: DuckDBConnection | null = null;
let readConn: DuckDBConnection | null = null;
let openedPath: string | null = null;

/**
 * 打开（或创建）库文件。
 *
 * ★ 路径可被环境变量 `BILITE_DB` 覆盖。为什么需要它：DuckDB 是**单写者**模型
 *   （见 AGENTS.md §4 备忘 5），而 e2e 要一边握着主库、一边起一个**真实的 MCP 子进程**
 *   去跑工具 —— 一个进程一个库是这套设计的硬约束，所以子进程得跑在**库的副本**上
 *   （`test/e2e.ts` 第 13 阶段就是这么做的）。没有这个口子，测试只能违反单写者约束，
 *   而那会把归档写成空文件（§4 备忘 13 的判例）。
 */
export async function open(
  dbPath = process.env.BILITE_DB ?? 'data/bi.duckdb',
  opts: { models?: 'ensure' | 'skip' } = {},
) {
  if (instance) return;
  openedPath = dbPath;

  // 确保归档目录存在（路径常量只有一份，见 db/compact.ts）
  fs.mkdirSync(path.join(PARQUET_ROOT), { recursive: true });

  instance = await DuckDBInstance.create(dbPath, {
    // 财务数据敏感：禁用外部访问，避免 SQL 里意外读到任意文件
    enable_external_access: 'false',
    memory_limit: '2GB',
  });

  writeConn = await instance.connect();
  readConn = await instance.connect();

  // 建表（幂等）：**基础元数据** DDL（运营侧 + 控制面）由手写 DDL 建；
  // 业务表（dim_* / fact_*）由 models/*.yml 声明生成（见 ensureModels）。
  for (const stmt of DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await writeConn.run(stmt);
  }

  // ★ 声明落地 + 列契约登记（P2 生成器）。
  //   `_meta_columns` 有**两个**登记时刻，而它们投影的是同一份 IR（metaOf）：
  //     ① 这里：**结构一存在，契约就在**（首次导入之前 catalog 也不是空的）；
  //     ② 接入层落库时（runIngest 的事务里）：数据与元数据同一时刻落库。
  //   `{ models: 'skip' }` 给生成器自己的两条命令用（`plan` 要看到一个**没被动过**的库；
  //   `apply` 要自己报告它落了什么，而不是被 open() 抢先做掉）。
  if (opts.models !== 'skip') await ensureModels();
}

/**
 * 让库结构与 `models/*.yml` 的声明**对得上**（P2）。启动时的策略只有三条，都要能一眼说清：
 *
 *  ① **阻塞项（删列 / 改类型 / 加 NOT NULL 列 / 无主的语义表）→ 抛错**。
 *     那种不一致只能由人决定，启动时糊弄过去最危险。
 *  ② **空库（一张声明的表都不存在）→ 引导落地**。全新装起来必须能直接跑，
 *     否则 `npm start` 的第一步就是"先手动 apply"。
 *  ③ **非空库 + 有结构变更 → 不落地，只**响亮报告**。**
 *     结构变更（DDL）一律要人点一次 `bilite apply` —— 这正是"plan 与 apply 是两条命令"的意义
 *     （`docs/开发计划.md` §1.2：先见 diff 再决定落地）。自动做的话，plan 就永远看不到东西了。
 *     **只有不是 DDL 的变更（列契约刷新）随手做掉** —— 它不动数据、也不改结构。
 */
async function ensureModels(): Promise<void> {
  const { loadModels, MODELS_DIR } = await import('../gen/parse.ts');
  const { applyModels } = await import('../gen/apply.ts');
  const { planModels, summarizePlan } = await import('../gen/plan.ts');

  const ir = loadModels(MODELS_DIR);
  const liveTables = new Set(
    (await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`,
    )).map((r) => r.table_name),
  );
  const empty = ir.tables.every((t) => !liveTables.has(t.name));

  const plan = await planModels(ir);
  if (plan.blocking.length > 0) {
    throw new Error(
      `库结构与模型声明（${MODELS_DIR}/*.yml）不一致，而这些变更 apply 不会自动做：\n  - ` +
        plan.blocking.map((c) => c.detail).join('\n  - ') +
        `\n先跑 \`bilite plan\` 看完整清单，再改声明或手工处理库。`,
    );
  }
  if (plan.structural.length > 0 && !empty) {
    console.error(
      `[gen] ⚠️ models/*.yml 有 ${plan.structural.length} 项**结构变更**没落地：\n  - ` +
        plan.structural.map((c) => c.detail).join('\n  - ') +
        `\n   结构变更一律要人点一次：\`bilite plan\` 看清单 → \`bilite apply\` 落地。` +
        `\n   库仍是旧结构，引擎照常可用（不自动改结构是刻意的：否则 plan 就永远看不到东西）。`,
    );
    return;
  }
  const r = await applyModels(ir);
  if (r.blocked.length > 0) {
    throw new Error(`模型落地被拒：\n  - ` + r.blocked.map((c) => c.detail).join('\n  - '));
  }
  if (r.applied.length > 0) console.error(`[gen] ${empty ? '空库引导：' : ''}${summarizePlan(r.plan)}`);
}

export function writer(): DuckDBConnection {
  if (!writeConn) throw new Error('先调用 open()');
  return writeConn;
}

export function reader(): DuckDBConnection {
  if (!readConn) throw new Error('先调用 open()');
  return readConn;
}

/** 查询辅助：返回普通对象数组。
 * 注意：getRowObjectsJson() 返回的**已经是解析好的数组**，不是 JSON 字符串；
 * 直接 JSON.stringify() 原始结果会因 BigInt 抛 TypeError，此方法已规避。 */
export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const res = await reader().runAndReadAll(sql);
  return res.getRowObjectsJson() as T[];
}

export async function execute(sql: string): Promise<void> {
  await writer().run(sql);
}

/**
 * 用**写连接**跑一条查询。
 *
 * ★ 为什么需要它：DuckDB 的读连接看不到**本事务尚未提交**的写。
 *   事务里"数一数自己刚写了多少行"（`runIngest` 校验事实装载没有少写）时，
 *   走 `query()` 会得到 0 —— 守卫于是**误报**，而误报的守卫比没有守卫更糟：人会开始不信它。
 *   凡是要读**自己刚写的**，都必须走这里。
 */
export async function queryWriter<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const res = await writer().runAndReadAll(sql);
  return res.getRowObjectsJson() as T[];
}

export function close() {
  readConn?.closeSync();
  writeConn?.closeSync();
  instance?.closeSync();
  readConn = writeConn = instance = null;
  openedPath = null;
}

/**
 * 导出一段查询结果到 Parquet，**不放松主实例的 `enable_external_access=false` 硬化**。
 *
 * 背景（本机实测，见 docs/需求与架构.md §4.4）：`COPY ... TO` 属于外部文件操作，
 * 被 `enable_external_access=false` 直接拒绝 —— 也就是说主实例永远写不出 Parquet。
 * 而 `allowed_directories` 与 `enable_external_access=false` 互斥
 * （`Cannot change allowed_directories when enable_external_access is disabled`），
 * 且它并不拦截 `read_text` / `read_csv`，所以不能拿它来"既允许归档又保持硬化"。
 *
 * 解法：归档时另开一个**短命只读实例**（`access_mode: READ_ONLY`）来跑 COPY。
 * 它的可写性由 DuckDB 结构性禁止（实测 `Cannot execute statement of type "INSERT"`）。
 *
 * ★★ 两个**实测**出来的坑（都是这一版才补上的，见 §4 备忘 13）：
 *   ① **关掉那个只读实例会把主实例的库锁一起丢掉**。实测：归档之前，第二个进程
 *      `db.open()` 报 `Could not set lock`；**归档一次之后，它就能开进来了**
 *      —— 于是两个写者同时操作一个库，之后所有归档都读到**过期视图**、
 *      写出**只有表头没有行的空 Parquet**，而 `archived` 还报 `true`。
 *      `CHECKPOINT` / 空查询都拿不回来，**只有"把主实例关掉重开"能拿回来**（实测），
 *      所以下面 `finally` 里 `reattach()`。
 *   ② **同一实例读的是创建那一刻的快照**：把只读实例留着不关能保住锁，但它再也看不见
 *      后来的提交（实测：连续三次归档都读回 0 行）。所以只读实例必须**每次新建**。
 *   合起来的结论：**每次新建只读实例 + 用完立刻重开主实例**。
 *
 * @param verify 可选的行数校验（写完之后在**同一个只读实例**上读回来数一遍）。
 *   为什么值得做：归档曾经"静默写出空文件"而没人发现（R13 的同款失败）。
 *   校验把"安静的错"变成**响亮的抛错**，调用方据此把 `archived` 置 false。
 */
export async function exportParquet(sql: string, verify?: { path: string; rows: number }): Promise<number> {
  if (!openedPath) throw new Error('先调用 open()');
  const inst = await DuckDBInstance.create(openedPath, {
    enable_external_access: 'true',
    access_mode: 'READ_ONLY',
  });
  let written = -1;
  try {
    const conn = await inst.connect();
    try {
      await conn.run(sql);
      if (verify) {
        const r = await conn.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${verify.path}')`);
        written = Number((r.getRowObjectsJson() as Record<string, unknown>[])[0]!.n);
        if (written !== verify.rows) {
          throw new Error(
            `Parquet 归档写出的行数不对：本批 ${verify.rows} 行，归档文件里只有 ${written} 行。` +
              ` 归档不可信，已判为失败（这比留一个安静的空归档安全）。`,
          );
        }
      }
    } finally {
      conn.closeSync();
    }
  } finally {
    inst.closeSync();
    // ★ 关掉只读实例会把主实例的锁丢掉（见上面 ①）—— 立刻重开把它拿回来。
    await reattach();
  }
  return written;
}

/**
 * 把主实例**关掉重开**，只为了把库锁拿回来（只读实例一关，锁就没了，实测）。
 *
 * ★ 为什么不走 `close()` + `open()`：`open()` 会重跑一遍 DDL 与列契约登记，
 *   而这里结构没变、什么都没变 —— 只是要那把锁。所以只重建实例与两条连接。
 * ★ 代价（要认）：重开的那一瞬间旧连接失效，若此刻别处正在读，那一次读会失败。
 *   换来的是**库锁始终在主实例手上**（否则第二个进程能进来，那是真的会坏数据）。
 *   落库与归档本来就是串行的（`runIngest` 内部排队），窗口是微秒级。
 */
async function reattach(): Promise<void> {
  if (!openedPath) return;
  const p = openedPath;
  try { readConn?.closeSync(); } catch { /* 已经在关了 */ }
  try { writeConn?.closeSync(); } catch { /* 同上 */ }
  try { instance?.closeSync(); } catch { /* 同上 */ }
  instance = await DuckDBInstance.create(p, {
    enable_external_access: 'false',
    memory_limit: '2GB',
  });
  writeConn = await instance.connect();
  readConn = await instance.connect();
  console.error(`[db] 归档后已重开主实例，库锁回到本进程（${p}）`);
}
