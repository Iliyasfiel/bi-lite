import fs from 'node:fs';
import { withPublishedFiles } from '../runtime/publication.ts';
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

const METRIC_KEYS = new Set([
  'id',
  'name',
  'unit',
  'category',
  'direction',
  'aliases',
  'fact',
  'calculation',
  'effectiveFrom',
]);

/** 定义不依赖数据库；缺少目录时兼容未声明指标的旧项目。 */
export function loadMetrics(dir = 'metrics'): MetricDefinition[] {
  return withPublishedFiles(path.dirname(path.resolve(dir)), () => loadMetricsUnchecked(dir));
}
function loadMetricsUnchecked(dir: string): MetricDefinition[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  return parseMetricSources(files.map((file) => ({
    file,
    text: fs.readFileSync(path.join(dir, file), 'utf8'),
  })));
}

/**
 * Parse metric declarations already held in memory.
 *
 * This is the same validator used by loadMetrics(); authoring candidates can
 * therefore include unpublished metrics without first writing workspace files.
 */
export function parseMetricSources(
  sources: Array<{ file: string; text: string }>,
): MetricDefinition[] {
  return parseMetricSourcesWithIssues(sources).definitions;
}

/** Validation path shared with authoring: all declaration problems are returned at once. */
export function diagnoseMetricSources(
  sources: Array<{ file: string; text: string }>,
): { definitions: MetricDefinition[]; issues: Array<{ code: string; at: string; message: string }> } {
  return parseMetricSourcesWithIssues(sources, false);
}

function parseMetricSourcesWithIssues(
  sources: Array<{ file: string; text: string }>,
  fail = true,
): { definitions: MetricDefinition[]; issues: Array<{ code: string; at: string; message: string }> } {
  const definitions: MetricDefinition[] = [];
  const issues: Array<{ code: string; at: string; message: string }> = [];
  const push = (code: string, at: string, error: unknown) => {
    issues.push({ code, at, message: error instanceof Error ? error.message : String(error) });
  };
  for (const { file, text } of sources) {
    let doc: unknown;
    try {
      doc = parse(text);
    } catch (error) {
      push('METRIC_YAML_BAD', file, error);
      continue;
    }
    if (!isRecord(doc) || Object.keys(doc).some((k) => k !== 'metrics')
      || !Array.isArray(doc.metrics)) {
      push('METRIC_DOCUMENT_BAD', file, `${file}: 需要 metrics 列表`);
      continue;
    }
    for (const raw of doc.metrics) {
      if (!isRecord(raw) || Object.keys(raw).some((k) => !METRIC_KEYS.has(k))) {
        push('METRIC_FIELD_BAD', file, `${file}: 指标包含未知字段或不是对象`);
        continue;
      }
      for (const key of ['id', 'name', 'unit', 'category']) {
        if (typeof raw[key] !== 'string' || !raw[key].trim()) {
          push('METRIC_FIELD_BAD', `${file}.${key}`, `${file}: 指标 ${raw.id ?? '(缺少 id)'} 的 ${key} 必须是非空字符串`);
        }
      }
      if (typeof raw.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(raw.id)) {
        push('METRIC_ID_BAD', `${file}.id`, `${file}: 指标 id 只接受小写英文、数字与下划线`);
        continue;
      }
      if (raw.direction !== undefined && !['positive', 'negative'].includes(raw.direction)) {
        push('METRIC_FIELD_BAD', `${file}.${raw.id}.direction`, `${raw.id}: direction 只能是 positive / negative`);
      }
      if (raw.aliases !== undefined && (!Array.isArray(raw.aliases)
        || raw.aliases.some((a: unknown) => typeof a !== 'string' || !normalizeName(a)))) {
        push('METRIC_FIELD_BAD', `${file}.${raw.id}.aliases`, `${raw.id}: aliases 必须是非空名称列表`);
      }
      if (raw.fact !== undefined && (typeof raw.fact !== 'string'
        || !/^[a-z_][a-z0-9_]*$/.test(raw.fact))) {
        push('METRIC_FIELD_BAD', `${file}.${raw.id}.fact`, `${raw.id}: fact 必须是模型表名`);
      }
      if (raw.calculation !== undefined && (typeof raw.calculation !== 'string'
        || !raw.calculation.trim())) {
        push('METRIC_FIELD_BAD', `${file}.${raw.id}.calculation`, `${raw.id}: calculation 必须是表达式`);
      }
      if (raw.effectiveFrom !== undefined && (
        typeof raw.effectiveFrom !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(raw.effectiveFrom)
        || !Number.isFinite(Date.parse(raw.effectiveFrom))
        || new Date(raw.effectiveFrom).toISOString().slice(0, 10) !== raw.effectiveFrom
      )) {
        push('METRIC_FIELD_BAD', `${file}.${raw.id}.effectiveFrom`, `${raw.id}: effectiveFrom 必须是有效 YYYY-MM-DD 日期`);
      }
      definitions.push({
        ...raw,
        direction: raw.direction ?? 'positive',
        aliases: raw.aliases ?? [],
        fact: raw.fact ?? DEFAULT_TARGET,
      });
    }
  }
  const ids = new Map<string, MetricDefinition>();
  const names = new Map<string, string>();
  for (const def of definitions) {
    if (ids.has(def.id)) {
      push('METRIC_ID_DUP', `${def.id}.id`, `指标 id 重复: ${def.id}`);
      continue;
    }
    ids.set(def.id, def);
    for (const label of [def.id, def.name, ...def.aliases]) {
      const key = normalizeName(label);
      if (!key || (names.has(key) && names.get(key) !== def.id)) {
        push('METRIC_LABEL_DUP', def.id, `指标名称/别名冲突: ${label}`);
      } else {
        names.set(key, def.id);
      }
    }
    if (def.calculation) {
      try {
        parseExpr(def.calculation);
      } catch (error) {
        push('METRIC_FORMULA_BAD', `${def.id}.calculation`, error);
      }
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (def: MetricDefinition) => {
    if (visiting.has(def.id)) {
      push('METRIC_FORMULA_CYCLE', `${def.id}.calculation`, `指标公式循环引用: ${def.id}`);
      return;
    }
    if (visited.has(def.id)) return;
    visiting.add(def.id);
    if (def.calculation) {
      let refs: string[];
      try {
        refs = exprRefs(def.calculation);
      } catch {
        visiting.delete(def.id);
        return;
      }
      if (!refs.length) push('METRIC_FORMULA_BAD', `${def.id}.calculation`, `${def.id}: 公式必须引用至少一个指标`);
      for (const ref of refs) {
        const dependency = ids.get(ref);
        if (!dependency) {
          push('METRIC_FORMULA_REF_BAD', `${def.id}.calculation`, `${def.id}: 未知指标引用 ${ref}`);
          continue;
        }
        if (dependency.fact !== def.fact) {
          push('METRIC_FORMULA_REF_BAD', `${def.id}.calculation`, `${def.id}: 不支持跨事实表公式 ${ref}`);
        }
        visit(dependency);
      }
    }
    visiting.delete(def.id); visited.add(def.id);
  };
  definitions.forEach(visit);
  if (fail && issues.length) {
    const error = new Error(issues.map((entry) => entry.message).join('；'));
    Object.assign(error, { issues });
    throw error;
  }
  return { definitions, issues };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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
