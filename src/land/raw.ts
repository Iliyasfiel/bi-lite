/**
 * 着陆层：源文件 → `raw_file` / `raw_cell`（架构 §4.1 ②、§6.1 ①②；docs/开发计划.md §1.1）
 *
 * ★ 这一层存在的唯一理由：**让"可重放"有个物理依据。**
 *   自动化清洗 / 单位换算 / 符号处理的每一步都会改变数字；只有源文件的**原样副本**
 *   能让人在三个月后回答"这个数当初是从哪个格读出来的"。所以：
 *   - **append-only**：写进去就不改（同一 `file_hash` 第二次进来直接复用，一格都不重写）。
 *   - **只存有值的格**：空格由"没有这一行"表达。这张表与源文件大小成正比，是全库最大的一组。
 *   - **`raw_value` 不做 trim**：与 `spec/template.ts` 的 `textAt()` 刻意不同 ——
 *     那里的 trim 是给人看标签用的，这里的责任是"原样"，trim 掉就不可逆了。
 *
 * ★ 幂等靠 `file_hash`（sha256 of 字节），不靠文件名、不靠时间戳：
 *   同一份文件改个名字再传，仍然不会产生第二份 raw。
 *
 * ★ **撞上扫描上限 = 报错，不落库**。"raw 只有一半"比"没有 raw"危险得多 ——
 *   下游会把它当成完整的重放依据，于是**静默少数据**。宁可当场失败，也不留半份。
 *
 * ⚠️ **本模块不参与任何判据**：它不做类型推断、不做单位换算、不判断哪一格是金额。
 *   解析规则属于接入规格 (`src/ingest/`)，这里只是搬运。
 */
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execute, query } from '../db/index.ts';
import { resolveSource } from '../paths.ts';
import { openTemplate, usesDate1904 } from '../spec/template.ts';
import type { Sheet } from 'xlsx-populate';

/**
 * 单个 sheet 的扫描上限。
 *
 * ★ 取值必须 **≥ 接入层的 `maxRows` 默认值（20000）**：着陆层扫到的行比接入层读到的少，
 *   就意味着"重放会少数据"，而那是**不报错**的那种少。两边对齐后，撞上限只在
 *   真的异常（误指了一个超大文件）时发生，而那时我们**直接报错**（见 landRawFile）。
 */
export const RAW_SCAN_ROWS = 20000;
export const RAW_SCAN_COLS = 512;

/** 一次 INSERT 拼多少行。太大 SQL 文本过长，太小则慢 */
const INSERT_CHUNK = 500;

export interface RawSheetCount {
  name: string;
  /** 真正落库的非空格数 */
  cells: number;
}

export interface RawLanding {
  fileHash: string;
  filename: string;
  sizeBytes: number;
  /** true = 这份文件此前已经着陆过，本次**一格都没重写** */
  reused: boolean;
  sheets: RawSheetCount[];
  cellsWritten: number;
}

/** SQL 字符串字面量转义。⚠️ 本仓库另有几份同功能实现（compile.ts / semantic/query.ts / ingest/run.ts），待收拢 */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 单元格值的种类。缺了它，重放时"这个格本来是数字还是文本"就分不出来 */
type ValueKind = 'text' | 'number' | 'bool' | 'date';

function classify(v: unknown): { kind: ValueKind; text: string } | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v === '' ? null : { kind: 'text', text: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'number', text: String(v) } : null;
  if (typeof v === 'boolean') return { kind: 'bool', text: v ? 'true' : 'false' };
  if (v instanceof Date) return { kind: 'date', text: v.toISOString() };
  return null; // 富文本片段之类：不猜，宁可少存也不存错
}

/** 公式文本（xlsx-populate 的 `Cell.formula` 未在 d.ts 里声明，故做窄化访问，与 spec/template.ts 同法） */
function formulaOf(sheet: Sheet, row: number, col: number): string | null {
  try {
    const cell = sheet.cell(row, col) as unknown as { formula?: () => string | null };
    const f = typeof cell.formula === 'function' ? cell.formula() : null;
    return typeof f === 'string' && f.trim() ? f.trim() : null;
  } catch {
    return null;
  }
}

function colLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export interface RawCellRow {
  sheet: string;
  row: number;
  col: number;
  ref: string;
  kind: ValueKind;
  text: string;
  formula: string | null;
}

/**
 * 把一份工作簿里的格读出来（**纯读，不碰库**）—— 便于脱库测试与复用。
 *
 * @returns `cells` 非空格；`sheets` 各 sheet 的计数；`clipped` **撞上扫描上限的 sheet 名**
 *          （调用方必须就它做决断：落库前报错，而不是存一份残缺的 raw）
 */
export async function readRawCells(
  absPath: string,
  opts: { maxRows?: number; maxCols?: number } = {},
): Promise<{ cells: RawCellRow[]; sheets: RawSheetCount[]; clipped: string[] }> {
  const maxRows = Math.min(Math.max(opts.maxRows ?? RAW_SCAN_ROWS, 1), RAW_SCAN_ROWS);
  const maxCols = Math.min(Math.max(opts.maxCols ?? RAW_SCAN_COLS, 1), RAW_SCAN_COLS);

  const wb = await openTemplate(absPath);
  // ★ 1904 日期系统的工作簿**不许着陆**。理由不是"读不了"，而是**着陆会造出一个重放陷阱**：
  //   raw 里存的是序列号（`46174` 这样的数字），而"这是 1900 还是 1904 系统"没地方存 ——
  //   于是重放时只能按一个基准去读，两套系统差 1462 天（实测），期数会整体差 4 年。
  //   与其留一份"重放得出另一个答案"的 raw，不如在这里明确拒绝（接入层打开源文件时也会拒）。
  if (await usesDate1904(absPath)) {
    throw new Error(
      `源文件 ${absPath} 用的是 **1904 日期系统**，无法着陆：raw 只存格里的序列号，`
      + '不存"哪套日期系统"这件事，重放时会把期数读偏 4 年。'
      + '请在 Excel 里改成 1900 系统（选项 → 高级 → 取消勾选"使用 1904 日期系统"）后重试。',
    );
  }
  const cells: RawCellRow[] = [];
  const sheets: RawSheetCount[] = [];
  const clipped: string[] = [];

  for (const sheet of wb.sheets() as unknown as Sheet[]) {
    const name = sheet.name();
    const used = sheet.usedRange();
    if (!used) {
      sheets.push({ name, cells: 0 });
      continue;
    }
    const first = used.startCell();
    const last = used.endCell();
    const rowFrom = first.rowNumber();
    const rowTo = Math.min(last.rowNumber(), rowFrom + maxRows - 1);
    const colFrom = first.columnNumber();
    const colTo = Math.min(last.columnNumber(), colFrom + maxCols - 1);
    if (last.rowNumber() > rowTo || last.columnNumber() > colTo) clipped.push(name);

    let n = 0;
    for (let r = rowFrom; r <= rowTo; r++) {
      for (let c = colFrom; c <= colTo; c++) {
        const cell = sheet.cell(r, c);
        const cls = classify(cell.value());
        if (!cls) continue;
        n++;
        cells.push({
          sheet: name,
          row: r,
          col: c,
          ref: `${colLetter(c)}${r}`,
          kind: cls.kind,
          text: cls.text,
          formula: formulaOf(sheet, r, c),
        });
      }
    }
    sheets.push({ name, cells: n });
  }

  return { cells, sheets, clipped };
}

/** 该文件是否已经着陆过；已着陆则返回当时落下的 sheet 统计 */
async function existing(fileHash: string): Promise<RawSheetCount[] | null> {
  const rows = await query<{ file_hash: string }>(
    `SELECT file_hash FROM raw_file WHERE file_hash = ${lit(fileHash)}`,
  );
  if (rows.length === 0) return null;
  const counts = await query<{ sheet: string; n: number }>(
    `SELECT sheet, count(*) AS n FROM raw_cell WHERE file_hash = ${lit(fileHash)} GROUP BY sheet ORDER BY sheet`,
  );
  return counts.map((c) => ({ name: c.sheet, cells: Number(c.n) }));
}

/**
 * 记下「源路径 → 这份 raw」。
 *
 * ★ **复用（reused）时也要记**：同一份文件被拷到另一个路径再传，内容没变、raw 直接复用，
 *   但那个新路径此前没被记过 —— 不记的话，源文件一删，从新路径就再也找不回 raw 了。
 *   路径 → hash 是多对一，所以它是独立的一张表，不是 raw_file 上的一列。
 */
async function rememberSource(source: string, fileHash: string): Promise<void> {
  await execute(
    `INSERT INTO raw_source (source_path, file_hash, seen_at) VALUES (${lit(source)}, ${lit(fileHash)}, now()) ` +
      `ON CONFLICT (source_path) DO UPDATE SET file_hash = EXCLUDED.file_hash, seen_at = EXCLUDED.seen_at`,
  );
}

/**
 * 这份源文件对应的 raw 是哪个？返回 `file_hash`，找不到返回 `null`。
 *
 * ★ **不写库** —— 干跑（`planOnly`）靠它决定"读 raw 还是读工作簿"，
 *   而干跑的契约是"一次库都不写"。
 *
 * 两步走，顺序不能反：
 *   ① 文件还在 → 按**内容**找。最准：内容变了就是另一份 raw，不会张冠李戴。
 *   ② 文件不在了（或换了内容）→ 按**当初记下的路径**找回最近一次着陆。
 *      没有 ②，"重放"就依赖源文件还在 —— 而源文件恰恰是最容易丢的东西。
 */
export async function findRawFile(source: string): Promise<string | null> {
  // ① 内容找
  let abs: string | null = null;
  try {
    abs = resolveSource(source);
  } catch {
    abs = null; // 白名单外：不可能被着陆过，② 自然查不到；真正的拒绝由 dryRunIngest 给出
  }
  if (abs && fs.existsSync(abs)) {
    const hash = sha256(fs.readFileSync(abs));
    if (await existing(hash)) return hash;
  }
  // ② 路径找（并确认那份 raw 确实在，别返回一个悬空 hash）
  const rows = await query<{ file_hash: string }>(
    `SELECT file_hash FROM raw_source WHERE source_path = ${lit(source)} ORDER BY seen_at DESC LIMIT 1`,
  );
  const hash = rows[0]?.file_hash ?? null;
  return hash && (await existing(hash)) ? hash : null;
}

/**
 * 把一份源文件原样着陆。
 *
 * **幂等**：同一 `file_hash` 第二次调用**一格都不重写**，返回 `reused: true`
 * 与首次落下的统计 —— 于是"同一份文件跑两次，raw_cell 行数不变"是结构上成立的，
 * 而不是靠调用方记得先查。
 *
 * @param source 源文件路径（必须在 `src/paths.ts` 的白名单目录内）
 * @throws 路径不在白名单内、文件不存在、**撞上扫描上限**，或写库失败
 *         （**不吞异常**，铁律 12；撞上限也抛，因为半份 raw 会让下游静默少数据）
 */
export async function landRawFile(
  source: string,
  opts: { maxRows?: number; maxCols?: number } = {},
): Promise<RawLanding> {
  const abs = resolveSource(source); // ★ 白名单判据只有一份（src/paths.ts），此处不另写
  if (!fs.existsSync(abs)) throw new Error(`源文件不存在：${source}（解析为 ${abs}）`);

  const bytes = fs.readFileSync(abs);
  const fileHash = sha256(bytes);
  const filename = abs.split('/').pop() ?? abs;

  const prior = await existing(fileHash);
  if (prior) {
    // ★ 复用也要记路径：同一份文件被拷到别的路径传进来时，那个路径此前没被记过
    await rememberSource(source, fileHash);
    return { fileHash, filename, sizeBytes: bytes.byteLength, reused: true, sheets: prior, cellsWritten: 0 };
  }

  const { cells, sheets, clipped } = await readRawCells(abs, opts);
  if (clipped.length > 0) {
    throw new Error(
      `着陆被截断：${clipped.join('、')} 超过扫描上限（每个 sheet 最多 ${RAW_SCAN_ROWS} 行 / ` +
        `${RAW_SCAN_COLS} 列）。**半份 raw 会让重放静默少数据**，所以这里不落库。` +
        `请调大 src/land/raw.ts 的 RAW_SCAN_*，或把该 sheet 拆小。`,
    );
  }

  const now = 'now()';
  await execute('BEGIN');
  try {
    await execute(
      `INSERT INTO raw_file (file_hash, filename, size_bytes, received_at) VALUES ` +
        `(${lit(fileHash)}, ${lit(filename)}, ${bytes.byteLength}, ${now})`,
    );
    await rememberSource(source, fileHash);
    for (let i = 0; i < cells.length; i += INSERT_CHUNK) {
      const values = cells
        .slice(i, i + INSERT_CHUNK)
        .map(
          (c) =>
            `(${lit(fileHash)}, ${lit(c.sheet)}, ${c.row}, ${c.col}, ${lit(c.ref)}, ` +
            `${lit(c.kind)}, ${lit(c.text)}, ${c.formula === null ? 'NULL' : lit(c.formula)}, ${now})`,
        )
        .join(',\n         ');
      await execute(
        `INSERT INTO raw_cell (file_hash, sheet, row_no, col_no, cell_ref, value_kind, raw_value, formula, loaded_at) VALUES ${values}`,
      );
    }
    await execute('COMMIT');
  } catch (e) {
    // 半截的 raw 比没有 raw 更坏：它看起来是"重放的依据"，其实缺格
    await execute('ROLLBACK');
    throw e;
  }

  return {
    fileHash,
    filename,
    sizeBytes: bytes.byteLength,
    reused: false,
    sheets,
    cellsWritten: cells.length,
  };
}

/** 只读：这份文件在 raw 里有多少格、按 sheet 分（给断言与将来的 UI 用） */
export async function rawSummary(fileHash: string): Promise<RawSheetCount[]> {
  return (await existing(fileHash)) ?? [];
}
