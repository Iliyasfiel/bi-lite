/**
 * spec → SQL 编译器（docs/需求与架构.md §5.4）
 *
 * 核心安全点：spec 在**服务端**编译成 SQL 并在 DuckDB 内执行；
 * agent 从不接触 SQL，也从不接触结果数值（只拿坐标）。
 */
import type { Block, Spec, SheetSpec } from './types.ts';
import { substitute } from './types.ts';

/**
 * 已注册的维度 —— group_by / rows / cols 只接受这里的名字（防注入 + 防越界）
 *
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

export function isRegisteredDim(d: string): d is DimName {
  return Object.hasOwn(DIMENSIONS, d);
}

/** SQL 字面量转义（单引号双写）—— 值来自 spec，仍需防御 */
function q(v: string | number): string {
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** 标识符安全校验：只允许已注册维度名 */
function ident(d: string): string {
  if (!isRegisteredDim(d)) throw new Error(`未注册的维度: ${d}（只允许 ${Object.keys(DIMENSIONS).join(' / ')}）`);
  return d;
}

export interface CompiledQuery {
  sql: string;
  rowLabels: string[];
  colLabels: string[];
  /** 每行的行维度值 → 用来做 Excel 行定位 */
  block: Block;
}

/**
 * 把一个 block 编译成「行标签 × 列口径」的透视 SQL。
 * 用条件聚合而不是 PIVOT 关键字，因为列数由 spec 决定、需要稳定可控。
 */
export function compileBlock(
  block: Block,
  params: Record<string, string | number> = {},
  opts: { maxRows?: number } = {},
): CompiledQuery {
  const rowsDim = ident(block.rows.dim);
  const colsDim = ident(block.cols.dim);
  const agg = block.value.agg ?? 'sum';
  const measure = block.value.measure ?? 'amount';

  const rowLabels = (block.rows.order ?? []).map((r) => substitute(String(r), params));
  const colLabels = (block.cols.order ?? []).map((c) => substitute(String(c), params));

  if (colLabels.length === 0) throw new Error('cols.order 不能为空（列口径必须显式声明）');

  // 需要的 join（去重）
  const joins = new Set<string>();
  for (const d of [rowsDim, colsDim]) {
    const j = DIMENSIONS[d].joinOn;
    if (j) joins.add(`JOIN ${DIMENSIONS[d].table} ON ${j}`);
  }

  // 行标签列
  const rowExpr =
    DIMENSIONS[rowsDim].table
      ? `${DIMENSIONS[rowsDim].table}.${DIMENSIONS[rowsDim].labelCol}`
      : `${DIMENSIONS[rowsDim].labelCol}`;

  // 列：条件聚合
  const colExprs = colLabels.map((c, i) => {
    const cond =
      colsDim === 'period_type'
        ? `f.period_type = ${q(c)}`
        : `${DIMENSIONS[colsDim].table}.${DIMENSIONS[colsDim].labelCol} = ${q(c)}`;
    // 别名用序号，避免中文别名在不同驱动下的引用问题
    return `${agg}(CASE WHEN ${cond} THEN f.${measure} END) AS c${i}`;
  });

  // WHERE
  const where: string[] = [];
  const addFilter = (dim: string, filter?: Record<string, string | string[]>) => {
    if (!filter) return;
    const d = ident(dim);
    const tbl = DIMENSIONS[d].table;
    for (const [col, val] of Object.entries(filter)) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(col)) throw new Error(`非法过滤字段: ${col}`);
      const ref = tbl ? `${tbl}.${col}` : `f.${col}`;
      if (Array.isArray(val)) {
        where.push(`${ref} IN (${val.map((v) => q(substitute(String(v), params))).join(', ')})`);
      } else {
        where.push(`${ref} = ${q(substitute(String(val), params))}`);
      }
    }
  };
  addFilter(rowsDim, block.rows.filter);
  addFilter(colsDim, block.cols.filter);
  addFilter('company', block.scope?.company?.filter as Record<string, string> | undefined);

  if (block.scope?.time?.year !== undefined) {
    where.push(`dim_period.year = ${q(substitute(String(block.scope.time.year), params))}`);
    joins.add('JOIN dim_period ON dim_period.fin_month = f.fin_month');
  }
  if (block.scope?.time?.month !== undefined) {
    where.push(`dim_period.month = ${q(substitute(String(block.scope.time.month), params))}`);
    joins.add('JOIN dim_period ON dim_period.fin_month = f.fin_month');
  }

  // 行标签必须限定在 order 里，避免返回多余行
  if (rowLabels.length > 0) {
    where.push(`${rowExpr} IN (${rowLabels.map((r) => q(r)).join(', ')})`);
  }

  const maxRows = opts.maxRows ?? 1000;
  const sql = [
    `SELECT ${rowExpr} AS row_label,`,
    '  ' + colExprs.join(',\n  '),
    'FROM fact_finance f',
    ...[...joins],
    where.length ? 'WHERE ' + where.join(' AND ') : '',
    `GROUP BY 1`,
    `LIMIT ${maxRows}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { sql, rowLabels, colLabels, block };
}

/** 执行编译结果，返回「行 × 列」矩阵 */
export async function runCompiled(c: CompiledQuery, query: (sql: string) => Promise<Record<string, unknown>[]>) {
  const raw = await query(c.sql);
  const byLabel = new Map<string, Record<string, unknown>>();
  for (const r of raw) byLabel.set(String(r.row_label), r);

  const matrix = c.rowLabels.map((label) => {
    const row = byLabel.get(label);
    return {
      label,
      values: c.colLabels.map((_, i) => {
        const v = row?.[`c${i}`];
        if (v === null || v === undefined) return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      }),
    };
  });

  return { rowLabels: c.rowLabels, colLabels: c.colLabels, matrix };
}

/**
 * 把几个 block 的结果合成「写盘计划」—— 只包含坐标与形状，不含金额。
 * 这是给 agent 看的预览（安全设计 §6.2 第②层：给坐标不给数值）。
 */
export function planOf(spec: Spec, results: Array<{ sheet: string; anchor: string; rowLabels: string[]; colLabels: string[] }>) {
  return {
    specId: spec.id,
    template: spec.template ?? null,
    sheets: results.map((r) => ({
      sheet: r.sheet,
      anchor: r.anchor,
      shape: `${r.rowLabels.length} 行 × ${r.colLabels.length} 列`,
      rowCount: r.rowLabels.length,
      colCount: r.colLabels.length,
    })),
    totalCells: results.reduce((a, r) => a + r.rowLabels.length * r.colLabels.length, 0),
    note: '本预览仅含坐标与形状，不含任何金额',
  };
}
