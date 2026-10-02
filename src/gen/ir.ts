/**
 * 生成器的**中间表示**（IR）—— 架构 §5.1 要的那一层，P2 的关键。
 *
 * ★ 判据只有一条（`docs/开发计划.md` §3 P2 的"主要风险"）：
 *   **换一种 YAML 写法，IR 以下的东西（plan / apply / DDL 生成 / 列契约）一行都不该改。**
 *   做不到这条，生成器就退化成字符串拼接 —— 也就是"没有 IR"。
 *   所以 `parse.ts` 允许**两种等价的写法**（分组的 `keys`/`measures` 与平铺的 `columns`），
 *   但都归一成下面这个语义模型；e2e 有一条断言把两种写法解析出的 IR **逐字段深度对比**。
 *
 * IR 只谈**语义**：表是什么、列是什么、谁是主键、谁引用谁、每列扮演什么角色。
 * 它不谈语法（YAML 长什么样），也不谈执行顺序（那是 plan / apply 的事）。
 */
import { createHash } from 'node:crypto';

/** 列在语义层扮演的角色 —— 与架构 §7.2 的五个取值一一对应（唯一一份定义，`meta/columns.ts` 从这里 re-export） */
export type MetaRole = 'pk' | 'dim_fk' | 'measure' | 'degenerate' | 'provenance';

/** 表在语义层的种类 */
export type ModelKind = 'dimension' | 'fact' | 'bridge';

export interface IrColumn {
  name: string;
  /** 归一化后的 SQL 类型（大写，如 DATE / VARCHAR / DECIMAL(18,2) / VARCHAR[]） */
  type: string;
  role: MetaRole;
  /** 是否属于主键 */
  key: boolean;
  /** 声明为 NOT NULL（主键列隐含 NOT NULL） */
  notNull: boolean;
  /** 语义类型：period / org / metric / money / …（给人看、给 agent 看，不参与 SQL） */
  semantic?: string;
  unit?: string;
  /** role='dim_fk' 时：这一列指向哪张表 */
  refs?: string;
  /** DEFAULT 的 SQL 字面量，原样写进去（不解释） */
  default?: string;
  comment?: string;
}

export interface IrTable {
  name: string;
  kind: ModelKind;
  title: string;
  /** 事实表的粒度（维度表留空）。必须是自己的列 */
  grain: string[];
  /** 列的顺序**就是物理列序**（DDL 按它生成） */
  columns: IrColumn[];
  /** 主键列名（顺序即 PK 顺序） */
  primaryKey: string[];
  /** 外键：列 → 指向的表（冗余于 columns[].refs，方便 plan 做依赖检查） */
  foreignKeys: Array<{ column: string; refs: string }>;
}

export interface Ir {
  /** 声明本身的口径版本（改 IR 语义时递增） */
  apiVersion: string;
  tables: IrTable[];
}

/** 解析/校验阶段的错误：带 code，便于 CLI 与 e2e 判据稳定 */
export class ModelError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------- 列契约（`_meta_columns` / `_meta_objects` 的投影） ----------------

export interface MetaColumn {
  column: string;
  role: MetaRole;
  semantic?: string;
  unit?: string;
  refTable?: string;
}

export interface MetaObject {
  name: string;
  kind: ModelKind;
  grain?: string[];
  columns: MetaColumn[];
}

/**
 * IR → 列契约。**这是"同一份事实的另一种视图"，不是第二份声明**：
 * `_meta_columns` 的内容只允许来自这里（apply 与接入层两处登记都调它）。
 */
export function metaOf(ir: Ir): MetaObject[] {
  return ir.tables.map((t) => ({
    name: t.name,
    kind: t.kind,
    grain: t.kind === 'fact' ? t.grain : undefined,
    columns: t.columns.map((c) => ({
      column: c.name,
      role: c.role,
      semantic: c.semantic,
      unit: c.unit,
      refTable: c.refs,
    })),
  }));
}

// ---------------- 指纹与规范化 ----------------

/** 类型归一化：大小写、空白、以及 `CHARACTER VARYING` 这类别名统一到一种写法 */
export function normalizeSqlType(raw: string): string {
  const s = raw.trim().replace(/\s+/g, ' ').toUpperCase();
  const aliases: Record<string, string> = {
    'CHARACTER VARYING': 'VARCHAR',
    'CHARACTER VARYING[]': 'VARCHAR[]',
    'DOUBLE': 'DOUBLE',
    'NUMERIC': 'DECIMAL',
    'BOOL': 'BOOLEAN',
  };
  return aliases[s] ?? s;
}

/**
 * 一张表的结构指纹（12 位）。给 `_model.ddl_hash` 用：
 * 声明变了而结构没变时，plan 靠它知道"该重新登记一次契约"。
 * ★ 只取**结构**（列名/类型/角色/主键），不取注释与标题 —— 改一句注释不该触发任何变更。
 */
export function ddlHashOf(t: IrTable): string {
  const canonical = t.columns.map((c) => `${c.name}:${c.type}:${c.role}:${c.key ? 'K' : '-'}`).join(',');
  return createHash('sha256')
    .update(`${t.name}|${t.kind}|${canonical}|pk=${t.primaryKey.join(',')}|grain=${t.grain.join(',')}`)
    .digest('hex')
    .slice(0, 12);
}

/** 整个声明的指纹（表按名字排序后拼接） */
export function irFingerprint(ir: Ir): string {
  return createHash('sha256')
    .update([...ir.tables].sort((a, b) => (a.name < b.name ? -1 : 1)).map(ddlHashOf).join(';'))
    .digest('hex')
    .slice(0, 12);
}
