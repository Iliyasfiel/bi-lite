import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { compileExpr, exprRefs, parseExpr } from '../spec/expr.ts';
import { normalizeName } from '../ingest/normalize.ts';
import { DEFAULT_TARGET, type DeclaredFact } from '../gen/ir.ts';

export interface MetricDefinition {
  id: string;
  name: string;
  unit: string;
  category: string;
  direction: 'positive' | 'negative';
  aliases: string[];
  fact: string;
  calculation?: string;
  effectiveFrom?: string;
}

/** 定义不依赖数据库；缺少目录时兼容未声明指标的旧项目。 */
export function loadMetrics(dir = 'metrics'): MetricDefinition[] {
  const definitions: MetricDefinition[] = [];
  if (!fs.existsSync(dir)) return definitions;
  const keys = new Set(['id', 'name', 'unit', 'category', 'direction', 'aliases', 'fact', 'calculation', 'effectiveFrom']);
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const doc = parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!doc || Object.keys(doc).some((k) => k !== 'metrics') || !Array.isArray(doc.metrics)) throw new Error(`${file}: 需要 metrics 列表`);
    for (const raw of doc.metrics) {
      if (!raw || typeof raw !== 'object' || Object.keys(raw).some((k) => !keys.has(k))) throw new Error(`${file}: 指标包含未知字段`);
      for (const key of ['id', 'name', 'unit', 'category']) {
        if (typeof raw[key] !== 'string' || !raw[key].trim()) throw new Error(`${file}: 指标 ${key} 必须是非空字符串`);
      }
      if (!/^[a-z][a-z0-9_]*$/.test(raw.id)) throw new Error(`${file}: 指标 id 只接受小写英文、数字与下划线`);
      if (raw.direction !== undefined && !['positive', 'negative'].includes(raw.direction)) throw new Error(`${raw.id}: direction 只能是 positive / negative`);
      if (raw.aliases !== undefined && (!Array.isArray(raw.aliases) || raw.aliases.some((a: unknown) => typeof a !== 'string' || !normalizeName(a)))) throw new Error(`${raw.id}: aliases 必须是非空名称列表`);
      if (raw.fact !== undefined && (typeof raw.fact !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(raw.fact))) throw new Error(`${raw.id}: fact 必须是模型表名`);
      if (raw.calculation !== undefined && (typeof raw.calculation !== 'string' || !raw.calculation.trim())) throw new Error(`${raw.id}: calculation 必须是表达式`);
      if (raw.effectiveFrom !== undefined && (typeof raw.effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.effectiveFrom) || !Number.isFinite(Date.parse(raw.effectiveFrom)) || new Date(raw.effectiveFrom).toISOString().slice(0, 10) !== raw.effectiveFrom)) throw new Error(`${raw.id}: effectiveFrom 必须是有效 YYYY-MM-DD 日期`);
      definitions.push({ ...raw, direction: raw.direction ?? 'positive', aliases: raw.aliases ?? [], fact: raw.fact ?? DEFAULT_TARGET });
    }
  }
  const ids = new Map<string, MetricDefinition>();
  const names = new Map<string, string>();
  for (const def of definitions) {
    if (ids.has(def.id)) throw new Error(`指标 id 重复: ${def.id}`);
    ids.set(def.id, def);
    for (const label of [def.id, def.name, ...def.aliases]) {
      const key = normalizeName(label);
      if (!key || (names.has(key) && names.get(key) !== def.id)) throw new Error(`指标名称/别名冲突: ${label}`);
      names.set(key, def.id);
    }
    if (def.calculation) parseExpr(def.calculation);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (def: MetricDefinition) => {
    if (visiting.has(def.id)) throw new Error(`指标公式循环引用: ${def.id}`);
    if (visited.has(def.id)) return;
    visiting.add(def.id);
    if (def.calculation) {
      const refs = exprRefs(def.calculation);
      if (!refs.length) throw new Error(`${def.id}: 公式必须引用至少一个指标`);
      for (const ref of refs) {
        const dependency = ids.get(ref);
        if (!dependency) throw new Error(`${def.id}: 未知指标引用 ${ref}`);
        if (dependency.fact !== def.fact) throw new Error(`${def.id}: 不支持跨事实表公式 ${ref}`);
        visit(dependency);
      }
    }
    visiting.delete(def.id); visited.add(def.id);
  };
  definitions.forEach(visit);
  return definitions;
}

export function metricOf(label: string, definitions: MetricDefinition[]): MetricDefinition | undefined {
  const key = normalizeName(label);
  return definitions.find((m) => [m.id, m.name, ...m.aliases].some((x) => normalizeName(x) === key));
}

export function validateMetricFacts(definitions: MetricDefinition[], facts: DeclaredFact[]): void {
  for (const def of definitions) if (!facts.some((f) => f.name === def.fact)) throw new Error(`指标 ${def.id}: 未声明的事实表 ${def.fact}`);
}

const q = (s: string) => "'" + s.replaceAll("'", "''") + "'";

/** 两个查询入口共享聚合后计算；公式永远不按事实行逐行求值再求和。 */
export function metricAggregate(label: string, definitions: MetricDefinition[], opts: {
  fact: string; agg: string; condition: string; value: string; invalidFx?: string;
}): { value: string; support: string; badFx: string } {
  const def = metricOf(label, definitions);
  if (def && def.fact !== opts.fact) throw new Error(`指标 ${def.id} 属于 ${def.fact}，不能在 ${opts.fact} 取数`);
  if (def?.calculation) {
    if (opts.agg !== 'sum') throw new Error(`派生指标 ${def.id} 只接受 sum（先聚合再计算）`);
    const inputs = new Map(exprRefs(def.calculation).map((id) => [id, metricAggregate(id, definitions, opts)]));
    return {
      value: compileExpr(def.calculation, (id) => inputs.get(id)!.value),
      support: `least(${[...inputs.values()].map((v) => v.support).join(', ')})`,
      badFx: '(' + [...inputs.values()].map((v) => v.badFx).join(' + ') + ')',
    };
  }
  const cond = `(dim_metric.name = ${q(def?.name ?? label)} AND (${opts.condition}))`;
  return {
    value: `${opts.agg}(CASE WHEN ${cond} THEN ${opts.value} END)`,
    support: `count(CASE WHEN ${cond} AND ${opts.value} IS NOT NULL THEN 1 END)`,
    badFx: opts.invalidFx ? `count(CASE WHEN ${cond} AND (${opts.invalidFx}) THEN 1 END)` : '0',
  };
}
