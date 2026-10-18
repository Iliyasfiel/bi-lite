import { Type, type Static } from 'typebox';
import type { Tool } from '@earendil-works/pi-ai';
import {
  validateCandidate,
  validateExportCandidate,
  type CandidateResult,
} from './candidates.ts';
import {
  applySemanticChanges,
  candidateFromState,
  candidateState,
  createSemanticSnapshot,
  reviewSemanticChanges,
} from './semantic.ts';
import {
  appendAuthoringMessage,
  authoringTemplateGeometry,
  getAuthoringTask,
  saveAuthoringDraft,
  type AuthoringDirection,
  type AuthoringTask,
} from './tasks.ts';

export { SUBMIT_AUTHORING_PROPOSAL_TOOL_NAME } from './pi.ts';
import { SUBMIT_AUTHORING_PROPOSAL_TOOL_NAME } from './pi.ts';

const DeclarationChangeSchema = Type.Object({
  path: Type.String({
    pattern: '^(models|metrics)/[A-Za-z0-9_-]+\\.ya?ml$',
    description: 'A managed declaration path under models/ or metrics/.',
  }),
  content: Type.Union([
    Type.String({ maxLength: 512 * 1024 }),
    Type.Null(),
  ], { description: 'Proposed file content, or null to delete.' }),
});

const ProposalSchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  expectedDraftVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  direction: Type.Union([Type.Literal('ingest'), Type.Literal('export')]),
  yaml: Type.String({ minLength: 1, maxLength: 512 * 1024 }),
  declarationChanges: Type.Array(DeclarationChangeSchema, { maxItems: 64 }),
  unresolved: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 32 }),
  note: Type.String({ minLength: 1, maxLength: 1000 }),
});

export type AuthoringProposal = Static<typeof ProposalSchema>;

export interface ProposalApplication {
  task: AuthoringTask;
  validation: CandidateResult;
  semanticIssues: CandidateResult['diagnostics'];
  declarationReview: Array<{ path: string; before: string | null; after: string | null }>;
}

export class ProposalError extends Error {
  readonly code:
    | 'PROPOSAL_TASK_MISMATCH'
    | 'PROPOSAL_DIRECTION_MISMATCH'
    | 'PROPOSAL_REVISION_STALE'
    | 'PROPOSAL_SEMANTIC_INVALID';

  constructor(code: ProposalError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export const authoringProposalDeclaration = {
  name: SUBMIT_AUTHORING_PROPOSAL_TOOL_NAME,
  description: 'Submit one candidate spec and any candidate declaration changes. Local validation returns diagnostics and a draft version; this never confirms or publishes.',
  parameters: ProposalSchema,
};

export function authoringProposalTool(options: {
  taskId: string;
  direction: AuthoringDirection;
  expectedRevision: number;
  currentDraftVersion: number | null;
  candidateFingerprint: string;
  modelRun?: number;
  workspace: string;
  assertRun?: () => unknown;
}): Tool<typeof ProposalSchema> {
  const staleReply = (at: string, message: string) => {
    const current = getAuthoringTask(options.taskId, options.workspace);
    const validation = { ok: false, diagnostics: [{ level: 'error', code: 'PROPOSAL_REVISION_STALE',
      at, message, hint: '使用本回执的 revision 与 draftVersion 修订；不要沿用旧对话中的编号。' }], unresolved: [] };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...validation,
        revision: current.task.revision, draftVersion: current.task.drafts[options.direction]?.version ?? null }) }],
      details: { validation },
    };
  };
  return {
    ...authoringProposalDeclaration,
    execute: async (_toolCallId, proposal, signal) => {
      signal?.throwIfAborted();
      options.assertRun?.();
      if (proposal.expectedRevision !== options.expectedRevision) {
        return staleReply('expectedRevision',
          `PROPOSAL_REVISION_STALE: 提案修订 ${proposal.expectedRevision} 已过期，当前为 ${options.expectedRevision}`,
        );
      }
      if (proposal.direction !== options.direction) {
        throw new ProposalError(
          'PROPOSAL_DIRECTION_MISMATCH',
          `PROPOSAL_DIRECTION_MISMATCH: 任务方向为 ${options.direction}`,
        );
      }
      const currentTask = getAuthoringTask(options.taskId, options.workspace);
      if (!['conversing', 'awaiting-confirmation'].includes(currentTask.task.status)) {
        throw new ProposalError('PROPOSAL_REVISION_STALE',
          `PROPOSAL_REVISION_STALE: 任务状态 ${currentTask.task.status} 不接受候选`,
        );
      }
      const currentDraft = currentTask.task.drafts[options.direction];
      if (currentDraft?.candidateState
        && currentDraft.candidateState.fingerprint !== options.candidateFingerprint) {
        throw new ProposalError(
          'PROPOSAL_REVISION_STALE',
          'PROPOSAL_REVISION_STALE: 当前草稿候选声明与本次会话快照不一致',
        );
      }
      if (proposal.expectedDraftVersion !== options.currentDraftVersion) {
        return staleReply('expectedDraftVersion',
          `PROPOSAL_REVISION_STALE: 提案草稿版本 ${proposal.expectedDraftVersion ?? '空'} 已过期，` +
            `当前为 ${options.currentDraftVersion ?? '空'}`,
        );
      }
      const applied = applyAuthoringProposal(proposal, options);
      options.expectedRevision = applied.task.task.revision;
      options.currentDraftVersion = applied.task.task.drafts[options.direction]?.version ?? null;
      options.candidateFingerprint = applied.task.task.drafts[options.direction]?.candidateState?.fingerprint
        ?? applied.task.task.declarationFingerprint;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: applied.validation.ok,
            draftVersion: applied.task.task.drafts[applied.task.task.direction!]?.version ?? null,
            revision: applied.task.task.revision,
            diagnostics: applied.validation.diagnostics,
            unresolved: applied.validation.unresolved,
            summary: applied.validation.summary,
            declarationReview: applied.declarationReview.map((change) => ({
              path: change.path,
              action: change.before === null ? 'create'
                : change.after === null ? 'delete' : 'replace',
            })),
          }),
        }],
        details: {
          proposalTaskId: options.taskId,
          validation: applied.validation,
          draftVersion: applied.task.task.drafts[applied.task.task.direction!]?.version ?? null,
          modelRun: options.modelRun ?? null,
        },
      };
    },
  };
}

/**
 * Applies a proposal locally. Candidate declaration errors are returned as
 * diagnostics and discard the candidate; the last valid draft is preserved.
 */
export function applyAuthoringProposal(
  proposal: AuthoringProposal,
  options: {
    taskId: string;
    direction: AuthoringDirection;
    expectedRevision: number;
    workspace: string;
  },
): ProposalApplication {
  const current = getAuthoringTask(options.taskId, options.workspace);
  if (current.task.direction !== options.direction) {
    throw new ProposalError('PROPOSAL_DIRECTION_MISMATCH', '提案方向与任务方向不一致');
  }
  if (current.task.revision !== proposal.expectedRevision) {
    throw new ProposalError(
      'PROPOSAL_REVISION_STALE',
      `PROPOSAL_REVISION_STALE: 提案修订 ${proposal.expectedRevision} 已过期，当前为 ${current.task.revision}`,
    );
  }

  const taskSnapshot = createSemanticSnapshot(options.workspace);
  if (taskSnapshot.fingerprint !== current.task.declarationFingerprint) {
    throw new ProposalError('PROPOSAL_REVISION_STALE', 'DECLARATION_FINGERPRINT_STALE: 工作区声明已变化');
  }
  let declarationReview: ProposalApplication['declarationReview'] = [];
  let semanticIssues: ProposalApplication['semanticIssues'] = [];
  let definitions;
  let facts;
  let nextCandidateState = null;
  const priorDraft = current.task.drafts[options.direction];
  if (proposal.expectedDraftVersion !== (priorDraft?.version ?? null)) {
    throw new ProposalError(
      'PROPOSAL_REVISION_STALE',
      `PROPOSAL_REVISION_STALE: 提案草稿版本 ${proposal.expectedDraftVersion ?? '空'} 已过期，` +
        `当前为 ${priorDraft?.version ?? '空'}`,
    );
  }
  try {
    const previous = priorDraft;
    const base = previous?.candidateState
      ? candidateFromState(previous.candidateState, options.workspace).snapshot
      : taskSnapshot;
    reviewSemanticChanges(base, proposal.declarationChanges);
    const candidate = applySemanticChanges(base, base.fingerprint, proposal.declarationChanges);
    const before = new Map(taskSnapshot.files.map((file) => [
      `${file.kind === 'model' ? 'models' : 'metrics'}/${file.name}`, file.text,
    ]));
    const after = new Map(candidate.snapshot.files.map((file) => [
      `${file.kind === 'model' ? 'models' : 'metrics'}/${file.name}`, file.text,
    ]));
    declarationReview = [...new Set([...before.keys(), ...after.keys()])].sort()
      .filter((file) => before.get(file) !== after.get(file))
      .map((file) => ({ path: file, before: before.get(file) ?? null, after: after.get(file) ?? null }));
    semanticIssues = candidate.issues.map((entry) => ({
      level: entry.level,
      code: entry.code,
      at: entry.at,
      message: entry.message,
      ...(entry.hint ? { hint: entry.hint } : {}),
    }));
    definitions = candidate.definitions;
    facts = candidate.facts;
    nextCandidateState = candidateState(candidate, current.task.declarationFingerprint);
  } catch (error) {
    const code = (error as Error & { code?: string }).code ?? 'PROPOSAL_SEMANTIC_INVALID';
    throw new ProposalError(
      code === 'DECLARATION_CANDIDATE_INVALID' ? 'PROPOSAL_SEMANTIC_INVALID' : 'PROPOSAL_SEMANTIC_INVALID',
      `${code}: ${(error as Error).message}`,
    );
  }

  const validation = options.direction === 'export'
    ? validateExportCandidate(proposal.yaml, {
      facts: facts ?? [],
      metrics: current.semantic.metrics,
      definitions,
    }, authoringTemplateGeometry(current.attachment))
    : validateCandidate(options.direction, proposal.yaml, {
      facts: facts ?? [],
      metrics: current.semantic.metrics,
      definitions,
    });
  const allDiagnostics = [...semanticIssues, ...validation.diagnostics];
  const allErrors = allDiagnostics.some((entry) => entry.level === 'error');
  const unresolved = [...new Set([
    ...proposal.unresolved,
    ...validation.unresolved,
    ...(allErrors ? ['存在必须修订的静态诊断'] : []),
  ])];
  const validEnough = validation.ok && !allErrors && unresolved.length === 0;
  let task: AuthoringTask;
  if (validEnough) {
    task = saveAuthoringDraft({
      taskId: current.task.id,
      expectedRevision: current.task.revision,
      direction: options.direction,
      yaml: proposal.yaml,
      summary: validation.summary,
      declarationReview,
      candidateState: nextCandidateState,
      diagnostics: allDiagnostics,
      unresolved,
      workspace: options.workspace,
    });
  } else if (priorDraft) {
    task = saveAuthoringDraft({
      taskId: current.task.id,
      expectedRevision: current.task.revision,
      direction: options.direction,
      yaml: proposal.yaml,
      summary: priorDraft.summary,
      declarationReview: priorDraft.declarationReview,
      candidateState: priorDraft.candidateState,
      diagnostics: allDiagnostics,
      unresolved,
      assistantText: priorDraft.assistantText,
      failed: true,
      workspace: options.workspace,
    });
  } else {
    task = appendAuthoringMessage({
      taskId: current.task.id,
      expectedRevision: current.task.revision,
      role: 'tool',
      kind: 'tool-result',
      name: SUBMIT_AUTHORING_PROPOSAL_TOOL_NAME,
      text: allErrors
        ? `候选未保留：${allDiagnostics.filter((entry) => entry.level === 'error').length} 个错误`
        : `候选未保留：${unresolved.join('；')}`,
      workspace: options.workspace,
    });
  }
  return {
    task,
    validation: {
      ...validation,
      diagnostics: allDiagnostics,
      ok: validEnough,
      unresolved,
    },
    semanticIssues,
    declarationReview,
  };
}

