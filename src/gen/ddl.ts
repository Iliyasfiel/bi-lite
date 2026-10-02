/**
 * IR → DDL（**纯函数**，不碰库）。
 *
 * ★ 为什么单独一层：`plan` 要把"会执行什么"给人看，`apply` 要执行同一批语句 ——
 *   两边调**同一个函数**，否则"计划"与"落地"迟早不是一回事（铁律 17 的漂移判例）。
 * ★ 生成的 DDL 里**不出现反引号**（`src/db/schema.ts` 那次的教训：模板字符串会被提前闭合），
 *   虽然这里是运行时拼字符串、没有那个风险，但保持同一条习惯 —— 想要样式就用中文引号。
 */
import type { Ir, IrColumn, IrTable } from './ir.ts';

/** 一列的定义片段（不含逗号、不含注释）：`name TYPE [NOT NULL] [DEFAULT x]` */
export function columnHead(c: IrColumn): string {
  const parts = [c.name, c.type];
  if (c.notNull) parts.push('NOT NULL');
  if (c.default) parts.push(`DEFAULT ${c.default}`);
  return '  ' + parts.join(' ');
}

export function createTableSql(t: IrTable): string {
  // ⚠️ 逗号必须在注释**之前**：SQL 的行注释从 `--` 到行尾，
  //    写成 `-- 注释,` 会把逗号也注释掉，报错是 `syntax error at or near "name"`（第一版就这么错的）
  const total = t.columns.length + (t.primaryKey.length > 0 ? 1 : 0);
  const lines = t.columns.map((c, i) => {
    const head = columnHead(c);
    const comma = i < total - 1 ? ',' : '';
    if (!c.comment) return head + comma;
    return (head + comma).padEnd(36) + `-- ${c.comment}`;
  });
  if (t.primaryKey.length > 0) lines.push(`  PRIMARY KEY (${t.primaryKey.join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS ${t.name} (\n${lines.join('\n')}\n)`;
}

/**
 * 加一列。
 *
 * ⚠️ 加列**不带 NOT NULL**：DuckDB 在有数据的表上加 NOT NULL 列（且没默认值）会直接失败，
 *   而"加一列"是本生成器最常见的变更 —— 让它因为一个没人要求的约束而失败毫无好处。
 *   声明里写了 `notNull: true` 的**新**列，由 `plan` 报成**阻塞项**让人自己决定（见 plan.ts）。
 */
export function addColumnSql(table: string, c: IrColumn): string {
  const parts = [c.name, c.type];
  if (c.default) parts.push(`DEFAULT ${c.default}`);
  return `ALTER TABLE ${table} ADD COLUMN ${parts.join(' ')}`;
}

/** 整份声明的建表 DDL（按依赖顺序：先维度、再事实 —— 建表时 DuckDB 不校验外键，但顺序读起来对） */
export function ddlOf(ir: Ir): string {
  const rank = (t: IrTable) => (t.kind === 'fact' ? 1 : 0);
  return [...ir.tables]
    .sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : 1))
    .map((t) => createTableSql(t) + ';')
    .join('\n\n');
}

/** 外键依赖对（给 `_model_dep` 用） */
export function depsOf(t: IrTable): Array<{ refs: string; column: string }> {
  return t.foreignKeys.map((f) => ({ refs: f.refs, column: f.column }));
}
