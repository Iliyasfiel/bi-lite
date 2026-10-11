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
 * ★ 安全含义（铁律 2）：**能进 SQL 的标识符只有这里的八个**。
 *   任何绕过这份白名单拼 SQL 的路都是漏洞，这也是"agent 无 SQL 权限"的落点。
 */

import type { DeclaredFact } from '../gen/ir.ts';

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
  // 行内退化列维（铁律 8 的运营事实表）：列长在事实表上、低基数、只用来切片，不值得单独建维。
  // ★ 是否可用由**目标表的声明**决定（dimAvailableOn）—— 财务表没有这一列，配了就报错。
  business_line: { table: null, labelCol: 'f.business_line', idCol: 'business_line', joinOn: null },
  // 正交维度（P5 刀 22）：scenario 过滤/分组零 join；ccy 的**换算**不在编译维度这层做，
  //   在 compileMetrics 的 selector 分支（fx_rate 按行落窗期取率）—— 这里只管「f.ccy 能过滤」。
  //   可用性同样由目标表声明决定（fact_finance 有这两列，运营事实表没有）。
  scenario: { table: null, labelCol: 'f.scenario', idCol: 'scenario', joinOn: null },
  ccy: { table: null, labelCol: 'f.ccy', idCol: 'ccy', joinOn: null },
} as const;

export type DimName = keyof typeof DIMENSIONS;

/** 全部维度名（报错文案与 lint 共用，避免各处重复写 join(' / ')） */
export const DIM_NAMES = Object.keys(DIMENSIONS) as DimName[];

export function isRegisteredDim(d: string): d is DimName {
  return Object.hasOwn(DIMENSIONS, d);
}

/**
 * 该维度在**目标事实表**上是否可用 —— 查询侧目标表声明化（报表 `spec.fact` / 看板 `query.fact`）
 * 的共用判据，编译器（compile.ts）、静态诊断（lint.ts）、看板（query.ts）都调它，不许另写一份。
 *
 * ★ fact === null 的语义是「**缺省的 fact_finance 形状**」（不是"不知道"）：
 *   调用方没注入声明时按缺省表判 —— fail-closed：退化列维对 null 恒为 false。
 * ★ 判据只来自声明（`gen/ir.ts` 的 DeclaredFact），这里不写任何表名/列名字面量。
 */
export function dimAvailableOn(dim: DimName, fact: DeclaredFact | null): boolean {
  const d = DIMENSIONS[dim];
  if (d.table !== null) return true; // 维表（metric / company）：任何事实表都带外键
  // 口径体系（刀 23）：period_type 列退场，口径唯一承载是声明 calibers —— 有声明即有口径轴
  if (dim === 'period_type') return fact ? fact.calibers.length > 0 : true;
  if (dim === 'month' || dim === 'year') return fact ? fact.periodColumn !== null : true;
  // 行内退化列维：目标表的声明里真有这一列才可用
  return fact ? fact.degenerateColumns.includes(d.idCol) : false;
}
