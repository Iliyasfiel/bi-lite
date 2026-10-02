/**
 * skill 导出：把 agent 手册里**能机械导出**的那部分，从实现里投影出来（架构 §8.2 ①）。
 *
 * ★ 为什么必须导出而不是手写：手写的 `RULES.md` 一定会和实现漂移（§8.2 原话）。
 *   所以这里做两件事 ——
 *     ① 导出**运行时可反射**的事实：工具面、注册表；
 *     ② 把"手册会不会漂"变成**可检测的断言**（`skillProblems()`）。
 *   这与 `metaProblems()` 对列契约做的是同一件事：**不靠人记得同步，靠机器对拍。**
 *
 * ⚠️ **诚实边界（必须写在导出物里，而不是让人以为它覆盖全了）**
 *   Node 原生 TS 是 strip-only，**类型在运行时不存在**。所以：
 *   - **规格的字段清单**（`source` / `sheets[].blocks[].anchor` …）**无法反射**；
 *   - **判据 code**（ingest 35 个 + spec 12 个）目前是散落在两个 lint 模块里的字符串字面量，
 *     没有中心表 —— 能把它们跑出来，但列不出"一共该有哪些"。
 *   这两块要真导出，得先把它们变成**声明式的一张表**（像 `META` 那样），
 *   而那会动到本仓库最受保护的那段代码（铁律 17 的"判据只有一份，禁止另写"）。
 *   **本模块没有做那件事**，而是把缺口显式列出来。
 */
import { API_VERSION, META } from '../meta/columns.ts';
import { PERIOD_TYPES } from '../db/schema.ts';
import { staticCatalog } from '../semantic/query.ts';

export interface SkillFacts {
  apiVersion: string;
  /** 工具面：agent 能做什么。**名称与描述直接取自 `TOOLS`**，不是抄的 */
  tools: Array<{ name: string; summary: string }>;
  registries: {
    periodTypes: Array<{ id: string; label: string; derivable: boolean }>;
    dimensions: Array<{ name: string; label: string }>;
    objects: Array<{ name: string; kind: string; columns: number }>;
  };
  /** ⚠️ 没被覆盖的东西 —— **半份规则比没有规则更危险**，因为它会让人以为够了 */
  notCovered: string[];
}

const NOT_COVERED = [
  '规格的字段清单（source / sheets[].blocks[].anchor / onConflict …）：Node 原生 TS 是 strip-only，**类型在运行时不存在**，反射不到。',
  '判据 code 的全集（ingest 35 个 + spec 12 个）：它们是两个 lint 模块里的字符串字面量，没有中心表 —— 跑得出来，列不出"该有哪些"。',
  '因此这份导出**替代不了** skills/bi-lite-ingest/SKILL.md —— 它是手册的**可对拍部分**，不是手册。',
];

/** 取描述的第一句（导出物要紧凑；完整描述在 MCP 工具清单里） */
function firstSentence(s: string): string {
  const cut = s.search(/[。;；]/);
  return (cut > 0 ? s.slice(0, cut) : s).replace(/\s+/g, ' ').trim();
}

/** 从实现里投影出可反射的事实。传 `tools` 进来是为了**脱库可测**（e2e 不必开库） */
export function skillFactsFrom(tools: Array<{ name: string; description: string }>): SkillFacts {
  const cat = staticCatalog();
  return {
    apiVersion: API_VERSION,
    tools: tools.map((t) => ({ name: t.name, summary: firstSentence(t.description) })),
    registries: {
      periodTypes: PERIOD_TYPES.map((p) => ({ id: p.id, label: p.label, derivable: p.derivable })),
      dimensions: cat.dimensions.map((d) => ({ name: d.name, label: d.label })),
      objects: META.map((o) => ({ name: o.name, kind: o.kind, columns: o.columns.length })),
    },
    notCovered: NOT_COVERED,
  };
}

/** 人 / agent 读的 Markdown */
export function skillPrompt(f: SkillFacts): string {
  const out = [
    `# bi-lite 规则导出 · apiVersion ${f.apiVersion}`,
    '',
    '> 本段由 `bilite skill export` 从实现投影而来（架构 §8.2 ①：**规则是实现的投影，不是实现的说明**）。',
    '> 手写的 `SKILL.md` 负责过程与判断，这一段负责**事实**。两者漂移会被 `skillProblems()` 抓出来。',
    '',
    `## 工具面（${f.tools.length} 个）`,
    '',
    ...f.tools.map((t) => `- \`${t.name}\` —— ${t.summary}`),
    '',
    '## 允许的字面值',
    '',
    `- 口径：${f.registries.periodTypes.map((p) => `${p.id}${p.derivable ? '（可派生）' : ''}`).join(' / ')}`,
    `- 维度：${f.registries.dimensions.map((d) => `${d.name}（${d.label}）`).join(' / ')}`,
    `- 语义对象：${f.registries.objects.map((o) => `${o.name}[${o.kind}, ${o.columns} 列]`).join(' / ')}`,
    '',
    '## ⚠️ 这份导出**没有**覆盖的',
    '',
    ...f.notCovered.map((s) => `- ${s}`),
  ];
  return out.join('\n') + '\n';
}

/**
 * 手册与实现**对拍**：手写的 `SKILL.md` 有没有落后于实现。
 *
 * 纯函数（吃文本与工具名），所以 e2e 不必开库就能验它。
 *
 * @returns 问题清单（空数组 = 手册没有落后）
 */
export function skillProblems(skillText: string, toolNames: readonly string[]): string[] {
  const problems: string[] = [];

  // ① 每个工具都必须在手册里出现 —— 这是最现实的失败：加了工具、忘了写进手册
  for (const name of toolNames) {
    if (!skillText.includes(name)) problems.push(`① 手册里没提到工具 ${name}（加了工具却忘了写进手册）`);
  }

  // ② 手册里自报的条数必须与实现一致 —— 数字对不上是最容易被忽略的那种"看起来对"
  const claimed = /工具面（\s*(\d+)\s*个）/.exec(skillText);
  if (!claimed) {
    problems.push('② 手册里找不到「工具面（N 个）」这一行 —— 没有它就无法对拍条数');
  } else if (Number(claimed[1]) !== toolNames.length) {
    problems.push(`② 手册说「${claimed[1]} 个」，实现里是 ${toolNames.length} 个`);
  }

  return problems;
}
