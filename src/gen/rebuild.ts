/**
 * 聚合表重算（P3 第一刀）。
 *
 * ★ 聚合表的写路径只有这一条：`CREATE OR REPLACE TABLE … AS SELECT … GROUP BY` —— 全量重算。
 *   没有增量、没有 UPSERT：聚合表是派生物，**删了能回来**。谁手工往里写数据，
 *   下一次 rebuild 就会把他的修改整个换掉 —— 这不是 bug，这是聚合表的定义。
 *
 * ★ 两个调用方，共用同一条 SQL 生成（`rebuildTableSql`，plan 的 rebuild-table 也用它）：
 *   - `bilite rebuild`：单独跑，自己开事务；
 *   - `runIngest` 落库事务内：数据与它的聚合**同一事务**落进去（聚合表不会出现
 *     "事实已提交、聚合还是旧的"那段窗口 —— 那种窗口里出的报表，对就是对不上账）。
 *
 * ★ 为什么不递归重建（agg on agg）：v1 的 source 必须是 fact（parse 守卫），
 *   聚合的聚合口径问题（两次 SUM 的语义）等真有需求再议，先不假装支持。
 */
import { execute } from '../db/index.ts';
import { registerMeta } from '../meta/columns.ts';
import { rebuildTableSql } from './ddl.ts';
import { metaOf, type Ir, type IrTable } from './ir.ts';

export interface RebuildResult {
  /** 重算了的聚合表名（执行顺序 = 声明顺序） */
  rebuilt: string[];
  /** 执行的语句（给人看：plan / e2e 对拍用） */
  sqls: string[];
}

/** 聚合表清单；source 给定时只留这些源的（ingest 只重建与本次落库有关的那几张） */
export function aggregateTablesOf(ir: Ir, source?: string): IrTable[] {
  return ir.tables.filter((t) => t.kind === 'aggregate' && (source === undefined || t.source === source));
}

/**
 * 执行一批重算（**不管理事务**）。
 * 事务由调用方决定：单独跑走 `rebuildAggregates()`，落库事务里复用 `runIngest` 的那一个。
 */
export async function executeRebuilds(tables: IrTable[]): Promise<string[]> {
  const sqls: string[] = [];
  for (const t of tables) {
    const sql = rebuildTableSql(t);
    await execute(sql);
    sqls.push(sql);
  }
  return sqls;
}

/**
 * 重算聚合表（单独跑的那条路：自己开事务，重算 + 契约刷新一起提交）。
 *
 * @param ir 声明的 IR（`loadModels(dir)` 的产物）
 * @param opts.sources 只重算这些源的聚合表（不给 = 全部）
 */
export async function rebuildAggregates(ir: Ir, opts: { sources?: string[] } = {}): Promise<RebuildResult> {
  const tables = ir.tables.filter(
    (t) => t.kind === 'aggregate' && (opts.sources === undefined || opts.sources.includes(t.source!)),
  );
  if (tables.length === 0) return { rebuilt: [], sqls: [] };

  await execute('BEGIN');
  try {
    const sqls = await executeRebuilds(tables);
    // 契约跟着一起刷（声明改了 grain 却只跑了 rebuild 的场景：数据与契约同一次提交）
    await registerMeta(metaOf({ apiVersion: ir.apiVersion, tables }));
    await execute('COMMIT');
    return { rebuilt: tables.map((t) => t.name), sqls };
  } catch (e) {
    try {
      await execute('ROLLBACK');
    } catch (rollbackErr) {
      // 回滚本身失败也要喊出来，但**不许盖过真正的原错**（与 runIngest / applyModels 同一条）
      console.error(`[gen] ROLLBACK 失败（原错误随后抛出）: ${(rollbackErr as Error).message}`);
    }
    throw e;
  }
}
