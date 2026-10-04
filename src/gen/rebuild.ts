/**
 * 派生物的重建：声明行（`rows:`）同步 + 聚合表（`kind: aggregate`）重算（P3）。
 *
 * ★ 写路径只有一条：`bilite rebuild` = **全量对齐**。没有增量、没有 UPSERT：
 *   声明行与聚合表都是**派生物**（行与数据从声明/事实投影出来），**删了能回来**。
 *   谁手工往里写，下一次 rebuild 就会把他的修改整个换掉 —— 这不是 bug，这是定义。
 *
 * ★ 三个调用方，共用同一条 SQL 生成（`rebuildTableSql`，plan 的 rebuild-table 也用它）：
 *   - `bilite rebuild`：`rebuildAll()` 单独跑，自己开事务；
 *   - `runIngest` 落库事务内：事实数据 + 它的聚合**同一事务**落进去（不会出现
 *     "事实已提交、聚合还是旧的"那段窗口 —— 那种窗口里出的报表，对就是对不上账）；
 *   - 落库事务**不**同步声明行：行不依赖事实数据，rebuild 才是它的写路径。
 *
 * ★ 顺序是语义：行同步在前（维度 → 桥接），聚合重算在后 ——
 *   via 摊分的聚合表 JOIN 桥接表，桥接行的 id 解析与权重守恒必须先过。
 *
 * ★ 为什么不递归重建（agg on agg）：v1 的 source 必须是 fact（parse 守卫），
 *   聚合的聚合口径问题（两次 SUM 的语义）等真有需求再议，先不假装支持。
 */
import { execute } from '../db/index.ts';
import { registerMeta } from '../meta/columns.ts';
import { rebuildTableSql } from './ddl.ts';
import { metaOf, type Ir, type IrTable } from './ir.ts';
import { syncRows, type SyncedRows } from './sync.ts';

export interface RebuildResult {
  /** 同步了声明行的表 + 行数 */
  synced: SyncedRows[];
  /** 重算了的聚合表名（执行顺序 = 声明顺序） */
  rebuilt: string[];
  /** 执行的重算语句（给人看：plan / e2e 对拍用）；行同步的 DELETE/INSERT 不在此列 */
  sqls: string[];
}

/** 聚合表清单；source 给定时只留这些源的（ingest 只重建与本次落库有关的那几张） */
export function aggregateTablesOf(ir: Ir, source?: string): IrTable[] {
  return ir.tables.filter((t) => t.kind === 'aggregate' && (source === undefined || t.source === source));
}

/**
 * 执行一批重算（**不管理事务**）。
 * 事务由调用方决定：单独跑走 `rebuildAll()`，落库事务里复用 `runIngest` 的那一个。
 */
export async function executeRebuilds(tables: IrTable[], ir: Ir): Promise<string[]> {
  const sqls: string[] = [];
  for (const t of tables) {
    const sql = rebuildTableSql(t, ir);
    await execute(sql);
    sqls.push(sql);
  }
  return sqls;
}

/**
 * 全量对齐（单独跑的那条路：自己开事务）。
 * 同一事务里做完：声明行同步（维度 → 桥接，错名 / 权重和 ≠ 1 整批回滚）→
 * 聚合表重算 → 契约刷新。任何一步失败，库里的派生物一根汗毛都没动过。
 *
 * @param ir 声明的 IR（`loadModels(dir)` 的产物）
 */
export async function rebuildAll(ir: Ir): Promise<RebuildResult> {
  const rowTables = ir.tables.filter((t) => t.rows);
  const aggs = ir.tables.filter((t) => t.kind === 'aggregate');
  if (rowTables.length === 0 && aggs.length === 0) return { synced: [], rebuilt: [], sqls: [] };

  await execute('BEGIN');
  try {
    const synced = await syncRows(ir);
    const sqls = await executeRebuilds(aggs, ir);
    // 契约跟着一起刷（声明改了 grain / rows 却只跑了 rebuild 的场景：数据与契约同一次提交）
    if (aggs.length > 0) await registerMeta(metaOf({ apiVersion: ir.apiVersion, tables: aggs }));
    await execute('COMMIT');
    return { synced, rebuilt: aggs.map((t) => t.name), sqls };
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
