import { createHash } from 'node:crypto';
import { buildSharedAuthoringTurnInput } from './context.ts';
import { authoringInputMessages, serializeAuthoringContext } from './pi.ts';
import { authoringProposalDeclaration } from './proposals.ts';
import { DEFAULT_AUTHORING_MAX_PROMPT_CHARS, assertAuthoringContextSize } from './limits.ts';
import {
  draftReadyForConfirmation,
  type AuthoringDraft,
  type AuthoringDraftContent,
  type AuthoringTask,
} from './tasks.ts';

export interface AuthoringReview {
  taskId: string;
  revision: number;
  status: AuthoringTask['task']['status'];
  direction: AuthoringTask['task']['direction'];
  attachment: AuthoringTask['task']['attachment'];
  semanticFingerprint: string;
  draft: AuthoringDraft | null;
  failedDraft: AuthoringDraftContent | null;
  readyForConfirmation: boolean;
  confirmation: AuthoringTask['task']['confirmation'];
}

export interface AuthoringSendPreview {
  taskId: string;
  revision: number;
  sendRevision: number;
  sendModelRun: number;
  direction: AuthoringTask['task']['direction'];
  draftVersion: number | null;
  previousMessageCount: number;
  previousMessages: unknown[];
  prompt: string;
  userText: string;
  promptChars: number;
  promptSha256: string;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Local review output for a human. It is never routed through MCP. */
export function inspectAuthoringTask(task: AuthoringTask): AuthoringReview {
  const direction = task.task.direction;
  const draft = direction ? task.task.drafts[direction] : null;
  const failedDraft = direction ? task.task.failedDrafts?.[direction] ?? null : null;
  return {
    taskId: task.task.id,
    revision: task.task.revision,
    status: task.task.status,
    direction,
    attachment: structuredClone(task.task.attachment),
    semanticFingerprint: task.task.declarationFingerprint,
    draft: structuredClone(draft),
    failedDraft: structuredClone(failedDraft),
    readyForConfirmation: draftReadyForConfirmation(draft),
    confirmation: structuredClone(task.task.confirmation),
  };
}

/** Builds the exact prompt prefix without making a provider request. */
export function previewAuthoringSend(
  task: AuthoringTask,
  userText: string,
  maxPromptChars = DEFAULT_AUTHORING_MAX_PROMPT_CHARS,
): AuthoringSendPreview {
  if (!task.task.direction) throw new Error('请先选择接入或导出方向');
  if (task.semantic.fingerprint !== task.task.declarationFingerprint) {
    throw new Error('DECLARATION_FINGERPRINT_STALE: 工作区声明已变化，请重新检查任务');
  }
  const direction = task.task.direction;
  const draft = task.task.drafts[direction];
  // A real turn first reserves one model run and appends the user message.
  // Each durable write advances the task revision once.
  const sendRevision = task.task.revision + 2;
  const sendModelRun = task.task.modelRuns + 1;
  const input = buildSharedAuthoringTurnInput({
    attachment: task.attachment,
    taskRevision: sendRevision,
    semantic: task.semantic,
    direction,
    draft: draft ? {
      version: draft.version,
      yaml: draft.yaml,
      summary: draft.summary,
      unresolved: draft.unresolved,
    } : null,
    modelRuns: sendModelRun,
    modelRunLimit: task.task.maxModelRuns,
    userText,
    maxPromptChars,
  });
  const prompt = input.systemPrompt;
  const previousMessages = task.task.messages
    .filter((message) => message.providerMessage !== undefined)
    .map((message) => structuredClone(message.providerMessage));
  const serialized = serializeAuthoringContext(authoringInputMessages({
    systemPrompt: prompt, userText,
    messages: previousMessages as Parameters<typeof authoringInputMessages>[0]['messages'],
    tools: [authoringProposalDeclaration],
  }));
  assertAuthoringContextSize(serialized.length, maxPromptChars);
  return {
    taskId: task.task.id,
    revision: task.task.revision,
    sendRevision,
    sendModelRun,
    direction,
    draftVersion: draft?.version ?? null,
    previousMessageCount: previousMessages.length,
    previousMessages,
    prompt,
    userText,
    promptChars: serialized.length,
    promptSha256: sha(serialized),
  };
}
