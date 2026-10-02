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
  normalizeSqlType,
  type Ir,
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
const KINDS: readonly ModelKind[] = ['dimension', 'fact', 'bridge'];

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

  // ---- 两种写法：分组（keys/measures/provenance）与平铺（columns）。同时给 = 说不清以哪个为准 ----
  const hasSplit = d.keys !== undefined || d.measures !== undefined || d.provenance !== undefined;
  const hasFlat = d.columns !== undefined;
  if (hasSplit && hasFlat) {
    issues.push(
      issue('error', 'MODEL_FIELD_BAD', file, '不能同时写 `columns` 与 `keys`/`measures`/`provenance`（两种等价写法，选一种）'),
    );
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
    issues.push(issue('warn', 'MODEL_GRAIN_IGNORED', `${file}.grain`, '维度表的 grain 会被忽略（它的"一行"就是主键）'));
  }

  if (issues.some((i) => i.level === 'error')) return { table: null, issues };

  const foreignKeys = columns.filter((c) => c.refs).map((c) => ({ column: c.name, refs: c.refs! }));
  return {
    table: { name, kind: kind as ModelKind, title, grain, columns, primaryKey, foreignKeys },
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

  if (issues.length > 0) return { ir: null, issues };
  return { ir: { apiVersion: MODEL_API_VERSION, tables }, issues: [] };
}

/** 确定性路径：读全部声明或抛 */
export function loadModels(dir = MODELS_DIR): Ir {
  const d = diagnoseModels(dir);
  if (!d.ir) {
    throw new ModelError(
      d.issues[0]?.code ?? 'MODEL_BAD',
      `模型声明有问题（${dir}）：\n  - ` +
        d.issues.map((e) => `[${e.code}] ${e.at}：${e.message}${e.hint ? `（${e.hint}）` : ''}`).join('\n  - '),
    );
  }
  return d.ir;
}
