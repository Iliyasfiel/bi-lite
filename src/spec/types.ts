/**
 * 口径规格（spec）—— bi-lite 的领域语言（docs/需求与架构.md §5）
 *
 * spec 是"透视表的声明式版本"，是数据与排版之间的唯一中间层。
 * 人和 agent 都写它；Excel 与图表都是它的渲染器。
 */
import { parse as parseYaml } from 'yaml';
import { lintSpec, type LintIssue } from './lint.ts';
import type { AnchorRef, ReportAxisGeometry, ReportBlockGeometry } from './geometry.ts';
import type { DeclaredFact } from '../gen/ir.ts';

export interface Spec {
  id: string;
  title?: string;
  template?: string;          // Excel 模板路径（版式来源）
  /**
   * 目标事实表（查询侧目标表声明化，与接入侧 `IngestSpec.target` 同一思路）。
   * ★ 省略时 = 缺省表 `fact_finance`（`gen/ir.ts` 的 DEFAULT_TARGET）—— 现有 specs 一行不用改。
   * ★ 表名必须已在 `models/*.yml` 声明（kind: fact）：compile/query 编译期白名单硬校验，
   *   lint 给 FACT_UNKNOWN —— 表名会**原样拼进 SQL**（铁律 2），绝不取未声明的名字。
   * ★ 字面量，不参与 {{参数}} 替换（substitutableStrings 刻意不含它）：标识符不做模板。
   */
  fact?: string;
  /**
   * 兼容读：执行参数（CLI `--param` / MCP、HTTP 的 `params`）永远覆盖这里的值。
   * params 是执行参数（架构 §8.1），存进 YAML 的只是**默认值**。
   */
  params?: Record<string, string | number>;
  sheets: SheetSpec[];
}

export interface SheetSpec {
  name: string;
  blocks: Block[];
}

/**
 * block = 模板几何（ReportBlockGeometry：anchor + 行/列各绑哪个维度）
 *       + 报表侧 overlay（order/filter/value/scope/chart —— 实例字面量与语义细节）。
 * 几何子集的定义在 `src/spec/geometry.ts`（架构 §8.1：两层架构的模板层）。
 */
export interface Block extends ReportBlockGeometry {
  rows: AxisSpec;
  cols: AxisSpec;
  value: ValueSpec;
  /** 参数化范围：时间 / 公司 / 任意维度 */
  scope?: {
    time?: { year?: string | number; month?: string | number };
    company?: { dim?: string; filter?: Record<string, string> };
    /**
     * 通用维度过滤：`{ metric: { name: 营业收入 }, company: { level: "2" } }`。
     *
     * ★ 存在的理由（§7.2 路径 2）：不把某个维度做成轴，而是**钉死成一个值**。
     *   典型场景：「本月营业收入」这张表里，指标不该出现在行列上，
     *   但 block 又必须限定它是哪个指标 —— 没有这个字段，`rows: company /
     *   cols: period_type` 就只能把五个指标加在一起（详见 lint.ts 文件头）。
     *
     * 与 `company.filter` 的关系：后者是它的特例，保留只为兼容文档 §5.2 的旧写法。
     */
    filter?: Record<string, Record<string, string | string[]>>;
  };
  /**
   * 可选图表声明 —— 同一份 spec 的第二个 renderer（§5.3、F5）。
   * 没写就只能出 Excel；写了就能出图，且换口径时图表与表格一起跟随。
   */
  chart?: {
    type: 'bar' | 'line' | 'pie' | 'area';
    category?: 'rows' | 'cols';
    title?: string;
    stacked?: boolean;
    include?: { rows?: string[]; cols?: string[] };
  };
}

/** 轴 = 几何（绑哪个维度）+ overlay（过滤与实例清单） */
export interface AxisSpec extends ReportAxisGeometry {
  filter?: Record<string, string | string[]>;
  order?: string[];
}

export interface ValueSpec {
  measure?: string;           // 事实表字段，通常是 amount
  agg?: 'sum' | 'avg' | 'max' | 'min' | 'count';
  /** 派生表达式，引用同区其他口径列，如 "(本年累计 - 去年同期累计) / 去年同期累计" */
  expr?: string;
  /** 同时管 Excel 单元格格式与看板显示（设计取自 Lightdash，见 §12.4.2） */
  format?: string;
}

/** 解析 YAML 文本为 spec */
/**
 * 解析并校验一份 spec。
 *
 * `opts.facts`（declaredFactsOf()）注入后，lint 才做"按目标表形状"的检查
 * （业务线规格的口径豁免、DIM_NOT_ON_FACT 等）—— 解析层不读盘，
 * 注入是调用方的纪律（server/tools/cli 的入口都注入了）。
 * 不注入时按老判据（全量量纲维 + 不查维度可用性）—— 现有 finance 规格不受影响。
 */
export function parseSpec(yamlText: string, opts: { facts?: DeclaredFact[] } = {}): Spec {
  const raw = parseYaml(yamlText) as Spec;
  validateSpec(raw, opts);
  return raw;
}

/**
 * 解析但**不校验** —— 给"诊断"场景用。
 *
 * ★ 为什么需要它：`/api/specs/lint`、`lint_spec` 工具的职责正是
 *   **告诉人哪里错了**。如果先用 parseSpec（它遇到 error 就抛），
 *   那么用户永远只能看到第一条错误，改一条再撞下一条。
 *   分开之后，一次就能给全清单。
 */
export function parseSpecLenient(yamlText: string): { spec: Spec | null; parseError: string | null } {
  try {
    return { spec: parseYaml(yamlText) as Spec, parseError: null };
  } catch (e) {
    // YAML 本身语法错误（缩进/引号）—— 这不是 spec 语义问题，单独报
    return { spec: null, parseError: (e as Error).message };
  }
}

export class SpecError extends Error {}

/**
 * 一次性给全所有诊断 —— `lint_spec` 工具与 Web 诊断面板的唯一入口。
 *
 * ★ 为什么不能直接用 parseSpec：它遇到第一条 error 就抛，
 *   于是人（和 agent）只能"改一条、再撞下一条"。
 *   这里把 YAML 语法错、结构诊断、params 未引用三类一次性报全。
 *
 * ★ 判据只有一份：结构诊断来自 `lintSpec`，与"保存时拒绝"用的是同一个函数。
 *   两份判据一定会漂移 —— 工具说没问题、保存却被拒，是最难查的那类 bug。
 *
 * `opts.facts` 透传给 lintSpec：注入声明过的事实表后，才做"按目标表形状"的检查
 * （FACT_UNKNOWN / DIM_NOT_ON_FACT）。与接入侧 diagnoseIngest 的 facts 注入同一条纪律。
 */
export function diagnoseSpec(yamlText: string, opts: { facts?: DeclaredFact[] } = {}): {
  spec: Spec | null;
  parseError: string | null;
  issues: LintIssue[];
  unusedParams: string[];
  /** 保存时会不会被拒（error 级 issue 或未引用的 params 都会导致拒绝） */
  willBeRejected: boolean;
  errors: string[];
} {
  const { spec, parseError } = parseSpecLenient(yamlText);
  if (!spec) {
    return {
      spec: null,
      parseError,
      issues: [],
      unusedParams: [],
      willBeRejected: true,
      errors: [parseError ?? 'YAML 解析失败'],
    };
  }
  const issues = lintSpec(spec, { facts: opts.facts });
  const unusedParams = findUnusedParams(spec);
  const errors = issues.filter((i) => i.level === 'error').map((i) => `${i.at}: ${i.message}`);
  if (unusedParams.length) {
    errors.push(
      `params 声明了但从未被引用: ${unusedParams.join(', ')} —— ` +
        `这通常意味着报表没有按参数过滤时间，会把所有期间的数字加总。`,
    );
  }
  return { spec, parseError: null, issues, unusedParams, willBeRejected: errors.length > 0, errors };
}

/**
 * 收集 spec 中**所有会被 substitute() 作用的字符串**。
 * 这份清单必须与 compile.ts 里实际调用 substitute() 的位置保持一致 ——
 * 漏掉一处，下面的「未使用参数」检查就会误报。
 */
function substitutableStrings(s: Spec): string[] {
  const out: string[] = [];
  for (const sheet of s.sheets ?? []) {
    for (const b of sheet.blocks ?? []) {
      out.push(...(b.rows?.order ?? []).map(String));
      out.push(...(b.cols?.order ?? []).map(String));
      for (const f of [b.rows?.filter, b.cols?.filter, b.scope?.company?.filter]) {
        for (const v of Object.values(f ?? {})) {
          Array.isArray(v) ? out.push(...v.map(String)) : out.push(String(v));
        }
      }
      // ★ scope.filter 里的值也可能带 {{参数}}（比如按板块筛选时 group_name: "{{group}}"）
      for (const f of Object.values(b.scope?.filter ?? {})) {
        for (const v of Object.values(f ?? {})) {
          Array.isArray(v) ? out.push(...v.map(String)) : out.push(String(v));
        }
      }
      if (b.scope?.time?.year !== undefined) out.push(String(b.scope.time.year));
      if (b.scope?.time?.month !== undefined) out.push(String(b.scope.time.month));
    }
  }
  return out;
}

/**
 * 找出声明了却从未被引用的参数。
 *
 * ★ 这条校验来自一次真实故障：`specs/月度保送表.yaml` 声明了
 *   `params: { year: 2026, month: 6 }`，但整个 spec 从未引用它们 ——
 *   于是「2026 年 6 月」的报送表静默地把 **12 个月全部加总**（B4 得 765345，
 *   而不是 66826）。数字看起来完全合理，没有任何报错，人工核对才能发现。
 *
 *   所以这里把它升级成**硬错误**：财务场景下，"静默算错"比"拒绝出表"危险得多。
 */
export function findUnusedParams(s: Spec): string[] {
  const declared = Object.keys(s.params ?? {});
  if (declared.length === 0) return [];
  const texts = substitutableStrings(s);
  return declared.filter((k) => !texts.some((t) => t.includes(`{{${k}}}`)));
}

/**
 * 校验入口。
 *
 * ★ 结构性判断全部委托给 `lintSpec`（src/spec/lint.ts）——
 *   这样"解析时拒绝"和"lint_spec 工具/Web 诊断面板报告"用的是**同一套判据**。
 *   两份判据会漂移：工具说没问题、保存时被拒，或者反过来。
 *
 * 只有 error 级才抛（"欠约束会静默算错"属于 error，见 lint.ts 文件头）；
 * warn 级放到诊断面板里给人看，不挡住保存 —— 一条"order 为空"的提醒
 * 不该让人连草稿都存不下来。
 */
function validateSpec(s: Spec, opts: { facts?: DeclaredFact[] } = {}) {
  const issues = lintSpec(s, opts);
  const errs = issues.filter((i) => i.level === 'error');

  // 「声明了 params 却从未引用」保持独立 —— 它关心的是 params 与引用的**关系**，
  // 不是单个 block 的结构，放在这里比塞进 lintBlock 更自然。
  const unused = findUnusedParams(s);
  const extra = unused.length
    ? [
        `params 声明了但从未被引用: ${unused.join(', ')}。` +
          `这通常意味着报表**没有按参数过滤时间**，会把所有期间的数字加总。` +
          `请在 block 里加 scope.time（如 scope: { time: { year: "{{year}}", month: "{{month}}" } }），` +
          `或删掉这些 params。`,
      ]
    : [];

  if (errs.length || extra.length) {
    const formatted = errs.map((i) => `${i.at}: ${i.message}${i.hint ? `\n      → ${i.hint}` : ''}`);
    throw new SpecError('spec 校验失败:\n  - ' + [...formatted, ...extra].join('\n  - '));
  }
}

/** 从派生表达式里抽取被引用的口径名 */
export function extractExprRefs(expr: string): string[] {
  const out: string[] = [];
  // 匹配中文字符/字母数字下划线组成的标识符
  for (const m of expr.matchAll(/[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/g)) {
    if (!['true', 'false', 'null'].includes(m[0])) out.push(m[0]);
  }
  return [...new Set(out)];
}

/** 把 spec 的 block 展开成需要查询的"格子矩阵" */
export function expandBlock(block: Block, params: Record<string, string | number> = {}) {
  const rows = block.rows.order ?? [];
  const cols = block.cols.order ?? [];
  return {
    rowLabels: rows.map((r) => substitute(String(r), params)),
    colLabels: cols.map((c) => substitute(String(c), params)),
  };
}

/** 简单的 {{var}} 替换 */
export function substitute(s: string, params: Record<string, string | number>): string {
  return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(params[k] ?? `{{${k}}}`));
}
