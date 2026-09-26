/**
 * 维度白名单（从 compile.ts 抽出来，成为独立模块）
 *
 * ★ 为什么要单独一个文件：这份白名单现在有三个使用者 ——
 *   编译器（拼 SQL）、静态诊断（lint.ts 判断"哪些维度没被约束"）、
 *   语法参考（grammar.ts 告诉 agent 有哪些 dim 可写）。
 *   如果它留在 compile.ts 里，lint.ts 就必须 import compile.ts，
 *   而 compile.ts 又 import types.ts、types.ts 要调用 lint —— 成环。
 *   单独成模块后依赖是单向的：dims.ts ← lint.ts ← types.ts ← compile.ts。
 *
 * ★ 安全含义（铁律 2）：**能进 SQL 的标识符只有这里的五个**。
 *   任何绕过这份白名单拼 SQL 的路都是漏洞，这也是"agent 无 SQL 权限"的落点。
 */

/**
 * table === null 表示该维度的取值**直接来自事实表**（或是个 SQL 表达式），不需要 join。
 * labelCol 在 table 为 null 时可以是完整表达式（如 `strftime(f.fin_month, '%Y-%m')`）。
 */
export const DIMENSIONS = {
  metric: {
    table: 'dim_metric',
    labelCol: 'name',
    idCol: 'id',
    joinOn: 'f.metric_id = dim_metric.id',
  },
  company: {
    table: 'dim_company',
    labelCol: 'name',
    idCol: 'id',
    joinOn: 'f.company_id = dim_company.id',
  },
  // 以下直接来自事实表，不 join
  period_type: { table: null, labelCol: 'f.period_type', idCol: 'period_type', joinOn: null },
  // 时间维度：Web 看板要"按月份筛选/分组"（F6）
  month: { table: null, labelCol: "strftime(f.fin_month, '%Y-%m')", idCol: 'fin_month', joinOn: null },
  year: { table: null, labelCol: 'CAST(year(f.fin_month) AS VARCHAR)', idCol: 'fin_month', joinOn: null },
} as const;

export type DimName = keyof typeof DIMENSIONS;

/** 全部维度名（报错文案与 lint 共用，避免各处重复写 join(' / ')） */
export const DIM_NAMES = Object.keys(DIMENSIONS) as DimName[];

export function isRegisteredDim(d: string): d is DimName {
  return Object.hasOwn(DIMENSIONS, d);
}
