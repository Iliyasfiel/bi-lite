/**
 * 口径规格（spec）—— bi-lite 的领域语言（docs/需求与架构.md §5）
 *
 * spec 是"透视表的声明式版本"，是数据与排版之间的唯一中间层。
 * 人和 agent 都写它；Excel 与图表都是它的渲染器。
 */
import { parse as parseYaml } from 'yaml';

export interface Spec {
  id: string;
  title?: string;
  template?: string;          // Excel 模板路径（版式来源）
  params?: Record<string, string | number>;
  sheets: SheetSpec[];
}

export interface SheetSpec {
  name: string;
  blocks: Block[];
}

export interface Block {
  /** 数据写入位置。字符串坐标 "B4"，或 {name: "定义名称"} 优先于坐标 */
  anchor: string | { name: string };
  rows: AxisSpec;
  cols: AxisSpec;
  value: ValueSpec;
  /** 参数化范围：时间 / 公司 */
  scope?: {
    time?: { year?: string | number; month?: string | number };
    company?: { dim?: string; filter?: Record<string, string> };
  };
}

export interface AxisSpec {
  dim: string;
  filter?: Record<string, string | string[]>;
  order?: string[];
}

export interface ValueSpec {
  measure?: string;           // 事实表字段，通常是 amount
  agg?: 'sum' | 'avg' | 'max' | 'min' | 'count';
  /** 派生表达式，引用同区其他口径列，如 "(本年累计 - 去年同期累计) / 去年同期累计" */
  expr?: string;
  /** 同时管 Excel 单元格格式与看板显示（设计取自 Lightdash，见 §12.4.2） */
  format?: string;
}

/** 解析 YAML 文本为 spec */
export function parseSpec(yamlText: string): Spec {
  const raw = parseYaml(yamlText) as Spec;
  validateSpec(raw);
  return raw;
}

export class SpecError extends Error {}

function validateSpec(s: Spec) {
  const errs: string[] = [];
  if (!s.id) errs.push('缺少 id');
  if (!Array.isArray(s.sheets) || s.sheets.length === 0) errs.push('至少需要一个 sheet');
  for (const [i, sheet] of (s.sheets ?? []).entries()) {
    if (!sheet.name) errs.push(`sheets[${i}] 缺少 name`);
    if (!Array.isArray(sheet.blocks) || sheet.blocks.length === 0) {
      errs.push(`sheets[${i}] (${sheet.name}) 至少需要一个 block`);
      continue;
    }
    for (const [j, b] of sheet.blocks.entries()) {
      const at = `sheets[${i}].blocks[${j}]`;
      if (!b.anchor) errs.push(`${at} 缺少 anchor`);
      if (!b.rows?.dim) errs.push(`${at} 缺少 rows.dim`);
      if (!b.cols?.dim) errs.push(`${at} 缺少 cols.dim`);
      if (!b.value || (!b.value.measure && !b.value.expr)) {
        errs.push(`${at} 的 value 需要 measure 或 expr`);
      }
      // 派生表达式校验：避免写出不可推导的派生式（见 §4.6.2）
      if (b.value?.expr && !b.value.measure) {
        // 纯表达式模式，需要 cols 至少覆盖表达式引用的口径
        const refs = extractExprRefs(b.value.expr);
        const known = new Set(b.cols?.order ?? []);
        if (known.size > 0) {
          const unknown = refs.filter((r) => !known.has(r) && r !== b.rows.dim);
          if (unknown.length) {
            errs.push(`${at} 的 expr 引用了未在 cols.order 中定义的口径: ${unknown.join(', ')}`);
          }
        }
      }
    }
  }
  if (errs.length) throw new SpecError('spec 校验失败:\n  - ' + errs.join('\n  - '));
}

/** 从派生表达式里抽取被引用的口径名 */
export function extractExprRefs(expr: string): string[] {
  const out: string[] = [];
  // 匹配中文字符/字母数字下划线组成的标识符
  for (const m of expr.matchAll(/[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/g)) {
    if (!['true', 'false', 'null'].includes(m[0])) out.push(m[0]);
  }
  return [...new Set(out)];
}

/** 把 spec 的 block 展开成需要查询的"格子矩阵" */
export function expandBlock(block: Block, params: Record<string, string | number> = {}) {
  const rows = block.rows.order ?? [];
  const cols = block.cols.order ?? [];
  return {
    rowLabels: rows.map((r) => substitute(String(r), params)),
    colLabels: cols.map((c) => substitute(String(c), params)),
  };
}

/** 简单的 {{var}} 替换 */
export function substitute(s: string, params: Record<string, string | number>): string {
  return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(params[k] ?? `{{${k}}}`));
}
