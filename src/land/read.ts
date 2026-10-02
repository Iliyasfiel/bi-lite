/**
 * 从 `raw_cell` 读回一个**可读工作簿**（`src/spec/template.ts` 的 `ReadableWorkbook`）。
 *
 * ★ 它存在的意义：让接入层不必每次去开 xlsx。源文件的解析规则（哪一列指什么、
 *   口径怎么映射）属于接入规格；而**格里的值**应当只有一个来源 —— 着陆层。
 *   于是"重放"才成立：删掉 stg/dim/fact、只留 raw，重跑一遍就能得到同一张事实表。
 *
 * ★ 这是**忠实还原**，不是重新解读：`value_kind` 决定还原成数字还是文本，
 *   原样存下的 `raw_value` 直接还回去，公式文本也一并还回 —— 不 trim、不做单位换算、
 *   不猜类型。凡是"解读"，都发生在接入层，不在这里。
 */
import { query } from '../db/index.ts';
import type { ReadableCell, ReadableSheet, ReadableWorkbook } from '../spec/template.ts';

interface StoredCell {
  kind: string;
  raw: string | null;
  formula: string | null;
}

/** `value_kind` + `raw_value` → 还原成工作簿里那种 JS 值。空的格还原成 `undefined`（与 xlsx-populate 一致） */
function restore(kind: string, raw: string | null): unknown {
  if (raw === null) return undefined;
  if (kind === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (kind === 'bool') return raw === 'true';
  if (kind === 'date') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return raw; // text
}

/** SQL 字符串字面量转义。⚠️ 本仓库另有几份同功能实现，待收拢 */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/**
 * 把某个 `file_hash` 已经着陆的格子读成一个 `ReadableWorkbook`。
 *
 * @param fileHash `raw_file.file_hash`（先经 `landRawFile()` 或 `findRawFile()` 拿到）
 * @throws 库里没有这个 hash 的格子（**不返回空壳**：空工作簿会让上层以为"源里什么都没有"）
 */
export async function rawWorkbook(fileHash: string): Promise<ReadableWorkbook> {
  const stored = await query<{
    sheet: string;
    row_no: number;
    col_no: number;
    value_kind: string;
    raw_value: string | null;
    formula: string | null;
  }>(
    `SELECT sheet, row_no, col_no, value_kind, raw_value, formula ` +
      `FROM raw_cell WHERE file_hash = ${lit(fileHash)}`,
  );
  if (stored.length === 0) throw new Error(`raw 里没有 file_hash=${fileHash} 的格子（先 landRawFile()）`);

  const bySheet = new Map<string, Map<string, StoredCell>>();
  for (const r of stored) {
    let cells = bySheet.get(r.sheet);
    if (!cells) {
      cells = new Map();
      bySheet.set(r.sheet, cells);
    }
    cells.set(`${Number(r.row_no)}.${Number(r.col_no)}`, {
      kind: r.value_kind,
      raw: r.raw_value,
      formula: r.formula,
    });
  }

  // sheet 名字按字典序（raw_cell 里没有顺序列）。顺序只在"找不到 sheet"的报错里被列出，
  // 不影响任何判据 —— 接入规格按名字取 sheet。
  const sheets: ReadableSheet[] = [...bySheet.keys()].sort().map((name) => {
    const cells = bySheet.get(name)!;
    return {
      name: () => name,
      cell: (row: number, col: number): ReadableCell => {
        const c = cells.get(`${row}.${col}`);
        return {
          value: () => (c ? restore(c.kind, c.raw) : undefined),
          formula: () => c?.formula ?? null,
        };
      },
    };
  });

  return {
    sheets: () => sheets,
    sheet: (name: string) => sheets.find((s) => s.name() === name),
  };
}
