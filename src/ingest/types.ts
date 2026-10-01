/**
 * 接入规格（ingest spec）—— 「任意形态的源 Excel → 星型表行」的领域语言。
 *
 * ★ 它和报表规格（`src/spec/types.ts`）方向相反：
 *   报表规格是 **DB → Excel**（把查询结果写进模板的数据格）；
 *   接入规格是 **Excel → DB**（把网格里最不起眼的一格格值展开成事实行）。
 *   两者共用的只有「锚点 + 行列几何」这一个概念。放进同一个 Block 类型
 *   会让两边都长出对方不需要的字段，于是放在平行的目录里、平行的类型。
 *
 * ★ 三条设计立场（全部来自旧导入链路的真实故障，见 src/import/ 的教训）：
 *   1. 凡是"能算出数"的开关，都必须回答「写错了会怎样」。本文件里每个可选字段
 *      的注释都写了写错时的行为，默认值一律选**拒绝**而不是"猜一个继续"。
 *   2. 判据只有一份：`lintIngest` 同时是「保存时拒绝」和「落库前拒绝」的入口
 *      （铁律 17）。旧实现把校验留在预览层，`/api/import/commit` 重读盘直接落库，
 *      一次 POST 就能绕过 —— 校验必须活在落库路径本身。
 *   3. 不静默猜。源文件里的公司/指标名认不出来时报给人确认，不自动新建
 *      （错合并比不合并危险得多：不合并数字少一半会被发现，错合并报表看起来正常）。
 */
import { parse as parseYaml } from 'yaml';
import { DIM_NAMES, isRegisteredDim } from '../spec/dims.ts';
import type { DimKind } from '../import/resolve.ts';

// ---------------- 列号工具（Excel 列字母 ↔ 序号） ----------------

/** "D" → 4（1-based）。不合法直接抛，不返回 NaN 让错误往下漂 */
export function colIndex(letter: string): number {
  const s = String(letter ?? '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(s)) throw new Error(`列号不合法：${JSON.stringify(letter)}`);
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** 4 → "D"（1-based） */
export function colLetter(index: number): string {
  if (!Number.isInteger(index) || index < 1) throw new Error(`列序号不合法：${JSON.stringify(index)}`);
  let n = index;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = (n - m - 1) / 26;
  }
  return s;
}

/**
 * 展开列清单：`["D", "F:H"]` → `["D","F","G","H"]`。
 * 只认列字母，**不认** `D2` 这种带行的写法 —— 接入规格里"哪一列"和"哪一行"是
 * 两个不同的字段，混在一起最容易写错。
 */
export function expandColumns(cols: string[]): string[] {
  const out: string[] = [];
  for (const item of cols ?? []) {
    const t = String(item ?? '').trim().toUpperCase();
    const m = /^([A-Z]{1,3})\s*:\s*([A-Z]{1,3})$/.exec(t);
    if (m) {
      const a = colIndex(m[1]);
      const b = colIndex(m[2]);
      if (b < a) throw new Error(`列区间方向反了：${JSON.stringify(item)}`);
      for (let i = a; i <= b; i++) out.push(colLetter(i));
    } else {
      out.push(colLetter(colIndex(t)));
    }
  }
  return out;
}

// ---------------- 规格 ----------------

/**
 * 网格之外的固定键值来源。
 *
 * ★ 为什么必须有它：有些源的键**真的不在网格里** —— 一个文件一家公司（公司名
 *   只在文件名或页眉里），或名字写在数据区之外的某个格子里。
 *
 * ★ 但它不是默认解法，判据只有一条：**看那一列有没有值**。
 *   公司财务报表模板的默认形状是「全集团一张表」：A1 表头写「单位」，A2 往下
 *   每行一家子公司（C 列是指标，跨公司同名）。那种情况下公司就是 `rows` 里的
 *   一列（`{ col: 'A', dim: 'company' }`），**不要**写成 facts —— 写成 facts 会
 *   把整张表的数全挂到同一个名下。注意空模板的那一列本来就是空的，"现在没值"
 *   推不出"不是一列"，拿不准就问人。
 *
 * ★ 不提供 `{ from: filename }`：从文件名里切出公司名需要一套 pattern 语言，
 *   而"切错一半"会被静默接受（切成「华东」→ 归并到另一家）。等到真需要时
 *   再连着 pattern 与校验一起做。
 */
export type FactSource =
  | { literal: string }
  | { cell: string };

/** 行方向的标签列：这一列的值绑到哪个维度 */
export interface RowKeySpec {
  col: string;
  dim: string;
}

/** 明确不接入的列 */
export interface SkipColumnsSpec {
  columns: string[];
  /**
   * ★ **必填**。跳过列是一个"不落数"的决定（同比/环比这类派生列看起来像数据，
   *   实际不能当事实存）。不写 why 就不许跳过 —— 决定必须带依据。
   */
  why: string;
}

export interface ValueColumnsSpec {
  /** 值列，必须**显式列出**，不自动推断（自动推断列族出过一次静默错位） */
  columns: string[];
  /**
   * 值列标签所在的表头行；默认 = 锚点的上一行。
   * 写错会怎样：高于锚点行 → 直接 error（那行是数据行，不是表头）。
   */
  headerRow?: number;
  /** 表头文本 → 口径。表头既不在映射里、又没在 periodTypes 里给出 → error（列出全部未映射的表头） */
  periodTypeFromHeader?: Record<string, string>;
  /** 按**位置**对应 columns 的口径，优先级高于表头映射（表头被合并单元格盖住、或压根没有表头时用它） */
  periodTypes?: string[];
  skip?: SkipColumnsSpec[];
  /** 事实表的度量字段，默认 `amount` */
  measure?: string;
}

export interface IngestBlock {
  /** 数据区左上角（第一个值格），如 "D2" —— 与报表规格同一个概念 */
  anchor: string;
  /** 行方向：哪些列是行标签。可以多列（如 A 列公司 + C 列指标） */
  rows: RowKeySpec[];
  /** 列方向：哪些列是值、各自是哪个口径 */
  values: ValueColumnsSpec;
  /** 行内的期数列（如 B 列每行都写着 2026-06） */
  keys?: Array<{ col: string; as: 'period' }>;
  /** 网格之外的固定键：company / metric / period */
  facts?: Record<string, FactSource>;
  /** 不接入的行 */
  drop?: { labels?: string[]; prefixes?: string[] };
}

export interface IngestSheet {
  name: string;
  blocks: IngestBlock[];
}

export interface IngestSpec {
  id: string;
  title?: string;
  /** 源 Excel 路径（相对仓库根；必须在允许的根目录内） */
  source: string;
  /**
   * 同一个坐标 (公司,指标,期数,口径) 在源里出现两次时：
   * `reject`（默认）整批拒绝并列出冲突；`replace` 后写覆盖、并把被覆盖的记进批次记录。
   * 写错会怎样：选了 replace 却不知道 —— 数据静默少一半。默认必须是 reject。
   */
  onConflict?: 'reject' | 'replace';
  /**
   * 公司/指标在库里找不到时：`confirm`（默认）整体不落库、交人确认；
   * `create` 自动新建（只在明确知道这是一份全新子公司报表时才写）。
   */
  unknownMaster?: 'confirm' | 'create';
  /**
   * 值格是**空**时怎么办：
   *   `skip`（默认）这一格不落库 —— 空不是 0，也不是一条事实；
   *   `null` 照样写一行、金额记 NULL（旧长表导入的行为）。
   *
   * ★ 为什么必须由规格声明：这两种读法在库里看不出区别，只有写下规格的人知道
   *   「这一格空着」到底意味着"这个月没这一项"还是"这一项是空的，请把旧值也抹掉"。
   *   引擎不替人挑 —— 挑错了不会报错，只会让数少一点或多一点。
   */
  onEmptyMeasure?: 'skip' | 'null';
  sheets: IngestSheet[];
}

// ---------------- 诊断 ----------------

export interface IngestIssue {
  level: 'error' | 'warn';
  code: string;
  /** 出错位置，如 `sheets[0].blocks[0].values.columns` —— 让人能直接点名 */
  at: string;
  message: string;
  hint?: string;
}

export interface IngestLintContext {
  /**
   * 已知口径（DB 里 period_type 的取值全集，来自 catalog）。
   * 给了才会校验"声明的口径是不是已注册的"；没给就跳过这一项。
   * ★ 刻意不 import 编译期常量 PERIOD_TYPES：口径是**数据**，不是语言常量，
   *   写在代码里必然与库里的实际取值漂移（旧实现就是这么漂的）。
   */
  periodTypes?: string[];
}

/**
 * 人工对一个未识别名称的处置决定（来自确认界面，或 agent 与用户对话后回传的结论）。
 *
 * ★ 接入层不负责"怎么问人"，只负责"人给了决定就照办、没给就一行都不写"。
 *   它在旧的 longtable.ts 里，现在搬到这里 —— 接入层是它的家，旧长表导入只是第一个调用方。
 */
export interface DimDecision {
  kind: DimKind;
  /** 源文件里的原始写法 */
  raw: string;
  /** merge = 并入已有主数据（会写进 dim_alias）；create = 确实是个新实体 */
  action: 'merge' | 'create';
  /** action='merge' 时必填：并入哪条 */
  targetId?: string;
  note?: string;
}

export class IngestError extends Error {}

/**
 * 人的处置决定：**唯一的解析与校验实现**。
 *
 * 为什么放在这里、而不是各入口各写一份：决定表决定「谁的钱并到谁头上」，
 * 两份判据一旦漂移，后果是**某一个入口静默接受了一个本该被拒的决定** ——
 * 正是 `AGENTS.md` 铁律 17 判过的那种最难查的 bug。MCP 工具与 CLI 都调本函数。
 *
 * `merge` 缺 `targetId` 直接拒：否则会造出**指向虚空却从此自动命中**的别名（铁律 16）。
 *
 * @param raw 未校验的输入（JSON 解析结果）；`undefined` / `null` 表示"调用方没给决定"
 * @returns 校验过的决定列表；`undefined` 表示没提供
 * @throws 形状不对、动作不认识、merge 缺目标
 */
export function parseDecisions(raw: unknown): DimDecision[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error('decisions 必须是数组');
  return raw.map((d) => {
    const o = d as Record<string, unknown>;
    const kind = String(o.kind);
    const action = String(o.action);
    if (kind !== 'company' && kind !== 'metric') {
      throw new Error(`decisions[].kind 只能是 company 或 metric，收到 ${kind}`);
    }
    if (action !== 'merge' && action !== 'create') {
      throw new Error(`decisions[].action 只能是 merge 或 create，收到 ${action}`);
    }
    if (action === 'merge' && !o.targetId) {
      throw new Error(`decisions 里 ${kind} ${String(o.raw)} 选了 merge 却没给 targetId`);
    }
    return {
      kind: kind as DimKind,
      raw: String(o.raw),
      action: action as 'merge' | 'create',
      targetId: o.targetId === undefined ? undefined : String(o.targetId),
      note: o.note === undefined ? undefined : String(o.note),
    };
  });
}

/**
 * 落库必需的四类坐标 + 度量。少任何一个，一行事实都写不出来。
 *
 * `period` 是"期数"这个声明侧的叫法，落到库里是 `fact_finance.fin_month`；
 * `period_type` 是口径（一列，不是行）。
 */
export const REQUIRED_COORDS = ['company', 'metric', 'period', 'period_type'] as const;
export type RequiredCoord = (typeof REQUIRED_COORDS)[number];

/**
 * 坐标 → 中文名。★ 只用于**文案**（issue / 报错），不参与任何判据。
 *
 * 行键重复的报错原本只印"第一个非空标签"，于是行键是 (公司, 指标) 时
 * 报出来的是**公司名** —— 人要去找"两家公司怎么重了"，而真正重的是指标。
 */
export const COORD_CN: Record<string, string> = {
  company: '公司',
  metric: '指标',
  period: '期数',
  period_type: '口径',
};

/**
 * 列号 → 规范大写列名；不合法返回 null（由调用方统一报成可读的 issue）。
 * 包一层 try 是为了不在每个字段上各写一次 catch —— 但**不吞错**：
 * null 一定会在同一个字段上变成一条 error，绝不静默放过。
 */
function safeCol(v: unknown): string | null {
  try {
    return colLetter(colIndex(String(v ?? '')));
  } catch {
    return null;
  }
}

/**
 * 值列的**有效清单** = `columns` 展开后**减去** `skip` 里的列（跳过优先）。
 *
 * ★ 为什么是"相减"而不是"两块必须互斥"：
 *   人（和 agent）看一张宽表，最自然的写法是「接入 D:L，但 F、I、L 三个派生列跳过」。
 *   要求他手算出 D,E,G,H,J,K 再写进来，等于逼着他复述一遍自己的意图 ——
 *   多写一遍就多一处能写错的地方，而且写错了没人看得见。
 *   相减之后只留一处知识：哪些**不**接入。
 *
 * ★ 那写错会怎样（skip 写宽了、把真值列也跳过）？
 *   不会静默：dry-run 会把**每一个**接入的列连口径一起列出来
 *   （`valueColumns`），少了一列一眼就能看见；`periodTypes` 是按有效列逐个对位的，
 *   数量对不上也会直接报错。**形状必须能被看见**，这是相减规则的安全垫。
 *
 * 非法列号不在这里抛，也不在别处再抛一次：`badFromColumns` / `badFromSkip` / `duplicateSkips`
 * 都从这里出去，lint 只是把它们的 code 翻成 IngestIssue —— **判据只有这一份**（铁律 17）。
 */
export function effectiveValueColumns(v: ValueColumnsSpec): {
  /** 真正会接入的列（已减去 skip） */
  cols: string[];
  /** skip 里声明跳过的列 */
  skipped: Set<string>;
  /** 同时在 columns 与 skip 里的列（跳过优先，会 warn） */
  overlap: string[];
  /** columns 里展开不了的列号 */
  badFromColumns: string[];
  /** skip 里展开不了的列号 */
  badFromSkip: string[];
  /** skip 里被重复声明的列 */
  duplicateSkips: string[];
} {
  const badFromColumns: string[] = [];
  const badFromSkip: string[] = [];
  const expand = (list: string[] | undefined, badTo: string[]): string[] => {
    const out: string[] = [];
    for (const item of list ?? []) {
      try {
        out.push(...expandColumns([item]));
      } catch {
        // 只把非法项挑出来交给调用方报错 —— 不吞掉，它一定会变成一条 error
        badTo.push(String(item));
      }
    }
    return out;
  };
  const all = expand(v?.columns, badFromColumns);
  const skipLists = (v?.skip ?? []).map((s) => expand(s?.columns, badFromSkip));
  const skipped = new Set<string>();
  const duplicateSkips: string[] = [];
  for (const xs of skipLists) {
    for (const c of xs) {
      if (skipped.has(c)) duplicateSkips.push(c);
      skipped.add(c);
    }
  }
  const overlap = all.filter((c) => skipped.has(c));
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const c of all) {
    if (skipped.has(c) || seen.has(c)) continue; // 跳过优先；重复列只算一次
    seen.add(c);
    cols.push(c);
  }
  return { cols, skipped, overlap, badFromColumns, badFromSkip, duplicateSkips };
}

/**
 * 某个 block 里每个必需坐标被**绑定了几次**、分别绑在哪。
 * 用于「一次都不许少」与「一次都不许多」两条判据 —— 它们是同一个函数的两面。
 */
export function bindingsOf(block: IngestBlock): Map<RequiredCoord, string[]> {
  const map = new Map<RequiredCoord, string[]>();
  const add = (coord: RequiredCoord, where: string) => {
    const arr = map.get(coord) ?? [];
    arr.push(where);
    map.set(coord, arr);
  };
  for (const r of block.rows ?? []) {
    if (r.dim === 'company' || r.dim === 'metric' || r.dim === 'period_type') {
      add(r.dim as RequiredCoord, `rows[col=${r.col}].dim`);
    }
  }
  for (const k of block.keys ?? []) {
    if (k.as === 'period') add('period', `keys[col=${k.col}].as`);
  }
  for (const [dim, src] of Object.entries(block.facts ?? {})) {
    if (dim === 'company' || dim === 'metric' || dim === 'period_type' || dim === 'period') {
      add(dim as RequiredCoord, `facts.${dim}${'literal' in (src as object) ? '.literal' : '.cell'}`);
    }
  }
  const v = block.values ?? ({} as ValueColumnsSpec);
  if (v.periodTypeFromHeader && Object.keys(v.periodTypeFromHeader).length > 0) {
    add('period_type', 'values.periodTypeFromHeader');
  }
  if (v.periodTypes && v.periodTypes.length > 0) add('period_type', 'values.periodTypes');
  return map;
}

/** 一次性给全所有结构诊断 —— 保存/落库/工具共用同一份判据（铁律 17） */
export function lintIngest(spec: IngestSpec, ctx: IngestLintContext = {}): IngestIssue[] {
  const out: IngestIssue[] = [];
  const err = (code: string, at: string, message: string, hint?: string) =>
    out.push({ level: 'error', code, at, message, hint });
  const warn = (code: string, at: string, message: string, hint?: string) =>
    out.push({ level: 'warn', code, at, message, hint });

  if (!spec || typeof spec !== 'object') {
    err('NO_SPEC', '(根)', '接入规格不是一个对象。');
    return out;
  }
  if (!spec.id || typeof spec.id !== 'string') {
    err('NO_ID', 'id', '接入规格必须有 id（批次记录要用它追溯"这份数是谁按哪份规格接进来的"）。');
  }
  if (!spec.source || typeof spec.source !== 'string') {
    err('NO_SOURCE', 'source', '必须声明 source：要接入的源 Excel 路径。');
  }
  if (spec.onConflict !== undefined && spec.onConflict !== 'reject' && spec.onConflict !== 'replace') {
    err('ONCONFLICT_BAD', 'onConflict', `onConflict 只能是 reject 或 replace，收到 ${JSON.stringify(spec.onConflict)}。`);
  }
  if (spec.onEmptyMeasure !== undefined && spec.onEmptyMeasure !== 'skip' && spec.onEmptyMeasure !== 'null') {
    err('ON_EMPTY_MEASURE_BAD', 'onEmptyMeasure', `onEmptyMeasure 只能是 skip 或 null，收到 ${JSON.stringify(spec.onEmptyMeasure)}。`);
  }
  if (spec.unknownMaster !== undefined && spec.unknownMaster !== 'confirm' && spec.unknownMaster !== 'create') {
    err('UNKNOWN_MASTER_BAD', 'unknownMaster', `unknownMaster 只能是 confirm 或 create，收到 ${JSON.stringify(spec.unknownMaster)}。`);
  }
  if (!Array.isArray(spec.sheets) || spec.sheets.length === 0) {
    err('NO_SHEETS', 'sheets', '至少要给一个 sheet。');
    return out;
  }

  spec.sheets.forEach((sheet, si) => {
    const sAt = `sheets[${si}]`;
    if (!sheet?.name) err('SHEET_NO_NAME', `${sAt}.name`, '每个 sheet 都要写 name（按名指定，不按序号 —— 序号会随插入行漂移）。');
    if (!Array.isArray(sheet?.blocks) || sheet.blocks.length === 0) {
      err('SHEET_NO_BLOCK', `${sAt}.blocks`, `sheet「${sheet?.name ?? '?'}」里没有任何 blocks。一张表一块；块里没有声明的数据区不会被接入。`);
      return;
    }
    sheet.blocks.forEach((block, bi) => {
      const at = `${sAt}.blocks[${bi}]`;
      // --- 锚点 ---
      if (!/^[A-Za-z]{1,3}[0-9]+$/.test(String(block?.anchor ?? ''))) {
        err('ANCHOR_BAD', `${at}.anchor`, `anchor 必须是数据区左上角的单元格坐标（如 "D2"），收到 ${JSON.stringify(block?.anchor)}。`);
      }
      // --- 行标签 ---
      if (!Array.isArray(block?.rows) || block.rows.length === 0) {
        err('ROWS_EMPTY', `${at}.rows`, '必须至少给一个行标签列（rows: [{col, dim}]）—— 事实行的行键来自这里。');
      } else {
        const seenCol = new Set<string>();
        const seenDim = new Set<string>();
        block.rows.forEach((r, ri) => {
          const rAt = `${at}.rows[${ri}]`;
          const col = safeCol(r?.col);
          if (!col) err('ROWKEY_BAD_COL', `${rAt}.col`, `列号不合法：${JSON.stringify(r?.col)}。`);
          else if (seenCol.has(col)) err('ROWKEY_DUP_COL', `${rAt}.col`, `列 ${col} 被声明了两次。`);
          else seenCol.add(col);
          if (!isRegisteredDim(String(r?.dim ?? ''))) {
            err('ROWKEY_DIM_UNKNOWN', `${rAt}.dim`,
              `维度 ${JSON.stringify(r?.dim)} 不在白名单里。能进 SQL 的标识符只有这几个：${DIM_NAMES.join(' / ')}。`,
              '铁律 2：白名单之外的维度名绝不进 SQL —— 这是"agent 无 SQL 权限"的落点。');
          } else if (r.dim === 'month' || r.dim === 'year') {
            err('ROWKEY_DIM_DERIVED', `${rAt}.dim`,
              `维度 ${r.dim} 由期数派生，不能从某一列直接绑。`,
              '请把这一列接到 keys: [{col: ..., as: period}]，让引擎去解析期数。');
          }
          if (seenDim.has(r.dim)) err('ROWKEY_DUP_DIM', `${rAt}.dim`, `维度 ${r.dim} 被两列同时绑定。`);
          else seenDim.add(r.dim);
        });
      }
      // --- 期数列 ---
      (block?.keys ?? []).forEach((k, ki) => {
        const kAt = `${at}.keys[${ki}]`;
        if (k?.as !== 'period') {
          err('KEYS_AS_BAD', `${kAt}.as`, `keys 只支持 as: period，收到 ${JSON.stringify(k?.as)}。`,
            '行内的其它列要么声明成 rows[].dim（当坐标），要么就不接入 —— 没有第三种。');
        }
        if (!safeCol(k?.col)) {
          err('KEYS_COL_BAD', `${kAt}.col`, `列号不合法：${JSON.stringify(k?.col)}。`);
        }
      });
      // --- 值列 ---
      // 有效清单 = columns 展开后**减去** skip（跳过优先）。判据只有一份：
      // 这里和 dry-run 都用 effectiveValueColumns()，不在两处各写一遍（铁律 17）。
      const v = (block?.values ?? {}) as ValueColumnsSpec;
      const {
        cols, overlap, badFromColumns, badFromSkip, duplicateSkips,
      } = effectiveValueColumns(v);
      if (!Array.isArray(v.columns) || v.columns.length === 0) {
        err('VALUES_NO_COLUMNS', `${at}.values.columns`, '必须显式列出值列（如 columns: ["D","E"] 或 ["D:K"]）。不自动推断列族 —— 推断错了会把派生的同比列当事实存进去。');
      }
      for (const b of badFromColumns) {
        err('VALUES_BAD_COLUMN', `${at}.values.columns`, `列号不合法：${JSON.stringify(b)}。`,
          '只认列字母："D" 或 "D:K"。带行号的 "D2" 是另一套语法（锚点用），混进来会让整块位置错开。');
      }
      for (const b of badFromSkip) {
        err('SKIP_BAD_COLUMN', `${at}.values.skip`, `列号不合法：${JSON.stringify(b)}。`,
          '只认列字母："F" 或 "F:F"。');
      }
      for (const c of duplicateSkips) {
        warn('SKIP_DUPLICATE', `${at}.values.skip`, `列 ${c} 被跳过了两次。`);
      }
      for (const c of overlap) {
        warn('COL_SKIP_OVERLAP', `${at}.values`, `列 ${c} 既在 columns 里又声明跳过 —— 跳过优先，它不会被接入。`,
          '这是最自然的写法（"接入 D:L，但其中几列跳过"），所以只提醒不算错；dry-run 会把真正接入的每个列连口径列出来，请对着核一遍。');
      }
      const anchorMatch = /^[A-Za-z]{1,3}([0-9]+)$/.exec(String(block?.anchor ?? ''));
      const anchorRow = anchorMatch ? Number(anchorMatch[1]) : 0;
      if (v.headerRow !== undefined) {
        if (!Number.isInteger(v.headerRow) || v.headerRow < 1) {
          err('VALUES_HEADER_BAD', `${at}.values.headerRow`, `headerRow 必须是正整数行号，收到 ${JSON.stringify(v.headerRow)}。`);
        } else if (anchorRow && v.headerRow >= anchorRow) {
          err('VALUES_HEADER_BAD', `${at}.values.headerRow`,
            `headerRow=${v.headerRow} 不低于锚点行 ${anchorRow} —— 那是数据区，不是表头。`,
            '表头必须在数据区上方（默认就是锚点的上一行）。');
        }
      }
      if (v.periodTypes !== undefined) {
        // ★ 按**有效列**对位（已减去 skip）。对不上就报错，并且把两边的数都写出来，
        //   让人一眼看清是不是 skip 多写了一列。
        if (!Array.isArray(v.periodTypes) || cols.length === 0 || v.periodTypes.length !== cols.length) {
          const skippedNote = overlap.length > 0 ? `（skip 跳过 ${overlap.length} 列后，真正接入的是 ${cols.join(',')}）` : '';
          err('VALUES_PERIODTYPES_LEN', `${at}.values.periodTypes`,
            `periodTypes 必须按位置一对一地覆盖**接入的**值列：接入 ${cols.length} 个${skippedNote}，periodTypes ${Array.isArray(v.periodTypes) ? v.periodTypes.length : '非数组'} 个。`,
            '位置对应错一位，口径就会整体错位 —— 这是最不该"尽力而为"的地方。');
        }
      }
      // --- 跳过列 ---
      // 机械部分（展开、去重、相减）都在 effectiveValueColumns 里做完了，这里只补"必须写 why"。
      (v.skip ?? []).forEach((s, xi) => {
        const xAt = `${at}.values.skip[${xi}]`;
        if (!s?.why || typeof s.why !== 'string') {
          err('SKIP_NO_WHY', `${xAt}.why`, '跳过列必须写 why：为什么这些列不接入。',
            '跳过是"不落数"的决定，没有依据的跳过最后没人能复核。');
        }
      });
      // --- 口径是否已注册 ---
      if (ctx.periodTypes && ctx.periodTypes.length > 0) {
        const declared = new Set<string>([
          ...(v.periodTypes ?? []),
          ...Object.values(v.periodTypeFromHeader ?? {}),
        ]);
        for (const p of declared) {
          if (!ctx.periodTypes.includes(p)) {
            err('PERIODTYPE_UNKNOWN', `${at}.values`, `口径 ${JSON.stringify(p)} 不在已注册的口径里：${ctx.periodTypes.join(' / ')}。`,
              '口径是事实表的取值，必须先在库里注册（或映射到已注册的口径）—— 拼错一个字，这份数就会以另一个口径名静默入库。');
          }
        }
      }
      // --- 网格外的固定键 ---
      for (const [dim, src] of Object.entries(block?.facts ?? {})) {
        const fAt = `${at}.facts.${dim}`;
        if (!isRegisteredDim(dim) && dim !== 'period') {
          err('FACT_DIM_UNKNOWN', fAt, `facts 的键必须是维度名或 period，收到 ${JSON.stringify(dim)}。`);
        }
        const s = src as Record<string, unknown>;
        const keys = Object.keys(s ?? {});
        const okLiteral = typeof s?.literal === 'string' && (s.literal as string).length > 0;
        const okCell = typeof s?.cell === 'string';
        if (okLiteral && okCell) {
          err('FACT_AMBIGUOUS', fAt, 'literal 与 cell 只能给一个 —— 两个来源会给同一个键，谁赢都不该由代码决定。');
        } else if (!okLiteral && !okCell) {
          err('FACT_BAD_SOURCE', fAt,
            `必须是 { literal: "..." } 或 { cell: "A2" }，收到 ${JSON.stringify(src)}。`,
            '网格里没有的东西（比如立刻要填的公司名）必须显式声明来源，引擎不做"从文件名猜一个"这种事。');
        } else if (okCell && !/^[A-Za-z]{1,3}[0-9]+$/.test(String(s.cell))) {
          err('FACT_CELL_BAD', fAt, `cell 必须是单元格坐标，收到 ${JSON.stringify(s.cell)}。`);
        }
        if (keys.length === 0) err('FACT_BAD_SOURCE', fAt, '不能是空对象。');
      }
      // --- 丢行规则 ---
      if (block?.drop && !(block.drop.labels?.length ?? 0) && !(block.drop.prefixes?.length ?? 0)) {
        warn('DROP_EMPTY', `${at}.drop`, 'drop 里既没有 labels 也没有 prefixes —— 等于没写。');
      }
      // --- 必需坐标：一次都不许少、一次都不许多 ---
      const bindings = bindingsOf(block ?? ({} as IngestBlock));
      for (const coord of REQUIRED_COORDS) {
        const where = bindings.get(coord) ?? [];
        if (where.length === 0) {
          err('COORD_MISSING', at,
            `「${COORD_CN[coord]}」没有任何来源（${coord}）。`,
            coord === 'company'
              ? '公司名通常就在网格里：整列都是公司名的（全集团一张表）用 rows: [{ col: "A", dim: "company" }]。真的是网格之外的固定键（一个文件一家公司）才用 facts.company: { literal: "..." }，名字写在某个固定格子里用 { cell: "A2" }。找不到就必须拒绝，绝不静默新建或归并。'
              : `请用 ${coord === 'period' ? 'keys: [{col, as: period}] 或 facts.period' : coord === 'period_type' ? 'values.periodTypes / periodTypeFromHeader' : `rows[].dim: ${coord} 或 facts.${coord}`} 绑定它。`);
        } else if (where.length > 1) {
          err('COORD_DUPLICATE', at,
            `「${COORD_CN[coord]}」被绑定了 ${where.length} 次：${where.join('、')}。`,
            '同一个坐标只能有一个来源：两个来源意味着有一处会被静默忽略。');
        }
      }
    });
  });

  return out;
}

/** 解析 YAML 但不校验（给"一次给全诊断"用） */
export function parseIngestSpecLenient(yamlText: string): { spec: IngestSpec | null; parseError: string | null } {
  try {
    return { spec: parseYaml(yamlText) as IngestSpec, parseError: null };
  } catch (e) {
    return { spec: null, parseError: (e as Error).message };
  }
}

/** 解析并校验；有 error 级问题就抛（与报表规格的 parseSpec 同形） */
export function parseIngestSpec(yamlText: string, ctx: IngestLintContext = {}): IngestSpec {
  const { spec, parseError } = parseIngestSpecLenient(yamlText);
  if (parseError) throw new IngestError(`YAML 语法错误：${parseError}`);
  const issues = lintIngest(spec as IngestSpec, ctx);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length > 0) {
    throw new IngestError(errors.map((i) => `[${i.code}] ${i.at}: ${i.message}`).join('\n'));
  }
  return spec as IngestSpec;
}

/**
 * 一次性给全诊断 —— Web 诊断面板、`lint_ingest` 工具和"保存时拒绝"的唯一入口。
 * ★ 不用 parseIngestSpec：它遇到第一条 error 就抛，人只能"改一条、再撞下一条"。
 */
export function diagnoseIngest(yamlText: string, ctx: IngestLintContext = {}): {
  spec: IngestSpec | null;
  parseError: string | null;
  issues: IngestIssue[];
  willBeRejected: boolean;
} {
  const { spec, parseError } = parseIngestSpecLenient(yamlText);
  if (parseError) return { spec: null, parseError, issues: [], willBeRejected: true };
  const issues = lintIngest(spec as IngestSpec, ctx);
  return { spec, parseError: null, issues, willBeRejected: issues.some((i) => i.level === 'error') };
}
