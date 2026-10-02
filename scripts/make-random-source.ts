#!/usr/bin/env node
/**
 * 按一份**报送模板**的版式生成随机源数据 —— 给人做端到端试跑用（模板 → spec → 导入 → 出表）。
 *
 * 它不是引擎的一部分，也不参与 e2e：**输出落在 `data/`（gitignore）**，
 * 而 `data/` 按 `AGENTS.md` 铁律 9 永不进版本库。
 *
 * ★ 为什么由它顺手把**接入规格**也写出来（和 `test/make-fixtures.ts` 同一个套路）：
 *   源文件与规格必须在**几何上完全一致**（锚点、列号、口径映射）。
 *   两处各写一遍 = 迟早对不上，而"对不上"的表现是干跑报缺坐标或口径串位 —— 都是安静错。
 *
 * 用法：
 *   node scripts/make-random-source.ts                                   # 用默认模板与默认参数
 *   node scripts/make-random-source.ts --template templates/uploads/模板.xlsx \
 *        --out data/月度经营-随机源.xlsx --months 6 --companies 集团本部,华东子公司,华南子公司 \
 *        --seed 20261002
 *
 * 口径映射（**只认注册过的口径**，其余列生成随机数但会被规格 skip 掉）：
 *   本年累计 → 本年累计 ・ 本年累计(上年)/去年同期累计 → 去年同期累计 ・ 本月数/单月 → 单月
 *   同比% / 同比(月)% / 环比% → 派生列（skip）
 *   本年累计(上月) / 本月数(上年) / 本月数(上月) → 未注册口径（skip，带 why）
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { openTemplate, textAt } from '../src/spec/template.ts';

// ---------------- 参数 ----------------
const argv = process.argv.slice(2);
const arg = (name: string, def: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def;
};
const TEMPLATE = arg('--template', 'templates/uploads/模板.xlsx');
const OUT = arg('--out', 'data/月度经营-随机源.xlsx');
const SPEC = arg('--spec', 'ingest/月度经营-随机接入.yaml');
const MONTHS = Number(arg('--months', '6'));
const SEED = Number(arg('--seed', '20261002'));
const COMPANIES = arg('--companies', '集团本部,华东子公司,华南子公司,华北子公司').split(',').map((s) => s.trim()).filter(Boolean);
const YEAR = Number(arg('--year', '2026'));

/** 注册过的口径（`src/db/schema.ts` 的 PERIOD_TYPES）—— 只有这些能进事实表 */
const REGISTERED: Record<string, string> = {
  本年累计: '本年累计',
  '本年累计（上年）': '去年同期累计',
  '本年累计(上年)': '去年同期累计',
  去年同期累计: '去年同期累计',
  本月数: '单月',
  单月: '单月',
};

// ---------------- 可复现的随机数（同一个 seed 出同一份数据） ----------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** 名字 → 稳定的数（0..1）。同一个指标/公司每次都得到同一个值 —— 见下面为什么必须稳定 */
function hashUnit(s: string): number {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return ((h >>> 8) % 10000) / 10000;
}
/**
 * 这个指标的**量级**（由名字决定，**不用随机数**）。
 *
 * ★ 为什么必须由名字决定、不能每行现抽：同一指标若每月换一个量级，
 *   报表上看就是"这个月 1 千、下个月 1 亿"，同比环比全是噪声 —— 那种假数据
 *   能跑通流程，却看不出**数据本身是否合理**，等于把试跑的价值砍掉一半。
 */
function metricBase(metric: string): number {
  const r = hashUnit(metric);
  if (/人数|职工|员工|从业|台数|户数|笔数/.test(metric)) return Math.round(20 + r * 5980);
  if (/率|占比|比重|天数|周转|人均/.test(metric)) return round2(0.5 + r * 59.5);
  return round2(10 ** (3.2 + r * 5.0)); // 1.5e3 ~ 1.6e8
}
/** 公司之间的规模差异（同样由名字决定，稳定） */
const companyFactor = (company: string) => 0.55 + hashUnit(company + '#scale') * 0.95;

// ---------------- 读模板版式 ----------------
const wb = await openTemplate(TEMPLATE);
const sheetName = wb.sheets()[0]!.name();
const sh = wb.sheet(sheetName)!;
const lastRow = sh.usedRange().endCell().rowNumber();
const lastCol = sh.usedRange().endCell().columnNumber();

// 表头行：含「指标」与「期数」的那一行（找不到就退回第 1 行 —— 并且**说出来**）
let headerRow = 1;
for (let r = 1; r <= Math.min(lastRow, 10); r++) {
  const texts = Array.from({ length: lastCol }, (_, i) => textAt(sh, r, i + 1) ?? '');
  if (texts.includes('指标') && texts.some((t) => t.includes('期数'))) {
    headerRow = r;
    break;
  }
}
const header = (c: number) => (textAt(sh, headerRow, c) ?? '').trim();
const colOf = (want: string, must = true): number => {
  for (let c = 1; c <= lastCol; c++) if (header(c) === want) return c;
  if (must) throw new Error(`模板的列里没有「${want}」（表头行 ${headerRow}）—— 这份模板的版式与生成器假设的不一致`);
  return 0;
};
const cUnit = colOf('单位', false);
const cPeriod = colOf('期数');
const cMetric = colOf('指标');

// 指标行：表头之后、指标列非空的行
const rawMetrics: string[] = [];
for (let r = headerRow + 1; r <= lastRow; r++) {
  const m = (textAt(sh, r, cMetric) ?? '').trim();
  if (m !== '') rawMetrics.push(m);
}
// ★ 同名指标去重（默认）：一模一样的名字出现两次 = 源里两行会落到**同一个坐标**
//   （公司×指标×期数），而引擎对重复坐标是**整批拒绝**（ROWKEY_DUPLICATE_IN_FILE）——
//   它没法知道该取哪一行。这不是引擎挑剔，而是"两份互相矛盾的数"本来就该由人决定。
//   保留两份就加 --keep-duplicates，然后自己在模板里区分它们（比如加一个区分列）。
const kept: string[] = [];
const seen = new Set<string>();
for (const m of rawMetrics) {
  if (seen.has(m)) continue;
  seen.add(m);
  kept.push(m);
}
const metrics = argv.includes('--keep-duplicates') ? rawMetrics : kept;
if (metrics.length !== rawMetrics.length) {
  const dup = [...new Set(rawMetrics.filter((m, i) => rawMetrics.indexOf(m) !== i))];
  console.log(`⚠️ 模板里有 ${rawMetrics.length - metrics.length} 行重名指标，已按"保留第一次出现"去重：${dup.join('、')}`);
  console.log(`   （重复的坐标会被引擎整批拒绝 —— 要保留两份就 --keep-duplicates，并自己给它们加上区分列）`);
}
if (metrics.length === 0) throw new Error(`模板里一个指标都没读到（第 ${headerRow} 行是表头、之后第 ${cMetric} 列应有指标名）`);

/** 每个值列（表头有字、且不是 单位/期数/指标）映射到什么 */
const valueCols: Array<{ col: number; header: string; periodType: string | null; kind: 'registered' | 'derived' | 'unregistered' }> = [];
for (let c = 1; c <= lastCol; c++) {
  if (c === cUnit || c === cPeriod || c === cMetric) continue;
  const h = header(c);
  if (h === '') continue;
  const registered = REGISTERED[h];
  const kind = registered ? 'registered' : /同比|环比|%/.test(h) ? 'derived' : 'unregistered';
  valueCols.push({ col: c, header: h, periodType: registered ?? null, kind });
}
if (valueCols.filter((v) => v.kind === 'registered').length === 0) {
  throw new Error(`模板的值列表头里没有一个认识的口径（认识的：${Object.keys(REGISTERED).join(' / ')}）`);
}

// ---------------- 生成随机数据 ----------------
const out = new ExcelJS.Workbook();
const ws = out.addWorksheet(sheetName);
// 表头行保持模板原文（前面若还有空行就补上），数据从 headerRow + 1 开始
for (let r = 1; r < headerRow; r++) ws.addRow(Array.from({ length: lastCol }, () => ''));
ws.addRow(Array.from({ length: lastCol }, (_, i) => header(i + 1)));

const periods = Array.from({ length: MONTHS }, (_, i) => `${YEAR}-${String(i + 1).padStart(2, '0')}`);
let rows = 0;
for (const company of COMPANIES) {
  for (const period of periods) {
    const monthIdx = Number(period.slice(5, 7));
    for (const metric of metrics) {
      // 量级 = 指标固有（名字定的）× 公司规模（名字定的）× 本月的小波动（随机）
      const base = metricBase(metric) * companyFactor(company);
      const cumulative = round2(base * monthIdx * between(0.85, 1.15)); // 本年累计
      const month = round2((cumulative / monthIdx) * between(0.75, 1.25)); // 本月数
      const lastYearCum = round2(cumulative * between(0.7, 1.15)); // 去年累计
      const lastYearMonth = round2((lastYearCum / monthIdx) * between(0.75, 1.25)); // 去年同月
      const lastMonthCum = round2(cumulative * between(0.85, 1.0)); // 上月末累计
      const lastMonthMonth = round2(month * between(0.8, 1.2)); // 上月数
      const pct = (a: number, b: number) => (b === 0 ? 0 : round2(((a - b) / Math.abs(b)) * 100));
      const cells: Array<string | number> = Array.from({ length: lastCol }, () => '');
      if (cUnit) cells[cUnit - 1] = company;
      cells[cPeriod - 1] = period;
      cells[cMetric - 1] = metric;
      for (const v of valueCols) {
        const h = v.header;
        const value =
          h === '本年累计' ? cumulative
          : /本年累计.*上?年|去年同期/.test(h) ? lastYearCum
          : h === '本月数' || h === '单月' ? month
          : /本月数.*上年/.test(h) ? lastYearMonth
          : h === '本年累计(上月)' || h === '本年累计（上月）' ? lastMonthCum
          : /本月数.*上月/.test(h) ? lastMonthMonth
          : h.includes('环比') ? pct(month, lastMonthMonth)
          : h.includes('同比(月)') || h.includes('同比（月）') ? pct(month, lastYearMonth)
          : h.includes('同比') ? pct(cumulative, lastYearCum)
          : 0; // 兜底：不认识的值列也给个数（规格里会 skip 掉它）
        // ★ 派生列与"未注册口径"的列**也填数**：真实导出就是长这样的（列都在、都有值）。
        //   它们不进事实表这件事由规格的 skip 说清楚 —— 那才是判据该在的地方，
        //   而不是靠"生成器没填"来隐含表达。
        cells[v.col - 1] = value;
      }
      ws.addRow(cells);
      rows++;
    }
  }
}
for (let c = 1; c <= lastCol; c++) ws.getColumn(c).width = c === cMetric ? 28 : 16;
ws.getRow(headerRow).font = { bold: true };
ws.views = [{ state: 'frozen', ySplit: headerRow }];

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await out.xlsx.writeFile(OUT);

// ---------------- 顺手写出配套的接入规格（几何只有一份） ----------------
const regCols = valueCols.filter((v) => v.kind === 'registered');
const skipped = valueCols.filter((v) => v.kind !== 'registered');
const letter = (n: number) => {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
};
const yaml = `# 由 scripts/make-random-source.ts 生成 —— **随机试跑数据**，不是生产规格。
# 模板：${TEMPLATE}（表头行 ${headerRow}，${metrics.length} 个指标 × ${COMPANIES.length} 家公司 × ${periods.length} 个月）
# seed=${SEED} 可复现；改参数重跑即可换一份数据。
id: 月度经营-随机接入
title: 随机经营数据（按模板版式生成）
source: ${OUT}
target: fact_finance
onConflict: reject
unknownMaster: create
onEmptyMeasure: skip
sheets:
  - name: ${sheetName}
    blocks:
      - anchor: ${letter(regCols[0]!.col)}${headerRow + 1}
        rows:
${cUnit ? `          - col: ${letter(cUnit)}\n            dim: company\n` : ''}          - col: ${letter(cMetric)}
            dim: metric
        keys:
          - col: ${letter(cPeriod)}
            as: period
        values:
          columns: [${valueCols.map((v) => letter(v.col)).join(', ')}]
${
  skipped.length
    ? `          skip:
${skipped
  .map(
    (v) =>
      `            - columns: [${letter(v.col)}]\n              why: ${
        v.kind === 'derived' ? `「${v.header}」是派生列（能从已接入的口径重算）` : `「${v.header}」的口径未注册（不在 PERIOD_TYPES 里）—— 先不收进事实表`
      }`,
  )
  .join('\n')}
`
    : ''
}          periodTypes: [${regCols.map((v) => v.periodType).join(', ')}]
`;
fs.mkdirSync(path.dirname(SPEC), { recursive: true });
fs.writeFileSync(SPEC, yaml);

const facts = rows * regCols.length;
console.log(`✅ 随机源: ${OUT}`);
console.log(`   ${COMPANIES.length} 家公司 × ${periods.length} 个月（${periods[0]}~${periods.at(-1)}）× ${metrics.length} 个指标 = ${rows} 行`);
console.log(`   接入的口径列: ${regCols.map((v) => `${letter(v.col)}=${v.header}→${v.periodType}`).join('  ')}`);
console.log(`   跳过: ${skipped.map((v) => `${letter(v.col)}=${v.header}`).join('  ') || '（无）'}`);
console.log(`   → 落库后约 ${facts} 条事实；seed=${SEED}`);
console.log(`✅ 接入规格: ${SPEC}`);
