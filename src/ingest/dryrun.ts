/**
 * 接入规格的 **dry-run**：只报形状与计数，一个金额都不出。
 *
 * ★ 为什么先有 dry-run 才有执行器：
 *   接入的错法几乎都是"形状错了"——行标签列认成了备注列、值列里混进了派生的同比列、
 *   合计行没排除、公司名其实是空的、表头被合并单元格盖住。这些错**看一眼形状就知道**，
 *   不需要落库、更不需要把数字搬到别处。先把形状说清楚，再谈写数。
 *
 * ★ 铁律 1 在这里的落点是"引擎不往外发数据"：
 *   本文件读源文件的标签列、表头、以及值格的**计数**（空/非数字各多少），
 *   但返回结构里**没有任何一个金额**。值格的值只在局部变量里活一瞬间。
 *   要复核"数字对不对"是人的事，不是 agent 的事。
 *
 * ★ 与执行器共用同一份判据：本文件先跑 `lintIngest`（结构），再报文件级问题；
 *   执行器落库前也必须跑同样的两步（铁律 17）。
 */
import fs from 'node:fs';
import type { Sheet } from 'xlsx-populate';
import { textAt, openTemplate, parsePeriodText, type ReadableWorkbook } from '../spec/template.ts';
import { parseRef } from '../render/excel.ts';
import { normalizeName } from './normalize.ts';
import {
  COORD_CN,
  colIndex,
  colLetter,
  effectiveValueColumns,
  expandColumns,
  lintIngest,
  type IngestBlock,
  type IngestIssue,
  type IngestLintContext,
  type IngestSpec,
} from './types.ts';

/**
 * 源文件白名单判据已搬到 `src/paths.ts` —— `land/` 也要用它，留在这里会成环。
 * 这里 import 进来自己用、同时转发出去，保持既有 import 点不变。
 * ⚠️ 别改成 `export ... from` —— 那样**不会**产生本地绑定，本文件里的调用会变成
 *   未定义引用（写这行时踩过一次，e2e 挂了 9 条）。
 */
import { resolveSource, SOURCE_ROOTS } from '../paths.ts';
export { resolveSource, SOURCE_ROOTS };

/** 主数据快照 —— 由调用方注入（来自 catalog()），使本模块可脱库测试 */
export interface MasterCatalog {
  companies: string[];
  metrics: string[];
  periodTypes: string[];
}

/**
 * 展开后的**一条事实行**（网格坐标 + 金额）。
 *
 * ★ 它含金额，因此**只允许引擎内部使用**（src/ingest/run.ts 落库那一路）。
 *   之所以用回调而不是返回值：回调没人传的时候，金额在循环结束后就随局部变量一起消失，
 *   `IngestShape`（给 agent / HTTP 的形状）里**结构上不可能**夹带金额 —— 这比"记得别序列化它"可靠。
 */
export interface IngestFactRow {
  source: string;
  sheet: string;
  block: number;
  /** 源文件里的行号（报错与追溯用） */
  row: number;
  company: string;
  metric: string;
  /** 归一成 `YYYY-MM`（期数列与 facts.period 都要能落库） */
  period: string;
  periodType: string;
  amount: number | null;
}

export interface IngestDryRunOptions {
  catalog: MasterCatalog;
  /** 读到多少行就停（防误指一个百万行的文件）；默认 20000。撞到会上报，不静默截断 */
  maxRows?: number;
  /**
   * 每展开出一条**坐标完整**的事实行就回调一次。
   * ★ 只有执行器（run.ts）会传它。dry-run、MCP 工具、HTTP 路由一律**不传** ——
   *   不传 = 金额根本不会离开这个循环（铁律 1）。
   */
  onRow?: (row: IngestFactRow) => void;
  /**
   * 值格空着时，算不算一条可落库的事实行。
   * 由规格的 `onEmptyMeasure` 解出来：`skip`(默认) → false，`null` → true。
   * ★ 必须是调用方解好的布尔值：读取层不去读规格的开关，否则同一个开关会有两处解释。
   */
  writeEmptyMeasures?: boolean;
  /**
   * **怎么把源文件读成一个可读工作簿**。默认 `openTemplate`（直接开 xlsx）。
   *
   * ★ 接入层不该自己决定"值从哪来"：源文件已经经由着陆层存成 `raw_cell` 时，
   *   就应该从 raw 读（`src/land/read.ts` 的 `rawWorkbook()`）—— 那是"可重放"的落点。
   *   这个口子只负责"把书拿进来"，其余判据一概不变。
   */
  openBook?: (absPath: string) => Promise<ReadableWorkbook>;
}

/** 值格的计数 —— **只报个数，从不报值** */
export interface CellStats {
  total: number;
  empty: number;
  nonNumeric: number;
}

export interface IngestBlockShape {
  sheet: string;
  anchor: string;
  headerRow: number;
  rows: Array<{ col: string; dim: string }>;
  /** 真正会接入的数据行数（已扣掉 drop 掉的行与空标签行） */
  dataRows: number;
  dropped: Array<{ row: number; label: string; by: string }>;
  /** 行键完全相同的行（会互相覆盖到同一个坐标） */
  duplicates: Array<{ label: string; rows: number[] }>;
  /** 底部合计行这类"带公式"的行 */
  computed: Array<{ row: number; label: string; formula: string }>;
  /** 行键里有空值的行（空公司/空指标 → 会建出无名主数据） */
  /** 行键为空的列：rows 只留前 8 行示例，count 才是总数（形状要能直接给 agent 看） */
  emptyKeys: Array<{ dim: string; rows: number[]; count: number }>;
  valueColumns: Array<{ col: string; header: string | null; periodType: string | null }>;
  skipped: Array<{ col: string; header: string | null; why: string }>;
  measure: string;
  measureCells: CellStats;
  coordinates: {
    /** 宽表展开后的坐标总数 = 数据行 × 值列 */
    total: number;
    /** 坐标里有空的（公司/指标/期数/口径任缺） */
    incomplete: number;
    /** 规范化后撞在一起的坐标（同一处被写两次） */
    duplicates: Array<{ key: string; count: number }>;
  };
  period: { year: number; month: number; evidence: string } | null;
  /** 库里找不到的主数据（要拿去问人），按出现行数降序 */
  unmatched: Array<{ kind: 'company' | 'metric'; name: string; rows: number }>;
  /** 网格外读到的键（如每次填在 A2 的公司名） */
  factsResolved: Array<{ dim: string; from: string; value: string | null }>;
}

export interface IngestShape {
  spec: { id: string; source: string; onConflict: 'reject' | 'replace'; unknownMaster: 'confirm' | 'create' };
  sheets: number;
  blocks: IngestBlockShape[];
  issues: IngestIssue[];
  /** 没有任何 error 级问题 */
  ok: boolean;
  note: string;
}

function labelOf(sheet: Sheet, row: number, cols: string[]): string[] {
  return cols.map((c) => (textAt(sheet, row, colIndex(c)) ?? '').trim());
}

/** 空值判定：undefined / null / 空串 / 只有空白的串都算空 */
function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

export async function dryRunIngest(spec: IngestSpec, opts: IngestDryRunOptions): Promise<IngestShape> {
  const ctx: IngestLintContext = { periodTypes: opts.catalog.periodTypes };
  const issues: IngestIssue[] = lintIngest(spec, ctx);
  const err = (code: string, at: string, message: string, hint?: string) =>
    issues.push({ level: 'error', code, at, message, hint });
  const warn = (code: string, at: string, message: string, hint?: string) =>
    issues.push({ level: 'warn', code, at, message, hint });

  const blocks: IngestBlockShape[] = [];
  const shape: IngestShape = {
    spec: {
      id: spec?.id ?? '',
      source: spec?.source ?? '',
      onConflict: spec?.onConflict ?? 'reject',
      unknownMaster: spec?.unknownMaster ?? 'confirm',
    },
    sheets: Array.isArray(spec?.sheets) ? spec.sheets.length : 0,
    blocks,
    issues,
    ok: false,
    note: '只报形状与计数：没有金额，也没有主数据 id。',
  };

  // 结构就有 error 时不再去读文件 —— 读出来的形状没有意义，还容易让人以为"能跑"
  if (issues.some((i) => i.level === 'error')) {
    shape.ok = false;
    return shape;
  }

  let abs: string;
  try {
    abs = resolveSource(spec.source);
  } catch (e) {
    err('SOURCE_OUTSIDE_ROOTS', 'source', (e as Error).message);
    return shape;
  }
  // ★ 有 `openBook`（值从 raw 来）时**不再要求源文件还在** —— 那正是"源文件删了也能重放"。
  //   没有它才要求文件在：那时值只能从工作簿来，文件没了就没得读。
  if (!opts.openBook && !fs.existsSync(abs)) {
    err('SOURCE_NOT_FOUND', 'source', `源文件不存在：${spec.source}（解析为 ${abs}）。`);
    return shape;
  }

  // ★ 值的来源由调用方决定：默认直接开 xlsx；已着陆过就换成从 raw_cell 读（可重放）
  const wb = await (opts.openBook ?? openTemplate)(abs);
  const maxRows = opts.maxRows ?? 20000;
  const companyIndex = new Map(opts.catalog.companies.map((n) => [normalizeName(n), n]));
  const metricIndex = new Map(opts.catalog.metrics.map((n) => [normalizeName(n), n]));

  spec.sheets.forEach((sheetSpec, si) => {
    const sheet = wb.sheet(sheetSpec.name);
    if (!sheet) {
      const names = (wb.sheets() as Array<{ name: () => string }>).map((s) => s.name()).join(' / ');
      err('SHEET_NOT_FOUND', `sheets[${si}].name`, `源文件里没有 sheet「${sheetSpec.name}」。现有的 sheet：${names}。`);
      return;
    }
    sheetSpec.blocks.forEach((block, bi) =>
      blocks.push(
        readBlockShape(sheet, block, {
          source: spec.source,
          si,
          bi,
          maxRows,
          companyIndex,
          metricIndex,
          err,
          warn,
          onRow: opts.onRow,
          writeEmptyMeasures: opts.writeEmptyMeasures === true,
        }),
      ),
    );
  });

  shape.ok = !issues.some((i) => i.level === 'error');
  return shape;
}

/**
 * 读一个 block 所需的全部上下文。
 *
 * ★ 之所以收成一个对象而不是继续加位置参数：这些参数里有 3 个函数（err/warn/onRow），
 *   位置一错**不会报类型错**（没有 tsconfig，也就没有类型检查门禁），
 *   上一次 onRow 站到了 err 的位置上，于是每条事实行（连金额）都被当成 issue 推进了 issues。
 *   同类参数扎堆时必须靠名字而不是靠顺序。
 */
interface BlockReadContext {
  /** 源文件（相对路径）—— 落库时 batch 要记它 */
  source: string;
  si: number;
  bi: number;
  maxRows: number;
  companyIndex: Map<string, string>;
  metricIndex: Map<string, string>;
  err: (code: string, at: string, message: string, hint?: string) => void;
  warn: (code: string, at: string, message: string, hint?: string) => void;
  onRow: ((row: IngestFactRow) => void) | undefined;
  writeEmptyMeasures: boolean;
}

function readBlockShape(sheet: Sheet, block: IngestBlock, ctx: BlockReadContext): IngestBlockShape {
  const { source, si, bi, maxRows, companyIndex, metricIndex, err, warn, onRow, writeEmptyMeasures } = ctx;
  const at = `${si}.${bi}`;
  const where = `sheets[${si}].blocks[${bi}]`;
  const anchor = parseRef(block.anchor);
  const rowCols = block.rows.map((r) => colLetter(colIndex(r.col)));
  const dimsOfRows = block.rows.map((r) => r.dim);
  const headerRow = block.values.headerRow ?? anchor.row - 1;
  // ★ 值列的有效清单走与 lint 同一个判据（跳过优先，见 effectiveValueColumns）。
  //   这里不再自己 flatMap skip —— 两处各写一遍就会分叉，那是旧导入层出过的错。
  const { cols: valueCols, badFromSkip } = effectiveValueColumns(block.values);
  const badSkip = new Set(badFromSkip);
  const skipCols: Array<{ col: string; why: string }> = [];
  for (const s of block.values.skip ?? []) {
    // 非法列号已经由 lintIngest 报成 SKIP_BAD_COLUMN（有 error 时根本走不到这里），
    // 这里只是不展开它、不让 dry-run 崩掉。
    if ((s.columns ?? []).some((c) => badSkip.has(String(c)))) continue;
    for (const c of expandColumns(s.columns)) skipCols.push({ col: c, why: s.why });
  }
  const measure = block.values.measure ?? 'amount';

  // ---- 值列的口径：位置优先，其次表头映射 ----
  const valueColumns = valueCols.map((col, i) => {
    const header = textAt(sheet, headerRow, colIndex(col));
    const byPos = block.values.periodTypes?.[i];
    const byHeader = header !== null ? block.values.periodTypeFromHeader?.[header] : undefined;
    return { col, header, periodType: byPos ?? byHeader ?? null };
  });
  const skipped = skipCols.map(({ col, why }) => ({ col, header: textAt(sheet, headerRow, colIndex(col)), why }));

  const needsPeriodTypeFromValues = !dimsOfRows.includes('period_type');
  if (needsPeriodTypeFromValues) {
    const unmapped = valueColumns.filter((v) => v.periodType === null);
    if (unmapped.length > 0) {
      err('HEADER_UNMAPPED', `${where}.values`,
        `有 ${unmapped.length} 个值列没有口径：${unmapped.map((u) => `${u.col}${u.header ? `（表头「${u.header}」）` : '（表头为空）'}`).join('、')}。`,
        '每个值列都必须能说清是哪个口径：用 values.periodTypes（按位置）或 values.periodTypeFromHeader（按表头文本）。' +
        ' 表头为空通常是合并单元格盖住了 —— 那就用 periodTypes 按位置写。');
    }
  }

  // ---- 网格外的固定键 ----
  const factsResolved: IngestBlockShape['factsResolved'] = [];
  const factValues = new Map<string, string>();
  for (const [dim, src] of Object.entries(block.facts ?? {})) {
    const s = src as { literal?: string; cell?: string };
    if (typeof s.literal === 'string') {
      factValues.set(dim, s.literal);
      factsResolved.push({ dim, from: 'literal', value: s.literal });
    } else if (typeof s.cell === 'string') {
      const ref = parseRef(s.cell);
      const v = textAt(sheet, ref.row, ref.col);
      factValues.set(dim, v ?? '');
      factsResolved.push({ dim, from: `cell ${s.cell}`, value: v });
      if (v === null) {
        err('FACT_CELL_EMPTY', `${where}.facts.${dim}`,
          `${s.cell} 是空的 —— 这一列/格就是"谁来填公司名"的位置，现在没人填。`,
          '引擎不会替你猜（文件名/上一批/唯一候选都不猜）：填上它再跑一次，或者改用 { literal: "..." }。');
      }
    }
  }

  // ---- 走行 ----
  const dropped: IngestBlockShape['dropped'] = [];
  const computed: IngestBlockShape['computed'] = [];
  const emptyRowsByDim: Array<{ dim: string; row: number }> = [];
  const seenRowKeys = new Map<string, { label: string; rows: number[] }>();
  const coordSeen = new Map<string, number>();
  const measureCells: CellStats = { total: 0, empty: 0, nonNumeric: 0 };
  const nonNumericByCol = new Map<string, number>();
  const nonNumericSample: number[] = [];
  const unmatchedCount = new Map<string, { kind: 'company' | 'metric'; name: string; rows: number }>();
  const periodSeen: Array<{ value: string; row: number; parsed: { year: number; month: number } | null }> = [];
  const periodKeyCol = (block.keys ?? []).find((k) => k.as === 'period')?.col;

  let dataRows = 0;
  let incomplete = 0;
  let coordTotal = 0;
  let stoppedAt = 0;
  for (let r = anchor.row; ; r++) {
    const labels = labelOf(sheet, r, rowCols);
    if (labels.every((x) => x === '')) break; // 行标签整行为空 = 数据区自然边界
    if (r - anchor.row >= maxRows) {
      err('TOO_MANY_ROWS', where,
        `数据行超过 ${maxRows} 行仍在继续（读到第 ${r} 行）。已读到的部分不可信。`,
        '请确认 anchor 有没有指错（指到了整张 sheet），或把数据区拆成多个 block。');
      stoppedAt = r;
      break;
    }
    // 展示用的行名：取第一个非空标签（行键里谁在前是声明顺序，不该决定名字）
    const label = labels.find((x) => x !== '') ?? '';
    // ★ 报错里说的名字：把行键**每一维**都连着自己的维度名写出来。
    //   只用 `label` 会让人看错对象 —— 行键 = (公司, 指标) 时报「华东子公司」重复，
    //   人去找"两家公司怎么重了"，而真正重复的是指标。
    const keyName = labels
      .map((x, i) => (x === '' ? null : `${COORD_CN[dimsOfRows[i]] ?? dimsOfRows[i]}=${x}`))
      .filter((x): x is string => x !== null)
      .join(' / ');

    // 丢行规则
    const dropLabel = (block.drop?.labels ?? []).find((x) => labels.includes(x));
    const dropPrefix = (block.drop?.prefixes ?? []).find((x) => labels.some((l) => l.startsWith(x)));
    if (dropLabel !== undefined || dropPrefix !== undefined) {
      dropped.push({ row: r, label: label || labels.filter(Boolean).join('/'), by: dropLabel ? `label「${dropLabel}」` : `prefix「${dropPrefix}」` });
      continue;
    }

    // 空行键（rename/空公司名会建出无名主数据）
    const rowDimOf = new Map<string, string | null>();
    rowCols.forEach((c, i) => {
      const v = labels[i];
      const existing = rowDimOf.get(dimsOfRows[i]);
      if (v !== '' && (existing === undefined || existing === null)) rowDimOf.set(dimsOfRows[i], v);
      else if (existing === undefined) rowDimOf.set(dimsOfRows[i], null);
    });
    for (const [dim, v] of rowDimOf) {
      if (v === null) emptyRowsByDim.push({ dim, row: r });
    }

    // 公式行（底部合计）
    for (const c of [...valueCols, ...skipped.map((s) => s.col)]) {
      const f = sheet.cell(r, colIndex(c)).formula();
      if (f) {
        computed.push({ row: r, label: label, formula: String(f) });
        break;
      }
    }

    // 值格计数（只看空/非数字，不看值）
    for (const c of valueCols) {
      const v = sheet.cell(r, colIndex(c)).value();
      measureCells.total++;
      if (isEmptyValue(v)) measureCells.empty++;
      else if (typeof v !== 'number') {
        measureCells.nonNumeric++;
        nonNumericByCol.set(c, (nonNumericByCol.get(c) ?? 0) + 1);
        // 只记坐标，绝不记那个字符串 —— 它可能是「（5,000）」这种带金额的写法
        if (nonNumericSample.length < 8) nonNumericSample.push(r);
      }
    }

    // 期数
    if (periodKeyCol) {
      const raw = textAt(sheet, r, colIndex(periodKeyCol));
      if (raw !== null) periodSeen.push({ value: raw, row: r, parsed: parsePeriodText(raw) });
    }
    const periodText = periodKeyCol
      ? (textAt(sheet, r, colIndex(periodKeyCol)) ?? '')
      : (factValues.get('period') ?? '');

    // 行键重复
    const rowKey = labels.map((x) => normalizeName(x)).join('\u0001');
    const hit = seenRowKeys.get(rowKey);
    if (hit) hit.rows.push(r);
    else seenRowKeys.set(rowKey, { label: keyName || label || labels.filter(Boolean).join('/'), rows: [r] });

    // 坐标（宽表展开：行键 × 每个值列的口径）
    const company = rowDimOf.get('company') ?? factValues.get('company') ?? null;
    const metric = rowDimOf.get('metric') ?? factValues.get('metric') ?? null;
    for (const vc of valueColumns) {
      coordTotal++;
      const periodType = dimsOfRows.includes('period_type') ? rowDimOf.get('period_type') ?? null : vc.periodType;
      if (!company || !metric || !periodType || !periodText) incomplete++;
      else {
        const key = [company, metric, periodText, periodType].map((x) => normalizeName(x)).join('|');
        coordSeen.set(key, (coordSeen.get(key) ?? 0) + 1);
        // ★ 只有执行器（run.ts）会走到这里。金额在这一行里读完就交出去，不落到 shape / issues / 日志里。
        //   空值格默认不回调（空不是 0，也不是一条事实）—— 规格写 onEmptyMeasure: null 才落 NULL。
        const raw = sheet.cell(r, colIndex(vc.col)).value();
        if (onRow && (writeEmptyMeasures || typeof raw === 'number')) {
          const p = parsePeriodText(periodText);
          onRow({
            source,
            sheet: sheet.name(),
            block: bi,
            row: r,
            company,
            metric,
            period: p ? `${p.year}-${String(p.month).padStart(2, '0')}` : periodText,
            periodType,
            amount: typeof raw === 'number' ? raw : null,
          });
        }
      }
    }

    // 未识别主数据
    for (const [kind, name, index] of [
      ['company', company, companyIndex],
      ['metric', metric, metricIndex],
    ] as Array<['company' | 'metric', string | null, Map<string, string>]>) {
      if (!name) continue;
      if (!index.has(normalizeName(name))) {
        const prev = unmatchedCount.get(`${kind}|${normalizeName(name)}`);
        if (prev) prev.rows++;
        else unmatchedCount.set(`${kind}|${normalizeName(name)}`, { kind, name, rows: 1 });
      }
    }

    dataRows++;
  }

  // ---- 汇总 ----
  const duplicates = [...seenRowKeys.values()].filter((x) => x.rows.length > 1);
  if (duplicates.length > 0) {
    err('ROWKEY_DUPLICATE_IN_FILE', where,
      `有 ${duplicates.length} 组行键重复：${duplicates.slice(0, 5).map((d) => `「${d.label}」在第 ${d.rows.join('、')} 行`).join('；')}${duplicates.length > 5 ? ` …共 ${duplicates.length} 组` : ''}。`,
      '同一个坐标只允许一个值：重复的行会互相覆盖（后写赢），另一行的数静默消失。请先在源里改掉，或把它们并入同一行。');
  }

  const undropped = computed.filter((c) => !dropped.some((d) => d.row === c.row));
  if (undropped.length > 0) {
    err('COMPUTED_ROW_NOT_DROPPED', where,
      `有 ${undropped.length} 行带公式（合计/小计）却没被 drop 排掉：第 ${undropped.slice(0, 5).map((c) => c.row).join('、')}${undropped.length > 5 ? ' …' : ''} 行。`,
      '合计行会与明细行一起入库，同一坐标被写两次（一个真值 + 一个求和值）。请用 drop.labels / drop.prefixes 排掉它。');
  }

  if (measureCells.nonNumeric > 0) {
    const cols = [...nonNumericByCol.entries()].map(([c, n]) => `${c} 列 ${n} 处`).join('、');
    err('MEASURE_NON_NUMERIC', where,
      `值列里有 ${measureCells.nonNumeric} 个格子不是数字（${cols}；第 ${nonNumericSample.join('、')} 行等）。`,
      '引擎不会把它们当 0、也不会当空 —— 旧实现把「1,234」「12%」「—」「N/A」一律 Number() 成 NaN 再变 NULL，' +
        '和真空格子无法区分，而文案只写「金额为空」。请在源里改成纯数字，或把这类格子排除出值列' +
        '（哪些写法算缺失必须由规格声明，不能由引擎猜）。');
  }

  for (const [dim, rows] of groupRows(emptyRowsByDim)) {
    err('ROWKEY_EMPTY_IN_FILE', where,
      `行键「${dim}」在第 ${rows.slice(0, 8).join('、')}${rows.length > 8 ? ` …共 ${rows.length}` : ''} 行是空的。`,
      dim === 'company'
        ? '公司名为空会建出一条无名主数据，钱从此挂在一个查不到的名字上。空行必须先在源里补齐或排掉。'
        : '空的名会建出无名主数据；请在源里补齐或排掉这些行。');
  }

  let period: IngestBlockShape['period'] = null;
  if (periodSeen.length > 0) {
    const distinct = [...new Set(periodSeen.map((p) => p.value))];
    const unparsed = periodSeen.filter((p) => p.parsed === null);
    if (unparsed.length > 0) {
      err('PERIOD_UNPARSEABLE', where,
        `期数解析不出来的写法：${[...new Set(unparsed.map((u) => u.value))].slice(0, 5).map((v) => `「${v}」`).join('、')}（第 ${unparsed.slice(0, 5).map((u) => u.row).join('、')} 行等）。`,
        '识别的写法：2026-06 / 2026/6 / 2026年6月 / 202606。认不出就报错 —— 旧实现把认不出的期数原样塞进 SQL，直到落库那一刻才炸成 500。');
    } else if (distinct.length > 1) {
      err('PERIOD_INCONSISTENT', where,
        `期数列在同一块里出现了 ${distinct.length} 个不同的期：${distinct.slice(0, 5).map((v) => `「${v}」`).join('、')}。`,
        '一个 block 只能属于一个期。多期请拆成多个 block（期数不是"第一个赢"的字段）。');
    } else {
      const p = periodSeen[0].parsed!;
      period = { year: p.year, month: p.month, evidence: `表头/期数列 ${periodKeyCol} 整块为同一期，取第 ${periodSeen[0].row} 行` };
    }
  } else if (factValues.get('period')) {
    const p = parsePeriodText(factValues.get('period')!);
    if (p) period = { year: p.year, month: p.month, evidence: `facts.period = ${factValues.get('period')}` };
    else err('PERIOD_UNPARSEABLE', `${where}.facts.period`, `期数「${factValues.get('period')}」认不出来。`);
  }

  const unmatched = [...unmatchedCount.values()].sort((a, b) => b.rows - a.rows);
  if (unmatched.length > 0) {
    const byKind = (k: 'company' | 'metric') => unmatched.filter((u) => u.kind === k);
    for (const k of ['company', 'metric'] as const) {
      const list = byKind(k);
      if (list.length === 0) continue;
      // ★ 只能是 warn：读取层的职责是说清「源里有哪些名字、库里对不上」，
      //   而「要不要新建 / 要不要并进谁」是落库层按 unknownMaster 与人工决定去办的。
      //   把它当 error，等于让「库里还没有这个指标」这件最普通的事永远跑不起来。
      warn('UNMATCHED_MASTER', where,
        `有 ${list.length} 个${k === 'company' ? '公司' : '指标'}名在库里找不到：${list.slice(0, 8).map((u) => `「${u.name}」(${u.rows} 行)`).join('、')}${list.length > 8 ? ` …共 ${list.length} 个` : ''}。`,
        `不认识的主数据必须由人拍板：${
          k === 'company' ? '并入某家已有公司' : '并入某个已有指标'
        }、还是确认这是一条新建的主数据。引擎既不自动新建（会把同一家拆成两家），也不自动归并（错合并比不合并危险得多）。`);
    }
  }

  if (dataRows === 0) {
    err('NO_DATA_ROWS', where, `锚点 ${block.anchor} 往下没有读到任何数据行（行标签列 ${rowCols.join('/')} 整列为空）。`,
      '请确认 anchor 指在第一个值格上、且行标签列填的不是别的东西。');
  }
  if (stoppedAt === 0 && dataRows >= maxRows) {
    warn('AT_MAX_ROWS', where, `正好读到 ${maxRows} 行上限，后面可能还有内容。`);
  }
  // ★ 空模板 vs 缺数据：两者的形状一样（一行都落不了库），但人要做的事完全不同。
  //   空模板要的是"结构先记下来"，缺数据要的是"回去补"。所以这里必须说出来是哪一种，
  //   而不是让人从「130 行都是空的」里自己猜。**只报形状，不放松任何判据**。
  if (dataRows > 0 && measureCells.total > 0 && measureCells.empty === measureCells.total) {
    warn('SOURCE_LOOKS_EMPTY', where,
      `${dataRows} 行数据行的 ${measureCells.total} 个值格**全是空的** —— 这个源看起来是一份空模板。`,
      '它现在一行都落不了库（空不是 0，也不是一条事实），但结构和坐标可以从这份模板读出来：' +
        `行标签在 ${rowCols.join('/')}、值列 ${valueColumns.length} 个、` +
        (period ? `期数 ${period.year}-${String(period.month).padStart(2, '0')}` : '期数没读到') +
        '。先用它把规格写好，等有数的文件来了再用同一份规格跑。');
  }

  return {
    sheet: sheet.name(),
    anchor: block.anchor,
    headerRow,
    rows: block.rows.map((r) => ({ col: colLetter(colIndex(r.col)), dim: r.dim })),
    dataRows,
    dropped,
    duplicates: duplicates.map((d) => ({ label: d.label, rows: d.rows })),
    computed,
    emptyKeys: [...groupRows(emptyRowsByDim)].map(([dim, rows]) => ({ dim, rows: rows.slice(0, 8), count: rows.length })),
    valueColumns,
    skipped,
    measure,
    measureCells,
    coordinates: {
      total: coordTotal,
      incomplete,
      duplicates: [...coordSeen.entries()].filter(([, n]) => n > 1).map(([key, count]) => ({ key, count })),
    },
    period,
    unmatched,
    factsResolved,
  };
}

function groupRows(items: Array<{ dim: string; row: number }>): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const { dim, row } of items) {
    const arr = m.get(dim) ?? [];
    arr.push(row);
    m.set(dim, arr);
  }
  return m;
}
