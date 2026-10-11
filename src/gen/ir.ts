/**
 * 生成器的**中间表示**（IR）—— 架构 §5.1 要的那一层，P2 的关键。
 *
 * ★ 判据只有一条（`docs/开发计划.md` §1.2 验收第一条「IR 是真抽象」）：
 *   **换一种 YAML 写法，IR 以下的东西（plan / apply / DDL 生成 / 列契约）一行都不该改。**
 *   做不到这条，生成器就退化成字符串拼接 —— 也就是"没有 IR"。
 *   所以 `parse.ts` 允许**两种等价的写法**（分组的 `keys`/`measures` 与平铺的 `columns`），
 *   但都归一成下面这个语义模型；e2e 有一条断言把两种写法解析出的 IR **逐字段深度对比**。
 *
 * IR 只谈**语义**：表是什么、列是什么、谁是主键、谁引用谁、每列扮演什么角色。
 * 它不谈语法（YAML 长什么样），也不谈执行顺序（那是 plan / apply 的事）。
 */
import { createHash } from 'node:crypto';

/**
 * 缺省目标事实表。放声明层只此一份：接入侧（`spec.target`）与报表侧（`spec.fact`）
 * 省略目标表时都落到它 —— 谁在别处再写一个 'fact_finance' 字面量，谁就造了第二个默认值。
 * （查询侧的两处 FROM 已改为从声明解析 —— `spec/compile.ts` / `semantic/query.ts`。）
 */
export const DEFAULT_TARGET = 'fact_finance';

/** 列在语义层扮演的角色 —— 与架构 §7.2 的五个取值一一对应（唯一一份定义，`meta/columns.ts` 从这里 re-export） */
export type MetaRole = 'pk' | 'dim_fk' | 'measure' | 'degenerate' | 'provenance';

/** 表在语义层的种类 */
export type ModelKind = 'dimension' | 'fact' | 'bridge' | 'aggregate';

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
  /** 聚合表（kind='aggregate'）的度量列：怎么聚合（v1 只认 sum） */
  agg?: string;
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
  /**
   * kind='fact' 且声明了口径体系时：**窗口起点列**（如 period_from）——终点 ≡ 期间锚列
   * （semantic: period 的那列，如 fin_month）。窗口规则逐条写在 `calibers`，
   * 判据单一在 `compileMetrics`（铁律 5）。
   */
  windowFrom?: string;
  /**
   * kind='fact' 时可选：**口径声明**（铁律 5 的"五值拆三件"）。规则（from/since/shift）决定
   * 装载怎么落窗与查询怎么展开谓词；`calculator: true` 的口径不落行，语义层算（铁律 6：
   * 非 calculator 的窗口口径不许在代码里"顺手算出来"）。
   */
  calibers?: IrCaliber[];
  /**
   * kind='aggregate' 时：从哪张事实表聚合（grain 里没出现的源维度就是被加总的）。
   * 聚合表的**列不是人写的**——由 parse 在跨表校验阶段从 source 投影出来
   * （grain 列带类型与角色，度量列带聚合函数）。
   */
  source?: string;
  /**
   * kind='aggregate' 时可选：JOIN 穿过哪张桥接表（kind='bridge'）做**加权摊分**
   * （SUM(度量 × 权重)）。join 键不写：自动取「source 与桥接表各自外键里引用同一张维表」
   * 的那一对（`viaJoinCandidates`，恰好一对才合法，parse 守卫）。
   */
  via?: string;
  /**
   * kind='dimension' / 'bridge' 时可选：**声明内嵌行**（值一律字符串，sync 时再按列类型落）。
   * 有 rows 的表写路径只有一条：`bilite rebuild` 全量对齐（DELETE + INSERT 同一事务）——
   * 改行 = 改声明，审计走 git diff。事实表不许带 rows（它的写路径是接入），聚合表也不许
   * （列都是投影来的，行更不该手写）。
   */
  rows?: Array<Record<string, string>>;
}

export interface Ir {
  /** 声明本身的口径版本（改 IR 语义时递增） */
  apiVersion: string;
  tables: IrTable[];
}

/**
 * 一条**口径声明**（铁律 5 的"窗口是声明，不是行上字符串"）。
 * - `calculator: true`：语义层算的口径（如单月同比），不落事实表，装载拒绝、查询展开成计算；
 * - 其余是窗口口径：`from` 声明窗口起点怎么定（same = 与期间锚同月；year_start = 当年首日；
 *   since = 固定起点 `since: "YYYY-MM"`），`shift: -1` 声明**装载即平移**（去年同期累计：
   * 落窗在平移后的期间上，查询期标签 +1 年对齐 x 轴 —— 存两份必然在审计调整时漂移，所以不存）。
 */
export interface IrCaliber {
  name: string;
  from?: 'same' | 'year_start' | 'since';
  /** from = since 时的固定起点（"YYYY-MM"，取当月首日） */
  since?: string;
  /** 窗口平移的年数（去年同期累计 = -1）；只能配 from: year_start */
  shift?: number;
  /** true = calculator 口径：不落行，语义层算（铁律 6） */
  calculator?: boolean;
  /** calculator 必填：操作数口径的名字（单月同比 = 单月）—— 同一张表里必须另有这个口径 */
  operand?: string;
}

/** 解析/校验阶段的错误：带 code，便于 CLI 与 e2e 判据稳定 */
export class ModelError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------- 事实表的"落库形状"（接入层的唯一依据） ----------------

/**
 * 一张**事实表**在落库时需要的全部信息 —— 由声明推出来，不是代码里的字符串。
 *
 * ★ 为什么要有它（`docs/开发计划.md` §2 的决策「先让目标表变成声明，它才有东西可填」）：
 *   接入层的 INSERT / 撞库预检 / 归档目录原来都写死了 `fact_finance` 与那四个坐标，
 *   于是 `fact_contract` / `fact_business_line` 这类**没有口径列**的运营事实表根本填不进去
 *   （建了也是一张永远空的表）。现在"写进哪张表、有哪些列、哪些坐标必需"全部从这份投影来。
 */
export interface DeclaredFact {
  name: string;
  /** 落库时的列序 —— 就是声明里的列序（DuckDB 不需要，但人读 DDL 与日志时一致更省事） */
  columns: IrColumn[];
  /** 期数的落点列（semantic = period） */
  periodColumn: string;
  /** 公司外键列（refs = dim_company） */
  companyColumn: string;
  /** 指标外键列（refs = dim_metric） */
  metricColumn: string;
  /** 行内携带的**退化列** —— 由规格的 `keys[].as` 提供（见下面怎么挑的） */
  degenerateColumns: string[];
  measureColumn: string;
  /** 溯源列（role = provenance） */
  provenanceColumn: string | null;
  primaryKey: string[];
  /** 窗口起点列（声明了 calibers 的事实表才有；见 IrTable.windowFrom） */
  windowFrom: string | null;
  /** 口径声明（无 = 这张表没有口径体系；有 = 查询白名单按它收窄） */
  calibers: IrCaliber[];
}

/** 从 IR 里挑出事实表的落库形状（`kind: fact` 的那些） */
export function declaredFacts(ir: Ir): DeclaredFact[] {
  const facts: DeclaredFact[] = [];
  for (const t of ir.tables) {
    if (t.kind !== 'fact') continue;
    const by = (p: (c: IrColumn) => boolean) => t.columns.find(p);
    const period = by((c) => c.semantic === 'period');
    const company = by((c) => c.refs === 'dim_company');
    const metric = by((c) => c.refs === 'dim_metric');
    const measure = by((c) => c.role === 'measure');
    const provenance = by((c) => c.role === 'provenance');
    if (!period || !company || !metric || !measure) continue; // 不是"接入层能填"的形状 —— 不假装能填
    facts.push({
      name: t.name,
      columns: t.columns,
      periodColumn: period.name,
      companyColumn: company.name,
      metricColumn: metric.name,
      // ★ 刀 23：period_type 列退场，口径的唯一承载是窗口（windowFrom + calibers）——
      //   IR 上不再有"口径列"概念；行上的 period_type 留在 stg_fact_rows（源侧溯源），不进事实表。
      // ★ 判据是"**谁来填**"而不是"声明里写了什么角色"：除了期数/公司/指标/度量/溯源，
      //   剩下的列只能由**行内携带**（如 fact_business_line 的 business_line）——
      //   它们必须出现在规格的 keys[].as 里，漏一个就会被 COORD_MISSING 拦下。
      //   用角色判会漏：business_line 既在粒度里、又是退化维，人给它标 pk 或 degenerate 都合理。
      degenerateColumns: t.columns
        .filter(
          (c) =>
            c.role !== 'measure' &&
            c.role !== 'provenance' &&
            c.name !== period.name &&
            c.name !== company.name &&
            c.name !== metric.name,
        )
        .map((c) => c.name),
      measureColumn: measure.name,
      provenanceColumn: provenance?.name ?? null,
      primaryKey: t.primaryKey,
      windowFrom: t.windowFrom ?? null,
      calibers: t.calibers ?? [],
    });
  }
  return facts;
}

/** 一张事实表的声明（找不到就是 undefined —— 调用方负责报"没声明过这张表"） */
export function declaredFact(ir: Ir, name: string): DeclaredFact | undefined {
  return declaredFacts(ir).find((f) => f.name === name);
}

// ---------------- 桥接层的推导件 ----------------

/**
 * 名字的**纯函数哈希**（31 乘子 → base36 前 8 位）。接入侧主数据 id（`ingest/run.ts`
 * 的 `entityId`：c_/m_ 前缀）与 sync 的声明行 id（表名去 `dim_` 前缀 + 本哈希）共用这一份
 * —— 谁想改哈希，两边的存量 id 就一起变，所以它放 IR 层导出，不放 run.ts 私有。
 */
export function nameHash(s: string): string {
  let h = 0;
  for (const ch of s) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h.toString(36).slice(0, 8);
}

/**
 * via 聚合的 join 键候选：source 的 dim_fk 列 × 桥接表的 dim_fk 列里，**引用同一张维表**的对。
 * 合法声明必须**恰好一对**（parse 守卫 MODEL_AGG_VIA_BAD）；SQL 生成（`rebuildTableSql`）取 [0]。
 */
export function viaJoinCandidates(t: IrTable, ir: Ir): Array<{ sourceCol: string; viaCol: string }> {
  const src = ir.tables.find((x) => x.name === t.source);
  const via = ir.tables.find((x) => x.name === t.via);
  if (!src || !via) return [];
  const out: Array<{ sourceCol: string; viaCol: string }> = [];
  for (const s of src.columns) {
    if (s.role !== 'dim_fk' || !s.refs) continue;
    for (const v of via.columns) {
      if (v.role === 'dim_fk' && v.refs === s.refs) out.push({ sourceCol: s.name, viaCol: v.name });
    }
  }
  return out;
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
    grain: t.kind === 'fact' || t.kind === 'aggregate' ? t.grain : undefined,
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
  const canonical = t.columns.map((c) => `${c.name}:${c.type}:${c.role}:${c.key ? 'K' : '-'}${c.agg ? ':' + c.agg : ''}`).join(',');
  return createHash('sha256')
    .update(`${t.name}|${t.kind}|${canonical}|pk=${t.primaryKey.join(',')}|grain=${t.grain.join(',')}|src=${t.source ?? ''}|via=${t.via ?? ''}`)
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
