/**
 * Excel 长表导入（docs/需求与架构.md §4.6）
 *
 * 财务数据从公司平台导出为长表：财务期月份 × 公司名称 × 指标名称 × 口径 → 金额
 * 导入三态：STAGED → SYNCING → READY / ERROR
 *
 * 关键：整个链路不经过 LLM（安全设计 §6.2 第⑤层）。
 */
import XLSXPopulate from 'xlsx-populate';
import fs from 'node:fs';
import { execute, exportParquet } from '../db/index.ts';
import { PERIOD_TYPES } from '../db/schema.ts';
import { buildResolver, registerAlias, normalizeName, describeUnresolved, type UnresolvedName, type DimKind } from './resolve.ts';
// DimDecision 已搬到接入层（src/ingest/types.ts）—— 旧长表导入只是它的第一个调用方。
// ★ 必须 import 进来再 export：只写 export ... from 不会把名字带进本地作用域，
//   而本文件内部还在用它（commit() 的 decided 表）→ 会变成 ReferenceError。
import type { DimDecision } from '../ingest/types.ts';
export type { DimDecision };

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
  /**
   * 带候选建议的未识别清单（§10 R1）。
   * `unknownCompanies` 是纯名字列表（向后兼容），这里是给人**做决定用**的版本：
   * 每个名字带上"建议并入哪条已有主数据 + 为什么"和它出现多少行。
   * 按出现行数降序 —— 人最该先核对的是覆盖最多数据的那个写法。
   */
  unresolved: { companies: UnresolvedName[]; metrics: UnresolvedName[] };
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

/**
 * STAGED 阶段：解析 + 校验，不写库
 *
 * `batchId` 必须**唯一**（`import_batch` 的主键）。只用 `Date.now()` 不够：
 * 毫秒级的两个请求会撞出同一个 id，后到的那个直接
 * `Constraint Error: Duplicate key "batch_id: ..."` 失败。
 * 这在浏览器里很容易复现 —— 用户手快连点两次，或拖放时误触发了两次 upload。
 * 所以时间戳之外再加一个进程内自增序号，彻底消灭同毫秒碰撞。
 */
let batchSeq = 0;

export async function stage(filePath: string, sheetName?: string): Promise<StageResult> {
  const batchId = `b${Date.now().toString(36)}${(batchSeq++).toString(36)}`;
  const rows = await readLongTable(filePath, sheetName);
  const issues: StageResult['issues'] = [];

  if (rows.length === 0) issues.push({ level: 'error', message: '文件中没有数据行' });

  // 已知主数据（§10 R1）。走 Resolver 而不是 Set 精确匹配：
  //   Tier 1 自动归并 —— 规范化后相同（全角/空格/括号等纯格式噪音）直接算已识别；
  //   Tier 2 需确认 —— 去壳/互相包含/写法相近只给候选，**绝不自动合并**。
  // 理由见 resolve.ts 头部：合并两家公司比不合并危险得多。
  const companyResolver = await buildResolver('company');
  const metricResolver = await buildResolver('metric');

  // 口径：以 PERIOD_TYPES 注册表为准（铁律 5），而不是"库里已有什么"。
  // 用库里的既有值当白名单会导致首次导入无法识别任何口径，且新增口径永远进不来。
  const knownPeriods = new Set<string>(PERIOD_TYPES.map((p) => p.id));

  const companyValues = rows.map((r) => r.company);
  const metricValues = rows.map((r) => r.metric);
  const unknownCompanyValues = [...new Set(companyValues)].filter((c) => !companyResolver.resolve(c));
  const unknownMetricValues = [...new Set(metricValues)].filter((m) => !metricResolver.resolve(m));

  const unknownCompanies = unknownCompanyValues;
  const unknownMetrics = unknownMetricValues;
  const unknownPeriodTypes = [...new Set(rows.map((r) => r.period_type))].filter(
    (p) => knownPeriods.size > 0 && !knownPeriods.has(p),
  );

  const unresolved = {
    companies: describeUnresolved(companyResolver, companyValues.filter((c) => !companyResolver.resolve(c))),
    metrics: describeUnresolved(metricResolver, metricValues.filter((m) => !metricResolver.resolve(m))),
  };

  // Tier 1 自动归并的痕迹 —— 让人看见"有 3 个写法被自动合并了"，
  // 而不是悄悄发生。合并是有后果的操作，即使安全也要留痕。
  // （Tier 1 只做 normalizeName，去的是全角/空格/括号这类纯格式噪音，
  //   所以这里列出来的每条都应该"肉眼一看就是同一个名字的两种写法"。）
  const merged: Array<{ kind: DimKind; raw: string; target: string; rows: number }> = [];
  for (const [kind, resolver, values] of [
    ['company', companyResolver, companyValues],
    ['metric', metricResolver, metricValues],
  ] as const) {
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const [raw, n] of counts) {
      const ent = resolver.entityOf(raw);
      if (ent && normalizeName(raw) !== normalizeName(ent.name)) {
        merged.push({ kind, raw, target: ent.name, rows: n });
      }
    }
  }

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

  // 有候选的名字单独提示 —— 这些是"很可能该合并，但需要人拍板"的
  const withCandidates = [...unresolved.companies, ...unresolved.metrics].filter((u) => u.candidates.length);
  if (withCandidates.length) {
    issues.push({
      level: 'warn',
      message: `${withCandidates.length} 个未识别名称看起来与已有主数据相近，请确认是「并入已有」还是「新建」: ${withCandidates
        .slice(0, 3)
        .map((u) => `${u.raw}（${u.rows} 行）→ 疑似 ${u.candidates.map((c) => c.name).join(' / ')}`)
        .join('；')}${withCandidates.length > 3 ? ' …' : ''}`,
    });
  }

  // Tier 1 自动归并留痕：这些写法已被并进已有主数据，**不再出现在未识别清单里**，
  // 但必须让人看见，否则"我的公司名怎么不见了"会变成一个无从排查的疑问。
  if (merged.length) {
    issues.push({
      level: 'warn',
      message: `已自动归并 ${merged.length} 个写法（仅去格式差异，未改语义）: ${merged
        .slice(0, 5)
        .map((m) => `${m.raw} → ${m.target}（${m.rows} 行）`)
        .join('；')}${merged.length > 5 ? ' …' : ''}`,
    });
  }

  if (unknownPeriodTypes.length) {
    // 口径未注册 = error：语义层会拒绝它，写进去也只是死数据（铁律 5）
    issues.push({
      level: 'error',
      message: `未注册的口径 ${unknownPeriodTypes.length} 个（须先加进 PERIOD_TYPES）: ${unknownPeriodTypes.join(', ')}`,
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
    unresolved,
    issues,
    sample: rows.slice(0, MAX_INFERRED_LINES),
  };
}

export interface CommitOptions {
  /**
   * 是否允许为新实体建维。默认 `true`（首次导入必须能建，否则链路跑不起来）。
   *
   * ⚠️ 但**"看起来像已有实体"的名字不受此开关保护** —— 它们走 `needsDecision` 拦下来，
   * 必须由人明确 `merge` 或 `create`。理由见 resolve.ts 头部：合并有风险，不合并也有风险，
   * 但**静默地替人做这个决定**是两害之中最坏的 —— 钱被拆到两条主数据上，报表看着正常。
   */
  autoCreateDims?: boolean;
  /** 人的处置决定（覆盖自动判定），每条都会记进 dim_alias（merge 时） */
  decisions?: DimDecision[];
  /** 遇到"疑似已有实体"时是否直接抛错（Web 先预览再确认的流程用得到）；默认 false（返回结论） */
  strict?: boolean;
}

export interface CommitResult {
  inserted: number;
  createdCompanies: string[];
  createdMetrics: string[];
  /**
   * Tier 1 自动归并（纯格式差异）—— 已合并，列出来是为了**留痕**。
   * 合并是"有后果"的操作，即使安全也要让人看得见。
   */
  merged: Array<{ kind: DimKind; raw: string; target: string; rows: number }>;
  /**
   * ★ Tier 2：疑似已有实体但**没有**人工决定的名字 —— **这些名字的行不会写库**。
   * 空数组 = 本次提交没有任何歧义。非空 = 必须让人拍板后重提。
   */
  needsDecision: Array<{ kind: DimKind; raw: string; rows: number; candidates: UnresolvedName['candidates'] }>;
  /** 因 needsDecision 而被跳过的行数 */
  skippedRows: number;
}

/** 提交：写维度 + 写事实表 + 写 Parquet 归档 */
export async function commit(
  batchId: string,
  rows: LongRow[],
  opts: CommitOptions = {},
): Promise<CommitResult> {
  const autoCreateDims = opts.autoCreateDims !== false;
  const strict = opts.strict === true;

  const resolvers = {
    company: await buildResolver('company'),
    metric: await buildResolver('metric'),
  };

  // 人的决定优先于一切自动判定 —— 人拍过板的事不该被算法再推翻
  const decided = new Map<string, DimDecision>();
  for (const d of opts.decisions ?? []) decided.set(`${d.kind}|${normalizeName(d.raw)}`, d);

  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(`company|${r.company}`, (counts.get(`company|${r.company}`) ?? 0) + 1);
    counts.set(`metric|${r.metric}`, (counts.get(`metric|${r.metric}`) ?? 0) + 1);
  }

  // ---------- 阶段 1：只做判断，一次库都不写 ----------
  //
  // ★ 为什么必须分两阶段：`settle()` 里的 `registerAlias()` 一旦执行就写进了 dim_alias，
  //   而别名是**永久生效**的，没有干净的撤销办法。若边判断边写，
  //   后面发现某个名字要人确认时，前面的别名已经落库了 ——
  //   库进入半成品状态，且"提交失败"这件事反而留下了副作用。
  //
  //   新建维度的 id 是 `hash(raw)` 决定的**纯函数**，所以阶段 1 完全可以在不写库的前提下
  //   算出 id。这是分两阶段可行的关键。

  /** `kind|raw` → 目标 id（已确定）；新建的目标 id 也在阶段 1 就算好 */
  const assigned = new Map<string, string>();
  /** 阶段 1 判定要新建的实体（阶段 2 才写） */
  const toCreate = new Map<string, { kind: DimKind; raw: string }>();
  /** 阶段 1 判定要登记的别名（阶段 2 才写） */
  const toAlias: Array<{ kind: DimKind; raw: string; targetId: string; note?: string }> = [];
  const needsDecision: CommitResult['needsDecision'] = [];
  const merged: CommitResult['merged'] = [];
  const pending = new Set<string>();

  function plan(kind: DimKind, raw: string): string | null {
    const key = `${kind}|${raw}`;
    const known = assigned.get(key);
    if (known) return known;
    if (pending.has(key)) return null;

    const resolver = resolvers[kind];
    const n = normalizeName(raw);
    const nrows = counts.get(key) ?? 0;

    // ① 人的决定最高优先
    const dec = decided.get(`${kind}|${n}`);
    if (dec) {
      if (dec.action === 'merge') {
        if (!dec.targetId) throw new Error(`决定「并入已有」但没给 targetId: ${kind} ${raw}`);
        // 目标是否真实存在留到阶段 2 校验 —— 那里才知道本批新建了哪些实体，
        // 而"把变体并进本批同时新建的实体"是合法且常见的操作。
        toAlias.push({ kind, raw, targetId: dec.targetId, note: dec.note ?? '导入时人工确认' });
        assigned.set(key, dec.targetId);
        return dec.targetId;
      }
      // action === 'create'：人明确说了"这是个新实体"
      const id = entityId(kind, raw);
      toCreate.set(key, { kind, raw });
      assigned.set(key, id);
      return id;
    }

    // ② Tier 1：规范化后命中（含 dim_alias 里人确认过的映射）—— 纯格式差异，自动归并
    const hit = resolver.resolve(raw);
    if (hit) {
      assigned.set(key, hit);
      const ent = resolver.entityOf(raw);
      // 写法与主名不同才值得提；同一个字面值不算"归并"
      if (ent && raw !== ent.name) merged.push({ kind, raw, target: ent.name, rows: nrows });
      return hit;
    }

    // ③ Tier 2：像已有实体但不确定 → 交给人
    const cands = resolver.candidates(raw);
    if (cands.length) {
      pending.add(key);
      needsDecision.push({ kind, raw, rows: nrows, candidates: cands });
      return null;
    }

    // ④ 完全不像任何已有实体
    if (!autoCreateDims) {
      pending.add(key);
      needsDecision.push({ kind, raw, rows: nrows, candidates: [] });
      return null;
    }
    const id = entityId(kind, raw);
    toCreate.set(key, { kind, raw });
    assigned.set(key, id);
    return id;
  }

  for (const r of rows) {
    plan('company', r.company);
    plan('metric', r.metric);
  }

  // ★ 有歧义 → 一行都不写，连维度都不建。
  //   "写一半"会让库进入既不是旧状态也不是新状态的中间态，比拒绝提交难排查得多。
  if (needsDecision.length) {
    const detail = needsDecision
      .map((d) => `${d.raw}（${d.rows} 行${d.candidates.length ? `，疑似 ${d.candidates.map((c) => c.name).join(' / ')}` : '，无相近主数据'}）`)
      .join('；');
    const msg =
      `有 ${needsDecision.length} 个名称需要人工确认后才能提交: ${detail}。` +
      `合并两家不同的公司会把它们的钱静默加在一起（报表看起来完全正常，没人会来查），所以这一步不自动做。` +
      `请对每个名称二选一：并入已有（action='merge' + targetId）或确认是新建（action='create'）。`;
    if (strict) throw new Error(msg);
    return { inserted: 0, createdCompanies: [], createdMetrics: [], merged: [], needsDecision, skippedRows: rows.length };
  }

  // ---------- 阶段 2：判断已全部通过，这才开始写 ----------

  // 先建维度，再登记别名 —— 别名可以指向**本批同时新建**的实体
  // （真实场景：「集团公司」新建为正式主数据，同时把「集团有限公司」「集团公司(本部)」
  //   这些变体并进它 —— 这是同一批导入里最自然的操作，顺序反了就会失败）。
  const createdCompanies: string[] = [];
  const createdMetrics: string[] = [];
  for (const { kind, raw } of toCreate.values()) {
    const id = entityId(kind, raw);
    if (kind === 'company') {
      await execute(
        `INSERT INTO dim_company (id, name, parent_id, level, group_name, alias) VALUES (${lit(id)}, ${lit(raw)}, NULL, 2, NULL, ARRAY[]::VARCHAR[])`,
      );
      createdCompanies.push(raw);
    } else {
      await execute(
        `INSERT INTO dim_metric (id, name, category, unit, direction, alias) VALUES (${lit(id)}, ${lit(raw)}, NULL, NULL, 'positive', ARRAY[]::VARCHAR[])`,
      );
      createdMetrics.push(raw);
    }
  }

  // 登记人的决定（写 dim_alias）。此时校验目标存在 —— 错过这一步会造出一条指向虚空、
  // 却从此自动命中的别名：所有带这个写法的行都被静默归并到不存在的公司上。
  const createdIds = new Set([...toCreate.keys()].map((k) => assigned.get(k)!));
  for (const a of toAlias) {
    const exists = resolvers[a.kind].ents.some((e) => e.id === a.targetId) || createdIds.has(a.targetId);
    if (!exists) throw new Error(`决定「并入已有」但目标主数据不存在: ${a.kind} ${a.raw} → ${a.targetId}`);
    await registerAlias(a.kind, a.raw, a.targetId, a.note);
  }

  // 期间维度（与公司/指标无关，逐行幂等）
  for (const r of rows) {
    await execute(
      `INSERT INTO dim_period (fin_month, year, month, is_audited)
       SELECT ${lit(r.fin_month)}::DATE, ${Number(r.fin_month.slice(0, 4))}, ${Number(r.fin_month.slice(5, 7))}, FALSE
       WHERE NOT EXISTS (SELECT 1 FROM dim_period WHERE fin_month = ${lit(r.fin_month)}::DATE)`,
    );
  }

  await execute(`UPDATE import_batch SET status = 'committed' WHERE batch_id = ${lit(batchId)}`);

  // 分批插入（避免单条 SQL 过长）
  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk
      .map((r) => {
        // assigned 里一定有：需要人决定的名字此时已因 needsDecision 提前返回
        const cid = assigned.get(`company|${r.company}`)!;
        const mid = assigned.get(`metric|${r.metric}`)!;
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

  return { inserted, createdCompanies, createdMetrics, merged, needsDecision: [], skippedRows: 0 };
}

/** 新建实体的 id：`hash(名字)` 决定的纯函数（阶段 1 无需写库即可算出） */
function entityId(kind: DimKind, raw: string): string {
  return `${kind === 'company' ? 'c' : 'm'}_${hash(raw)}`;
}

/**
 * 写 Parquet 归档（备份与溯源用，不在查询关键路径上）。
 *
 * 注意：必须走 `exportParquet()` 而不是 `execute()` —— 主实例开着
 * `enable_external_access=false`（见 src/db/index.ts），`COPY ... TO` 会被直接拒绝。
 * 归档实例是 READ_ONLY 的，因此不可能反过来改动主库。
 */
export async function archiveParquet(batchId: string, expectRows?: number) {
  const dir = `data/parquet/fact_finance/batch=${batchId}`;
  fs.mkdirSync(dir, { recursive: true });
  const path = `${dir}/part.parquet`;
  await exportParquet(
    `COPY (SELECT * FROM fact_finance WHERE batch_id = ${lit(batchId)})
     TO '${path}' (FORMAT parquet)`,
    // 与接入层同款：写完读回来数一遍，空归档不许安静过关（见 db/index.ts 的注释）
    expectRows === undefined ? undefined : { path, rows: expectRows },
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
