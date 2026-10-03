/**
 * 模板几何（TemplateGeometry）—— 架构 v2 §8.1 的"模板层"公共子集。
 *
 * ★ 模板层只答两问：**数在哪一格**（anchor / 列号 / 行键）、**格的本体含义**（绑到哪个维度）。
 *   报表规格（`src/spec/types.ts` 的 Block）与接入规格（`src/ingest/types.ts` 的 IngestBlock）
 *   方向相反，但回答的是**同样两问** —— 本文件把这份公共子集收在一处：
 *
 *   - **几何**：anchor、行键列、值格列、跳过列、维度角色。
 *   - **不含**：实例字面量（order 清单、filter 值、drop 标签、口径名）—— 那些留在
 *     各自的 overlay（报表侧：value/scope/chart/order/filter；接入侧：values 的口径映射、
 *     facts、drop.labels）；也**不含 source** —— 源文件/模板是执行参数（§8.1），
 *     不是模板几何的一部分。
 *
 * ★ 为什么值得单独一个文件：两侧各写一份"锚点怎么算合法"一定会漂
 *   （铁律 17 的同款毛病）。锚点判据只有一份（`lintAnchorGeometry`），
 *   两份 lint（`lintSpec` / `lintIngest`）都调它 —— 判据不合并、调用合并。
 *   "该用哪份判据"的顶层判别（`looksLikeIngestDoc`）也在这里：按**几何**判
 *   （接入块的 rows 是「列 → 维」数组，报表块的 rows 是带 dim 的轴对象），
 *   不再靠"有没有 source"——source 已经是执行参数，不再是身份特征。
 */

// ---------------- 锚点 ----------------

/** 数据区锚点："B4" 这样的坐标，或 { name: "定义名称" }（模板改版式时跟着走） */
export type AnchorRef = string | { name: string };

/** 坐标形态的锚点（"B4"）；命名锚点或非法输入返回 null */
export function anchorCoordOf(anchor: AnchorRef | unknown): string | null {
  return typeof anchor === 'string' ? anchor.trim() : null;
}

/** 命名锚点（{ name: ... } 的 name）；其它形态返回 null */
export function anchorNameOf(anchor: AnchorRef | unknown): string | null {
  if (anchor && typeof anchor === 'object' && !Array.isArray(anchor)) {
    const n = (anchor as { name?: unknown }).name;
    return typeof n === 'string' && n.trim() !== '' ? n.trim() : null;
  }
  return null;
}

const COORD_RE = /^[A-Za-z]{1,3}[0-9]+$/;

/**
 * 锚点判据 —— **唯一一份**，报表侧与接入侧的 lint 都调它。
 *
 * @param anchor  未校验的锚点值
 * @param at      issue 的位置（调用方拼好，如 `sheets[0].blocks[0].anchor`）
 * @param opts.named  是否接受 { name: 定义名称 }（报表侧 true；接入侧 false ——
 *   接入要读的是源文件的数据区，定义名称解析属于报表模板那侧的能力）
 * @returns 0～1 条 error（缺锚点 / 锚点不合法），code 与文案与两侧原来的判据一致
 */
export function lintAnchorGeometry(
  anchor: unknown,
  at: string,
  opts: { named: boolean } = { named: true },
): Array<{ level: 'error'; code: string; at: string; message: string }> {
  if (anchor === undefined || anchor === null || anchor === '') {
    return [{ level: 'error', code: 'ANCHOR_MISSING', at, message: '缺少 anchor（数据写入位置）。' }];
  }
  const coord = anchorCoordOf(anchor);
  if (coord !== null) {
    if (COORD_RE.test(coord)) return [];
  } else if (opts.named) {
    if (anchorNameOf(anchor) !== null) return [];
  }
  return [{
    level: 'error',
    code: 'ANCHOR_BAD',
    at,
    message: opts.named
      ? `anchor 必须是 "B4" 这样的坐标，或 { name: 定义名称 }，收到 ${JSON.stringify(anchor)}。`
      : `anchor 必须是数据区左上角的单元格坐标（如 "D2"），收到 ${JSON.stringify(anchor)}。`,
  }];
}

// ---------------- 几何子集与 overlay ----------------

/** 报表块：几何子集 —— anchor + 行/列两个轴各绑哪个维度 */
export interface ReportBlockGeometry {
  anchor: AnchorRef;
  rows: { dim: string };
  cols: { dim: string };
}

/** 报表轴：几何子集只有 dim；filter/order 是实例字面量，属于 overlay */
export interface ReportAxisGeometry {
  dim: string;
}

/** 接入块：几何子集 —— anchor + 行标签列绑哪个维 + 行键（期数列/退化列） */
export interface IngestBlockGeometry {
  anchor: string;
  rows: Array<{ col: string; dim: string }>;
  keys?: Array<{ col: string; as: string; type?: 'text' | 'date' }>;
}

/**
 * 模板几何的**统一读法** —— 两侧 block 各自投影成这一份：
 * 报表块由 `geometryOfReportBlock` 投影，接入块由 `geometryOfIngestBlock` 投影。
 * 只有角色与格位，没有实例字面量，没有 source。
 */
export interface TemplateGeometry {
  anchor: AnchorRef;
  /** 本块绑定的维度角色，以及它是从哪个方向绑进来的 */
  dims: Array<{ dim: string; via: 'rows' | 'cols' | 'rowCol' }>;
  /** 行键（接入：keys；报表块没有 → []） */
  keys: Array<{ col: string; as: string; type?: 'text' | 'date' }>;
  /** 值格列（接入：values.columns 原样；报表块的值格由查询结果决定 → []） */
  valueColumns: string[];
  /** 几何上跳过的列（接入：values.skip[].columns；why 属于 overlay，不在这里） */
  skipColumns: string[];
  /** 是否声明了"不接入的行"之类的丢弃规则（具体标签是实例字面量，留在 overlay） */
  hasDropRules: boolean;
}

/** 报表块 → 模板几何（order/filter/value/scope/chart 都不是几何） */
export function geometryOfReportBlock(b: {
  anchor?: unknown;
  rows?: { dim?: unknown };
  cols?: { dim?: unknown };
}): TemplateGeometry {
  const dims: TemplateGeometry['dims'] = [];
  const via = (d: unknown, v: 'rows' | 'cols') => {
    if (typeof d === 'string' && d !== '') dims.push({ dim: d, via: v });
  };
  via(b.rows?.dim, 'rows');
  via(b.cols?.dim, 'cols');
  return { anchor: b.anchor as AnchorRef, dims, keys: [], valueColumns: [], skipColumns: [], hasDropRules: false };
}

/** 接入块 → 模板几何（口径映射/skip 的 why/facts/drop 标签都不是几何） */
export function geometryOfIngestBlock(b: {
  anchor?: unknown;
  rows?: Array<{ col?: unknown; dim?: unknown }>;
  keys?: Array<{ col: string; as: string; type?: 'text' | 'date' }>;
  values?: { columns?: unknown; skip?: Array<{ columns?: unknown }> };
  drop?: unknown;
}): TemplateGeometry {
  const dims: TemplateGeometry['dims'] = [];
  for (const r of Array.isArray(b.rows) ? b.rows : []) {
    if (typeof r?.dim === 'string' && r.dim !== '') dims.push({ dim: r.dim, via: 'rowCol' });
  }
  return {
    anchor: b.anchor as AnchorRef,
    dims,
    keys: Array.isArray(b.keys) ? b.keys : [],
    valueColumns: Array.isArray(b.values?.columns) ? (b.values?.columns as string[]) : [],
    skipColumns: (Array.isArray(b.values?.skip) ? b.values!.skip : []).flatMap((s) =>
      Array.isArray(s?.columns) ? (s.columns as string[]) : [],
    ),
    hasDropRules: b.drop !== undefined,
  };
}

/**
 * 顶层判别：这份 YAML 文档是接入规格还是报表规格？
 *
 * ★ 按**模板几何**判：任何一个 block 的 `rows` 是数组（列 → 维）→ 接入；
 *   `rows` 是带 `dim` 的对象 → 报表。不再按"有没有 source"判 ——
 *   source 已经是执行参数（CLI `--source` / MCP、HTTP 的 `source` 参数），
 *   一份没有 source 的接入规格是合法的，不该被判别器认错。
 */
export function looksLikeIngestDoc(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const sheets = (doc as { sheets?: unknown }).sheets;
  if (!Array.isArray(sheets)) return false;
  for (const sheet of sheets) {
    for (const block of (sheet as { blocks?: unknown })?.blocks ?? []) {
      const rows = (block as { rows?: unknown })?.rows;
      if (Array.isArray(rows)) return true;
      if (rows && typeof rows === 'object' && typeof (rows as { dim?: unknown }).dim === 'string') return false;
    }
  }
  return false;
}
