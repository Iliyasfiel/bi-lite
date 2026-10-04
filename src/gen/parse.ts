/**
 * `models/*.yml` → IR（P2 的"解析"那一层）。
 *
 * ★ 允许**两种等价写法**，它们必须归一成同一个 IR（e2e 有断言逐字段对比）：
 *
 *   写法 A（分组，"这是张什么表"读起来最顺）：
 *     kind: fact
 *     grain: [fin_month, company_id]
 *     keys:        [ { name: fin_month, type: date, key: true } ]
 *     measures:    [ { name: amount, type: decimal(18,2), unit: 元 } ]
 *     provenance:  [ { name: batch_id, type: varchar } ]
 *
 *   写法 B（平铺，加列时 diff 最干净）：
 *     kind: fact
 *     columns:     [ { name: fin_month, type: date, role: pk, key: true }, ... ]
 *
 *   为什么非要两种：**判据是"换一种 YAML 写法，IR 以下一行都不改"**。只有一种写法时，
 *   这句话既没法被断言、也没法被证明 —— 两种写法解析出同一份 IR，才说明 IR 真的在中间。
 *
 * ★ 角色只有一处推断规则（写法 A 从分组推断），而且**推断结果与显式声明冲突时报错、不猜**。
 * ★ 诊断**一次给全所有问题**（与 `lint_spec` / `lint_ingest` 同一条纪律，铁律 17）：
 *   `diagnoseModels()` 列清单；`loadModels()` 是确定性路径，有问题就抛。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  ModelError,
  declaredFacts,
  normalizeSqlType,
  viaJoinCandidates,
  type DeclaredFact,
  type Ir,
  type IrCaliber,
  type IrColumn,
  type IrTable,
  type MetaRole,
  type ModelKind,
} from './ir.ts';

/** 声明文件放哪 —— **唯一一处**（CLI 的 `--models` 与 e2e 的临时目录都经过它） */
export const MODELS_DIR = 'models';

export const MODEL_API_VERSION = '2026-10-02';

export interface GenIssue {
  level: 'error' | 'warn';
  code: string;
  at: string;
  message: string;
  hint?: string;
}

const ROLES: readonly MetaRole[] = ['pk', 'dim_fk', 'measure', 'degenerate', 'provenance'];
const KINDS: readonly ModelKind[] = ['dimension', 'fact', 'bridge', 'aggregate'];

/** 允许的物理类型（归一化之后比对）。刻意**短**：声明层不该成为"随便写个类型都能过"的地方 */
const TYPE_OK = /^(VARCHAR|VARCHAR\[\]|DATE|INTEGER|BIGINT|BOOLEAN|TIMESTAMP|DECIMAL\(\d+,\d+\))$/;

const NAME_OK = /^[a-z_][a-z0-9_]*$/;

function issue(level: 'error' | 'warn', code: string, at: string, message: string, hint?: string): GenIssue {
  return { level, code, at, message, hint };
}

interface RawColumn {
  name?: unknown;
  type?: unknown;
  role?: unknown;
  key?: unknown;
  notNull?: unknown;
  semantic?: unknown;
  unit?: unknown;
  refs?: unknown;
  default?: unknown;
  comment?: unknown;
}

/** 把一组列的原始项收进一个列表（写法 A 的每个分组各调一次，顺带记下"它属于哪一组"） */
function readList(
  v: unknown,
  what: string,
  file: string,
  issues: GenIssue[],
): RawColumn[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.${what}`, `${what} 必须是列表`));
    return [];
  }
  const out: RawColumn[] = [];
  for (const [i, item] of v.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.${what}[${i}]`, '每一项必须是映射（name / type / …）'));
      continue;
    }
    out.push(item as RawColumn);
  }
  return out;
}

/**
 * 声明内嵌行 → 字符串行。**值一律收成字符串**（标量：string/number/boolean）——
 * 类型是列的事，行只管值；落库时 DuckDB 自己按列类型转换。
 *
 * ★ dimension：id **不收**（名字的纯函数 `nameHash`，手写会在改名时漂移）；name 必填且不重复。
 * ★ bridge：外键收**名字**（sync 时查维表解析成 id，错名整批响亮报错），权重列也必填。
 */
function parseRows(
  kind: 'dimension' | 'bridge',
  columns: IrColumn[],
  rowsRaw: unknown,
  file: string,
  issues: GenIssue[],
): Array<Record<string, string>> | undefined {
  if (!Array.isArray(rowsRaw)) {
    issues.push(issue('error', 'MODEL_ROWS_BAD', `${file}.rows`, 'rows 必须是列表（每行一个映射：列名 → 值）'));
    return undefined;
  }
  if (rowsRaw.length === 0) {
    issues.push(issue('error', 'MODEL_ROWS_BAD', `${file}.rows`, 'rows 是空的 —— 空行集什么都对齐不了（没有行就别写 rows）'));
    return undefined;
  }
  if (kind === 'dimension') {
    const hasId = columns.some((c) => c.name === 'id');
    const hasName = columns.some((c) => c.name === 'name');
    if (!hasId || !hasName) {
      issues.push(
        issue('error', 'MODEL_ROWS_BAD', file, '带 rows 的维度表必须有 id 与 name 列 —— id 由名字派生、对齐按名字做，少一个"这行是谁"就说不清'),
      );
    }
  }
  const colNames = new Set(columns.map((c) => c.name));
  const fkCols = columns.filter((c) => c.role === 'dim_fk' && c.key).map((c) => c.name);
  const measureCols = columns.filter((c) => c.role === 'measure').map((c) => c.name);
  const out: Array<Record<string, string>> = [];
  const seenNames = new Set<string>();
  const seenCombos = new Set<string>();
  for (const [i, r] of rowsRaw.entries()) {
    const at = `${file}.rows[${i}]`;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      issues.push(issue('error', 'MODEL_ROWS_BAD', at, '每一行必须是映射（列名 → 值）'));
      continue;
    }
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (kind === 'dimension' && k === 'id') {
        issues.push(issue('error', 'MODEL_ROWS_BAD', at, 'id 不手写 —— 它是名字的纯函数（ir.ts 的 nameHash），手写的 id 在改名时漂移'));
        continue;
      }
      if (!colNames.has(k)) {
        issues.push(issue('error', 'MODEL_ROWS_BAD', at, `行里有不是这张表列的键：${k}`));
        continue;
      }
      if (v === null || typeof v === 'object') {
        issues.push(issue('error', 'MODEL_ROWS_BAD', at, `${k} 的值必须是标量（收到 ${v === null ? 'null' : '嵌套结构'}）`));
        continue;
      }
      row[k] = String(v);
    }
    if (kind === 'dimension') {
      if (!row.name) {
        issues.push(issue('error', 'MODEL_ROWS_BAD', at, '维度行缺 name —— 名字是这一行唯一的身份，也是 id 的来源'));
      } else if (seenNames.has(row.name)) {
        issues.push(issue('error', 'MODEL_ROWS_DUP', at, `名字重复：${row.name}（id 由名字派生，名字撞 = id 撞）`));
      } else {
        seenNames.add(row.name);
      }
      for (const c of columns) {
        if (c.name === 'id') continue;
        if (c.notNull && row[c.name] === undefined) {
          issues.push(issue('error', 'MODEL_ROWS_BAD', at, `缺 ${c.name}（声明了 notNull 的列每行都要给值）`));
        }
      }
    } else {
      for (const k of [...fkCols, ...measureCols]) {
        if (row[k] === undefined) issues.push(issue('error', 'MODEL_ROWS_BAD', at, `桥接行缺 ${k} —— 外键写名字、权重写数值，缺一个这条边就悬空`));
      }
      const combo = fkCols.map((k) => row[k]).join('→');
      if (seenCombos.has(combo)) issues.push(issue('error', 'MODEL_ROWS_DUP', at, `重复的桥接边：${combo}`));
      else seenCombos.add(combo);
    }
    out.push(row);
  }
  return out;
}

/**
 * 解析一份声明。**只解析，不跨表校验**（refs 指向的表存不存在，要等所有文件都读进来才知道）。
 * 一次给全本文件里的所有问题；有 error 时 `table` 为 null。
 */
export function diagnoseModel(text: string, file: string): { table: IrTable | null; issues: GenIssue[] } {
  const issues: GenIssue[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return { table: null, issues: [issue('error', 'MODEL_YAML_BAD', file, `YAML 语法错：${(e as Error).message}`)] };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { table: null, issues: [issue('error', 'MODEL_FIELD_BAD', file, '声明必须是一个 YAML 映射（顶层是键值对）')] };
  }
  const d = doc as Record<string, unknown>;

  // 文件名（去掉 .yml）就是表名 —— 一个文件一张表，省掉一处"名字写两遍"的漂移源
  const name = path.basename(file).replace(/\.ya?ml$/i, '');
  if (!NAME_OK.test(name)) {
    issues.push(issue('error', 'MODEL_NAME_BAD', file, `表名不合法：${name}（只认 [a-z_][a-z0-9_]*）`));
  }

  const kind = String(d.kind ?? '');
  if (!KINDS.includes(kind as ModelKind)) {
    issues.push(issue('error', 'MODEL_KIND_BAD', `${file}.kind`, `kind 只能是 ${KINDS.join(' / ')}（收到 ${kind || '空'}）`));
  }

  const title = typeof d.title === 'string' && d.title.trim() ? d.title.trim() : '';
  if (!title) issues.push(issue('warn', 'MODEL_TITLE_MISSING', `${file}.title`, '没写 title —— catalog 里这张表对人就没有描述'));

  // ---- 聚合表：第三种声明形状（source + grain + measures），列**不是人写的** ----
  //      单文件阶段只校验形状；列要等跨表阶段从 source 投影（这里看不见别的表）。
  //      所以 measures 先记成"原型列"（type 为空），投影时再从 source 抄类型。
  if (kind === 'aggregate') {
    for (const stray of ['columns', 'keys', 'provenance', 'rows'] as const) {
      if (d[stray] !== undefined) {
        issues.push(
          issue('error', 'MODEL_FIELD_BAD', `${file}.${stray}`, `聚合表不写 ${stray} —— 它的列由 source 投影（留哪些维度写 grain，聚合什么写 measures）${stray === 'rows' ? '；行更不是人写的（数据从事实派生）' : ''}`),
        );
      }
    }
    const source = typeof d.source === 'string' ? d.source.trim() : '';
    if (!source) issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.source`, '聚合表必须声明 source（从哪张事实表聚合）'));
    else if (!NAME_OK.test(source)) issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.source`, `source 表名不合法：${source}`));

    // via：JOIN 穿过哪张桥接表做加权摊分（可选；join 键跨表推导，见 diagnoseModels）
    const via = typeof d.via === 'string' ? d.via.trim() : '';
    if (d.via !== undefined && !via) issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.via`, 'via 要写表名（JOIN 穿过哪张桥接表）'));
    else if (via && !NAME_OK.test(via)) issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.via`, `via 表名不合法：${via}`));

    const grain = Array.isArray(d.grain) ? d.grain.map((g) => String(g)) : [];
    if (grain.length === 0) {
      issues.push(issue('error', 'MODEL_AGG_GRAIN_BAD', `${file}.grain`, '聚合表必须声明 grain（聚合键：留下的维度，没留下的都被加总）'));
    } else if (!grain.every((g) => NAME_OK.test(g))) {
      issues.push(issue('error', 'MODEL_AGG_GRAIN_BAD', `${file}.grain`, `grain 里有不合法的列名：${grain.filter((g) => !NAME_OK.test(g)).join('、')}`));
    } else if (new Set(grain).size !== grain.length) {
      issues.push(issue('error', 'MODEL_AGG_GRAIN_BAD', `${file}.grain`, `grain 里有重复列：${grain.join(',')}`));
    }

    const measures: IrColumn[] = [];
    for (const c of readList(d.measures, 'measures', file, issues)) {
      const n = typeof c.name === 'string' ? c.name.trim() : '';
      if (!n) continue;
      if (!NAME_OK.test(n)) issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.measures.${n}`, `度量名不合法：${n}`));
      if (grain.includes(n)) {
        issues.push(issue('error', 'MODEL_AGG_GRAIN_BAD', `${file}.measures.${n}`, `${n} 同时在 grain 与 measures 里 —— 聚合键和被加总的量不能是同一列`));
      }
      const agg = c.agg === undefined ? 'sum' : String(c.agg);
      if (agg !== 'sum') {
        issues.push(
          issue('error', 'MODEL_AGG_FUNC_BAD', `${file}.measures.${n}`, `聚合函数只认 sum（收到 ${agg}）`, 'v1 只加总：均值/最值都有口径问题（分母是谁？），要扩先过铁律 8'),
        );
      }
      measures.push({ name: n, type: '', role: 'measure', key: false, notNull: false, agg });
    }
    if (!Array.isArray(d.measures) || measures.length === 0) {
      issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.measures`, '聚合表必须声明 measures（至少一个要聚合的度量）'));
    }

    if (issues.some((i) => i.level === 'error')) return { table: null, issues };
    return {
      table: { name, kind: 'aggregate', title, grain, columns: measures, primaryKey: [], foreignKeys: [], source, via: via || undefined },
      issues,
    };
  }


  // ---- 两种写法：分组（keys/measures/provenance）与平铺（columns）。同时给 = 说不清以哪个为准 ----
  const hasSplit = d.keys !== undefined || d.measures !== undefined || d.provenance !== undefined;
  const hasFlat = d.columns !== undefined;
  if (hasSplit && hasFlat) {
    issues.push(
      issue('error', 'MODEL_FIELD_BAD', file, '不能同时写 `columns` 与 `keys`/`measures`/`provenance`（两种等价写法，选一种）'),
    );
  }
  // via 是聚合表的专属字段（穿桥加权摊分）；写在别的表上是笔误，不是"以后可能用到"
  if (d.via !== undefined) {
    issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.via`, `via 只写在聚合表上（${kind || '这个 kind'} 用不着穿桥摊分）`));
  }

  let raw: RawColumn[] = [];
  if (hasFlat) {
    raw = readList(d.columns, 'columns', file, issues);
  } else if (hasSplit) {
    // ★ 角色**在这一处**从分组推断出来，之后所有代码只看 `role`（不再看"它在哪个分组里"）。
    //   ⚠️ 只有 measures / provenance 两个分组**唯一确定**角色；`keys` 里可以是 pk / dim_fk /
    //      degenerate 三种，所以它的规则是"显式优先、没写才按 key 推"。写死成 degenerate
    //      会把 `{ role: dim_fk, refs: … }` 误报成自相矛盾（第一版就是这么错的，e2e 之前的
    //      手工试跑当场抓出来了）。
    const groups: Array<{ list: unknown; group: string; role: (c: RawColumn) => MetaRole; forced: boolean }> = [
      [d.keys, 'keys', (c) => (c.key === true ? 'pk' : 'degenerate'), false],
      [d.measures, 'measures', () => 'measure', true],
      [d.provenance, 'provenance', () => 'provenance', true],
    ].map(([list, group, role, forced]) => ({
      list,
      group: group as string,
      role: role as (c: RawColumn) => MetaRole,
      forced: forced as boolean,
    }));
    const fromGroup = new Map<string, { role: MetaRole; group: string }>();
    for (const g of groups) {
      for (const c of readList(g.list, g.group, file, issues)) {
        const n = typeof c.name === 'string' ? c.name.trim() : '';
        if (!n) continue;
        const prev = fromGroup.get(n);
        if (prev) {
          issues.push(issue('error', 'MODEL_COLUMN_DUP', file, `${n} 同时出现在 ${prev.group} 与 ${g.group}（一列只能属于一组）`));
          continue;
        }
        const explicit = c.role === undefined ? undefined : (String(c.role) as MetaRole);
        const inferred = g.role(c);
        // 分组**强制**角色（measures / provenance）时，显式写了别的就是自相矛盾 —— 不猜
        if (g.forced && explicit !== undefined && explicit !== inferred) {
          issues.push(
            issue('error', 'MODEL_ROLE_BAD', `${file}.${g.group}.${n}`, `${n} 的角色自相矛盾：分组说 ${inferred}、列上写 ${explicit}`, '要么删掉显式的 role，要么把它改对 —— 这一处不猜'),
          );
          continue;
        }
        const role = explicit ?? inferred;
        fromGroup.set(n, { role, group: g.group });
        c.role = role; // 归一回去，下面只按 role 走
        raw.push(c);
      }
    }
  }

  // ---- 逐列归一 ----
  const columns: IrColumn[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const cn = typeof c.name === 'string' ? c.name.trim() : '';
    const at = `${file}${cn ? '.' + cn : ''}`;
    if (!cn) {
      issues.push(issue('error', 'MODEL_FIELD_BAD', at, '缺列名（name）'));
      continue;
    }
    if (!NAME_OK.test(cn)) issues.push(issue('error', 'MODEL_FIELD_BAD', at, `列名不合法：${cn}`));
    if (seen.has(cn)) {
      issues.push(issue('error', 'MODEL_COLUMN_DUP', at, `列名重复：${cn}`));
      continue;
    }
    seen.add(cn);

    const type = normalizeSqlType(String(c.type ?? ''));
    if (!type) issues.push(issue('error', 'MODEL_TYPE_BAD', at, `${cn} 没写 type`));
    else if (!TYPE_OK.test(type)) {
      issues.push(
        issue('error', 'MODEL_TYPE_BAD', at, `${cn} 的 type 不在允许清单里：${String(c.type)}`, '允许：varchar / varchar[] / date / integer / bigint / boolean / timestamp / decimal(p,s)'),
      );
    }

    const role = (c.role === undefined ? undefined : String(c.role)) as MetaRole | undefined;
    if (role !== undefined && !ROLES.includes(role)) {
      issues.push(issue('error', 'MODEL_ROLE_BAD', at, `${cn} 的 role 只能是 ${ROLES.join(' / ')}（收到 ${String(c.role)}）`));
    }
    if (c.key !== undefined && typeof c.key !== 'boolean') {
      issues.push(issue('error', 'MODEL_FIELD_BAD', at, `${cn} 的 key 只能是 true/false`));
    }
    if (c.refs !== undefined && typeof c.refs !== 'string') {
      issues.push(issue('error', 'MODEL_FIELD_BAD', at, `${cn} 的 refs 必须是表名字符串`));
    }

    const key = c.key === true;
    const finalRole = role ?? 'degenerate';
    // ★ `key`（**物理**主键成员）与 `role`（**语义**角色）是两件事：
    //   fact_finance.company_id 既在主键里、又是 dim_fk —— 这正是星型模型的样子。
    //   所以只判两个方向里**确定错**的那一个：写了 role: pk 却不进主键。
    if (!key && finalRole === 'pk') {
      issues.push(issue('error', 'MODEL_ROLE_BAD', at, `${cn} 写了 role: pk 却没进主键（用 key: true 声明主键成员）`));
    }
    if (key && finalRole === 'measure') issues.push(issue('error', 'MODEL_ROLE_BAD', at, '度量列不能进主键'));

    columns.push({
      name: cn,
      type: type || 'VARCHAR',
      role: finalRole,
      key,
      notNull: c.notNull === true,
      semantic: typeof c.semantic === 'string' ? c.semantic : undefined,
      unit: typeof c.unit === 'string' ? c.unit : undefined,
      refs: typeof c.refs === 'string' ? c.refs : undefined,
      default: typeof c.default === 'string' ? c.default : undefined,
      comment: typeof c.comment === 'string' ? c.comment : undefined,
    });
  }
  if (columns.length === 0) {
    issues.push(issue('error', 'MODEL_FIELD_BAD', file, '这张表一个列都没有 —— 至少要有主键列'));
  }

  const primaryKey = columns.filter((c) => c.key).map((c) => c.name);
  if (primaryKey.length === 0 && columns.length > 0) {
    issues.push(issue('error', 'MODEL_PK_MISSING', file, '没有任何列标了 key: true —— 每张表都要有主键（幂等靠它）'));
  }

  // grain：事实表必须写，且必须与主键一致（"一行代表什么"与"幂等靠什么"是同一件事）
  const grain = Array.isArray(d.grain) ? d.grain.map((g) => String(g)) : [];
  if (kind === 'fact') {
    if (grain.length === 0) {
      issues.push(issue('error', 'MODEL_GRAIN_BAD', `${file}.grain`, '事实表必须声明 grain（一行代表什么）'));
    } else if (!grain.every((g) => seen.has(g))) {
      issues.push(issue('error', 'MODEL_GRAIN_BAD', `${file}.grain`, `grain 里有不是这张表列的项：${grain.filter((g) => !seen.has(g)).join('、')}`));
    } else if (primaryKey.length > 0 && [...grain].sort().join(',') !== [...primaryKey].sort().join(',')) {
      issues.push(
        issue('error', 'MODEL_GRAIN_BAD', `${file}.grain`, `grain（${grain.join(',')}）必须与主键（${primaryKey.join(',')}）一致`, '事实表的"一行"就是主键说的那个交点；不一致时幂等与对拍都会错'),
      );
    }
  } else if (grain.length > 0) {
    issues.push(issue('warn', 'MODEL_GRAIN_IGNORED', `${file}.grain`, '维度 / 桥接表的 grain 会被忽略（它的"一行"就是主键）'));
  }

  // ---- 桥接表的形状只有一种：恰好两个外键进主键 + ≤1 个权重列，没有第三种列 ----
  //      "A 到 B 的多对多边"：少一端不叫桥，两端之外的东西（溯源/退化列）属于别的表。
  if (kind === 'bridge') {
    const fkKey = columns.filter((c) => c.role === 'dim_fk' && c.key);
    const weights = columns.filter((c) => c.role === 'measure');
    const rest = columns.filter((c) => !(c.role === 'dim_fk' && c.key) && c.role !== 'measure');
    if (fkKey.length !== 2) {
      issues.push(issue('error', 'MODEL_BRIDGE_SHAPE_BAD', file, `桥接表 = 恰好两个外键进主键（现在 ${fkKey.length} 个）—— 多对多的边，少一端就不叫桥`));
    }
    if (weights.length > 1) {
      issues.push(issue('error', 'MODEL_BRIDGE_SHAPE_BAD', file, `桥接表最多一个权重列（现在 ${weights.length} 个）—— 一张桥只摊一件事；要摊两件事就建两张桥`));
    }
    if (rest.length > 0) {
      issues.push(issue('error', 'MODEL_BRIDGE_SHAPE_BAD', file, `桥接表只有外键与权重列，这些列不属于这里：${rest.map((c) => c.name).join('、')}`));
    }
  }

  // ---- 声明内嵌行（rows）：写路径唯一 = bilite rebuild 全量对齐，审计走 git diff ----
  //      事实表带 rows 是结构错（它的写路径是接入，两条写路径会互相覆盖），不是行写错了的小错。
  let rows: Array<Record<string, string>> | undefined;
  if (d.rows !== undefined) {
    if (kind === 'fact') {
      issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.rows`, '事实表由接入装载 —— 行来自 Excel，不来自声明。给它写行就是开第二条写路径'));
    } else {
      rows = parseRows(kind === 'dimension' ? 'dimension' : 'bridge', columns, d.rows, file, issues);
    }
  }

  // ---- 口径声明（calibers / windowFrom，铁律 5"五值拆三件"）：只有 fact 能带 ----
  //      窗口是声明不是行上字符串：from/since/shift 决定装载怎么落窗、查询怎么展开谓词；
  //      calculator 口径不落行（语义层算）。判据只有这一处，别处不许再写窗口规则。
  let windowFrom: string | undefined;
  let calibers: IrCaliber[] | undefined;
  if (d.windowFrom !== undefined || d.calibers !== undefined) {
    if (kind !== 'fact') {
      issues.push(issue('error', 'MODEL_FIELD_BAD', file, `${kind} 表不声明口径（calibers/windowFrom 是事实表的口径体系）`));
    } else {
      const wf = typeof d.windowFrom === 'string' ? d.windowFrom.trim() : '';
      if (!wf) {
        issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.windowFrom`, '声明了口径就必须写 windowFrom（窗口起点列）—— 非 calculator 的窗口口径都要落到这一列'));
      } else if (!seen.has(wf)) {
        issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.windowFrom`, `windowFrom 指向的列不存在：${wf}`));
      } else {
        windowFrom = wf;
      }
      const rawCalibers = Array.isArray(d.calibers) ? (d.calibers as Array<Record<string, unknown>>) : [];
      if (rawCalibers.length === 0) {
        issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.calibers`, 'calibers 必须是非空列表（每条口径一条声明）'));
      }
      const names = new Set<string>();
      const parsed: IrCaliber[] = [];
      const operandOwners = new Map<string, string>(); // operand 名 → calculator 口径名（循环后验指向）
      for (const rc0 of rawCalibers) {
        const rc = (rc0 ?? {}) as Record<string, unknown>;
        const name = typeof rc.name === 'string' ? rc.name.trim() : '';
        const at = `${file}.calibers${name ? '.' + name : ''}`;
        if (!name) {
          issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.calibers`, '口径缺 name'));
          continue;
        }
        if (names.has(name)) issues.push(issue('error', 'MODEL_FIELD_BAD', at, `口径名重复：${name}`));
        names.add(name);
        const calculator = rc.calculator === true;
        const from = typeof rc.from === 'string' ? rc.from.trim() : undefined;
        const since = typeof rc.since === 'string' ? rc.since.trim() : undefined;
        const shift = typeof rc.shift === 'number' && Number.isInteger(rc.shift) ? rc.shift : undefined;
        const operand = typeof rc.operand === 'string' ? rc.operand.trim() : undefined;
        if (calculator) {
          if (from !== undefined || since !== undefined || shift !== undefined) {
            issues.push(issue('error', 'MODEL_FIELD_BAD', at, `calculator 口径不落行，不能带 from/since/shift：${name}`));
          }
          // calculator 必须声明操作数（单月同比 = 单月）—— 不声明，改写器就无从取数，拒绝猜
          if (!operand) {
            issues.push(issue('error', 'MODEL_FIELD_BAD', at, `calculator 口径必须写 operand（操作数口径名）：${name}`));
          } else {
            operandOwners.set(operand, name);
          }
          parsed.push(operand ? { name, calculator: true, operand } : { name, calculator: true });
          continue;
        }
        if (operand !== undefined) {
          issues.push(issue('error', 'MODEL_FIELD_BAD', at, `${name} 不是 calculator 口径，写了 operand 也无处安放（只有语义层口径有操作数）`));
          continue;
        }
        if (from !== 'same' && from !== 'year_start' && from !== 'since') {
          issues.push(issue('error', 'MODEL_FIELD_BAD', at, `${name} 的 from 只能是 same / year_start / since（calculator: true 才是语义层口径）`));
          continue;
        }
        if (from === 'since' && (since === undefined || !/^\d{4}-\d{2}$/.test(since))) {
          issues.push(issue('error', 'MODEL_FIELD_BAD', at, `${name} 是 since 口径，必须写 since: "YYYY-MM"`));
          continue;
        }
        if (from !== 'since' && since !== undefined) {
          issues.push(issue('error', 'MODEL_FIELD_BAD', at, `${name} 不是 since 口径，写了 since 也无处安放`));
          continue;
        }
        if (shift !== undefined && from !== 'year_start') {
          issues.push(issue('error', 'MODEL_FIELD_BAD', at, `${name} 的 shift 只能配 from: year_start（窗口平移以年首为基准）`));
          continue;
        }
        parsed.push({ name, from, since, shift });
      }
      if (parsed.length > 0 && windowFrom === undefined && parsed.some((c) => !c.calculator)) {
        issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.windowFrom`, '有窗口口径（非 calculator）就必须写 windowFrom —— 窗口要落到一列上'));
      }
      // operand 必须指向同表声明的另一个口径（操作数是它自己的数据来源，跨表 = 隐式耦合）
      for (const [op, owner] of operandOwners) {
        if (!names.has(op)) {
          issues.push(issue('error', 'MODEL_FIELD_BAD', `${file}.calibers.${owner}`, `operand 指向的口径「${op}」不在本表 calibers 声明里 —— calculator 只能算本表口径`));
        }
      }
      calibers = parsed;
    }
  }

  if (issues.some((i) => i.level === 'error')) return { table: null, issues };

  const foreignKeys = columns.filter((c) => c.refs).map((c) => ({ column: c.name, refs: c.refs! }));
  return {
    table: { name, kind: kind as ModelKind, title, grain, columns, primaryKey, foreignKeys, rows, windowFrom, calibers },
    issues,
  };
}

/** 确定性路径：有问题就抛（把所有 error 汇总成一段话，一次给全） */
export function parseModel(text: string, file: string): IrTable {
  const d = diagnoseModel(text, file);
  if (!d.table) {
    const errs = d.issues.filter((i) => i.level === 'error');
    throw new ModelError(
      errs[0]?.code ?? 'MODEL_BAD',
      `${file} 有问题：\n  - ` + errs.map((e) => `[${e.code}] ${e.at}：${e.message}${e.hint ? `（${e.hint}）` : ''}`).join('\n  - '),
    );
  }
  return d.table;
}

/** 列出声明文件（排序后读，保证 IR 与指纹稳定） */
export function listModelFiles(dir = MODELS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * 读一个目录里的全部声明，做**跨表**校验，返回 IR。
 * 一次给全所有问题（本文件的 + 跨表的），有问题就抛 —— 这份 IR 是 plan / apply 的唯一输入。
 */
export function diagnoseModels(dir = MODELS_DIR): { ir: Ir | null; issues: GenIssue[] } {
  const files = listModelFiles(dir);
  const issues: GenIssue[] = [];
  if (files.length === 0) {
    return { ir: null, issues: [issue('error', 'MODEL_DIR_EMPTY', dir, `没有找到任何声明文件（${dir}/*.yml）`)] };
  }
  const tables: IrTable[] = [];
  for (const f of files) {
    const d = diagnoseModel(fs.readFileSync(f, 'utf8'), f);
    issues.push(...d.issues.filter((i) => i.level === 'error'));
    if (d.table) tables.push(d.table);
  }
  // 跨表：refs 必须指向**本目录里声明过**的表。引用运营侧的手写表一律视为写错 ——
  // 那等于让依赖图缺一块（谁引用了谁，plan 的建表顺序就靠这个）。
  const names = new Set(tables.map((t) => t.name));
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.refs && !names.has(c.refs)) {
        issues.push(
          issue('error', 'MODEL_REFS_BAD', `${t.name}.${c.name}`, `${t.name}.${c.name} 引用了没声明的表 ${c.refs}`, '被引用的表也要在 models/ 里声明（引用不受声明管理的表 = 让依赖图缺一块）'),
        );
      }
    }
  }
  const dup = tables.map((t) => t.name).filter((n, i, a) => a.indexOf(n) !== i);
  for (const n of new Set(dup)) issues.push(issue('error', 'MODEL_TABLE_DUP', n, `表名重复声明：${n}`));

  // ---- 桥接表：外键只许指维度表，而且那张维度表要有 name 列 ----
  //      桥接行里的外键写的是**名字**，sync 靠查维表的 name 列把它解析成 id；
  //      指到非维度表、或维度表没有 name 列，解析就没有落点。
  for (const t of tables) {
    if (t.kind !== 'bridge') continue;
    for (const fk of t.foreignKeys) {
      const target = tables.find((x) => x.name === fk.refs);
      if (!target) continue; // 指了没声明的表，上面 MODEL_REFS_BAD 已经报过
      if (target.kind !== 'dimension') {
        issues.push(issue('error', 'MODEL_BRIDGE_REF_BAD', `${t.name}.${fk.column}`, `桥接外键只能指向维度表（${fk.refs} 是 ${target.kind}）`));
      } else if (!target.columns.some((c) => c.name === 'name' && c.type === 'VARCHAR')) {
        issues.push(issue('error', 'MODEL_BRIDGE_REF_BAD', `${t.name}.${fk.column}`, `${fk.refs} 没有 name 列 —— 桥接行写的是名字，解析时没东西可查`));
      }
    }
  }

  // ---- 单一写路径守卫：带 rows 的维度表，不许再被事实表引用 ----
  //      事实表引用它 = 接入的主数据归并会往这张维表**建行**；而 rows 又让 rebuild 全量对齐
  //      （DELETE + INSERT）。两条写路径互相删对方的东西，谁最后跑谁说了算 —— 这种表没有"对的时刻"。
  //      （桥接表引用它没问题：桥接行解析只**读**维表，不写。）
  const dimsWithRows = new Set(tables.filter((t) => t.kind === 'dimension' && t.rows).map((t) => t.name));
  for (const t of tables) {
    if (t.kind !== 'fact') continue;
    for (const c of t.columns) {
      if (c.role === 'dim_fk' && c.refs && dimsWithRows.has(c.refs)) {
        issues.push(
          issue('error', 'MODEL_ROWS_OWNER_BAD', `${t.name}.${c.name}`, `${c.refs} 带声明行（写路径 = bilite rebuild 全量对齐），但 ${t.name}.${c.name} 又引用它 —— 接入归并与声明对齐是两条写路径，会互相覆盖`, '行归声明，表就归 sync 一个写路径：事实表去引用不带 rows 的维度表'),
        );
      }
    }
  }

  // ---- 聚合表：跨表校验 + 列投影（单文件阶段只有形状，这里才看得见 source） ----
  //   投影规则：grain 列从 source **原样抄**（类型/角色/语义/refs），并且 key: true（聚合键就是主键）；
  //   measures 从 source 的度量列抄类型，聚合函数来自本声明。列序 = grain 在前、measures 在后。
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i]!;
    if (t.kind !== 'aggregate') continue;
    const src = tables.find((s) => s.name === t.source);
    if (!src || src.kind !== 'fact') {
      issues.push(
        issue('error', 'MODEL_SOURCE_BAD', `${t.name}.source`, `聚合的 source 必须是本目录声明过的事实表（${t.source} ${!src ? '没声明过' : `是 ${src.kind}，不是 fact`}）`, '聚合的数据从事实表派生：维度 / 桥接 / 别的聚合表都不许当源头'),
      );
      continue;
    }
    const srcCol = (n: string) => src.columns.find((c) => c.name === n);
    // ---- via：JOIN 穿过桥接表加权摊分（第二种聚合形态） ----
    //   join 键不写：source 与桥接表各自的外键里引用**同一张维表**的那一对，恰好一对才合法。
    const viaTable = t.via ? tables.find((x) => x.name === t.via) : undefined;
    const viaCol = (n: string) => viaTable?.columns.find((c) => c.name === n);
    if (t.via) {
      if (!viaTable || viaTable.kind !== 'bridge') {
        issues.push(
          issue('error', 'MODEL_AGG_VIA_BAD', `${t.name}.via`, `via 必须是本目录声明过的桥接表（${t.via} ${!viaTable ? '没声明过' : `是 ${viaTable.kind}，不是 bridge`}）`, '加权摊分穿的是桥接表：两张维表之间的多对多边'),
        );
      } else {
        const joins = viaJoinCandidates(t, { apiVersion: '', tables });
        if (joins.length === 0) {
          issues.push(issue('error', 'MODEL_AGG_VIA_BAD', `${t.name}.via`, `${src.name} 与 ${viaTable.name} 的外键没有引用同一张维表 —— 找不到 join 键`));
        } else if (joins.length > 1) {
          issues.push(
            issue('error', 'MODEL_AGG_VIA_BAD', `${t.name}.via`, `join 键不唯一（${joins.map((j) => `${j.sourceCol} = ${j.viaCol}`).join('、')}）—— 共用的维表必须恰好一个，否则不知道按谁摊`),
          );
        }
        const weights = viaTable.columns.filter((c) => c.role === 'measure');
        if (weights.length !== 1) {
          issues.push(issue('error', 'MODEL_AGG_VIA_BAD', `${t.name}.via`, `via 桥接表必须恰好一个权重列（${viaTable.name} 有 ${weights.length} 个）—— 加权摊分乘的就是它`));
        }
        if (!t.grain.some((g) => !srcCol(g) && viaCol(g))) {
          issues.push(issue('error', 'MODEL_AGG_VIA_BAD', `${t.name}.grain`, 'grain 里没有来自 via 的维度 —— 穿了桥却不在桥那头留坐标，摊出去的钱没有去处（不要 via，直接聚）'));
        }
      }
    }
    for (const g of t.grain) {
      const sc = srcCol(g);
      const vc = viaCol(g);
      if (!sc && !vc) issues.push(issue('error', 'MODEL_AGG_GRAIN_BAD', `${t.name}.grain`, `grain 里的 ${g} 不是 ${src.name}${t.via ? ` 或 ${t.via}` : ''} 的列`));
      if (sc && (sc.role === 'measure' || sc.role === 'provenance')) {
        issues.push(issue('error', 'MODEL_AGG_GRAIN_BAD', `${t.name}.grain`, `grain 里的 ${g} 在 ${src.name} 是${sc.role === 'measure' ? '度量' : '溯源'}列 —— 聚合键只能是维度坐标`));
      }
      if (vc && vc.role !== 'dim_fk') {
        issues.push(issue('error', 'MODEL_AGG_GRAIN_BAD', `${t.name}.grain`, `grain 里的 ${g} 在 ${viaTable!.name} 是 ${vc.role} 列 —— 桥接表上能当聚合键的只有两端外键`));
      }
    }
    // ★ 铁律 8 前移到解析期：口径（period_type）与期数（period）**不许被聚合掉**。
    //   聚合掉口径 = 把"本年累计"与"单月"加在一起 —— 这是错得最安静的那一种：
    //   数字看起来照样是对的量级，只是谁都不知道它已经不对了。
    const dropped = src.columns.filter(
      (c) => !t.grain.includes(c.name) && (c.semantic === 'period' || c.semantic === 'period_type'),
    );
    for (const c of dropped) {
      issues.push(
        issue('error', 'MODEL_AGG_NONADDABLE', `${t.name}.grain`, `${c.name} 被聚合掉了 —— 口径与期数不是可加维度（把${c.semantic === 'period' ? '不同月份' : '本年累计与单月'}加在一起是无声错）`, `把 ${c.name} 加进 grain；要换时间窗是查询侧的事，不是建表侧的事`),
      );
    }
    // noop 提醒：grain 与 source 主键一致 → 一行都没被加总，这是复制不是聚合
    if (
      t.grain.length === src.grain.length &&
      [...t.grain].sort().join(',') === [...src.grain].sort().join(',')
    ) {
      issues.push(
        issue('warn', 'MODEL_AGG_NOOP', `${t.name}.grain`, `grain 与 ${src.name} 的粒度一致 —— 一行都没被加总（这不是聚合，是复制）`, '要么去掉一个维度（它会被 SUM 掉），要么别建这张表'),
      );
    }
    for (const m of t.columns) {
      const sc = srcCol(m.name);
      if (!sc) issues.push(issue('error', 'MODEL_AGG_MEASURE_BAD', `${t.name}.measures.${m.name}`, `${m.name} 不是 ${src.name} 的列`));
      else if (sc.role !== 'measure') {
        issues.push(issue('error', 'MODEL_AGG_MEASURE_BAD', `${t.name}.measures.${m.name}`, `${m.name} 在 ${src.name} 是${sc.role}列，不是度量列`));
      }
    }
    if (issues.some((i) => i.level === 'error' && i.at.startsWith(`${t.name}.`))) continue;

    // 投影：grain 列原样抄（source 里没有的，从 via 桥接表抄 —— 摊分坐标也在主键里，key: true），度量列抄类型、带聚合函数
    const columns: IrColumn[] = t.grain.map((g) => {
      const base = srcCol(g) ?? viaCol(g)!;
      return { ...base, key: true, agg: undefined };
    });
    for (const m of t.columns) {
      const sc = srcCol(m.name)!;
      columns.push({ ...sc, key: false, agg: m.agg });
    }
    const primaryKey = [...t.grain];
    tables[i] = {
      ...t,
      columns,
      primaryKey,
      foreignKeys: columns.filter((c) => c.refs).map((c) => ({ column: c.name, refs: c.refs! })),
    };
  }

  if (issues.length > 0) return { ir: null, issues };
  return { ir: { apiVersion: MODEL_API_VERSION, tables }, issues: [] };
}

/** 确定性路径：读全部声明或抛 */
export function loadModels(dir = MODELS_DIR): Ir {  const d = diagnoseModels(dir);
  if (!d.ir) {
    throw new ModelError(
      d.issues[0]?.code ?? 'MODEL_BAD',
      `模型声明有问题（${dir}）：\n  - ` +
        d.issues.map((e) => `[${e.code}] ${e.at}：${e.message}${e.hint ? `（${e.hint}）` : ''}`).join('\n  - '),
    );
  }
  return d.ir;
}

/**
 * 声明里的事实表投影（**不碰库**）—— 静态诊断与落库两条路都从这里取，判据只有一份。
 *
 * ★ 为什么留在 `gen/` 而不是 `ingest/master.ts`：`master.ts` 会（经由 `semantic/query.ts`）
 *   拉进 DuckDB，而 `ingest lint` 是**零 DB 访问**的命令 —— 它要么读不到声明，
 *   要么被迫加载整个库。让这条投影待在只依赖 fs/yaml 的这一层，两条路都干净。
 */
export function declaredFactsOf(dir = MODELS_DIR): DeclaredFact[] {
  return declaredFacts(loadModels(dir));
}
