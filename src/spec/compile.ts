/**
 * spec → SQL 编译器（docs/需求与架构.md §5.4）
 *
 * 核心安全点：spec 在**服务端**编译成 SQL 并在 DuckDB 内执行；
 * agent 从不接触 SQL，也从不接触结果数值（只拿坐标）。
 */
import type { Block, Spec, SheetSpec } from './types.ts';
import { substitute } from './types.ts';
import { DIMENSIONS, DIM_NAMES, dimAvailableOn, isRegisteredDim, type DimName } from './dims.ts';
import { evalExpr, type ExprScope } from './expr.ts';
import { DEFAULT_TARGET, type DeclaredFact } from '../gen/ir.ts';

// 白名单已抽到 ./dims.ts（lint.ts 与 grammar.ts 也要用，放在这里会成环）。
// 下面转出去，保持 `from './compile.ts'` 的既有调用点不用改。
export { DIMENSIONS, DIM_NAMES, isRegisteredDim, dimAvailableOn };
export type { DimName };

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
  /**
   * 聚合之后的派生计算（`value.expr`，见 §5.2.1）。
   *
   * 语义：SQL 先把 expr 引用的**输入列**都算出来（columns[0..n]），
   * 再对每一行按表达式合成**一个**输出值。所以有 expr 时：
   *   - SQL 的列 = `inputLabels`（expr 的输入）
   *   - 结果的列 = `colLabels` = 单个标签（expr 的输出）
   * 这个分工是必要的：expr 是「同一区里几列之间的关系」，
   * 它不能也不需要下推到 SQL —— 下推反而要重复写聚合逻辑。
   */
  expr?: { src: string; inputLabels: string[] };
}

/** 维度取值在 SQL 里的引用表达式（兼容 table=null 的 period_type/month/year） */
function labelRef(dim: DimName): string {
  const d = DIMENSIONS[dim];
  return d.table ? `${d.table}.${d.labelCol}` : d.labelCol;
}

/** 维度过滤列的引用表达式（filter 的 key 是列名，不是维度名） */
function filterRef(dim: DimName, col: string): string {
  const d = DIMENSIONS[dim];
  // table=null 的维度取值在事实表上（period_type / fin_month），列名前缀是 f.
  return d.table ? `${d.table}.${col}` : `f.${col}`;
}

/**
 * 把一个 block 编译成「行标签 × 列口径」的透视 SQL。
 * 用条件聚合而不是 PIVOT 关键字，因为列数由 spec 决定、需要稳定可控。
 *
 * 目标表声明化（查询侧与接入侧同一思路）：
 *   - `opts.factName` 是 spec.fact 的原样透传（缺省/空 = DEFAULT_TARGET，见 gen/ir.ts）；
 *   - `opts.facts` 是调用方注入的 models 声明（declaredFactsOf()）。
 * 表名会**原样拼进 SQL**（铁律 2），所以这里是最硬的墙：
 *   factName 有值但声明里找不到 → 直接 throw，绝不把 spec 里的裸字符串放进 FROM；
 *   能进 SQL 的表名永远来自 `models/*.yml` 的声明（fact.name），不是 spec 的输入。
 * 轴/过滤用到的维度也必须真的长在目标表上（dimAvailableOn）——
 * 运营事实表没有口径列，配 period_type 轴在这里就报错，而不是跑出恒 0 的表。
 */
export function compileBlock(
  block: Block,
  params: Record<string, string | number> = {},
  opts: { maxRows?: number; factName?: string; facts?: DeclaredFact[] } = {},
): CompiledQuery {
  // ---- 目标表解析：factName 有值就必须声明过（fail-closed），否则落缺省表 ----
  const factName = opts.factName && opts.factName.trim() !== '' ? opts.factName : undefined;
  // 缺省表也按声明解析（口径窗口声明长在 models/fact_finance.yml 的 calibers 上，
  // 不查声明就拿不到 windowFrom / 平移口径，编译出来的窗口条件会悄悄回到旧路）；
  // 调用方没注入 facts 时保持 null（表名仍落 DEFAULT_TARGET，旧行为不变）。
  const fact: DeclaredFact | null = (opts.facts ?? []).find(
    (f) => f.name === (factName ?? DEFAULT_TARGET),
  ) ?? null;
  if (factName && !fact) {
    throw new Error(
      `目标表未声明: ${factName} —— 表名会原样拼进 SQL（铁律 2），只接受 models/*.yml 里声明过的事实表（kind: fact）。`,
    );
  }
  const tableName = fact?.name ?? DEFAULT_TARGET;

  // 维度必须长在目标表上（可用性判据只有一份：dims.ts 的 dimAvailableOn）
  const needDim = (d: DimName, at: string) => {
    if (!dimAvailableOn(d, fact)) {
      throw new Error(
        d === 'period_type'
          ? `目标表 ${tableName} 没有口径列（运营事实表没有口径体系，铁律 8），不能配 period_type ${at}`
          : `维度 ${d} 在目标表 ${tableName} 的声明里不存在，不能用作 ${at}`,
      );
    }
  };

  const rowsDim = ident(block.rows.dim);
  const colsDim = ident(block.cols.dim);
  needDim(rowsDim, 'rows.dim');
  needDim(colsDim, 'cols.dim');
  // 口径轴只支持做列（刀 23，与 lint 同一判据）：口径不落行，行轴没有可分组的坐标
  if (rowsDim === 'period_type') {
    throw new Error(
      '口径轴只支持做列（cols.dim: period_type）—— 口径不落行，行轴没有可分组的行坐标（铁律 5）。',
    );
  }
  const agg = block.value.agg ?? 'sum';
  const measure = block.value.measure ?? fact?.measureColumn ?? 'amount';

  const rowLabels = (block.rows.order ?? []).map((r) => substitute(String(r), params));
  const colLabels = (block.cols.order ?? []).map((c) => substitute(String(c), params));

  if (colLabels.length === 0) throw new Error('cols.order 不能为空（列口径必须显式声明）');

  // 需要的 join（去重）
  const joins = new Set<string>();
  const needJoin = (d: DimName) => {
    const j = DIMENSIONS[d].joinOn;
    if (j) joins.add(`JOIN ${DIMENSIONS[d].table} ON ${j}`);
  };
  needJoin(rowsDim);
  needJoin(colsDim);

  const rowExpr = labelRef(rowsDim);

  // ---- 口径轴特判（刀 23：period_type 列退场，口径的唯一承载是窗口）----
  //   cols.dim: period_type 的每个列值 = 一个口径名 → 展开成**窗口谓词**（声明 calibers，铁律 5），
  //   scope.time 的 as-of 期**嵌进每个列自己的条件**：平移口径（如去年同期累计）的落窗月
  //   = as-of 期 + shift 年 —— 历史月份钉不能是全局 WHERE（会把平移行的 fin_month 钉掉）。
  //   判据只有一份：窗口规则与 shift 全部来自 fact.calibers 声明，这里不做第二份口径知识。
  const caliberWindowRule = (name: string): { rule: string; shift: number } => {
    const cal = (fact?.calibers ?? []).find((x) => x.name === name);
    if (!cal || cal.calculator) {
      throw new Error(
        `口径「${name}」不在 ${tableName} 的声明 calibers 里（calculator 口径不落事实表，铁律 5）—— 列口径必须从声明的 calibers 取。`,
      );
    }
    const w = fact!.windowFrom!;
    const p = fact!.periodColumn;
    return {
      rule:
        cal.from === 'same'
          ? `f.${w} = f.${p}`
          : cal.from === 'year_start'
            ? `f.${w} = date_trunc('year', f.${p})`
            : `f.${w} = DATE '${cal.since}-01'`,
      shift: cal.shift ?? 0,
    };
  };
  /** as-of 期（scope.time 钉的年/月）按口径 shift 平移后的 fin_month 谓词片段 */
  const asOfPin = (shift: number): string[] => {
    const pins: string[] = [];
    const yRaw = block.scope?.time?.year;
    if (yRaw !== undefined) {
      const y = Number(substitute(String(yRaw), params));
      if (Number.isNaN(y)) throw new Error('scope.time.year 平移失败：不是数字');
      pins.push(`year(f.fin_month) = ${y + shift}`);
    }
    const mRaw = block.scope?.time?.month;
    if (mRaw !== undefined) {
      // month 兼容 'MM' 与 'YYYY-MM'：取月号（年份由 year 钉单独管）
      const m = Number(String(substitute(String(mRaw), params)).slice(-2));
      if (Number.isNaN(m)) throw new Error('scope.time.month 平移失败：不是数字');
      pins.push(`month(f.fin_month) = ${m}`);
    }
    return pins;
  };
  const caliberCond = (name: string): string => {
    const { rule, shift } = caliberWindowRule(name);
    return [rule, ...asOfPin(shift)].join(' AND ');
  };

  // 列：条件聚合。口径轴 → 窗口谓词；其余轴 → 维表/列标签等值（原行为）
  const colExprs = colLabels.map((c, i) => {
    const cond = colsDim === 'period_type' ? caliberCond(c) : `${labelRef(colsDim)} = ${q(c)}`;
    // 别名用序号，避免中文别名在不同驱动下的引用问题
    return `${agg}(CASE WHEN ${cond} THEN f.${measure} END) AS c${i}`;
  });

  // WHERE
  const where: string[] = [];
  const addFilter = (dim: DimName, filter?: Record<string, string | string[]>) => {
    if (!filter) return;
    needDim(dim, '过滤');
    for (const [col, val] of Object.entries(filter)) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(col)) throw new Error(`非法过滤字段: ${col}`);
      const ref = filterRef(dim, col);
      // ★ 修复：引用了某个维度的列，就必须带上它的 JOIN。
      //   首版只对 rows/cols 建 join，于是 scope.company.filter 生成
      //   「WHERE dim_company.name = ... 但没有 JOIN dim_company」→ 查库直接报错。
      needJoin(dim);
      if (Array.isArray(val)) {
        where.push(`${ref} IN (${val.map((v) => q(substitute(String(v), params))).join(', ')})`);
      } else {
        where.push(`${ref} = ${q(substitute(String(val), params))}`);
      }
    }
  };
  addFilter(rowsDim, block.rows.filter);
  addFilter(colsDim, block.cols.filter);
  // 兼容文档 §5.2 的旧写法
  addFilter('company', block.scope?.company?.filter as Record<string, string> | undefined);
  // 通用维度过滤（§7.2 路径 2 的主力：把某个维度钉死成单一值而不做成轴）
  for (const [dim, f] of Object.entries(block.scope?.filter ?? {})) {
    addFilter(ident(dim), f);
  }

  // ★ scope.time 时间钉（刀 23 重写）：
  //   口径轴（cols.dim: period_type）上，as-of 期已按列嵌入窗口条件（caliberCond ——
  //   平移口径的落窗月 = as-of + shift），全局时间钉**不再 push**：全局钉会把平移列的
  //   落窗月（fin_month = as-of − 1 年）钉掉。dim_period join 也随之不需要（asOfPin 直接用
  //   f.fin_month，年份/月份不需要 dim_period 的映射）。
  //   非口径轴的 block（运营事实表报表）：时间钉保持全局 WHERE（dim_period join）。
  if (colsDim !== 'period_type') {
    const timePin: string[] = [];
    if (block.scope?.time?.year !== undefined) {
      timePin.push(`dim_period.year = ${q(substitute(String(block.scope.time.year), params))}`);
      joins.add('JOIN dim_period ON dim_period.fin_month = f.fin_month');
    }
    if (block.scope?.time?.month !== undefined) {
      timePin.push(`dim_period.month = ${q(substitute(String(block.scope.time.month), params))}`);
      joins.add('JOIN dim_period ON dim_period.fin_month = f.fin_month');
    }
    where.push(...timePin);
  }

  // 行标签必须限定在 order 里，避免返回多余行
  if (rowLabels.length > 0) {
    where.push(`${rowExpr} IN (${rowLabels.map((r) => q(r)).join(', ')})`);
  }

  const maxRows = opts.maxRows ?? 1000;
  const sql = [
    `SELECT ${rowExpr} AS row_label,`,
    '  ' + colExprs.join(',\n  '),
    `FROM ${tableName} f`,
    ...[...joins],
    where.length ? 'WHERE ' + where.join(' AND ') : '',
    `GROUP BY 1`,
    `LIMIT ${maxRows}`,
  ]
    .filter(Boolean)
    .join('\n');

  // ★ 派生表达式（§5.2.1）。
  //   首版 compile.ts 认得 value.expr 这个字段但从不使用它 —— 于是写了同比表达式
  //   的 spec 会**静默**返回两个累计额本身（实测 [65198, 60870]，而期望 0.0711）。
  //   现在：SQL 照常取出所有输入列，输出列变成"每行一个表达式结果"。
  if (block.value.expr) {
    return {
      sql,
      rowLabels,
      colLabels: [exprLabel(block.value.expr)],
      block,
      expr: { src: block.value.expr, inputLabels: colLabels },
    };
  }

  return { sql, rowLabels, colLabels, block };
}

/** 派生列的显示名：优先用 spec 里的 format 提示，否则用表达式原文 */
function exprLabel(src: string): string {
  return src.trim();
}

/** 执行编译结果，返回「行 × 列」矩阵 */
export async function runCompiled(c: CompiledQuery, query: (sql: string) => Promise<Record<string, unknown>[]>) {
  const raw = await query(c.sql);
  const byLabel = new Map<string, Record<string, unknown>>();
  for (const r of raw) byLabel.set(String(r.row_label), r);

  // SQL 的列是 expr 的**输入**；没有 expr 时它就是输出
  const inputLabels = c.expr ? c.expr.inputLabels : c.colLabels;

  const matrix = c.rowLabels.map((label) => {
    const row = byLabel.get(label);
    const inputs = inputLabels.map((_, i) => {
      const v = row?.[`c${i}`];
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    });

    if (c.expr) {
      // 输入列名 → 值 的上下文（expr 里的变量就是 cols.order 里的口径名）
      const scope: ExprScope = {};
      inputLabels.forEach((name, i) => (scope[name] = inputs[i]));
      return { label, values: [evalExpr(c.expr.src, scope)] };
    }
    return { label, values: inputs };
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
