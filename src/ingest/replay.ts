// ★ 标准化层的重放对拍（架构 §4.7）：`bilite replay` 的**唯一实现**，判据不许另写一份。
//   用接入规格从**库内 raw** 重展一遍（源文件删了也能重放 —— raw_cell 是可重放的依据），
//   与该 spec 最新批次的 stg_fact_rows 逐格对拍：键 (sheet, block, row, value_col)；
//   值 period / company_raw / metric_raw / period_type / amount / deg 全等。
//   ★ 零金额出口：结论只含计数与不一致的**坐标 + 字段名**，不回显任何值
//     （与 planOf 同一条纪律；stg 含金额，与 fact 同级安全面，e2e 钉着）。

import { dryRunIngest, type IngestFactRow, type IngestSpec } from './dryrun.ts';
import { masterCatalog } from './master.ts';
import { rawWorkbook } from '../land/read.ts';
import { lit } from '../land/raw.ts';
import { query } from '../db/index.ts';

export interface ReplayMismatch {
  sheet: string;
  block: number;
  row: number;
  valueCol: string;
  /** period / company_raw / metric_raw / period_type / amount / deg */
  field: string;
}

export interface ReplayDiff {
  specId: string;
  batchId: string;
  /** raw = 从库内 raw 重放（默认）；source-file = 显式 --source 开当前文件重展 */
  mode: 'raw' | 'source-file';
  stgRows: number;
  replayedRows: number;
  /** 重展有、库内该批没有 */
  missingInStg: number;
  /** 库内有、重展没有 */
  extraInStg: number;
  /** 值不一致的坐标+字段（截断到 MISMATCH_CAP 条；全量看 mismatchTotal） */
  mismatches: ReplayMismatch[];
  mismatchTotal: number;
  ok: boolean;
}

/** 大面积不一致时只回前 50 条坐标 —— 对拍结论是给人看的，不是给循环遍历的 */
const MISMATCH_CAP = 50;

/** deg 规范化（键排序 JSON；空对象 = NULL）。与 run.ts 物化时的写法互为镜像 —— 两处漂移会当场对拍红，不会静默 */
function degJsonOf(r: IngestFactRow): string | null {
  const keys = Object.keys(r.deg).sort();
  return keys.length > 0 ? JSON.stringify(Object.fromEntries(keys.map((k) => [k, r.deg[k]!]))) : null;
}

export async function replaySpec(spec: IngestSpec, opts: { source?: string } = {}): Promise<ReplayDiff> {
  // ① 该 spec 的最新批次。stg 里一行都没有 = 从未落库 —— **响亮报**，不静默当"空对空"通过
  //   （"都对不上"和"根本没有"是两回事，后者更该停下来）。
  const b = await query<{ batch_id: string; file_hash: string }>(
    `SELECT batch_id, file_hash FROM stg_fact_rows WHERE spec_id = ${lit(spec.id)} ORDER BY loaded_at DESC LIMIT 1`,
  );
  const batchId = b[0]?.batch_id;
  if (!batchId || typeof batchId !== 'string') {
    throw new Error(
      `SPEC_NOT_INGESTED：规格 ${spec.id} 在 stg_fact_rows 里没有任何批次 —— ` +
        `它从未被 ingest run 落过库，没有可对拍的对象。`,
    );
  }
  const fileHash = b[0]!.file_hash;
  const stgCount = await query<{ n: number }>(
    `SELECT count(*) AS n FROM stg_fact_rows WHERE batch_id = ${lit(batchId)}`,
  );
  const stgRows = Number(stgCount[0]?.n ?? 0);

  // ② 重展。默认从库内 raw 重放（openBook 口子 —— 与 run.ts 落库用的是**同一个**重放依据，
  //    这样"源文件还在不在"根本不影响对拍）；显式 --source 时开当前文件，对拍"源改了没"。
  const rows: IngestFactRow[] = [];
  const cat = await masterCatalog();
  await dryRunIngest(spec, {
    catalog: cat,
    ...(opts.source ? { source: opts.source } : { openBook: () => rawWorkbook(fileHash) }),
    // ★ 与 run.ts 落库同一份解法（onEmptyMeasure → writeEmptyMeasures），
    //   否则"落库写了 NULL 行、重展不回调"会成批假红。
    writeEmptyMeasures: (spec.onEmptyMeasure ?? 'skip') === 'null',
    onRow: (r) => rows.push(r),
  });

  // ③ 逐格对拍。
  const keyOf = (sheet: string, block: number, row: number, col: string): string =>
    `${sheet}\u0001${block}\u0001${row}\u0001${col}`;
  const replayed = new Map<string, IngestFactRow>();
  for (const r of rows) replayed.set(keyOf(r.sheet, r.block, r.row, r.col), r);

  const stg = await query<{
    sheet: string;
    block: number;
    row_no: number;
    value_col: string;
    period: string;
    company_raw: string;
    metric_raw: string;
    period_type: string | null;
    amount: number | null;
    deg: string | null;
  }>(
    `SELECT sheet, block, row_no, value_col, period, company_raw, metric_raw, period_type, amount, deg
     FROM stg_fact_rows WHERE batch_id = ${lit(batchId)}`,
  );

  const mismatches: ReplayMismatch[] = [];
  let mismatchTotal = 0;
  let extraInStg = 0;
  const stgKeys = new Set<string>();
  for (const s of stg) {
    const k = keyOf(s.sheet, s.block, s.row_no, s.value_col);
    stgKeys.add(k);
    const r = replayed.get(k);
    if (!r) {
      extraInStg++;
      continue;
    }
    const push = (field: string) => {
      mismatchTotal++;
      if (mismatches.length < MISMATCH_CAP) {
        mismatches.push({ sheet: s.sheet, block: s.block, row: s.row_no, valueCol: s.value_col, field });
      }
    };
    // ★ 只记坐标+字段名，不回显两侧的值。
    if (s.period !== r.period) push('period');
    if (s.company_raw !== r.company) push('company_raw');
    if (s.metric_raw !== r.metric) push('metric_raw');
    if ((s.period_type ?? null) !== (r.periodType ?? null)) push('period_type');
    if ((s.amount ?? null) !== (r.amount ?? null)) push('amount');
    if ((s.deg ?? null) !== degJsonOf(r)) push('deg');
  }
  let missingInStg = 0;
  for (const k of replayed.keys()) if (!stgKeys.has(k)) missingInStg++;

  return {
    specId: spec.id,
    batchId,
    mode: opts.source ? 'source-file' : 'raw',
    stgRows,
    replayedRows: rows.length,
    missingInStg,
    extraInStg,
    mismatches,
    mismatchTotal,
    ok: stgRows === rows.length && missingInStg === 0 && extraInStg === 0 && mismatchTotal === 0,
  };
}
