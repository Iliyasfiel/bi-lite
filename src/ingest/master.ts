/**
 * 主数据快照（公司的名字、指标的名字、已注册口径）。
 *
 * ★ 只有这一份实现：MCP 工具与 Web 路由都用它。
 *   "两处各写一遍判据"在本仓库出过事（stage 用原始名判重、commit 用解析后 id 落库，
 *   同一批数据两套结论），所以凡是"判重/归并/校验"要用的快照，都从这里取。
 */
import { catalog } from '../semantic/query.ts';
import type { MasterCatalog } from './dryrun.ts';

export async function masterCatalog(): Promise<MasterCatalog> {
  const c = await catalog();
  return {
    companies: c.companies.map((x) => x.name),
    metrics: c.metrics.map((x) => x.name),
    // ★ period_type 的实际取值就是 PERIOD_TYPES 的 id（catalog 已把它当数据下发）
    periodTypes: c.periodTypes.map((x) => x.id),
  };
}
