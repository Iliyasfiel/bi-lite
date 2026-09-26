/**
 * DuckDB 连接管理（单进程独占模型，见 docs/需求与架构.md §4.4）
 *
 * 纪律：整个进程只有一个 DuckDBInstance。
 * 导入与查询用**不同连接**，靠 MVCC 让读不被写阻塞。
 */
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { DDL } from './schema.ts';
import fs from 'node:fs';
import path from 'node:path';

let instance: DuckDBInstance | null = null;
let writeConn: DuckDBConnection | null = null;
let readConn: DuckDBConnection | null = null;

export async function open(dbPath = 'data/bi.duckdb') {
  if (instance) return;

  // 确保归档目录存在
  fs.mkdirSync(path.join('data/parquet'), { recursive: true });

  instance = await DuckDBInstance.create(dbPath, {
    // 财务数据敏感：禁用外部访问，避免 SQL 里意外读到任意文件
    enable_external_access: 'false',
    memory_limit: '2GB',
  });

  writeConn = await instance.connect();
  readConn = await instance.connect();

  // 建表（幂等）
  for (const stmt of DDL.split(';').map((s) => s.trim()).filter(Boolean)) {
    await writeConn.run(stmt);
  }
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

export function close() {
  readConn?.closeSync();
  writeConn?.closeSync();
  instance?.closeSync();
  readConn = writeConn = instance = null;
}
