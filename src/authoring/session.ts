import {
  defaultAuthoringAuthPath,
  loadAuthoringConfig,
  runtimeFromAuthoringConfig,
} from './config.ts';
import { buildSharedAuthoringTurnInput } from './context.ts';
import { runAuthoringTurn, type PiRunResult, type PiRuntimeOptions } from './pi.ts';
import { authoringProposalTool } from './proposals.ts';
import { previewAuthoringSend } from './inspect.ts';
import {
  AUTHORING_MODEL_LEASE_RENEW_MS,
  acquireAuthoringModelLease,
  appendAuthoringMessage,
  getAuthoringTask,
  markAuthoringFailed,
  replaceAuthoringMessages,
  updateAuthoringDraftAssistantText,
  type AuthoringTask,
} from './tasks.ts';

export interface AuthoringTurnRequest {
  taskId: string;
  expectedRevision: number;
  userText: string;
  workspace?: string;
  runtime?: PiRuntimeOptions;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}

export interface AuthoringTurnResult {
  task: AuthoringTask;
  text: string;
  stopReason: string | undefined;
  errorMessage: string | undefined;
  requestCount: number;
  proposals: PiRunResult['proposals'];
  toolResults: PiRunResult['toolResults'];
}

function withoutActiveRun(task: AuthoringTask): AuthoringTask {
  const view = structuredClone(task);
  view.task.activeRun = null;
  return view;
}

function resolveRuntime(runtime: PiRuntimeOptions | undefined): PiRuntimeOptions {
  if (runtime) return runtime;
  const authFile = defaultAuthoringAuthPath();
  return runtimeFromAuthoringConfig(loadAuthoringConfig(), process.env, { authFile });
}

/**
 * One local user turn in the shared task. It reserves durable budget and the
 * single-run lease before the network call, restores provider history from
 * stored tool receipts, and rejects late writes after cancellation.
 */
export async function runSharedAuthoringTurn(
  request: AuthoringTurnRequest,
): Promise<AuthoringTurnResult> {
  const workspace = request.workspace ?? process.cwd();
  let task = getAuthoringTask(request.taskId, workspace);
  if (!task.task.direction) throw new Error('请先选择接入或导出方向');
  if (task.semantic.fingerprint !== task.task.declarationFingerprint) {
    throw new Error('DECLARATION_FINGERPRINT_STALE: 工作区声明已变化，请重新检查任务');
  }
  if (task.task.revision !== request.expectedRevision) {
    throw new Error(`TASK_REVISION_CONFLICT: 当前修订 ${task.task.revision}`);
  }
  if (!request.userText.trim()) throw new Error('用户消息不能为空');
  if (request.signal?.aborted) {
    return {
      task,
      text: '',
      stopReason: 'aborted',
      errorMessage: 'AUTHORING_TURN_ABORTED',
      requestCount: 0,
      proposals: [],
      toolResults: [],
    };
  }

  const direction = task.task.direction;
  const runtime = resolveRuntime(request.runtime);
  previewAuthoringSend(task, request.userText, runtime.maxPromptChars);

  // Validate the final projected shape before consuming durable budget.
  const preflightDraft = task.task.drafts[direction];
  buildSharedAuthoringTurnInput({
    attachment: task.attachment,
    taskRevision: task.task.revision + 2,
    semantic: task.semantic,
    direction,
    draft: preflightDraft ? {
      version: preflightDraft.version,
      yaml: preflightDraft.yaml,
      summary: preflightDraft.summary,
      unresolved: preflightDraft.unresolved,
    } : null,
    modelRuns: task.task.modelRuns + 1,
    modelRunLimit: task.task.maxModelRuns,
    userText: request.userText,
    maxPromptChars: runtime.maxPromptChars,
  });

  const lease = acquireAuthoringModelLease({
    taskId: request.taskId,
    expectedRevision: task.task.revision,
    workspace,
  });
  let taskAtRequest: AuthoringTask;
  let result: PiRunResult;
  let priorProviderCount = 0;
  let userSequence = 0;
  const heartbeat = setInterval(() => {
    try {
      lease.renew();

    } catch { /* ownership is rechecked before persistence */ }
  }, AUTHORING_MODEL_LEASE_RENEW_MS);
  heartbeat.unref();
  try {
    task = appendAuthoringMessage({
      taskId: request.taskId,
      expectedRevision: lease.revision,
      role: 'user',
      kind: 'message',
      text: request.userText,
      workspace,
    });
    taskAtRequest = structuredClone(task);
    const draft = taskAtRequest.task.drafts[direction];
    const candidateFingerprint = draft?.candidateState?.fingerprint
      ?? task.task.declarationFingerprint;
    const previousMessages = task.task.messages
      .filter((message) => message.providerMessage !== undefined)
      .map((message) => message.providerMessage as PiRunResult['messages'][number]);
    priorProviderCount = previousMessages.length;
    userSequence = task.task.messages.length;
    const input = buildSharedAuthoringTurnInput({
      attachment: task.attachment,
      taskRevision: task.task.revision,
      semantic: task.semantic,
      direction,
      draft: draft ? {
        version: draft.version,
        yaml: draft.yaml,
        summary: draft.summary,
        unresolved: draft.unresolved,
      } : null,
      modelRuns: task.task.modelRuns,
      modelRunLimit: task.task.maxModelRuns,
      userText: request.userText,
      maxPromptChars: runtime.maxPromptChars,
    });
    const tool = authoringProposalTool({
      taskId: task.task.id,
      direction,
      expectedRevision: task.task.revision,
      currentDraftVersion: draft?.version ?? null,
      candidateFingerprint,
      modelRun: task.task.modelRuns,
      assertRun: () => { request.signal?.throwIfAborted(); return lease.assertOwned(); },
      workspace,
    });
    result = await runAuthoringTurn({
      ...input,
      tools: [tool],
      messages: previousMessages,
      onTextDelta: request.onTextDelta,
      signal: request.signal,
    }, runtime);
  } catch (error) {
    clearInterval(heartbeat);
    try { lease.release(); } catch { /* preserve the provider or storage error */ }
    throw error;
  }
  clearInterval(heartbeat);

  if (request.signal?.aborted) {
    const current = lease.release();
    return {
      task: withoutActiveRun(current),
      text: result.text,
      stopReason: 'aborted',
      errorMessage: 'AUTHORING_TURN_ABORTED',
      requestCount: result.requestCount,
      proposals: [],
      toolResults: result.toolResults,
    };
  }

  let current: AuthoringTask;
  try {
    current = lease.assertOwned();
    const newMessages = result.messages.slice(priorProviderCount).flatMap((providerMessage) => {
      const role = providerMessage.role === 'toolResult' ? 'tool'
        : providerMessage.role === 'assistant' ? 'assistant'
          : providerMessage.role === 'user' ? 'user' : null;
      if (!role) return [];
      const fields = providerMessage as unknown as Record<string, unknown>;
      const content = typeof fields.content === 'string'
        ? fields.content
        : Array.isArray(fields.content)
          ? fields.content.map((item) => {
            if (!item || typeof item !== 'object') return '';
            const block = item as Record<string, unknown>;
            return typeof block.text === 'string'
              ? block.text
              : block.type === 'toolCall' && typeof block.name === 'string'
                ? `[工具调用 ${block.name}]`
                : '';
          }).filter(Boolean).join('\n')
          : '';
      if (!content) return [];
      const kind = Array.isArray(fields.content) && fields.content.some((item) =>
        item && typeof item === 'object' && (item as Record<string, unknown>).type === 'toolCall')
        ? 'tool-call'
        : providerMessage.role === 'toolResult' ? 'tool-result' : 'message';
      return [{
        sequence: 0,
        role,
        kind,
        text: content.slice(0, 20_000),
        ...(typeof fields.toolName === 'string' ? { name: fields.toolName } : {}),
        ...(typeof fields.toolCallId === 'string' ? { callId: fields.toolCallId } : {}),
        providerMessage,
        createdAt: new Date().toISOString(),
      }];
    });
    const prefix = current.task.messages.slice(0, userSequence - 1);
    const merged = [
      ...prefix,
      ...newMessages,
    ].map((message, index) => ({ ...message, sequence: index + 1 }));
    const latestDraft = current.task.drafts[direction];
    if (latestDraft && result.text.trim()
      && latestDraft.assistantText !== result.text) {
      current = updateAuthoringDraftAssistantText({
        taskId: current.task.id,
        expectedRevision: current.task.revision,
        direction,
        assistantText: result.text,
        workspace,
      });
    }
    current = replaceAuthoringMessages({
      taskId: current.task.id,
      expectedRevision: current.task.revision,
      messages: merged,
      workspace,
    });
    if (result.errorMessage) {
      current = markAuthoringFailed({
        taskId: current.task.id,
        expectedRevision: current.task.revision,
        code: 'PROVIDER_FAILURE',
        message: result.errorMessage,
        workspace,
      });
    }
  } finally {
    current = lease.release();
  }
  return {
    task: withoutActiveRun(current),
    text: result.text,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    requestCount: result.requestCount,
    proposals: result.proposals,
    toolResults: result.toolResults,
  };
}
