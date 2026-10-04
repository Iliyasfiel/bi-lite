#!/usr/bin/env node
/**
 * bi-lite 命令行入口（docs/开发计划.md §1.5）
 *
 * 定位：三个入口（CLI / MCP / Web）里的第三个 —— 给**人与脚本**。
 * 命令面已走完：引擎侧（ingest / render / query）、生成器侧（`plan` / `apply`）、
 * 物料侧（`catalog` / `validate` / `skill export`）与运维（`compact`）。
 *
 * 四条纪律（都有出处，改之前先读）：
 *
 *  1. **与另两个入口同构**：薄壳 + 自己开库，互斥由 DuckDB 的单写者锁强制
 *     （`docs/需求与架构.md` §4.4 末、`AGENTS.md` §4 备忘 5）。
 *     服务端在跑时拿不到锁 → **明确报错**，不静默失败（铁律 12）。
 *  2. **不另写判据**：本文件只做参数解析与呈现，判据一律调引擎已有的函数 ——
 *     `diagnoseIngest` / `parseIngestSpec` / `parseDecisions` / `runIngest`；
 *     与 MCP 工具调的是**同一批**（铁律 17 的漂移判例）。
 *  3. **数据走 stdout，日志与进度走 stderr** —— 与 MCP 服务端同一条纪律。
 *     所以 `bilite ingest lint x.yaml > report.json` 是干净的。
 *  4. **受众钉死 `human`**（铁律 10）：不提供任何能选 agent 的开关。
 *     且**不许把 CLI 的取数命令写进 agent 侧物料**（skill / `skill export`）——
 *     那等于给 agent 开一条官方泄漏路径（`docs/开发计划.md` §1.5）。
 *
 * 形状借鉴 DSH（`docs/开发计划.md` §1.5）：argv → **纯数据 Invocation** → 分派；
 * handler 惰性 import（`--help` / `lint` 都不加载 duckdb）；命令表自检；
 * 退出码由一处决定，不散落 `process.exit()`。
 */
import fs from 'node:fs';
// ⚠️ 类型必须用顶层 `import type` —— `const { f, type T } = await import(...)` 是**语法错误**
//    （`type` 修饰符只在 import 语句里合法，解构里不认）。而且 `import type` 会被完全擦除，
//    所以 "help / lint 不加载 xlsx-populate" 这条性质不受影响。
import type { RenderBlock } from './render/excel.ts';
import { looksLikeIngestDoc } from './spec/geometry.ts';

// ---------------- IO（可注入，便于 e2e 在进程内跑而不杀测试进程） ----------------

export interface CliIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

export function processIO(): CliIO {
  return {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
  };
}

// ---------------- 退出码（有意义，别随便加） ----------------

/**
 * 0 = 跑通了（**含"需要人拍板"的待办情形** —— 铁律 16：那是待办，不是失败）
 * 1 = 被拒 / 执行失败（有 error）
 * 2 = 用法错误（命令、选项、参数不对）
 */
export const EXIT = { OK: 0, FAILED: 1, USAGE: 2 } as const;

// ---------------- Invocation：argv 的纯数据化 ----------------

export type Invocation =
  | { kind: 'help'; command: string | null }
  | { kind: 'version' }
  | { kind: 'ingest-lint'; specFile: string }
  | { kind: 'ingest-dry-run'; specFile: string; decisionsPath: string | null; source: string | null }
  | { kind: 'ingest-run'; specFile: string; decisionsPath: string | null; strict: boolean; source: string | null }
  | { kind: 'render'; specFile: string; params: Record<string, string>; out: string | null }
  | {
      kind: 'query';
      measures: Array<{ metric: string; periodType: string }>;
      groupBy: string[];
      filter: Record<string, string | string[]>;
    }
  | { kind: 'catalog-dump'; format: 'json' | 'prompt' }
  | { kind: 'catalog-show'; object: string }
  | {
      kind: 'compact';
      /** 空的 = 归档里**所有**表（`data/parquet/` 下的目录名） */
      tables: string[];
      /** null = 用模块自己的默认值（默认值只允许有一份，在 `db/compact.ts`） */
      maxBytes: number | null;
      minFiles: number | null;
      dryRun: boolean;
    }
  | { kind: 'plan'; modelsDir: string | null; check: boolean }
  | { kind: 'apply'; modelsDir: string | null }
  | { kind: 'rebuild'; modelsDir: string | null }
  | { kind: 'validate'; specFile: string }
  | { kind: 'skill-export'; format: 'json' | 'prompt' }
  | { kind: 'usage-error'; message: string; hint: string | null };

const HELP_FLAGS = new Set(['-h', '--help']);
const VERSION_FLAGS = new Set(['-V', '--version']);

const HINT = 'bilite --help';

function usage(message: string, hint: string | null = HINT): Invocation {
  return { kind: 'usage-error', message, hint };
}

/**
 * 把 argv 解析成一个 Invocation。**纯函数，没有任何副作用** ——
 * 不读文件、不碰库、不打印。于是 e2e 能在不启动任何东西的前提下覆盖整个命令面
 * （`--help` / 退出码 / 参数校验），见 `test/e2e.ts` 第 16 阶段。
 */
export function parseCliArgs(argv: readonly string[]): Invocation {
  const tokens = [...argv];
  const first = tokens[0];
  if (first === undefined) return { kind: 'help', command: null };
  if (VERSION_FLAGS.has(first) || first === 'version') return { kind: 'version' };
  if (HELP_FLAGS.has(first)) return { kind: 'help', command: null };
  if (first === 'help') return { kind: 'help', command: tokens[1] ?? null };
  if (first === 'ingest') return parseIngestArgs(tokens.slice(1));
  if (first === 'render') return parseRenderArgs(tokens.slice(1));
  if (first === 'query') return parseQueryArgs(tokens.slice(1));
  if (first === 'catalog') return parseCatalogArgs(tokens.slice(1));
  if (first === 'compact') return parseCompactArgs(tokens.slice(1));
  if (first === 'plan') return parseGenArgs('plan', tokens.slice(1));
  if (first === 'apply') return parseGenArgs('apply', tokens.slice(1));
  if (first === 'rebuild') return parseGenArgs('rebuild', tokens.slice(1));
  if (first === 'validate') return parseValidateArgs(tokens.slice(1));
  if (first === 'skill') return parseSkillArgs(tokens.slice(1));
  return usage(`未知命令：${first}`);
}

// ---------------- 极简参数扫描（唯一一份；别在命令里各写一套） ----------------

interface RawArgs {
  positionals: string[];
  /** 选项 → 值列表（可重复）。布尔开关的值为空串。 */
  values: Record<string, string[]>;
  problem: { message: string; hint: string } | null;
}

/**
 * 扫 `--flag value`（可重复）与 `--bool`。
 *
 * ★ 未知选项**直接记 problem**，不静默忽略 —— 同铁律 14 的思路：给了却没被用上，
 *   写的人就该当场知道，而不是等某天发现"那个参数其实一直没生效"。
 */
function scanArgs(
  tokens: readonly string[],
  valued: readonly string[],
  booleans: readonly string[],
  hint: string,
): RawArgs {
  const out: RawArgs = { positionals: [], values: {}, problem: null };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith('--')) {
      if (booleans.includes(t)) {
        out.values[t] = [''];
        continue;
      }
      if (valued.includes(t)) {
        const v = tokens[i + 1];
        if (v === undefined || v.startsWith('--')) {
          out.problem = { message: `${t} 需要一个值`, hint };
          return out;
        }
        (out.values[t] ??= []).push(v);
        i++;
        continue;
      }
      out.problem = { message: `未知选项：${t}`, hint };
      return out;
    }
    if (t.startsWith('-') && t !== '-') {
      out.problem = { message: `未知选项：${t}`, hint };
      return out;
    }
    out.positionals.push(t);
  }
  return out;
}

/** 单个定位参数（缺了/多了都报错，不猜） */
function onePositional(args: RawArgs, what: string, hint: string): string | Invocation {
  if (args.positionals.length === 0) return usage(`缺${what}`, hint);
  if (args.positionals.length > 1) return usage(`只能给一个${what}，多出来的：${args.positionals[1]}`, hint);
  return args.positionals[0]!;
}

/** `k=v` → 普通对象（重复的键以后者为准）；给 `--param` 用 */
function keyValues(pairs: readonly string[], flag: string, hint: string): Record<string, string> | Invocation {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const at = p.indexOf('=');
    if (at <= 0) return usage(`${flag} 要写成 k=v（收到 ${p}）`, hint);
    out[p.slice(0, at)] = p.slice(at + 1);
  }
  return out;
}

function parseIngestArgs(tokens: readonly string[]): Invocation {
  const sub = tokens[0];
  if (sub === undefined || HELP_FLAGS.has(sub)) return { kind: 'help', command: 'ingest' };
  if (!isIngestSub(sub)) return usage(`ingest 没有子命令「${sub}」`, 'bilite ingest --help');

  const subHint = `bilite ingest ${sub} --help`;
  const rest = tokens.slice(1);
  if (rest.some((t) => HELP_FLAGS.has(t))) return { kind: 'help', command: `ingest ${sub}` };

  const args = scanArgs(rest, ['--decisions', '--source'], ['--strict'], subHint);
  if (args.problem) return usage(args.problem.message, args.problem.hint);

  const strict = '--strict' in args.values;
  const decisions = args.values['--decisions']?.[0] ?? null;
  // ★ source 是执行参数（架构 §8.1）：命令行上选文件，不改规格文本
  const source = args.values['--source']?.[0] ?? null;

  // ★ 同铁律 14 的思路：**给了却用不上就报错**，不静默忽略
  if (strict && sub !== 'run') return usage(`--strict 只对「ingest run」有意义（${sub} 不落库）`, subHint);
  if (decisions !== null && sub === 'lint') {
    return usage('--decisions 对「ingest lint」没有意义（静态诊断不比对主数据）', subHint);
  }
  if (source !== null && sub === 'lint') {
    return usage('--source 对「ingest lint」没有意义（静态诊断不读源文件）', subHint);
  }

  const specFile = onePositional(args, '接入规格文件（如 ingest/华东子公司.yaml）', subHint);
  if (typeof specFile !== 'string') return specFile;

  if (sub === 'lint') return { kind: 'ingest-lint', specFile };
  if (sub === 'dry-run') return { kind: 'ingest-dry-run', specFile, decisionsPath: decisions, source };
  return { kind: 'ingest-run', specFile, decisionsPath: decisions, strict, source };
}

function parseRenderArgs(tokens: readonly string[]): Invocation {
  const hint = 'bilite render --help';
  if (tokens.some((t) => HELP_FLAGS.has(t))) return { kind: 'help', command: 'render' };

  const args = scanArgs(tokens, ['--param', '--out'], [], hint);
  if (args.problem) return usage(args.problem.message, args.problem.hint);
  const specFile = onePositional(args, '报表规格文件（如 specs/月度保送表.yaml）', hint);
  if (typeof specFile !== 'string') return specFile;

  const params = keyValues(args.values['--param'] ?? [], '--param', hint);
  if ('kind' in params) return params;

  const out = args.values['--out']?.[0] ?? null;
  return { kind: 'render', specFile, params, out };
}

/**
 * `catalog dump` / `catalog show` —— 把「库里现在有什么」给 agent（架构 §8.2 ②③、§8.5）。
 * 注意这里是**人的命令行**；agent 侧要另走 MCP（且必须过 `callTool()` 的金额兜底）。
 */
function parseCatalogArgs(tokens: readonly string[]): Invocation {
  const sub = tokens[0];
  if (sub === undefined || HELP_FLAGS.has(sub)) return { kind: 'help', command: 'catalog' };
  if (sub !== 'dump' && sub !== 'show') return usage(`catalog 没有子命令「${sub}」`, 'bilite catalog --help');

  const hint = `bilite catalog ${sub} --help`;
  const rest = tokens.slice(1);
  if (rest.some((t) => HELP_FLAGS.has(t))) return { kind: 'help', command: `catalog ${sub}` };

  if (sub === 'dump') {
    const args = scanArgs(rest, ['--format'], [], hint);
    if (args.problem) return usage(args.problem.message, args.problem.hint);
    const fmt = args.values['--format']?.[0] ?? 'json';
    if (fmt !== 'json' && fmt !== 'prompt') return usage(`--format 只认 json / prompt（收到 ${fmt}）`, hint);
    if (args.positionals.length > 0) return usage(`dump 不接受位置参数（收到 ${args.positionals[0]}）`, hint);
    return { kind: 'catalog-dump', format: fmt };
  }

  const args = scanArgs(rest, [], [], hint);
  if (args.problem) return usage(args.problem.message, args.problem.hint);
  const object = onePositional(args, '对象名（如 fact_finance）', hint);
  if (typeof object !== 'string') return object;
  return { kind: 'catalog-show', object };
}

/**
 * `compact` —— 合并 Parquet 归档里的小文件（架构 §10 R8）。
 *
 * ★ 它不是"库的命令"：归档目录不是库，合并只碰 `data/parquet/**`，用内存实例读它们，
 *   **既不打开 `.duckdb` 文件、也不碰库锁** —— 所以服务端正在跑时也能跑（e2e 钉着"不碰库"）。
 * ★ 表名判据**不在这里**：`--table` 的形状由 `compact.ts` 的 `assertSafeTableName()` 说了算，
 *   这里只负责"给了几个"与"数字长得对不对"（判据只有一份，铁律 17）。
 */
function parseCompactArgs(tokens: readonly string[]): Invocation {
  const hint = 'bilite compact --help';
  if (tokens.some((t) => HELP_FLAGS.has(t))) return { kind: 'help', command: 'compact' };

  const args = scanArgs(tokens, ['--table', '--max-bytes', '--min-files'], ['--dry-run'], hint);
  if (args.problem) return usage(args.problem.message, args.problem.hint);
  if (args.positionals.length > 0) {
    return usage(`compact 不接受位置参数（收到 ${args.positionals[0]}）—— 表名用 --table 给`, hint);
  }

  const positiveInt = (flag: string, min: number): number | null | Invocation => {
    const raw = args.values[flag]?.[0];
    if (raw === undefined) return null; // 交给模块自己的默认值
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) return usage(`${flag} 要写成 ≥ ${min} 的整数（收到 ${raw}）`, hint);
    return n;
  };
  const maxBytes = positiveInt('--max-bytes', 1);
  // ⚠️ `typeof null === 'object'` —— 少了 `!== null` 这一半，缺选项时会直接把 null 当 Invocation 返回
  if (maxBytes !== null && typeof maxBytes === 'object') return maxBytes;
  const minFiles = positiveInt('--min-files', 2);
  if (minFiles !== null && typeof minFiles === 'object') return minFiles;

  return {
    kind: 'compact',
    tables: args.values['--table'] ?? [],
    maxBytes,
    minFiles,
    dryRun: '--dry-run' in args.values,
  };
}

/**
 * `plan` / `apply` / `rebuild` —— 生成器侧的三条命令（P2 + P3）。
 *
 * ★ 为什么 plan 与 apply 必须是**两条**命令（而不是一条带 `--yes`）：先见 diff 再决定落地，
 *   是这个生成器存在的理由（`docs/开发计划.md` §1.2 的验收）。`plan` 一个字节都不写。
 * ★ 默认目录不在这里写死：缺 `--models` 时交给 `gen/parse.ts` 的 `MODELS_DIR`
 *   （默认值只允许有一份 —— 同 `compact` 的 `--max-bytes`）。
 */
function parseGenArgs(cmd: 'plan' | 'apply' | 'rebuild', tokens: readonly string[]): Invocation {
  const hint = `bilite ${cmd} --help`;
  if (tokens.some((t) => HELP_FLAGS.has(t))) return { kind: 'help', command: cmd };
  const args = scanArgs(tokens, ['--models'], cmd === 'plan' ? ['--check'] : [], hint);
  if (args.problem) return usage(args.problem.message, args.problem.hint);
  if (args.positionals.length > 0) {
    return usage(`${cmd} 不接受位置参数（收到 ${args.positionals[0]}）—— 模型目录用 --models 给`, hint);
  }
  const modelsDir = args.values['--models']?.[0] ?? null;
  if (cmd === 'apply') return { kind: 'apply', modelsDir };
  if (cmd === 'rebuild') return { kind: 'rebuild', modelsDir };
  return { kind: 'plan', modelsDir, check: '--check' in args.values };
}

/**
 * `validate <yaml>` —— §8.2 的第 ④ 条接口：**可执行、带修复建议**的校验。
 *
 * ★ 它**不写新判据**。判据仍是那两份（接入规格 `diagnoseIngest` / 报表规格 `diagnoseSpec`），
 *   这里只做一件它们没做的事：**判别该用哪一份** —— 按**模板几何**判
 *   （`looksLikeIngestDoc`：接入块的 rows 是「列 → 维」数组，报表块是带 dim 的轴对象）。
 *   不再按"有没有 source"判 —— source 已经是执行参数，没有 source 的接入规格是合法的。
 *   判别本身也是判据，所以只有这一处。
 */
function parseValidateArgs(tokens: readonly string[]): Invocation {
  const hint = 'bilite validate --help';
  if (tokens.some((t) => HELP_FLAGS.has(t))) return { kind: 'help', command: 'validate' };
  // 裸跑 `validate` 退 0 会让"脚本里变量为空"看起来像通过 —— 只有这一个形式能跑，所以缺文件就是用法错误
  if (tokens.length === 0) return usage('缺规格文件（接入规格或报表规格）', hint);
  const args = scanArgs(tokens, [], [], hint);
  if (args.problem) return usage(args.problem.message, args.problem.hint);
  const specFile = onePositional(args, '规格文件（接入规格或报表规格）', hint);
  if (typeof specFile !== 'string') return specFile;
  return { kind: 'validate', specFile };
}

function parseSkillArgs(tokens: readonly string[]): Invocation {
  const hint = 'bilite skill export --help';
  const sub = tokens[0];
  if (sub === undefined || HELP_FLAGS.has(sub)) return { kind: 'help', command: 'skill' };
  if (sub !== 'export') return usage(`skill 没有子命令「${sub}」（只有 export）`, hint);

  const rest = tokens.slice(1);
  if (rest.some((t) => HELP_FLAGS.has(t))) return { kind: 'help', command: 'skill' };
  const args = scanArgs(rest, ['--format'], [], hint);
  if (args.problem) return usage(args.problem.message, args.problem.hint);
  const fmt = args.values['--format']?.[0] ?? 'json';
  if (fmt !== 'json' && fmt !== 'prompt') return usage(`--format 只认 json / prompt（收到 ${fmt}）`, hint);
  if (args.positionals.length > 0) return usage(`export 不接受位置参数（收到 ${args.positionals[0]}）`, hint);
  return { kind: 'skill-export', format: fmt };
}

function parseQueryArgs(tokens: readonly string[]): Invocation {
  const hint = 'bilite query --help';
  if (tokens.some((t) => HELP_FLAGS.has(t))) return { kind: 'help', command: 'query' };

  // ⚠️ 这里**故意**不接受任何"受众"开关（铁律 10：受众由入口钉死）。
  //    写成 `--audience` 会落到"未知选项"上 —— 那不是遗漏，是设计。
  const args = scanArgs(tokens, ['--measure', '--by', '--filter'], [], hint);
  if (args.problem) return usage(args.problem.message, args.problem.hint);

  const measures: Array<{ metric: string; periodType: string }> = [];
  for (const m of args.values['--measure'] ?? []) {
    const at = m.indexOf(':');
    if (at <= 0 || at === m.length - 1) {
      return usage(`--measure 要写成「指标:口径」（收到 ${m}），如 --measure 营业收入:本年累计`, hint);
    }
    measures.push({ metric: m.slice(0, at), periodType: m.slice(at + 1) });
  }
  if (measures.length === 0) return usage('至少要一个 --measure（指标:口径）', hint);

  const filter: Record<string, string | string[]> = {};
  for (const f of args.values['--filter'] ?? []) {
    const at = f.indexOf('=');
    if (at <= 0) return usage(`--filter 要写成 dim=值（收到 ${f}）`, hint);
    const k = f.slice(0, at);
    const v = f.slice(at + 1);
    const prev = filter[k];
    if (prev === undefined) filter[k] = v;
    else if (Array.isArray(prev)) prev.push(v);
    else filter[k] = [prev, v];
  }

  return { kind: 'query', measures, groupBy: args.values['--by'] ?? [], filter };
}

const INGEST_SUBS = ['lint', 'dry-run', 'run'] as const;
type IngestSub = (typeof INGEST_SUBS)[number];

function isIngestSub(s: string): s is IngestSub {
  return (INGEST_SUBS as readonly string[]).includes(s);
}

// parseIngestArgs 与 render / query 共用同一个 scanArgs（见上）——
// 这里只留子命令判定表，不再各写一套参数扫描。

// ---------------- 库的生命周期：只有真 open 过才记 ----------------

/**
 * 本进程是否**真的**打开过库。
 *
 * ★ 不用"handlers 汇报"那种写法：handler 抛错时汇报值只能靠猜，而猜错的表现是
 *   要么漏关、要么把一个不属于自己的库关掉（嵌入运行时库归调用方管）。
 *   这里只在一处置位 —— `openDb()` 成功之后。
 */
let dbOpened = false;

async function openDb(opts?: { models?: 'ensure' | 'skip' }) {
  const db = await import('./db/index.ts');
  await db.open(undefined, opts);
  dbOpened = true;
  return db;
}

/** 仅供测试观察：本进程有没有开过库（e2e 用它断言 lint / help 不碰库） */
export function hasOpenedDb(): boolean {
  return dbOpened;
}

// ---------------- 命令表（与 Invocation 一一对应；缺一个就启动即报错） ----------------

export interface CliCommand {
  /** 与 `Invocation['kind']` 一一对应 —— 自检靠它 */
  invocation: Invocation['kind'];
  /** 两个词，供 help 列表与 `help <命令>` */
  name: string;
  summary: string;
  usage: string;
  run: (inv: Invocation, io: CliIO) => Promise<number>;
}

/**
 * 需要 handler 的 Invocation 种类。
 * ⚠️ 往 `Invocation` 加一种 kind 时，这里与 `COMMANDS` **都要动**，
 * 否则 `commandTableProblems()` 会在启动时把这件事喊出来。
 */
const HANDLED_KINDS: readonly Invocation['kind'][] = [
  'ingest-lint',
  'ingest-dry-run',
  'ingest-run',
  'render',
  'query',
  'catalog-dump',
  'catalog-show',
  'compact',
  'plan',
  'apply',
  'rebuild',
  'validate',
  'skill-export',
];

/** `--decisions` 给的是文件路径；读出来交给 ingest 侧**唯一**的校验实现 */
async function loadDecisions(path: string | null): Promise<unknown> {
  if (path === null) return undefined;
  if (!fs.existsSync(path)) throw new Error(`--decisions 指定的文件不存在：${path}`);
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`--decisions 文件不是合法 JSON（${path}）：${(e as Error).message}`);
  }
}

/** 读源规格文本；文件不存在时给一句人话，而不是让 ENOENT 冒上去 */
function readSpecFile(specFile: string): string {
  if (!fs.existsSync(specFile)) {
    throw new Error(`接入规格文件不存在：${specFile}（先写一份 YAML，或检查路径）`);
  }
  return fs.readFileSync(specFile, 'utf8');
}

function jsonTo(io: CliIO, value: unknown): void {
  io.out(JSON.stringify(value, null, 2) + '\n');
}

export const COMMANDS: CliCommand[] = [
  {
    invocation: 'ingest-lint',
    name: 'ingest lint',
    summary: '静态诊断接入规格：只读 YAML 文本，不读源文件、不碰数据库',
    usage: 'bilite ingest lint <规格.yaml>',
    async run(inv, io) {
      if (inv.kind !== 'ingest-lint') throw new Error('命令表与 Invocation 不匹配');
      // ★ 静态诊断只需要"已注册的口径"，而它来自 staticCatalog() —— **零 DB 访问**。
      //   于是 lint 在服务端正持有库锁时也能跑（§7.2 的"被占用就报错"对它不适用）。
      const { diagnoseIngest } = await import('./ingest/types.ts');
      const { staticCatalog } = await import('./semantic/query.ts');
      // ★ 目标表也是判据的一部分：声明的投影**不碰库**，所以 lint 照旧零 DB 访问
      const { declaredFactsOf } = await import('./gen/parse.ts');
      const text = readSpecFile(inv.specFile);
      const d = diagnoseIngest(text, { periodTypes: staticCatalog().periodTypes.map((p) => p.id), facts: declaredFactsOf() });
      const errors = d.issues.filter((i) => i.level === 'error');
      const warns = d.issues.filter((i) => i.level === 'warn');
      jsonTo(io, {
        from: inv.specFile,
        id: d.spec?.id ?? null,
        willBeRejected: d.willBeRejected,
        parseError: d.parseError ?? null,
        errorCount: errors.length,
        warningCount: warns.length,
        errors,
        warnings: warns,
      });
      io.err(
        `bilite ingest lint: ${errors.length} error / ${warns.length} warn` +
          (d.willBeRejected ? ' —— 会被 parseIngestSpec 拒绝' : '') +
          '\n',
      );
      return d.willBeRejected ? EXIT.FAILED : EXIT.OK;
    },
  },
  {
    invocation: 'ingest-dry-run',
    name: 'ingest dry-run',
    summary: '真读源文件，只出形状与主数据判定 —— 一行都不写库',
    usage: 'bilite ingest dry-run <规格.yaml> [--source 源.xlsx] [--decisions <decisions.json>]',
    async run(inv, io) {
      if (inv.kind !== 'ingest-dry-run') throw new Error('命令表与 Invocation 不匹配');
      const { diagnoseIngest, parseIngestSpec, parseDecisions } = await import('./ingest/types.ts');
      const { masterCatalog } = await import('./ingest/master.ts');
      const { runIngest } = await import('./ingest/run.ts');

      // 先读规格文本再开库：规格都不存在时，不该先去碰库
      const text = readSpecFile(inv.specFile);
      await openDb();
      const cat = await masterCatalog();
      // ★ 同一份 ctx 给两次调用（诊断 + 解析）—— 少给一次就会出现
      //   "工具说没问题、落库却被拒"（判据漂移的老毛病，铁律 17）
      const lintCtx = { periodTypes: cat.periodTypes, facts: cat.facts };
      const d = diagnoseIngest(text, lintCtx);
      if (d.willBeRejected) {
        jsonTo(io, {
          from: inv.specFile,
          ok: false,
          refused: true,
          errors: d.issues.filter((i) => i.level === 'error'),
          note: '规格没通过静态诊断，先按 errors 改规格（这一步连源文件都没读）。',
        });
        io.err('bilite ingest dry-run: 静态诊断没通过，未读源文件\n');
        return EXIT.FAILED;
      }
      const spec = parseIngestSpec(text, lintCtx);
      const r = await runIngest(spec, {
        catalog: cat,
        planOnly: true,
        decisions: parseDecisions(await loadDecisions(inv.decisionsPath)),
        source: inv.source ?? undefined,
      });
      jsonTo(io, { from: inv.specFile, planOnly: true, ...r });
      io.err(
        r.errors.length
          ? `bilite ingest dry-run: ${r.errors.length} 个 error（${r.errors.map((e) => e.code).join('、')}）` +
              ' —— 现在跑进去也只会一行不落地被拒\n'
          : `bilite ingest dry-run: 本批会写 ${r.inserted} 行` +
              (r.needsDecision.length
                ? `；${r.needsDecision.length} 个名字需要人拍板（这些行不会落库）`
                : '') +
              '\n',
      );
      // ★ 退出码的分界就在这一行：`needsDecision` 是**待办**不是失败（铁律 16），所以退 0；
      //   但 `error` 不是待办 —— 脚本只看退出码，把"这份源根本读不了"报成成功
      //   正是本仓库最讨厌的那种安静失败（铁律 12）。
      return r.errors.length > 0 ? EXIT.FAILED : EXIT.OK;
    },
  },
  {
    invocation: 'ingest-run',
    name: 'ingest run',
    summary: '真正落库：源 Excel → 星型表（唯一会写库的接入命令）',
    usage: 'bilite ingest run <规格.yaml> [--source 源.xlsx] [--decisions <decisions.json>] [--strict]',
    async run(inv, io) {
      if (inv.kind !== 'ingest-run') throw new Error('命令表与 Invocation 不匹配');
      const { diagnoseIngest, parseIngestSpec, parseDecisions } = await import('./ingest/types.ts');
      const { masterCatalog } = await import('./ingest/master.ts');
      const { runIngest } = await import('./ingest/run.ts');

      const text = readSpecFile(inv.specFile);
      await openDb();
      const cat = await masterCatalog();
      // ★ 同一份 ctx 给两次调用（诊断 + 解析）—— 少给一次就会出现
      //   "工具说没问题、落库却被拒"（判据漂移的老毛病，铁律 17）
      const lintCtx = { periodTypes: cat.periodTypes, facts: cat.facts };
      const d = diagnoseIngest(text, lintCtx);
      if (d.willBeRejected) {
        jsonTo(io, {
          from: inv.specFile,
          ok: false,
          refused: true,
          errors: d.issues.filter((i) => i.level === 'error'),
          note: '规格没通过静态诊断，没有落任何数据。',
        });
        io.err('bilite ingest run: 静态诊断没通过，一行都没写\n');
        return EXIT.FAILED;
      }
      const spec = parseIngestSpec(text, lintCtx);
      const r = await runIngest(spec, {
        catalog: cat,
        decisions: parseDecisions(await loadDecisions(inv.decisionsPath)),
        strict: inv.strict,
        source: inv.source ?? undefined,
      });
      jsonTo(io, { from: inv.specFile, ...r });
      io.err(
        `bilite ingest run: 写入 ${r.inserted} 行 / 批次 ${r.batchId ?? '(无)'} / 归档 ${
          r.archived ? '成功' : '未成功（要看 stderr 的日志）'
        }` + (r.needsDecision.length ? `；${r.needsDecision.length} 个名字待拍板（未落库）` : '') + '\n',
      );
      return r.errors.length > 0 ? EXIT.FAILED : EXIT.OK;
    },
  },
  {
    invocation: 'render',
    name: 'render',
    summary: '按报表规格填出 Excel（保留模板版式）；只回路径与计数，不含金额',
    usage: 'bilite render <报表规格.yaml> [--param k=v]... [--out 文件名]',
    async run(inv, io) {
      if (inv.kind !== 'render') throw new Error('命令表与 Invocation 不匹配');
      const db = await import('./db/index.ts');
      const { parseSpec } = await import('./spec/types.ts');
      const { compileBlock, runCompiled } = await import('./spec/compile.ts');
      const { declaredFactsOf } = await import('./gen/parse.ts');
      const { renderTemplate } = await import('./render/excel.ts');

      if (!fs.existsSync(inv.specFile)) throw new Error(`报表规格文件不存在：${inv.specFile}`);
      const spec = parseSpec(fs.readFileSync(inv.specFile, 'utf8'), { facts: declaredFactsOf() });
      if (!spec.template) throw new Error('这份规格没有声明 template，没法出 Excel');
      if (!fs.existsSync(spec.template)) throw new Error(`模板不存在：${spec.template}`);

      await openDb();
      const p = { ...(spec.params ?? {}), ...inv.params };

      const blocks: RenderBlock[] = [];
      for (const sheet of spec.sheets) {
        for (const b of sheet.blocks) {
          // ↓ 数值只在本地变量里停留，绝不进返回值（与 MCP 的 render_report 同一条纪律）
          const compiled = compileBlock(b, p, { factName: spec.fact, facts: declaredFactsOf() });
          const result = await runCompiled(compiled, (sql) => db.query(sql));
          blocks.push({
            sheet: sheet.name,
            anchor: b.anchor,
            colLabels: result.colLabels,
            rows: result.matrix.map((m) => ({ label: m.label, values: m.values })),
            format: b.value.format,
            writeRowLabels: false,
            writeColLabels: false,
          });
        }
      }

      const dir = 'output';
      fs.mkdirSync(dir, { recursive: true });
      const base = spec.id.replace(/[^\w\u4e00-\u9fa5.\-]/g, '_');
      const name = inv.out ?? `${base}-${p.year ?? ''}${String(p.month ?? '').padStart(2, '0')}.xlsx`;
      const outPath = `${dir}/${name.split('/').pop()}`;

      const r = await renderTemplate(spec.template, outPath, blocks);
      jsonTo(io, {
        from: inv.specFile,
        outputPath: r.outputPath,
        cellsWritten: r.cellsWritten,
        blocks: r.blocks,
        formatKept: r.formatKept,
        warnings: r.warnings,
        note: '数值不在本返回值里 —— 要看数请打开文件预览。',
      });
      io.err(`bilite render: 写出 ${r.outputPath}（${r.cellsWritten} 格）\n`);
      return EXIT.OK;
    },
  },
  {
    invocation: 'query',
    name: 'query',
    summary: '查数（受众固定为 human，返精确值）；不许接进 agent 侧物料',
    usage:
      "bilite query --measure '指标:口径' [--measure ...] [--by 维度]... [--filter 维度=值]...",
    async run(inv, io) {
      if (inv.kind !== 'query') throw new Error('命令表与 Invocation 不匹配');
      const { queryMetrics } = await import('./semantic/query.ts');
      const { declaredFactsOf } = await import('./gen/parse.ts');
      const db = await import('./db/index.ts');
      await openDb();

      const r = await queryMetrics(
        {
          measures: inv.measures,
          groupBy: inv.groupBy,
          filter: inv.filter,
          // ★ 铁律 10：受众由**入口**钉死。CLI 是人的入口 → human（精确值、无阈值）。
          //   这里写死，不留任何可被参数覆盖的分支 —— 与 Web 入口同一套纪律。
          audience: 'human',
        },
        (sql) => db.query(sql),
        declaredFactsOf(),
      );

      jsonTo(io, r);
      io.err(
        `bilite query: ${r.groups.length} 组 / ${r.meta.cellCount} 格（audience=${r.meta.audience}）\n`,
      );
      return EXIT.OK;
    },
  },
  {
    invocation: 'catalog-dump',
    name: 'catalog dump',
    summary: '导出「库里现在有什么」：L1 业务成员 / L2 物理结构 / L3 版本；零金额',
    usage: 'bilite catalog dump [--format json|prompt]',
    async run(inv, io) {
      if (inv.kind !== 'catalog-dump') throw new Error('命令表与 Invocation 不匹配');
      const { catalogDump, catalogPrompt } = await import('./meta/catalog.ts');
      await openDb();
      const c = await catalogDump();
      if (inv.format === 'prompt') io.out(catalogPrompt(c));
      else jsonTo(io, c);
      io.err(
        `bilite catalog dump: ${c.objects.length} 个对象 / ${c.members.metrics.length} 个指标` +
          (c.drift.length ? `；⚠️ ${c.drift.length} 条契约漂移 —— 这份 catalog 不可信\n` : '\n'),
      );
      // ★ 漂移时**不以成功退出**：一份不可信的 catalog 不该被脚本当成"拿到了"
      return c.drift.length > 0 ? EXIT.FAILED : EXIT.OK;
    },
  },
  {
    invocation: 'catalog-show',
    name: 'catalog show',
    summary: '按需下钻一张表的结构（默认路径：别把整库吞下去）',
    usage: 'bilite catalog show <表名>',
    async run(inv, io) {
      if (inv.kind !== 'catalog-show') throw new Error('命令表与 Invocation 不匹配');
      const { catalogShow } = await import('./meta/catalog.ts');
      await openDb();
      const o = await catalogShow(inv.object);
      jsonTo(io, o);
      io.err(`bilite catalog show: ${o.name}（${o.columns.length} 列 / ${o.rowCount ?? '?'} 行）\n`);
      return EXIT.OK;
    },
  },
  {
    invocation: 'compact',
    name: 'compact',
    summary: 'Parquet 归档的小文件合并（R8）：先逐批次对拍再删源文件；不碰库、不碰库锁',
    usage: 'bilite compact [--table <表名>]... [--max-bytes <n>] [--min-files <n>] [--dry-run]',
    async run(inv, io) {
      if (inv.kind !== 'compact') throw new Error('命令表与 Invocation 不匹配');
      const { compactParquet, listArchiveTables, assertSafeTableName, suspectInputs } = await import('./db/compact.ts');

      // 不给 --table 就是"归档里的所有表" —— 定期 compaction 就是 `bilite compact`
      const tables = inv.tables.length > 0 ? inv.tables : listArchiveTables();
      const results = [];
      for (const t of tables) {
        assertSafeTableName(t); // 判据在模块里，这里只是调用点
        results.push(
          await compactParquet(t, {
            maxBytes: inv.maxBytes ?? undefined,
            minFiles: inv.minFiles ?? undefined,
            dryRun: inv.dryRun,
          }),
        );
      }
      const suspects = results.flatMap(suspectInputs);
      jsonTo(io, {
        dryRun: inv.dryRun,
        tables,
        results,
        suspects,
        note: inv.dryRun
          ? 'dry-run：计划给你看，一个字节都没写。'
          : '合并产物已逐批次对拍通过，源文件已删；没有候选的表是正常结果，不是失败。',
      });
      io.err(
        `bilite compact: ` +
          (results.length === 0
            ? '归档里一张表都没有（data/parquet 是空的）\n'
            : results
                .map(
                  (r) =>
                    `${r.table} ` +
                    (r.sources.length > 1
                      ? inv.dryRun
                        ? `会合并 ${r.sources.length} 个小文件`
                        : `${r.sources.length} 个小文件 → 1`
                      : '无候选'),
                )
                .join(' / ') + '\n') +
          (suspects.length > 0
            ? `⚠️ ${suspects.length} 个 0 行残骸没动（那多半是过去某次归档失败的证据）：${suspects.join('、')}\n`
            : ''),
      );
      // 0 行残骸不是"合并成功"该有的样子 —— 让脚本能看见（铁律 12：不许安静）
      return suspects.length > 0 ? EXIT.FAILED : EXIT.OK;
    },
  },
  {
    invocation: 'plan',
    name: 'plan',
    summary: '把 models/*.yml 的声明与库结构对一遍，出人可读的变更清单 —— 一个字节都不写',
    usage: 'bilite plan [--models <目录>] [--check]',
    async run(inv, io) {
      if (inv.kind !== 'plan') throw new Error('命令表与 Invocation 不匹配');
      const { diagnoseModels, MODELS_DIR } = await import('./gen/parse.ts');
      const { planModels, summarizePlan } = await import('./gen/plan.ts');
      const dir = inv.modelsDir ?? MODELS_DIR;

      const d = diagnoseModels(dir);
      if (!d.ir) {
        jsonTo(io, { models: dir, ok: false, issues: d.issues });
        io.err('bilite plan: 声明本身有问题，先改声明\n');
        return EXIT.FAILED;
      }
      // ★ 生成器自己的命令**不让 open() 碰声明**：plan 要看到一个没被动过的库
      //   （否则空库引导会在 open() 里把变更落掉，plan 永远说"无变更"，这条命令就废了）
      await openDb({ models: 'skip' });
      const plan = await planModels(d.ir);
      jsonTo(io, {
        models: dir,
        ok: true,
        pending: plan.pending,
        tables: plan.tables,
        irHash: plan.irHash,
        appliedHash: plan.appliedHash,
        structuralCount: plan.structural.length,
        changes: plan.changes,
        blocking: plan.blocking,
        note: 'plan 是只读的：它连一条 DDL 都没执行。要落地用 bilite apply。',
      });
      io.err(`bilite plan: ${summarizePlan(plan)}\n`);
      // --check 给 CI 用：有未落地的变更就退 1（不给它时，plan 只是"给你看一眼"，不算失败）
      if (inv.check && plan.pending) return EXIT.FAILED;
      return EXIT.OK;
    },
  },
  {
    invocation: 'apply',
    name: 'apply',
    summary: '按 models/*.yml 落地变更（建表 / 加列 / 刷新契约）—— 删列与改类型永不自动做',
    usage: 'bilite apply [--models <目录>]',
    async run(inv, io) {
      if (inv.kind !== 'apply') throw new Error('命令表与 Invocation 不匹配');
      const { diagnoseModels, MODELS_DIR } = await import('./gen/parse.ts');
      const { applyModels } = await import('./gen/apply.ts');
      const dir = inv.modelsDir ?? MODELS_DIR;

      const d = diagnoseModels(dir);
      if (!d.ir) {
        jsonTo(io, { models: dir, ok: false, issues: d.issues });
        io.err('bilite apply: 声明本身有问题，一行都没动\n');
        return EXIT.FAILED;
      }
      // 同理：apply 要自己报告落了什么，不能被 open() 抢先做掉
      await openDb({ models: 'skip' });
      const r = await applyModels(d.ir);
      jsonTo(io, {
        models: dir,
        ok: r.blocked.length === 0,
        tables: r.tables,
        irHash: r.irHash,
        applied: r.applied.map((c) => ({ kind: c.kind, table: c.table, column: c.column ?? null, detail: c.detail })),
        blocked: r.blocked,
        note: r.note,
      });
      io.err(`bilite apply: ${r.note}\n`);
      return r.blocked.length > 0 ? EXIT.FAILED : EXIT.OK;
    },
  },
  {
    invocation: 'rebuild',
    name: 'rebuild',
    summary: '全量对齐派生物：声明行（rows:）同步 + 聚合表重算 —— 都是删了能回来的东西',
    usage: 'bilite rebuild [--models <目录>]',
    async run(inv, io) {
      if (inv.kind !== 'rebuild') throw new Error('命令表与 Invocation 不匹配');
      const { diagnoseModels, MODELS_DIR } = await import('./gen/parse.ts');
      const { rebuildAll } = await import('./gen/rebuild.ts');
      const dir = inv.modelsDir ?? MODELS_DIR;

      const d = diagnoseModels(dir);
      if (!d.ir) {
        jsonTo(io, { models: dir, ok: false, issues: d.issues });
        io.err('bilite rebuild: 声明本身有问题，一行都没动\n');
        return EXIT.FAILED;
      }
      // 生成器命令一律 models:'skip'（与 plan/apply 同理：不让 open() 抢先落地任何东西）
      await openDb({ models: 'skip' });
      const r = await rebuildAll(d.ir);
      jsonTo(io, { models: dir, ok: true, synced: r.synced, rebuilt: r.rebuilt, sqls: r.sqls });
      const parts: string[] = [];
      if (r.synced.length > 0) parts.push(`同步了声明行 ${r.synced.map((s) => `${s.table}×${s.rows}`).join('、')}`);
      if (r.rebuilt.length > 0) parts.push(`重算了聚合表 ${r.rebuilt.join('、')}`);
      io.err(parts.length > 0 ? `bilite rebuild: ${parts.join('；')}\n` : 'bilite rebuild: models/ 里没有派生物（rows: 或 kind: aggregate），什么都没做\n');
      return EXIT.OK;
    },
  },
  {
    invocation: 'validate',
    name: 'validate',
    summary: '校验一份 YAML（接入规格或报表规格），自动判别该用哪份判据；一次给全问题',
    usage: 'bilite validate <规格.yaml>',
    async run(inv, io) {
      if (inv.kind !== 'validate') throw new Error('命令表与 Invocation 不匹配');
      const { parse: parseYaml } = await import('yaml');
      const text = readSpecFile(inv.specFile);

      let doc: unknown = null;
      try {
        doc = parseYaml(text);
      } catch {
        doc = null; // 语法错交给下面的 diagnose 去报（它们对"解析失败"有专门的措辞）
      }
      // ★ 判别按模板几何（geometry.ts 的唯一实现），不按"有没有 source"——
      //   source 是执行参数，没有它的一份接入规格也是接入规格
      const looksIngest = doc !== null && looksLikeIngestDoc(doc);

      const count = (issues: Array<{ level: string }>) => ({
        errors: issues.filter((i) => i.level === 'error').length,
        warns: issues.filter((i) => i.level === 'warn').length,
      });

      if (looksIngest) {
        const { diagnoseIngest } = await import('./ingest/types.ts');
        const { staticCatalog } = await import('./semantic/query.ts');
        const { declaredFactsOf } = await import('./gen/parse.ts');
        const d = diagnoseIngest(text, { periodTypes: staticCatalog().periodTypes.map((p) => p.id), facts: declaredFactsOf() });
        const c = count(d.issues);
        jsonTo(io, {
          kind: 'ingest',
          from: inv.specFile,
          ok: !d.willBeRejected,
          willBeRejected: d.willBeRejected,
          parseError: d.parseError ?? null,
          issueCount: d.issues.length,
          issues: d.issues,
          note: '判据就是 lint_ingest 那一份；这里只多了「自动判别用哪份判据」。',
        });
        io.err(`bilite validate: 接入规格 · ${c.errors} error / ${c.warns} warn\n`);
        return d.willBeRejected ? EXIT.FAILED : EXIT.OK;
      }

      const { diagnoseSpec } = await import('./spec/types.ts');
      const { declaredFactsOf } = await import('./gen/parse.ts');
      const d = diagnoseSpec(text, { facts: declaredFactsOf() });
      const c = count(d.issues);
      jsonTo(io, {
        kind: 'report',
        from: inv.specFile,
        ok: !d.willBeRejected,
        willBeRejected: d.willBeRejected,
        parseError: d.parseError ?? null,
        issueCount: d.issues.length,
        unusedParams: d.unusedParams,
        issues: d.issues.map((i) => ({ level: i.level, code: i.code, at: i.at, message: i.message, hint: i.hint ?? null })),
        note: '判据就是 lint_spec / parseSpec 那一份；这里只多了「自动判别用哪份判据」。',
      });
      io.err(`bilite validate: 报表规格 · ${c.errors} error / ${c.warns} warn\n`);
      return d.willBeRejected ? EXIT.FAILED : EXIT.OK;
    },
  },
  {
    invocation: 'skill-export',
    name: 'skill export',
    summary: '把手册里**可对拍**的事实从实现投影出来（工具面 + 注册表；缺口写在导出物里）',
    usage: 'bilite skill export [--format json|prompt]',
    async run(inv, io) {
      if (inv.kind !== 'skill-export') throw new Error('命令表与 Invocation 不匹配');
      const { skillFactsFrom, skillPrompt } = await import('./skill/export.ts');
      const { TOOLS } = await import('./mcp/tools.ts');
      // 不起库：工具面与注册表都是静态事实（注册表来自白名单/DDL 常量，不查 DB）
      const f = skillFactsFrom(TOOLS.map((t) => ({ name: t.name, description: t.description })));
      if (inv.format === 'prompt') io.out(skillPrompt(f));
      else jsonTo(io, f);
      io.err(
        `bilite skill export: 工具 ${f.tools.length} 个 / 对象 ${f.registries.objects.length} 个；` +
          `⚠️ 有 ${f.notCovered.length} 项**没有**覆盖（写在导出物里）\n`,
      );
      return EXIT.OK;
    },
  },
];

/**
 * 命令表自检 —— **缺 handler 必须响亮地失败**。
 *
 * 借鉴 DSH 的 `hasAction()`：那里记的故障形态是"解析成功、什么都不发布"，
 * 最后只表现为下游一直在等一个永不到来的服务。这在本仓库更不能接受 ——
 * 「安静地什么都不干」正是要消灭的失败形态（铁律 12、`AGENTS.md` §6.2 那三个 bug）。
 *
 * @returns 问题清单（空数组 = 表是好的）
 */
export function commandTableProblems(commands: readonly CliCommand[], handled: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const c of commands) {
    if (!c.name.trim()) problems.push('命令缺 name');
    if (!c.summary.trim()) problems.push(`命令 ${c.name || '(无名)'} 缺 summary`);
    if (!c.usage.trim()) problems.push(`命令 ${c.name || '(无名)'} 缺 usage`);
    if (typeof c.run !== 'function') problems.push(`命令 ${c.name || '(无名)'} 没有 handler —— 注册了却没人接`);
    if (seen.has(c.name)) problems.push(`命令名重复：${c.name}`);
    seen.add(c.name);
  }
  const covered = new Set(commands.map((c) => c.invocation as string));
  for (const k of handled) if (!covered.has(k)) problems.push(`Invocation「${k}」没有任何命令接手`);
  for (const c of commands) {
    if (!(handled as readonly string[]).includes(c.invocation as string)) {
      problems.push(`命令 ${c.name} 声明的 Invocation「${c.invocation}」不在 HANDLED_KINDS 里`);
    }
  }
  return problems;
}

// 启动即自检：命令表破了，宁可当场炸，也不要跑到一半安静地什么都不做
{
  const problems = commandTableProblems(COMMANDS, HANDLED_KINDS);
  if (problems.length) throw new Error(`CLI 命令表自检失败：\n  - ${problems.join('\n  - ')}`);
}

// ---------------- help / version ----------------

function readVersion(io: CliIO): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch (e) {
    // 铁律 12：不静默。读不到就说出来，但不因此让 --version 失败
    io.err(`bilite: warning: 读不到 package.json 版本（${(e as Error).message}）\n`);
    return '0.0.0';
  }
}

/** 有专门帮助页的主题：总览(null)、每个命令名、以及 "ingest" 这个分组 */
function isKnownHelpTopic(command: string): boolean {
  return command === 'ingest' || COMMANDS.some((c) => c.name === command);
}

function helpText(io: CliIO, command: string | null): string {
  if (command === null) {
    return (
      [
        `bi-lite ${readVersion(io)} —— 本地 BI 引擎的命令行入口`,
        '',
        '用法： bilite <命令> [选项]',
        '',
        '命令：',
        ...COMMANDS.map((c) => `  ${c.name.padEnd(18)} ${c.summary}`),
        '  help [命令]        看帮助',
        '  version            看版本（等价于 --version）',
        '',
        '退出码： 0 跑通了（含"需要人拍板"的待办） | 1 被拒 | 2 用法错误',
        '',
        '例子：',
        '  bilite ingest lint ingest/华东子公司.yaml',
        '  bilite ingest dry-run ingest/华东子公司.yaml',
        '  bilite ingest run ingest/华东子公司.yaml --strict',
        '',
        '数据走 stdout，日志与进度走 stderr —— 可以直接 `> report.json` 接管道。',
      ].join('\n') + '\n'
    );
  }
  if (command === 'skill') {
    return (
      [
        '用法： bilite skill export [--format json|prompt]',
        '',
        '把手册里**可对拍**的事实从实现投影出来（架构 §8.2 ①：规则是实现的投影，不是实现的说明）。',
        '',
        '★ 它导出的是**事实**（工具面、允许的字面值），过程与判断仍在',
        '  skills/bi-lite-ingest/SKILL.md 里由人写；两者漂移会被 `skillProblems()` 抓出来。',
        '⚠️ 规格字段清单与判据 code 的全集**反射不到**（Node 原生 TS 是 strip-only，类型在运行时不存在），',
        '  导出物里会显式列出这个缺口 —— 别把这份导出当成完整手册。',
      ].join('\n') + '\n'
    );
  }
  if (command === 'catalog') {
    return (
      [
        '用法： bilite catalog <子命令>',
        '',
        '子命令：',
        ...COMMANDS.filter((c) => c.name.startsWith('catalog ')).map(
          (c) => `  ${c.name.slice('catalog '.length).padEnd(8)} ${c.summary}`,
        ),
        '',
        '这是给 agent 的「素材」：L1 业务成员 / L2 物理结构 / L3 版本。零金额。',
        'agent 侧走 MCP；命令行这一份是给人看的。',
      ].join('\n') + '\n'
    );
  }
  if (command === 'ingest') {
    return (
      [
        '用法： bilite ingest <子命令> <规格.yaml>',
        '',
        '子命令：',
        ...COMMANDS.filter((c) => c.name.startsWith('ingest ')).map(
          (c) => `  ${c.name.slice('ingest '.length).padEnd(10)} ${c.summary}`,
        ),
        '',
        '规格文件是一份"接入规格 YAML"，说清这份 Excel 怎么读。',
        '字段与五步流程见 skills/bi-lite-ingest/SKILL.md。',
      ].join('\n') + '\n'
    );
  }
  const c = COMMANDS.find((x) => x.name === command);
  if (!c) return `没有这个命令：${command}\n`;
  return [`用法： ${c.usage}`, '', c.summary, ''].join('\n') + '\n';
}

// ---------------- 分派 ----------------

/**
 * 跑一条命令。**返回值就是退出码的唯一来源** —— handler 不许自己 `process.exit()`
 * （否则 e2e 没法在进程内跑 CLI）。
 *
 * 库的生命周期：只有 `openDb()` 成功过才置位 `dbOpened`，而只有 `import.meta.main`
 * 那一层才真的关它 —— 嵌入运行（e2e）时库归调用方管。
 */
export async function main(argv: readonly string[], io: CliIO): Promise<number> {
  const inv = parseCliArgs(argv);

  if (inv.kind === 'help') {
    if (inv.command !== null && !isKnownHelpTopic(inv.command)) {
      io.err(`bilite: 没有这个命令：${inv.command}\n提示：${HINT}\n`);
      return EXIT.USAGE;
    }
    io.out(helpText(io, inv.command));
    return EXIT.OK;
  }
  if (inv.kind === 'version') {
    io.out(`${readVersion(io)}\n`);
    return EXIT.OK;
  }
  if (inv.kind === 'usage-error') {
    io.err(`bilite: ${inv.message}\n`);
    if (inv.hint) io.err(`提示：${inv.hint}\n`);
    return EXIT.USAGE;
  }

  const cmd = COMMANDS.find((c) => c.invocation === inv.kind);
  if (!cmd) {
    // 命令表自检已保证这条不该发生；真发生了也要响亮
    io.err(`bilite: 内部错误：Invocation「${inv.kind}」没有对应命令\n`);
    return EXIT.FAILED;
  }
  try {
    return await cmd.run(inv, io);
  } catch (e) {
    io.err(`bilite ${cmd.name}: ${(e as Error).message}\n`);
    return EXIT.FAILED;
  }
}

// 只在直接运行时自启动（被 import 时不退出进程 —— e2e 就是这样在进程内跑 CLI 的）
if (import.meta.main) {
  const io = processIO();
  const code = await main(process.argv.slice(2), io);
  // ★ 惰性：没开过库就连 @duckdb/node-api 都不加载（--help / lint 走不到这里）
  if (dbOpened) (await import('./db/index.ts')).close();
  process.exit(code);
}
