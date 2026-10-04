/**
 * 声明内嵌行（`rows:`）的落库 —— kind: dimension / bridge 的写路径（P3 第二刀）。
 *
 * ★ 写路径只有一条：**全量对齐**（DELETE + INSERT，同一事务）。没有 UPSERT、没有 diff：
 *   声明行是"声明的另一面"，改一行 = 改声明 = 一次可 review 的 git 提交；
 *   库里的行不是数据，是声明的**投影**（与聚合表同一哲学：删了能回来）。
 *
 * ★ 顺序是语义：**维度在前、桥接在后** —— 桥接行的外键写的是**名字**，sync 时查维表
 *   把名字解析成 id；维表行必须先就位（同一事务里，后面的 SELECT 读得到前面未提交的 INSERT）。
 *
 * ★ 响亮失败（fail-closed）：错名一次给全清单、权重和 ≠ 1 一次给全违反组 —— 绝不静默丢行、
 *   绝不"顺手"建主数据（那是接入层的职责，两边的判据不一样：接入归并要人拍板，声明行没有拍板环节）。
 */
import { execute, queryWriter } from '../db/index.ts';
import { nameHash, type Ir, type IrTable } from './ir.ts';

/** 同步结果：表名 + 落进去的行数 */
export interface SyncedRows {
  table: string;
  rows: number;
}

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** 有声明行的表，同步顺序：维度在前、桥接在后（桥接行按名字解析，要等维度行先就位） */
export function declaredRowTables(ir: Ir): IrTable[] {
  const byName = (a: IrTable, b: IrTable) => (a.name < b.name ? -1 : 1);
  const dims = ir.tables.filter((t) => t.kind === 'dimension' && t.rows).sort(byName);
  const bridges = ir.tables.filter((t) => t.kind === 'bridge' && t.rows).sort(byName);
  return [...dims, ...bridges];
}

/** 维度声明行 → (id, 其余列)。id 是名字的纯函数：表名去 dim_ 前缀 + nameHash */
function dimRowValues(t: IrTable): Array<Record<string, string>> {
  const prefix = t.name.replace(/^dim_/, '');
  return t.rows!.map((r) => ({ id: `${prefix}_${nameHash(r.name!)}`, ...r }));
}

/** INSERT 分批（一列名序 + 多行值），批大小与 run.ts 的落库相同量级。行里没给的列落 NULL */
async function insertRows(t: IrTable, rows: Array<Record<string, string>>): Promise<void> {
  const cols = t.columns.map((c) => c.name);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const tuples = chunk.map((r) => `(${cols.map((c) => (r[c] === undefined ? 'NULL' : lit(r[c]))).join(', ')})`).join(',\n');
    await execute(`INSERT INTO ${t.name} (${cols.join(', ')}) VALUES\n${tuples}`);
  }
}

/** 名字 → id（读维表的 name 列）。错名**一次给全**，别让人一个一个试。
 *  ★ 必须走 queryWriter：读连接看不到本事务尚未提交的写（桥接解析读的是同事务里刚插的维表行）。 */
async function resolveNames(dimTable: string, names: string[], at: string): Promise<Map<string, string>> {
  const uniq = [...new Set(names)];
  const found = await queryWriter<{ id: string; name: string }>(
    `SELECT id, name FROM ${dimTable} WHERE name IN (${uniq.map(lit).join(', ')})`,
  );
  const map = new Map(found.map((r) => [r.name, r.id]));
  const missing = uniq.filter((n) => !map.has(n));
  if (missing.length > 0) {
    throw new Error(`${at}：这些名字在 ${dimTable} 里不存在 —— ${missing.join('、')}\n（声明行不做归并：要么改行里的名字，要么先把维度行声明出来；绝不静默建主数据）`);
  }
  return map;
}

/** 桥接声明行 → id 解析后的行 */
async function bridgeRowValues(t: IrTable): Promise<Array<Record<string, string>>> {
  const fkCols = t.columns.filter((c) => c.role === 'dim_fk' && c.key);
  const maps = new Map<string, Map<string, string>>();
  for (const fk of fkCols) {
    maps.set(fk.name, await resolveNames(fk.refs!, t.rows!.map((r) => r[fk.name]!), `${t.name}.${fk.name}`));
  }
  return t.rows!.map((r) => {
    const out: Record<string, string> = { ...r };
    for (const fk of fkCols) out[fk.name] = maps.get(fk.name)!.get(r[fk.name]!)!;
    return out;
  });
}

/** 权重和守恒：按第一个外键端分组，每组 SUM(weight) 必须 = 1（DECIMAL 精确比对，没有容差） */
async function assertWeightsSumToOne(t: IrTable): Promise<void> {
  const fkCols = t.columns.filter((c) => c.role === 'dim_fk' && c.key);
  const weight = t.columns.find((c) => c.role === 'measure');
  if (!weight || fkCols.length === 0) return;
  const bad = await queryWriter<{ k: string; s: string }>(
    `SELECT ${fkCols[0]!.name} AS k, CAST(SUM(${weight.name}) AS VARCHAR) AS s FROM ${t.name} GROUP BY 1 HAVING SUM(${weight.name}) <> 1`,
  );
  if (bad.length > 0) {
    const list = bad.map((r) => `${r.k} = ${r.s}`).join('、');
    throw new Error(
      `${t.name} 的权重和不是 1：${list}\n（摊分要么完整、要么整个不摊 —— 权重和 ≠ 1 就是漏钱或虚增，是错得最安静的那一种）`,
    );
  }
}

/**
 * 同步全部声明行（**不管理事务** —— 单独跑走 `rebuildAll()`，落库事务里复用调用方的那一个）。
 * 同步顺序：维度 → 桥接。任何一步错，整个事务回滚，库里的行一根汗毛都没动。
 */
export async function syncRows(ir: Ir): Promise<SyncedRows[]> {
  const out: SyncedRows[] = [];
  for (const t of declaredRowTables(ir)) {
    const values = t.kind === 'dimension' ? dimRowValues(t) : await bridgeRowValues(t);
    await execute(`DELETE FROM ${t.name}`);
    await insertRows(t, values);
    if (t.kind === 'bridge') await assertWeightsSumToOne(t);
    out.push({ table: t.name, rows: values.length });
  }
  return out;
}
