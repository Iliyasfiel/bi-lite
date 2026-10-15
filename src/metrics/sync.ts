import { execute, queryWriter } from '../db/index.ts';
import { setDimAttributes, writeFirstVersion, today } from '../db/scd2.ts';
import { loadMetrics, validateMetricFacts } from './definitions.ts';
import { normalizeName } from '../ingest/normalize.ts';
import { declaredFactsOf } from '../gen/parse.ts';

const q = (s: string) => "'" + s.replaceAll("'", "''") + "'";

/** 编号沿用 dim_alias 的持久映射，首次接管旧名称时保留已有事实外键。 */
export async function syncMetrics(): Promise<void> {
  const definitions = loadMetrics();
  if (!definitions.length) return;
  const facts = declaredFactsOf();
  validateMetricFacts(definitions, facts);
  await execute('BEGIN');
  try {
    const entities = await queryWriter<{ id: string; name: string; alias: string[] | null }>('SELECT id, name, alias FROM dim_metric');
    const aliases = await queryWriter<{ normalized: string; target_id: string }>("SELECT normalized, target_id FROM dim_alias WHERE kind = 'metric'");
    const owners = new Map<string, Set<string>>();
    const own = (label: string, id: string) => {
      const key = normalizeName(label);
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key)!.add(id);
    };
    entities.forEach((e) => [e.name, ...(e.alias ?? [])].forEach((x) => own(x, e.id)));
    aliases.forEach((a) => own(a.normalized, a.target_id));
    const claimed = new Set<string>();
    for (const def of definitions) {
      const labels = [def.id, def.name, ...def.aliases];
      const matches = new Set(labels.flatMap((x) => [...(owners.get(normalizeName(x)) ?? [])]));
      if (matches.size > 1) throw new Error(`指标 ${def.id}: 名称/别名对应多个已有指标，需先人工归并`);
      const id = [...matches][0] ?? `metric_${def.id}`;
      if (claimed.has(id)) throw new Error(`指标 ${def.id}: 两份定义指向同一个已有指标`);
      claimed.add(id);
      const attrs = { name: def.name, unit: def.unit, category: def.category, direction: def.direction };
      const from = def.effectiveFrom ?? today();
      if (entities.some((e) => e.id === id)) {
        if (def.calculation) {
          for (const fact of facts) {
            const used = await queryWriter<{ n: string }>(`SELECT count(*) AS n FROM ${fact.name} WHERE ${fact.metricColumn} = ${q(id)}`);
            if (Number(used[0].n)) throw new Error(`派生指标 ${def.id} 已有源事实，不能直接改成公式`);
          }
        }
        await setDimAttributes('metric', id, attrs, { effectiveFrom: from });
      } else {
        await execute(`INSERT INTO dim_metric (id, name, unit, category, direction, alias) VALUES (${q(id)}, ${q(def.name)}, ${q(def.unit)}, ${q(def.category)}, ${q(def.direction)}, ARRAY[]::VARCHAR[])`);
        await writeFirstVersion('metric', id, from);
      }
      for (const label of labels) {
        await execute(`INSERT INTO dim_alias (kind, normalized, alias, target_id, note, created_at)
          VALUES ('metric', ${q(normalizeName(label))}, ${q(label)}, ${q(id)}, 'YAML 指标定义', now())
          ON CONFLICT (kind, normalized) DO UPDATE SET alias = EXCLUDED.alias, target_id = EXCLUDED.target_id`);
        own(label, id);
      }
    }
    await execute('COMMIT');
  } catch (e) {
    await execute('ROLLBACK');
    throw e;
  }
}
