/**
 * 语义自省（架构 §7.1 自省面）：从声明推导「每张表能查什么」。
 *
 * ★ 判据（docs/开发计划.md §3.1 主要风险）：语义层**不设自己的登记表**。
 *   _meta_columns 是声明的投影（src/meta/columns.ts），这里直接读 IR —— 同一份
 *   `models/*.yml` 的唯一投影（`metaOf()` 同源），因为标题、grain、谱系（source/via）
 *   只在 IR 上有。谁想改「能查什么」，改的是 models/*.yml；本文件里没有任何表名/列名字面量。
 *
 * 对应架构文档的 sem_* 视图（全部纯函数、零 DB 访问，加一张表 = 自省多一项）：
 *   sem_metric   → SemanticFact.measures（role=measure 自动可选指标，带 unit）
 *   sem_dim_ref  → SemanticFact.dimRefs（role=dim_fk 自动可用维度）+ slicers（行内退化列切片）
 *   sem_lineage  → SemanticFact.lineage（聚合表的 source / via 派生边）
 *   sem_caliber  → 只暴露「口径列在不在」：在 = 查询必须钉口径（铁律 17）；
 *                  成员清单沿用 PERIOD_TYPES 唯一注册表（semantic/query.ts 的 staticCatalog），
 *                  selector/calculator 二分是 P5 的事。
 */
import { loadModels } from '../gen/parse.ts';
import type { Ir, IrColumn, IrTable } from '../gen/ir.ts';

export interface SemanticMeasure {
  column: string;
  unit: string | null;
  /** 聚合方式；仅聚合表有（v1 只认 sum），事实表无 */
  agg: string | null;
}

export interface SemanticDimRef {
  /** 本表外键列 */
  column: string;
  /** 指到的维表 */
  refTable: string;
  semantic: string | null;
}

export interface SemanticSlicer {
  /** 行内携带的切片列（如 fact_business_line.business_line），可直接当维度过滤/分组 */
  column: string;
  semantic: string | null;
}

export interface SemanticFact {
  name: string;
  kind: 'fact' | 'aggregate';
  title: string;
  grain: string[];
  measures: SemanticMeasure[];
  /** 时间列（semantic=period）；无则该表不可按月/年切片 */
  periodColumn: string | null;
  /** 口径列（semantic=period_type）。非 null = 铁律 17：查询必须钉住口径 */
  periodTypeColumn: string | null;
  dimRefs: SemanticDimRef[];
  slicers: SemanticSlicer[];
  /** 派生谱系：聚合表的 source（声明的 fact）与 via（穿桥摊分）；事实表为 null */
  lineage: { source: string | null; via: string | null };
}

function periodColumnOf(columns: IrColumn[]): string | null {
  const c = columns.find((c) => c.semantic === 'period');
  return c ? c.name : null;
}

function periodTypeColumnOf(columns: IrColumn[]): string | null {
  const c = columns.find((c) => c.semantic === 'period_type');
  return c ? c.name : null;
}

function toSemanticFact(t: IrTable): SemanticFact {
  return {
    name: t.name,
    kind: t.kind as 'fact' | 'aggregate',
    title: t.title,
    grain: [...t.grain],
    measures: t.columns
      .filter((c) => c.role === 'measure')
      .map((c) => ({ column: c.name, unit: c.unit ?? null, agg: c.agg ?? null })),
    periodColumn: periodColumnOf(t.columns),
    periodTypeColumn: periodTypeColumnOf(t.columns),
    dimRefs: t.columns
      .filter((c) => c.role === 'dim_fk' && c.refs)
      .map((c) => ({ column: c.name, refTable: c.refs!, semantic: c.semantic ?? null })),
    slicers: t.columns
      .filter((c) => c.role !== 'measure' && c.role !== 'provenance' && c.role !== 'dim_fk'
        && c.semantic !== 'period' && c.semantic !== 'period_type')
      .map((c) => ({ column: c.name, semantic: c.semantic ?? null })),
    lineage: t.kind === 'aggregate'
      ? { source: t.source ?? null, via: t.via ?? null }
      : { source: null, via: null },
  };
}

/** 全部可查询表（kind: fact | aggregate）的语义形状，按声明顺序。 */
export function semanticFacts(ir: Ir = loadModels()): SemanticFact[] {
  return ir.tables.filter((t: IrTable) => t.kind === 'fact' || t.kind === 'aggregate').map(toSemanticFact);
}

/** 单表语义形状；未声明的可查询表名返回 null（fail-closed，调用方负责报错）。 */
export function semanticFactOf(name: string, ir: Ir = loadModels()): SemanticFact | null {
  return semanticFacts(ir).find((f) => f.name === name) ?? null;
}
