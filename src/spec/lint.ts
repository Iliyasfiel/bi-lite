/**
 * spec 的静态诊断（docs/需求与架构.md §5.5、§7.2 路径 2）
 *
 * 定位：在**任何数值被计算之前**，回答一个问题 ——
 * 「这份 spec 描述的口径是不是完整的、会不会算出一个看起来正常但其实错误的值？」
 *
 * ★ 为什么这个模块存在（三条实测出来的静默算错）：
 *
 *   ① **缺指标约束**：`rows: company / cols: period_type` 却没写指标 →
 *      SQL 里没有任何 metric 条件，**五个指标的钱被加成一行**。
 *      实测：利润总额那一格返回 67283，真值 65198。
 *      两数同量级、格式正常，人不会怀疑。
 *
 *   ② **value.expr 被忽略**：写了 `expr: (本年累计-去年同期累计)/去年同期累计`，
 *      编译器却不认这个字段 → 同比被算成两个累计额本身（实测 `[65198, 60870]`，
 *      而期望 `0.0711`）。声明了却静默不生效，比不支持更糟。
 *
 *   ③ **scope.company.filter 不建 join**：WHERE 里引用了 dim_company、
 *      FROM 里却没有 JOIN dim_company → DuckDB 直接报"列不存在"。
 *      （这条会报错，不算静默；但同样属于"写的时候看不出来"。）
 *
 *   ④ **口径名写错一个字**：`order: [本年度累计, ...]`（真名是「本年累计」）。
 *     实测（2026-10-01）：`parseSpec` 放行、诊断**一条不报**，而那一格在结果矩阵里
 *     从 **50115 变成 null** —— 写进报送表就是"这一格空着"，看起来像"这一项本月没有数"。
 *     接入侧早就有 `PERIODTYPE_UNKNOWN` 拦这类（那边靠注入的已注册口径），报表侧一直没有。
 *     口径取值来自 `src/db/schema.ts` 的 PERIOD_TYPES（铁律 5：新增口径 = 注册进那里），
 *     与 `semantic/query.ts` 的 `allowedPeriods` **同源** —— 判据只有一份。
 *
 *   这四条有一个共同点：**spec 语法上完全合法，只有跑出来才知道错。**
 *   而 §7.2 路径 2 是「让 agent 从一句自然语言写 spec」—— 如果语言本身允许
 *   欠约束的 spec，那么 agent 每写一次都可能静默算错一次。
 *   所以路径 2 的前置条件不是"提示词写得好"，而是**语言本身把错误挡在解析期**。
 *
 * 本模块**只吃 spec 结构，不碰数据库、不碰任何数值** ——
 * 因此它的诊断结果可以安全地进 LLM 上下文（铁律 1）。
 */
import type { Spec, Block, SheetSpec } from './types.ts';
import { DIMENSIONS, DIM_NAMES, dimAvailableOn, isRegisteredDim, type DimName } from './dims.ts';
import { exprRefs, ExprError, parseExpr } from './expr.ts';
import { PERIOD_TYPES } from '../db/schema.ts';
import { lintAnchorGeometry } from './geometry.ts';
import type { DeclaredFact } from '../gen/ir.ts';

export type LintLevel = 'error' | 'warn';

export interface LintIssue {
  level: LintLevel;
  /** 机器可读的代号，便于 e2e 与前端分支 */
  code:
    | 'UNCONSTRAINED_DIM'
    | 'EXPR_REFS'
    | 'EXPR_BAD'
    | 'FILTER_UNKNOWN_DIM'
    | 'FILTER_BAD_COLUMN'
    | 'DIM_UNKNOWN'
    | 'ORDER_EMPTY'
    | 'ORDER_DUPLICATE'
    | 'PERIODTYPE_UNKNOWN'
    | 'VALUE_MISSING'
    | 'ANCHOR_MISSING'
    | 'ANCHOR_BAD'
    | 'SHEET_NO_BLOCK'
    | 'NO_ID_OR_SHEET'
    | 'FACT_UNKNOWN'
    | 'DIM_NOT_ON_FACT';
  /** 出问题的位置，人能直接对着 YAML 找（如 `sheets[0].blocks[1]`） */
  at: string;
  message: string;
  /** 建议怎么改 —— 给人也给 agent 看 */
  hint?: string;
}

/**
 * 财务事实的两个「量纲维」：**指标与口径**。
 *
 * 为什么只有这两个必须被约束、而公司/月份/年份可以留空：
 *   - `rows: metric, cols: period_type`、不限定公司 → 是**集团合计**，完全合法
 *     （实测：4 家公司 16811+15940+17234+16841 = 66826，正是 B4 的值）
 *   - `rows: company, cols: period_type`、不限定指标 → 把 5 个指标加在一起，
 *     得到的数**没有任何业务含义**（实测 67283 vs 65198）
 *
 * 所以判据是「这个维度是不是金额含义的一部分」：
 * 指标与口径决定"这个数是什么"，公司/期间只决定"哪些数加进来"。
 */
export const MEANING_DIMS: DimName[] = ['metric', 'period_type'];

/** 一个 block 里某个维度是否被"钉住"了（作为轴，或被 filter 显式限定） */
function isPinned(b: Block, dim: DimName): boolean {
  if (b.rows?.dim === dim || b.cols?.dim === dim) return true;
  // 自己的轴 filter（rows.filter 作用在 rows.dim 上，cols.filter 同理）
  if (b.rows?.dim === dim && Object.keys(b.rows?.filter ?? {}).length) return true;
  if (b.cols?.dim === dim && Object.keys(b.cols?.filter ?? {}).length) return true;
  // 通用 scope.filter（路径 2 主要靠它：不把指标做成轴，而是钉死成某一个指标）
  const sf = b.scope?.filter?.[dim];
  if (sf && Object.keys(sf).length) return true;
  // 兼容文档 §5.2 的 scope.company.filter 写法
  if (dim === 'company' && Object.keys(b.scope?.company?.filter ?? {}).length) return true;
  return false;
}

/**
 * 哪些「量纲维」（指标 / 口径）没有被钉住。
 *
 * 导出给 infer.ts 用 —— 模板推断遇到"表里根本没有指标信息"的 sheet
 * （如一个只有「公司 × 本年累计」的分板块表）时，必须据此显式告诉人，
 * 而不是产出一份会静默加总五个指标的 spec。
 */
export function unpinnedMeaningDims(b: Block): DimName[] {
  return MEANING_DIMS.filter((d) => !isPinned(b, d));
}

/** 检查一组 filter 的字段名，避免写出 "dim_metric.nmae" 这类拼错 */
function checkFilter(
  filter: Record<string, string | string[]> | undefined,
  dim: DimName,
  at: string,
  out: LintIssue[],
) {
  if (!filter) return;
  for (const col of Object.keys(filter)) {
    // compile.ts 只接受合法标识符（它会把列名直接拼进 SQL）
    if (!/^[a-z_][a-z0-9_]*$/i.test(col)) {
      out.push({
        level: 'error',
        code: 'FILTER_BAD_COLUMN',
        at,
        message: `filter 的字段名「${col}」不是合法列名。`,
        hint: '列名只能是字母/数字/下划线，且以字母或下划线开头（它会被直接拼进 SQL）。',
      });
      continue;
    }
    // 常见笔误提示：name 是最常用的列
    const known = new Set(['name', 'id', 'category', 'unit', 'direction', 'level', 'group_name', 'parent_id', 'alias']);
    if (DIMENSIONS[dim].table && !known.has(col)) {
      out.push({
        level: 'warn',
        code: 'FILTER_BAD_COLUMN',
        at,
        message: `filter 的字段「${col}」不在 ${DIMENSIONS[dim].table} 的常用列里。`,
        hint: `常用列：${[...known].join(' / ')}。写错列名会在查库时报"列不存在"，现在提前告诉你。`,
      });
    }
  }
}

/**
 * 诊断单个 block。
 *
 * `fact` 是**已解析的目标表声明**（spec.fact 在 models 里找到的那份；null = 缺省 fact_finance 形状）；
 * `shapeKnown` 为 true 才做"按目标表形状"的检查（维度可用性、量纲维豁免）——
 * 它要求：调用方注入了 facts，且 spec.fact 解析成功（未写 fact 也算解析成功=缺省表）。
 * shapeKnown=false 时退回老判据（全量量纲维、不查可用性）：解析层不读盘，
 * 没注入 facts 就没有资格对目标表形状下结论 —— 白名单的硬墙在 compile/query 的编译期。
 */
function lintBlock(b: Block, at: string, out: LintIssue[], fact: DeclaredFact | null, shapeKnown: boolean) {
  const factLabel = fact?.name ?? 'fact_finance（缺省）';
  /** 维度在目标表上不可用的统一文案（轴与 scope.filter 共用） */
  const notOnFact = (dim: DimName, issueAt: string) =>
    out.push({
      level: 'error',
      code: 'DIM_NOT_ON_FACT',
      at: issueAt,
      message: `目标表 ${factLabel} 没有「${dim}」这个维度。`,
      hint:
        dim === 'period_type'
          ? '这张表没有口径列 —— 运营事实表没有财务的"本年累计/单月"这套口径体系（铁律 8）。'
            + '去掉 period_type 轴/filter，或把 spec.fact 换成带口径列的事实表。'
          : `目标表由 spec.fact 声明，可用的维度随表走（${factLabel} 的声明里没有这一列）。`,
    });

  // ★ 锚点判据只有一份（geometry.ts 的 lintAnchorGeometry）—— 接入侧 lintIngest 调的是同一个
  for (const i of lintAnchorGeometry(b.anchor, at, { named: true })) out.push(i);

  // ---- 维度名必须是白名单里的 ----
  for (const [axis, spec] of [['rows', b.rows], ['cols', b.cols]] as const) {
    if (!spec?.dim) {
      out.push({
        level: 'error',
        code: 'DIM_UNKNOWN',
        at: `${at}.${axis}`,
        message: `${axis}.dim 缺失。`,
        hint: `只能取 ${DIM_NAMES.join(' / ')}`,
      });
      continue;
    }
    if (!isRegisteredDim(spec.dim)) {
      out.push({
        level: 'error',
        code: 'DIM_UNKNOWN',
        at: `${at}.${axis}.dim`,
        message: `未注册的维度「${spec.dim}」。`,
        hint: `只能取 ${DIM_NAMES.join(' / ')}。写成已注册的名字，否则查询会报错。`,
      });
    } else if (shapeKnown && !dimAvailableOn(spec.dim, fact)) {
      // 维度注册了，但目标表的声明里没有这一列（如财务表配 business_line 轴、运营表配口径轴）
      notOnFact(spec.dim, `${at}.${axis}.dim`);
    }
    // order 是显式清单 —— 留空会退化成"整张表"，数字会随数据增长而变化
    const order = spec.order ?? [];
    if (order.length === 0) {
      out.push({
        level: 'warn',
        code: 'ORDER_EMPTY',
        at: `${at}.${axis}.order`,
        message: `${axis}.order 为空。`,
        hint: 'order 是显式清单：建议把它写全。留空时该轴不受约束，模板上会填不满或行数随数据变化。',
      });
    }
    if (new Set(order.map(String)).size !== order.length) {
      const dup = order.map(String).filter((x, i, a) => a.indexOf(x) !== i);
      out.push({
        level: 'error',
        code: 'ORDER_DUPLICATE',
        at: `${at}.${axis}.order`,
        message: `${axis}.order 里有重复项（${[...new Set(dup)].slice(0, 3).join('、')}）。`,
        // ★ warn 改 error 的理由：重复标签不是"风格问题"，是**会静默出错**的问题 ——
        //   两个同名行写到同一个坐标，后写的盖前写的，读者只看到一行，账面少一格。
        //   实测用户模板第 89/90 行同名「经营活动产生的现金流量净额」。
        //   判据只有一份（铁律 17），所以这里必须是 error，让 parseSpec 直接拒绝。
        hint: '重复的标签会互相覆盖到同一个格子（只写进去一条，另一条静默消失）。请在模板里改成不同的名字，或从 order 里删掉多余项。',
      });
    }
    // ★ 口径名必须是注册过的口径（判例见文件头 ④）。
    //   只查**字面量**：带 {{参数}} 的标签要等替换之后才知道是什么，这里不猜。
    if (spec.dim === 'period_type' && order.length) {
      const registered = new Set(PERIOD_TYPES.map((p) => p.id));
      const bad = [...new Set(order.map(String).filter((x) => !x.includes('{{') && !registered.has(x)))];
      if (bad.length) {
        out.push({
          level: 'error',
          code: 'PERIODTYPE_UNKNOWN',
          at: `${at}.${axis}.order`,
          message: `口径名不在注册的口径里：${bad.slice(0, 3).join('、')}。`,
          hint:
            `已注册的口径：${PERIOD_TYPES.map((p) => p.id).join(' / ')}。`
            + '写错一个字不会被别的判据拦住 —— 而实测那一格会**静默变成空**（本该有数、结果 null），'
            + '写进报送表就像"这一项没有数"。要新增口径，注册进 src/db/schema.ts 的 PERIOD_TYPES（铁律 5）。',
        });
      }
    }
  }

  // ---- 量纲维必须被钉住（本模块存在的主要理由，见文件头 ①）----
  // ★ 注入 facts 时集合随**目标表的形状**走：没有口径列的表（运营事实，铁律 8）只要求钉住
  //   指标 —— 否则每个运营报表都得假装有一个不存在的口径维。
  //   没注入时保持老判据（metric + period_type 全查）—— finance 规格的静默加总照样拦。
  const meaning = shapeKnown ? MEANING_DIMS.filter((d) => dimAvailableOn(d, fact)) : MEANING_DIMS;
  for (const dim of meaning) {
    if (isPinned(b, dim)) continue;
    const axisHint =
      dim === 'metric'
        ? `把这个 block 的指标钉死。两种改法：① 把指标做成轴（rows: { dim: metric, order: [营业收入, 利润总额] }）；② 用 scope.filter 指定单一指标（scope: { filter: { metric: { name: 营业收入 } } }）。`
        : `把这个 block 的口径钉死。通常把口径做成列：cols: { dim: period_type, order: [本年累计, 去年同期累计] }。`;
    out.push({
      level: 'error',
      code: 'UNCONSTRAINED_DIM',
      at: `${at}`,
      message:
        `这个 block 没有任何${dim === 'metric' ? '指标' : '口径'}约束：` +
        `行和列分别是 ${b.rows?.dim ?? '?'} / ${b.cols?.dim ?? '?'}，` +
        `这会把多个${dim === 'metric' ? '指标' : '口径'}的金额**加成一个数**。`,
      hint: axisHint + '（这不是格式问题，是会让结果静默出错的问题。）',
    });
  }

  // ---- value ----
  const v = b.value;
  if (!v || (!v.measure && !v.expr)) {
    out.push({
      level: 'error',
      code: 'VALUE_MISSING',
      at: `${at}.value`,
      message: 'value 既没有 measure 也没有 expr。',
      hint: '通常写 measure: amount（事实表金额列）。',
    });
  }

  // ---- 派生表达式（见文件头 ②）----
  if (v?.expr) {
    try {
      // 语法必须先能解析 —— 否则求值时会抛，等于"写到 spec 里才炸"
      parseExpr(v.expr);
      const refs = exprRefs(v.expr);
      const known = new Set((b.cols?.order ?? []).map(String));
      const unknown = refs.filter((r) => !known.has(r));
      if (unknown.length && b.cols?.dim === 'period_type') {
        out.push({
          level: 'error',
          code: 'EXPR_REFS',
          at: `${at}.value.expr`,
          message: `派生表达式引用了 cols.order 里没有的口径: ${unknown.join(', ')}。`,
          hint: 'expr 只能引用同一 block 的 cols.order 里声明过的口径 —— 那些才是计算结果里真正存在的列。',
        });
      }
      if (b.cols?.dim !== 'period_type') {
        out.push({
          level: 'warn',
          code: 'EXPR_REFS',
          at: `${at}.value.expr`,
          message: `派生表达式引用口径名，但 cols.dim 是「${b.cols?.dim}」而不是 period_type。`,
          hint: 'expr 的变量来自列标签。若列不是口径，表达式里的名字对不上，会求值失败。',
        });
      }
    } catch (e) {
      out.push({
        level: 'error',
        code: 'EXPR_BAD',
        at: `${at}.value.expr`,
        message: `派生表达式无法解析: ${(e as Error).message}`,
        hint: 'expr 只支持 数字、口径名、+ - * / % 与圆括号。',
      });
    }
    if (v.measure) {
      out.push({
        level: 'warn',
        code: 'EXPR_BAD',
        at: `${at}.value`,
        message: 'value 同时写了 measure 和 expr。',
        hint: 'expr 优先：数值会按派生式算，measure 只用来决定从哪个列取数。确认这是你要的。',
      });
    }
  }

  // ---- filter 字段名 ----
  checkFilter(b.rows?.filter, (b.rows?.dim ?? 'metric') as DimName, `${at}.rows.filter`, out);
  checkFilter(b.cols?.filter, (b.cols?.dim ?? 'period_type') as DimName, `${at}.cols.filter`, out);
  if (b.scope?.filter) {
    for (const [dim, f] of Object.entries(b.scope.filter)) {
      if (!isRegisteredDim(dim)) {
        out.push({
          level: 'error',
          code: 'FILTER_UNKNOWN_DIM',
          at: `${at}.scope.filter.${dim}`,
          message: `scope.filter 里有未注册的维度「${dim}」。`,
          hint: `key 只能是 ${DIM_NAMES.join(' / ')}。`,
        });
        continue;
      }
      if (shapeKnown && !dimAvailableOn(dim, fact)) {
        notOnFact(dim, `${at}.scope.filter.${dim}`);
        continue;
      }
      checkFilter(f, dim, `${at}.scope.filter.${dim}`, out);
    }
  }
  if (b.scope?.company?.filter) checkFilter(b.scope.company.filter, 'company', `${at}.scope.company.filter`, out);

  // ---- chart 的 include 必须真的存在于 order 里 ----
  if (b.chart?.include) {
    for (const [axis, items] of Object.entries(b.chart.include)) {
      const pool = axis === 'rows' ? (b.rows?.order ?? []) : (b.cols?.order ?? []);
      const missing = (items ?? []).filter((x) => !pool.map(String).includes(String(x)));
      if (missing.length) {
        out.push({
          level: 'warn',
          code: 'ORDER_EMPTY',
          at: `${at}.chart.include.${axis}`,
          message: `chart.include.${axis} 里的 ${missing.join(', ')} 不在 ${axis}.order 里，不会被画出来。`,
        });
      }
    }
  }
}

/**
 * 诊断整份 spec。
 *
 * 返回值按 level 排序（error 在前），方便人先看要紧的。
 * `parseSpec` 只在有 error 时抛；这个函数的完整清单给 lint_spec 工具与 Web 诊断面板用
 * —— 人需要看到"哪些是提醒、哪些是必须改"。
 *
 * `opts.facts` 是调用方注入的**声明过的事实表**（`gen/parse.ts` 的 declaredFactsOf()，
 * 与接入侧 diagnoseIngest 的 facts 注入同一条纪律 —— 本模块不读盘）。
 * 不注入时跳过"按目标表形状"的检查（FACT_UNKNOWN / DIM_NOT_ON_FACT）：
 * lint 是参谋，白名单的硬墙在 compile/query 的编译期 —— 解析期读盘会把纯函数变成 IO。
 */
export function lintSpec(spec: Spec, opts: { facts?: DeclaredFact[] } = {}): LintIssue[] {
  const out: LintIssue[] = [];

  // ---- 目标表声明化：spec.fact 必须是声明过的事实表 ----
  // ★ 注入了 facts 才做声明校验与形状检查（shapeKnown）——解析层不读盘，
  //   这是调用方的纪律（server/tools/cli 的入口都注入了 declaredFactsOf()）。
  const facts = opts.facts;
  let fact: DeclaredFact | null = null;
  let factUnknown = false;
  if (facts && typeof spec?.fact === 'string' && spec.fact.trim() !== '') {
    fact = facts.find((f) => f.name === spec.fact) ?? null;
    if (!fact) {
      factUnknown = true;
      out.push({
        level: 'error',
        code: 'FACT_UNKNOWN',
        at: 'fact',
        message: `目标表未声明：${spec.fact}。表名会原样拼进 SQL（铁律 2），只接受 models/*.yml 里声明过的事实表（kind: fact）。`,
        hint: `已声明的事实表：${facts.map((f) => f.name).join(' / ')}。`,
      });
    }
  }
  const shapeKnown = !!facts && !factUnknown;

  if (!spec?.id) out.push({ level: 'error', code: 'NO_ID_OR_SHEET', at: 'id', message: '缺少 id。', hint: 'id 是保存时的文件名，也是报表的标识。' });
  if (!Array.isArray(spec?.sheets) || spec.sheets.length === 0) {
    out.push({ level: 'error', code: 'NO_ID_OR_SHEET', at: 'sheets', message: '至少需要一个 sheet。' });
    return out;
  }

  (spec.sheets as SheetSpec[]).forEach((sheet, i) => {
    const sat = `sheets[${i}]`;
    if (!sheet?.name) out.push({ level: 'error', code: 'SHEET_NO_BLOCK', at: sat, message: '缺少 name。' });
    if (!Array.isArray(sheet?.blocks) || sheet.blocks.length === 0) {
      out.push({
        level: 'error',
        code: 'SHEET_NO_BLOCK',
        at: sat,
        message: `sheet「${sheet?.name ?? i}」至少需要一个 block。`,
        hint: 'block 是"数据区"的声明：anchor + rows + cols + value。',
      });
      return;
    }
    sheet.blocks.forEach((b, j) => lintBlock(b, `${sat}.blocks[${j}]`, out, fact, shapeKnown));
  });

  // 模板路径：定了 anchor 为定义名称却没有模板 → 解析不出坐标
  if (!spec.template) {
    const usesName = (spec.sheets ?? []).some((s) => (s?.blocks ?? []).some((b) => typeof b?.anchor === 'object'));
    if (usesName) {
      out.push({
        level: 'error',
        code: 'ANCHOR_MISSING',
        at: 'template',
        message: 'block 用了定义名称锚点，但 spec 没有声明 template，无法解析坐标。',
        hint: '补上 template: templates/xxx.xlsx，或把 anchor 改成 "B4" 这样的绝对坐标。',
      });
    }
  }

  // error 排前面，人先看必须改的
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}

/** 把 error 级诊断压成一条可读的异常消息（parseSpec 用） */
export function formatLintErrors(issues: LintIssue[]): string {
  return issues
    .filter((i) => i.level === 'error')
    .map((i) => `${i.at}: ${i.message}${i.hint ? `\n      → ${i.hint}` : ''}`)
    .join('\n  - ');
}

export { ExprError };
