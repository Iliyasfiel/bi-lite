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

/** 打开或创建数据库；BILITE_DB 可覆盖路径，遵循 DuckDB 单写者约束。 */
export async function open(
  dbPath = process.env.BILITE_DB ?? 'data/bi.duckdb',
  opts: { models?: 'ensure' | 'skip' } = {},
) {
  if (instance) return;

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
  if (opts.models !== 'skip') {
    try {
      await ensureModels();
      const { syncMetrics } = await import('../metrics/sync.ts');
      await syncMetrics();
    } catch (e) {
      close();
      throw e;
    }
  }
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
}

/**
 * 由主库连接读取已提交结果，按原生数据块复制到独立内存实例后写出归档。
 * 不把金额转换为 JS number，不重复打开库文件，也不关闭主实例或释放库锁。
 * 主库始终禁用外部访问；只有临时内存实例可以读写 Parquet。
 */
export async function exportParquet(selectSql: string, output: { path: string; rows: number }): Promise<number> {
  const result = await reader().run(selectSql);
  const inst = await DuckDBInstance.create(':memory:', { enable_external_access: 'true' });
  const identifier = (s: string) => '"' + s.replaceAll('"', '""') + '"';
  const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  try {
    const conn = await inst.connect();
    try {
      const columns = result.columnNames().map((name, i) => identifier(name) + ' ' + result.columnType(i).toString());
      await conn.run('CREATE TABLE archive_rows (' + columns.join(', ') + ')');
      const appender = await conn.createAppender('archive_rows');
      try {
        for await (const chunk of result) appender.appendDataChunk(chunk);
      } finally {
        appender.closeSync();
      }
      await conn.run('COPY archive_rows TO ' + literal(output.path) + ' (FORMAT parquet)');
      const back = await conn.runAndReadAll('SELECT count(*) AS n FROM read_parquet(' + literal(output.path) + ')');
      const written = Number(back.getRowObjectsJson()[0]!.n);
      if (written !== output.rows) {
        throw new Error('Parquet 归档写出的行数不对：本批 ' + output.rows + ' 行，归档文件里只有 ' + written + ' 行。归档不可信，已判为失败。');
      }
      return written;
    } finally {
      conn.closeSync();
    }
  } finally {
    inst.closeSync();
  }
}
