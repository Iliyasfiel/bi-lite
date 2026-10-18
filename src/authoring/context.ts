import type { AuthoringTask, TemplateProjection } from './attachment.ts';
import { authoringDirectionContract, type AuthoringContractDirection } from './contract.ts';
import { runAuthoringTurn, type PiRunOptions, type PiRunResult, type PiRuntimeOptions } from './pi.ts';
import type { SemanticProjection } from './semantic.ts';
import { DEFAULT_AUTHORING_MAX_PROMPT_CHARS, assertAuthoringContextSize } from './limits.ts';
import { DIM_NAMES } from '../spec/dims.ts';

export const AUTHORING_SYSTEM_PROMPT = [
  '你是 bi-lite 的内置规格助手，只处理空白模板的结构澄清与规格提案。',
  '不要声称已注册规格、已确认版本或已导入数据；这些动作只能由人工在本地入口完成。',
  '只使用提供的模板结构投影和用户文字。不要请求业务金额、源文件、任意路径、SQL 或 shell。',
  '需要更多业务语义时先提问。需要提交修改时只能调用 submit_spec_proposal。',
].join('\n');

/**
 * 共享系统提示：角色边界 + 当前方向的内置契约（真实字段、枚举与可校验的最小样例）。
 * 方向为 null 时只给两方向共用的声明、指标与行为规则。每一轮（含恢复）都由它重建，
 * 所以契约在首轮和恢复后都可见。
 */
export function sharedAuthoringSystemPrompt(
  direction: AuthoringContractDirection | null,
): string {
  return [
    '你是 bi-lite 的共享规格制定助手，只处理受控模板结构、语义声明和当前候选 YAML。',
    '只能通过 submit_authoring_proposal 提交候选；expectedRevision 必须原样使用上下文字段 revision，' +
      'expectedDraftVersion 使用 currentDraft.version 或 null；再次提案使用最新工具回执的 revision 和 draftVersion。',
    '声明改动只能写 models/*.yml 或 metrics/*.yml。不要请求业务金额、报表源文件、任意路径、SQL 或 shell。',
    '接入 source 可省略；导出 template 使用 templates/spec.xlsx 占位，正式路径由本地确认保存时绑定。',
    '诊断和摘要由本地引擎生成。模型不能确认、发布、接入、查询或填充报表。',
    '需要更多业务语义时先提问；未决项必须保留，不得把推测写成已确定口径。',
    '',
    authoringDirectionContract(direction),
    `维度注册表：${DIM_NAMES.join(' / ')}。仍须符合当前方向和目标事实表的约束；接入的 year/month 从 period 派生，不作为行标签列绑定。`,
  ].join('\n');
}

export interface AuthoringSendPreview {
  prompt: string;
  projection: TemplateProjection;
  userText: string;
}

export interface AuthoringTurnInput extends PiRunOptions {
  preview: AuthoringSendPreview;
}

export interface SharedAuthoringModelProjection {
  revision: number;
  direction: 'ingest' | 'export' | null;
  attachment: {
    policy: string;
    projection: TemplateProjection;
  };
  semantic: SemanticProjection;
  currentDraft: {
    version: number;
    yaml: string | null;
    summary: unknown | null;
    unresolved: string[];
  } | null;
  runBudget: { used: number; limit: number };
}

export function projectContextForModel(projection: TemplateProjection): TemplateProjection {
  return {
    policy: projection.policy,
    sheets: projection.sheets.map((sheet) => ({
      id: sheet.id,
      label: sheet.label,
      usedRange: sheet.usedRange,
      mergedCells: [...sheet.mergedCells],
      cells: sheet.cells.map((cell) => ({
        ref: cell.ref,
        ...(cell.text === undefined ? {} : { text: cell.text }),
        ...(cell.formula ? { formula: true as const } : {}),
      })),
    })),
    anchors: projection.anchors.map((anchor) => ({
      label: anchor.label,
      sheetId: anchor.sheetId,
      ref: anchor.ref,
    })),
    omittedHiddenSheets: projection.omittedHiddenSheets,
  };
}

export function buildAuthoringTurnInput(
  task: AuthoringTask,
  userText: string,
  maxPromptChars = DEFAULT_AUTHORING_MAX_PROMPT_CHARS,
): AuthoringTurnInput {
  if (task.status !== 'ready' || !task.projection) {
    throw new Error('AUTHORING_TASK_NOT_READY');
  }
  const projection = projectContextForModel(task.projection);
  const prompt = `${AUTHORING_SYSTEM_PROMPT}\n\n模板结构投影（JSON）：\n${JSON.stringify(projection)}`;
  const input: AuthoringTurnInput = {
    systemPrompt: prompt,
    userText,
    preview: { prompt: AUTHORING_SYSTEM_PROMPT, projection, userText },
  };
  assertAuthoringContextSize(prompt.length + userText.length, maxPromptChars);
  return input;
}

/**
 * Shared-task prompt projection. This is built by explicit field copies so
 * persisted task records, paths, messages and tool results never reach the model.
 */
export function buildSharedAuthoringTurnInput(options: {
  attachment: AuthoringTask;
  taskRevision: number;
  semantic: SemanticProjection;
  direction: 'ingest' | 'export' | null;
  draft: {
    version: number;
    yaml: string;
    summary: unknown | null;
    unresolved: string[];
  } | null;
  modelRuns: number;
  modelRunLimit: number;
  userText: string;
  maxPromptChars?: number;
}): AuthoringTurnInput {
  if (!options.attachment.projection) throw new Error('AUTHORING_TASK_NOT_READY');
  const systemPrompt = sharedAuthoringSystemPrompt(options.direction);
  const projection: SharedAuthoringModelProjection = {
    revision: options.taskRevision,
    direction: options.direction,
    attachment: {
      policy: options.attachment.policy,
      projection: projectContextForModel(options.attachment.projection),
    },
    semantic: options.semantic,
    currentDraft: options.draft ? {
      version: options.draft.version,
      yaml: options.draft.yaml,
      summary: options.draft.summary,
      unresolved: [...options.draft.unresolved],
    } : null,
    runBudget: { used: options.modelRuns, limit: options.modelRunLimit },
  };
  const prompt = `${systemPrompt}\n\n受控共享任务上下文（JSON）：\n${JSON.stringify(projection)}`;
  const input: AuthoringTurnInput = {
    systemPrompt: prompt,
    userText: options.userText,
    preview: {
      prompt: systemPrompt,
      projection: projection.attachment.projection,
      userText: options.userText,
    },
  };
  assertAuthoringContextSize(prompt.length + options.userText.length, options.maxPromptChars);
  return input;
}

export async function runAuthoringTaskTurn(
  task: AuthoringTask,
  userText: string,
  runtime: PiRuntimeOptions,
  signal?: AbortSignal,
): Promise<PiRunResult> {
  const input = buildAuthoringTurnInput(task, userText, runtime.maxPromptChars);
  return runAuthoringTurn({ ...input, signal }, runtime, {
    task: { id: task.id, sha256: task.template.sha256 },
  });
}
