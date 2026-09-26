/**
 * Excel 长表导入（docs/需求与架构.md §4.6）
 *
 * 财务数据从公司平台导出为长表：财务期月份 × 公司名称 × 指标名称 × 口径 → 金额
 * 导入三态：STAGED → SYNCING → READY / ERROR
 *
 * 关键：整个链路不经过 LLM（安全设计 §6.2 第⑤层）。
 */
import XLSXPopulate from 'xlsx-populate';
import { execute, query, writer } from '../db/index.ts';

export interface LongRow {
  fin_month: string;    // YYYY-MM-DD
  company: string;      // 公司名称（导入时映射为 id）
  metric: string;       // 指标名称
  period_type: string;  // 口径
  amount: number | null;
}

export interface StageResult {
  batchId: string;
  status: 'staged' | 'error';
  sourceFile: string;
  rowCount: number;
  /** 未识别的公司/指标名 —— 必须让人确认（§10 R1，最关键） */
  unknownCompanies: string[];
  unknownMetrics: string[];
  unknownPeriodTypes: string[];
  /** 校验问题清单 */
  issues: Array<{ level: 'error' | 'warn'; row?: number; message: string }>;
  /** 类型推断样例（§4.6.2 max-inferred-lines = 10） */
  sample: LongRow[];
}

const MAX_INFERRED_LINES = 10;

/** 从 xlsx 读长表。用 xlsx-populate 的只读能力，避免 exceljs 的崩溃问题。 */
export async function readLongTable(filePath: string, sheetName?: string): Promise<LongRow[]> {
  const wb = await XLSXPopulate.fromFileAsync(filePath);
  const sheet = sheetName ? wb.sheet(sheetName) : wb.sheets()[0];
  const used = sheet.usedRange();
  if (!used) return [];

  const endRow = used.endCell().rowNumber();
  const endCol = used.endCell().columnNumber();
  const startRow = used.startCell().rowNumber();

  // 表头（按中文列名识别，允许顺序不同）
  const header: Record<string, number> = {};
  for (let c = 1; c <= endCol; c++) {
    const v = sheet.cell(startRow, c).value();
    if (v !== undefined && v !== null) header[String(v).trim()] = c;
  }

  const col = (...names: string[]) => {
    for (const n of names) if (header[n] !== undefined) return header[n];
    return undefined;
  };
  const cMonth = col('财务期', '月份', '期间', 'fin_month');
  const cCompany = col('公司名称', '公司', 'company');
  const cMetric = col('指标名称', '指标', 'metric');
  const cPeriod = col('口径', '度量口径', 'period_type');
  const cAmount = col('金额', '数值', 'amount');

  const missing = [
    !cMonth && '财务期',
    !cCompany && '公司名称',
    !cMetric && '指标名称',
    !cPeriod && '口径',
    !cAmount && '金额',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`模板缺少必需列: ${missing.join(' / ')}（实际表头: ${Object.keys(header).join(', ')}）`);
  }

  const rows: LongRow[] = [];
  for (let r = startRow + 1; r <= endRow; r++) {
    const company = sheet.cell(r, cCompany!).value();
    const metric = sheet.cell(r, cMetric!).value();
    if (!company && !metric) continue; // 空行

    const rawAmount = sheet.cell(r, cAmount!).value();
    const amount = rawAmount === '' || rawAmount === undefined || rawAmount === null ? null : Number(rawAmount);

    rows.push({
      fin_month: normalizeMonth(sheet.cell(r, cMonth!).value()),
      company: String(company ?? '').trim(),
      metric: String(metric ?? '').trim(),
      period_type: String(sheet.cell(r, cPeriod!).value() ?? '').trim(),
      // 空串 → NULL（§4.6.2）
      amount: amount !== null && Number.isFinite(amount) ? amount : null,
    });
  }
  return rows;
}

function normalizeMonth(v: unknown): string {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-01`;
  }
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})[-/年]?(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-01`;
  return s;
}

/** STAGED 阶段：解析 + 校验，不写库 */
export async function stage(filePath: string, sheetName?: string): Promise<StageResult> {
  const batchId = `b${Date.now().toString(36)}`;
  const rows = await readLongTable(filePath, sheetName);
  const issues: StageResult['issues'] = [];

  if (rows.length === 0) issues.push({ level: 'error', message: '文件中没有数据行' });

  // 已知主数据
  const knownCompanies = new Set(
    (await query<{ name: string; alias: string[] | null }>('SELECT name, alias FROM dim_company')).flatMap((r) => [
      r.name,
      ...(r.alias ?? []),
    ]),
  );
  const knownMetrics = new Set(
    (await query<{ name: string; alias: string[] | null }>('SELECT name, alias FROM dim_metric')).flatMap((r) => [
      r.name,
      ...(r.alias ?? []),
    ]),
  );
  const knownPeriods = new Set(
    (await query<{ period_type: string }>('SELECT DISTINCT period_type FROM fact_finance')).map((r) => r.period_type),
  );

  const unknownCompanies = [...new Set(rows.map((r) => r.company))].filter((c) => !knownCompanies.has(c));
  const unknownMetrics = [...new Set(rows.map((r) => r.metric))].filter((m) => !knownMetrics.has(m));
  const unknownPeriodTypes = [...new Set(rows.map((r) => r.period_type))].filter(
    (p) => knownPeriods.size > 0 && !knownPeriods.has(p),
  );

  if (unknownCompanies.length) {
    issues.push({
      level: 'warn',
      message: `未识别的公司名 ${unknownCompanies.length} 个（需确认后再提交）: ${unknownCompanies.slice(0, 5).join(', ')}${unknownCompanies.length > 5 ? ' …' : ''}`,
    });
  }
  if (unknownMetrics.length) {
    issues.push({
      level: 'warn',
      message: `未识别的指标名 ${unknownMetrics.length} 个: ${unknownMetrics.slice(0, 5).join(', ')}${unknownMetrics.length > 5 ? ' …' : ''}`,
    });
  }

  // 唯一性校验：三维交点 + 口径
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const key = `${r.fin_month}|${r.company}|${r.metric}|${r.period_type}`;
    if (seen.has(key)) {
      issues.push({ level: 'error', row: i + 2, message: `重复坐标: ${key}（与行 ${seen.get(key)} 冲突）` });
    } else {
      seen.set(key, i + 2);
    }
  });

  // 类型校验
  rows.forEach((r, i) => {
    if (r.amount === null) issues.push({ level: 'warn', row: i + 2, message: '金额为空' });
    if (!r.fin_month) issues.push({ level: 'error', row: i + 2, message: '财务期无法解析' });
  });

  const hasError = issues.some((i) => i.level === 'error');

  // 记账（pending / error 都记录，便于排查）
  await execute(
    `INSERT INTO import_batch VALUES (${lit(batchId)}, ${lit(filePath)}, ${rows.length}, now(), ${lit(
      hasError ? 'error' : 'staged',
    )}, ${lit(issues.map((i) => i.message).join(' | ').slice(0, 500))})`,
  );

  return {
    batchId,
    status: hasError ? 'error' : 'staged',
    sourceFile: filePath,
    rowCount: rows.length,
    unknownCompanies,
    unknownMetrics,
    unknownPeriodTypes,
    issues,
    sample: rows.slice(0, MAX_INFERRED_LINES),
  };
}

/** 提交：写维度 + 写事实表 + 写 Parquet 归档 */
export async function commit(
  batchId: string,
  rows: LongRow[],
  opts: { autoCreateDims?: boolean } = {},
): Promise<{ inserted: number; createdCompanies: string[]; createdMetrics: string[] }> {
  const createdCompanies: string[] = [];
  const createdMetrics: string[] = [];

  const companyMap = new Map((await query<{ id: string; name: string; alias: string[] | null }>('SELECT id, name, alias FROM dim_company')).flatMap((r) => [[r.name, r.id], ...(r.alias ?? []).map((a) => [a, r.id] as [string, string])]));
  const metricMap = new Map((await query<{ id: string; name: string; alias: string[] | null }>('SELECT id, name, alias FROM dim_metric')).flatMap((r) => [[r.name, r.id], ...(r.alias ?? []).map((a) => [a, r.id] as [string, string])]));

  if (opts.autoCreateDims !== false) {
    for (const r of rows) {
      if (!companyMap.has(r.company)) {
        const id = `c_${hash(r.company)}`;
        await execute(
          `INSERT INTO dim_company (id, name, parent_id, level, group_name, alias) VALUES (${lit(id)}, ${lit(r.company)}, NULL, 2, NULL, ARRAY[]::VARCHAR[])`,
        );
        companyMap.set(r.company, id);
        createdCompanies.push(r.company);
      }
      if (!metricMap.has(r.metric)) {
        const id = `m_${hash(r.metric)}`;
        await execute(
          `INSERT INTO dim_metric (id, name, category, unit, direction, alias) VALUES (${lit(id)}, ${lit(r.metric)}, NULL, NULL, 'positive', ARRAY[]::VARCHAR[])`,
        );
        metricMap.set(r.metric, id);
        createdMetrics.push(r.metric);
      }
      // 期间
      await execute(
        `INSERT INTO dim_period (fin_month, year, month, is_audited)
         SELECT ${lit(r.fin_month)}::DATE, ${Number(r.fin_month.slice(0, 4))}, ${Number(r.fin_month.slice(5, 7))}, FALSE
         WHERE NOT EXISTS (SELECT 1 FROM dim_period WHERE fin_month = ${lit(r.fin_month)}::DATE)`,
      );
    }
  }

  await execute(`UPDATE import_batch SET status = 'committed' WHERE batch_id = ${lit(batchId)}`);

  // 分批插入（避免单条 SQL 过长）
  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk
      .map((r) => {
        const cid = companyMap.get(r.company) ?? '';
        const mid = metricMap.get(r.metric) ?? '';
        const amt = r.amount === null ? 'NULL' : r.amount;
        return `(${lit(r.fin_month)}::DATE, ${lit(cid)}, ${lit(mid)}, ${lit(r.period_type)}, ${amt}, ${lit(batchId)})`;
      })
      .join(',\n');
    await execute(
      `INSERT INTO fact_finance (fin_month, company_id, metric_id, period_type, amount, batch_id)
       VALUES ${values}
       ON CONFLICT (fin_month, company_id, metric_id, period_type) DO UPDATE SET amount = EXCLUDED.amount, batch_id = EXCLUDED.batch_id`,
    );
    inserted += chunk.length;
  }

  return { inserted, createdCompanies, createdMetrics };
}

/** 写 Parquet 归档（备份与溯源用，不在查询关键路径上） */
export async function archiveParquet(batchId: string) {
  await execute(
    `COPY (SELECT * FROM fact_finance WHERE batch_id = ${lit(batchId)})
     TO 'data/parquet/fact_finance/batch=${batchId}/part.parquet' (FORMAT parquet)`,
  );
}

function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}
function hash(s: string): string {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h.toString(36).slice(0, 8);
}
