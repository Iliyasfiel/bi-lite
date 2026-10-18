import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getAuthoringTask as getAttachmentCheck, type AuthoringTask as AttachmentCheck } from './attachment.ts';
import {
  createSemanticSnapshot,
  semanticProjection,
  type SemanticCandidateState,
  type SemanticSnapshot,
} from './semantic.ts';

export const AUTHORING_TASK_STORE_VERSION = 1;
export const AUTHORING_MAX_MODEL_RUNS = 24;
export const AUTHORING_MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const AUTHORING_MODEL_LEASE_MS = 5 * 60_000;
export const AUTHORING_MODEL_LEASE_RENEW_MS = 30_000;

export type AuthoringDirection = 'ingest' | 'export';
export type AuthoringStatus =
  | 'checking'
  | 'awaiting-direction'
  | 'conversing'
  | 'awaiting-confirmation'
  | 'generating'
  | 'completed'
  | 'retained'
  | 'cancelled'
  | 'rejected'
  | 'failed';

export interface AuthoringAttachment {
  checkId: string;
  filename: string;
  href: string;
  sizeBytes: number;
  sha256: string;
  checkedAt: string;
  policy: string;
}

export interface AuthoringMessage {
  sequence: number;
  role: 'user' | 'assistant' | 'tool';
  kind: 'message' | 'tool-call' | 'tool-result';
  text: string;
  name?: string;
  callId?: string;
  run?: number;
  providerMessage?: unknown;
  createdAt: string;
}

export interface AuthoringDiagnostic {
  code: string;
  at: string;
  message: string;
  hint?: string;
}

export interface AuthoringDraft {
  version: number;
  contentHash: string;
  yaml: string;
  summary: unknown | null;
  declarationReview: Array<{ path: string; before: string | null; after: string | null }>;
  candidateState: SemanticCandidateState | null;
  assistantText: string;
  createdAt: string;
  diagnostics: AuthoringDiagnostic[];
  unresolved: string[];
}

export interface AuthoringDraftContent {
  version: number;
  contentHash: string;
  yaml: string;
  summary: unknown | null;
  declarationReview: Array<{ path: string; before: string | null; after: string | null }>;
  candidateState: SemanticCandidateState | null;
  assistantText: string;
  createdAt: string;
  diagnostics: AuthoringDiagnostic[];
  unresolved: string[];
}

export interface AuthoringConfirmation {
  direction: AuthoringDirection;
  draftVersion: number;
  draftHash: string;
  excelHash: string;
  policy: string;
  declarationFingerprint: string;
  confirmedAt: string;
  planHash?: string;
}

export interface AuthoringPublication {
  status: 'completed' | 'failed';
  files: Array<{ path: string; sha256: string }>;
  completedAt: string;
  error?: string;
}

export interface AuthoringActiveRun {
  id: string;
  pid: number;
  processStart: string | null;
  revision: number;
  modelRun: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface AuthoringTaskRecord {
  storeVersion: typeof AUTHORING_TASK_STORE_VERSION;
  id: string;
  workspaceIdentity: string;
  status: AuthoringStatus;
  revision: number;
  direction: AuthoringDirection | null;
  attachment: AuthoringAttachment;
  declarationFingerprint: string;
  modelRuns: number;
  maxModelRuns: typeof AUTHORING_MAX_MODEL_RUNS;
  activeRun: AuthoringActiveRun | null;
  origin: 'legacy-check' | 'new';
  messages: AuthoringMessage[];
  drafts: Record<AuthoringDirection, AuthoringDraft | null>;
  failedDrafts?: Partial<Record<AuthoringDirection, AuthoringDraftContent | null>>;
  confirmation: AuthoringConfirmation | null;
  publication: AuthoringPublication | null;
  failure: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthoringTask {
  task: AuthoringTaskRecord;
  attachment: AttachmentCheck;
  semantic: ReturnType<typeof semanticProjection>;
}

export interface AuthoringModelLease {
  id: string;
  taskId: string;
  modelRun: number;
  revision: number;
  renew: () => AuthoringTask;
  assertOwned: () => AuthoringTask;
  release: () => AuthoringTask;
}

export interface AuthoringLeaseRecovery {
  taskId: string;
  leaseId: string | null;
  pid: number | null;
  expiresAt: string | null;
  expired: boolean;
  processAlive: boolean;
}

export interface AuthoringTemplateGeometry {
  sheets: Array<{
    name: string;
    usedRange: string | null;
    mergedCells: string[];
    formulaCells: string[];
  }>;
  anchors: Array<{ name: string; sheet: string; ref: string }>;
}

/** User-facing task presentation never includes stored Excel paths or internal semantic source text. */
export interface AuthoringTaskView {
  task: Omit<AuthoringTaskRecord, 'workspaceIdentity' | 'drafts' | 'failedDrafts'> & {
    drafts: Record<AuthoringDirection, {
      version: number;
      contentHash: string;
      summary: unknown | null;
      declarationReview: Array<{ path: string; action: 'create' | 'replace' | 'delete' }>;
      diagnostics: AuthoringDiagnostic[];
      unresolved: string[];
      assistantText: string;
      createdAt: string;
    } | null>;
    failedDrafts?: Partial<Record<AuthoringDirection, {
      version: number;
      contentHash: string;
      summary: unknown | null;
      declarationReview: Array<{ path: string; action: 'create' | 'replace' | 'delete' }>;
      diagnostics: AuthoringDiagnostic[];
      unresolved: string[];
      assistantText: string;
      createdAt: string;
    } | null>>;
  };
  attachment: {
    checkId: string;
    filename: string;
    href: string;
    sizeBytes: number;
    sha256: string;
    checkedAt: string;
    policy: string;
  };
  semantic: AuthoringTask['semantic'];
  declarationStale: boolean;
}

export function draftReadyForConfirmation(draft: AuthoringDraft | null): boolean {
  return Boolean(draft
    && draft.unresolved.length === 0
    && !draft.diagnostics.some((entry) => entry.level === 'error')
    && draft.candidateState?.issues.every((entry) => entry.level !== 'error'));
}

/** Local-only fill geometry projected from the checked upload snapshot. */
export function authoringTemplateGeometry(attachment: AttachmentCheck): AuthoringTemplateGeometry {
  if (!attachment.projection) {
    throw new AuthoringTaskError('TASK_ATTACHMENT_INVALID', '附件检查未生成结构投影');
  }
  const projection = attachment.projection;
  const formulaBySheet = new Map<string, string[]>();
  for (const cell of attachment.formulaCells) {
    const list = formulaBySheet.get(cell.sheet) ?? [];
    list.push(cell.ref);
    formulaBySheet.set(cell.sheet, list);
  }
  return {
    sheets: projection.sheets.map((sheet) => ({
      name: sheet.sourceName ?? sheet.label ?? sheet.id,
      usedRange: sheet.usedRange,
      mergedCells: [...sheet.mergedCells],
      formulaCells: [
        ...(formulaBySheet.get(sheet.sourceName ?? '') ?? []),
        ...(formulaBySheet.get(sheet.label ?? '') ?? []),
        ...(formulaBySheet.get(sheet.id) ?? []),
      ],
    })),
    anchors: projection.anchors
      .filter((anchor): anchor is typeof anchor & { label: string } => anchor.label !== null)
      .map((anchor) => ({
        name: anchor.label,
        sheet: projection.sheets.find((sheet) => sheet.id === anchor.sheetId)?.label ?? '',
        ref: anchor.ref,
      })),
  };
}

export class AuthoringTaskError extends Error {
  readonly code:
    | 'TASK_NOT_FOUND'
    | 'TASK_STORE_INVALID'
    | 'TASK_REVISION_CONFLICT'
    | 'TASK_TRANSITION_INVALID'
    | 'TASK_CANCELLED'
    | 'TASK_BUDGET_EXHAUSTED'
    | 'TASK_SEMANTIC_INVALID'
    | 'TASK_CHECK_REQUIRED'
    | 'TASK_ATTACHMENT_INVALID';

  constructor(code: AuthoringTaskError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const rootOf = (workspace: string) => path.join(path.resolve(workspace), '.bilite/authoring');
const recordPath = (workspace: string, taskId: string) =>
  path.join(rootOf(workspace), taskId, 'authoring-task.json');
const validId = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
const nowIso = () => new Date().toISOString();
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const taskDir = (workspace: string, taskId: string) => path.dirname(recordPath(workspace, taskId));
const recordLockPath = (workspace: string, taskId: string) =>
  path.join(taskDir(workspace, taskId), 'authoring-task.lock');

function workspaceIdentity(workspace: string): string {
  return sha(path.resolve(workspace));
}

function processStartTime(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : null;
    } catch { return null; }
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
    });
    const started = result.status === 0 ? result.stdout.trim() : '';
    return started ? `darwin:${started}` : null;
  }
  return null;
}

function sameProcess(run: AuthoringActiveRun): boolean {
  try { process.kill(run.pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
  }
  if (!run.processStart) return true;
  return processStartTime(run.pid) === run.processStart;
}

function lstatRegularFile(file: string, required = true): fs.Stats | null {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new AuthoringTaskError('TASK_STORE_INVALID', '任务记录必须是普通文件，不能是链接或目录');
    }
    if (stat.size > AUTHORING_MAX_RECORD_BYTES) {
      throw new AuthoringTaskError('TASK_STORE_INVALID', '任务记录超过 8MB 上限');
    }
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) return null;
    if (error instanceof AuthoringTaskError) throw error;
    throw new AuthoringTaskError('TASK_STORE_INVALID', '无法读取任务记录');
  }
}

function writeAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function lockIsStale(file: string, invalidGraceMs = 30_000): boolean {
  let owner: { pid?: unknown; processStart?: unknown } = {};
  try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { owner = {}; }
  if (Number.isInteger(owner.pid) && (owner.pid as number) > 0) {
    const pid = owner.pid as number;
    if (!pidAlive(pid)) return true;
    if (typeof owner.processStart === 'string') {
      const current = processStartTime(pid);
      return current !== null && current !== owner.processStart;
    }
    return false;
  }
  try { return Date.now() - fs.statSync(file).mtimeMs > invalidGraceMs; }
  catch { return true; }
}

/**
 * The lock is held only for a local read/validate/write transition. Model and
 * provider work never holds it; the task record's lease covers that longer span.
 */
function withRecordLock<T>(taskId: string, workspace: string, action: () => T): T {
  if (!validId(taskId)) throw new AuthoringTaskError('TASK_NOT_FOUND', '任务不存在');
  const dir = taskDir(workspace, taskId);
  if (!fs.existsSync(dir)) throw new AuthoringTaskError('TASK_NOT_FOUND', '任务不存在');
  const guard = path.join(taskDir(workspace, taskId), 'authoring-task.guard');
  let guardFd: number | null = null;
  try {
    guardFd = fs.openSync(guard, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!lockIsStale(guard)) {
      throw new AuthoringTaskError(
        'TASK_REVISION_CONFLICT',
        '任务正在由另一个本地操作更新，请重试',
      );
    }
    try { fs.unlinkSync(guard); } catch (staleError) {
      if ((staleError as NodeJS.ErrnoException).code !== 'ENOENT') throw staleError;
    }
    guardFd = fs.openSync(guard, 'wx');
  }
  try {
    if (process.platform !== 'win32') fs.chmodSync(guard, 0o600);
    fs.writeFileSync(guardFd!, JSON.stringify({
      pid: process.pid,
      processStart: processStartTime(process.pid),
      createdAt: nowIso(),
    }) + '\n');
    const lock = recordLockPath(workspace, taskId);
    let lockFd: number;
    try {
      lockFd = fs.openSync(lock, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // The guard serializes creation and stale cleanup. Only a lock from a
      // process that no longer exists can be removed; time alone is insufficient.
      if (!lockIsStale(lock)) {
        throw new AuthoringTaskError(
          'TASK_REVISION_CONFLICT',
          '任务正在由另一个本地操作更新，请重试',
        );
      }
      fs.unlinkSync(lock);
      lockFd = fs.openSync(lock, 'wx');
    }
    try {
      if (process.platform !== 'win32') fs.chmodSync(lock, 0o600);
      fs.writeFileSync(lockFd, JSON.stringify({
        pid: process.pid,
        processStart: processStartTime(process.pid),
        createdAt: nowIso(),
      }) + '\n');
      return action();
    } finally {
      fs.closeSync(lockFd);
      try { fs.unlinkSync(lock); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } finally {
    if (guardFd !== null) fs.closeSync(guardFd);
    try { fs.unlinkSync(guard); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function validAttachment(check: AttachmentCheck, expectedId: string): boolean {
  return check.id === expectedId
    && check.status === 'ready'
    && check.projection !== null
    && check.policy === check.projection.policy;
}

function initialStatus(check: AttachmentCheck): AuthoringStatus {
  if (check.status === 'ready') return 'awaiting-direction';
  return 'rejected';
}

function validateRecord(raw: unknown, workspace: string): AuthoringTaskRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthoringTaskError('TASK_STORE_INVALID', '任务记录必须是 JSON 对象');
  }
  const task = raw as AuthoringTaskRecord;
  if (task.storeVersion !== AUTHORING_TASK_STORE_VERSION) {
    throw new AuthoringTaskError('TASK_STORE_INVALID', '任务记录版本不受支持');
  }
  if (!validId(task.id)) throw new AuthoringTaskError('TASK_STORE_INVALID', '任务 ID 不合法');
  if (task.workspaceIdentity !== workspaceIdentity(workspace)) {
    throw new AuthoringTaskError('TASK_STORE_INVALID', '任务不属于当前工作区');
  }
  if (!Number.isInteger(task.revision) || task.revision < 0) {
    throw new AuthoringTaskError('TASK_STORE_INVALID', '任务修订号不合法');
  }
  if (!Number.isInteger(task.modelRuns) || task.modelRuns < 0
    || task.modelRuns > AUTHORING_MAX_MODEL_RUNS) {
    throw new AuthoringTaskError('TASK_STORE_INVALID', '任务模型调用计数不合法');
  }
  if (task.maxModelRuns !== AUTHORING_MAX_MODEL_RUNS) {
    throw new AuthoringTaskError('TASK_STORE_INVALID', '任务模型预算不匹配');
  }
  // Store version 1 predates the model-run lease. Normalize records written by
  // earlier builds instead of rejecting otherwise valid pending tasks.
  if (task.activeRun === undefined) task.activeRun = null;
  if (task.activeRun && task.activeRun.processStart === undefined) {
    task.activeRun.processStart = null;
  }
  if (task.activeRun !== null) {
    const run = task.activeRun;
    if (!run || typeof run !== 'object'
      || !validId(run.id)
      || !Number.isInteger(run.pid) || run.pid <= 0
      || (run.processStart !== null && typeof run.processStart !== 'string')
      || !Number.isInteger(run.revision) || run.revision < 0
      || !Number.isInteger(run.modelRun) || run.modelRun < 1
      || !Number.isFinite(Date.parse(run.acquiredAt))
      || !Number.isFinite(Date.parse(run.heartbeatAt))
      || !Number.isFinite(Date.parse(run.expiresAt))) {
      throw new AuthoringTaskError('TASK_STORE_INVALID', '任务模型运行租约不合法');
    }
  }
  if (!Array.isArray(task.messages) || task.messages.length > 2000) {
    throw new AuthoringTaskError('TASK_STORE_INVALID', '任务消息记录不合法');
  }
  if (!task.attachment || !task.drafts) {
    throw new AuthoringTaskError('TASK_STORE_INVALID', '任务记录缺少附件或草稿');
  }
  if (task.direction !== null && task.direction !== 'ingest' && task.direction !== 'export') {
    throw new AuthoringTaskError('TASK_STORE_INVALID', '任务方向不受支持');
  }
  if (typeof task.declarationFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(task.declarationFingerprint)) {
    throw new AuthoringTaskError('TASK_STORE_INVALID', '任务声明指纹不合法');
  }
  const statuses = new Set<AuthoringStatus>([
    'checking', 'awaiting-direction', 'conversing', 'awaiting-confirmation',
    'generating', 'completed', 'retained', 'cancelled', 'rejected', 'failed',
  ]);
  if (!statuses.has(task.status)) {
    throw new AuthoringTaskError('TASK_STORE_INVALID', '任务状态不受支持');
  }
  for (const [sequence, message] of task.messages.entries()) {
    if (!message || message.sequence !== sequence + 1
      || !['user', 'assistant', 'tool'].includes(message.role)
      || !['message', 'tool-call', 'tool-result'].includes(message.kind)
      || typeof message.text !== 'string' || message.text.length > 20_000) {
      throw new AuthoringTaskError('TASK_STORE_INVALID', '任务消息顺序或字段不合法');
    }
  }
  for (const direction of ['ingest', 'export'] as const) {
    const draft = task.drafts[direction];
    const failedDraft = task.failedDrafts?.[direction];
    const validDraft = (candidate: unknown): candidate is AuthoringDraftContent => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      const value = candidate as AuthoringDraftContent;
      return Number.isInteger(value.version) && value.version >= 1
        && typeof value.yaml === 'string' && Boolean(value.yaml)
        && typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/.test(value.contentHash)
        && Array.isArray(value.diagnostics) && Array.isArray(value.unresolved);
    };
    if (draft !== null && !validDraft(draft)) {
      throw new AuthoringTaskError('TASK_STORE_INVALID', `任务 ${direction} 草稿记录不合法`);
    }
    if (failedDraft !== undefined && failedDraft !== null && !validDraft(failedDraft)) {
      throw new AuthoringTaskError('TASK_STORE_INVALID', `任务 ${direction} 失败候选记录不合法`);
    }
  }
  return task;
}

function readRecord(taskId: string, workspace: string): AuthoringTaskRecord {
  if (!validId(taskId)) throw new AuthoringTaskError('TASK_NOT_FOUND', '任务不存在');
  const file = recordPath(workspace, taskId);
  if (!lstatRegularFile(file, false)) throw new AuthoringTaskError('TASK_NOT_FOUND', '任务不存在');
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new AuthoringTaskError('TASK_STORE_INVALID', '任务记录不是有效 JSON'); }
  return validateRecord(raw, workspace);
}

function hydrate(record: AuthoringTaskRecord, workspace: string): AuthoringTask {
  const attachment = getAttachmentCheck(record.id, workspace);
  if (!attachment || !validAttachment(attachment, record.id)) {
    throw new AuthoringTaskError('TASK_ATTACHMENT_INVALID', '任务附件检查记录不存在或未通过');
  }
  const snapshot = createSemanticSnapshot(workspace);
  return {
    task: record,
    attachment,
    semantic: semanticProjection(snapshot),
  };
}

export function getAuthoringTask(taskId: string, workspace = process.cwd()): AuthoringTask {
  return hydrate(readRecord(taskId, workspace), workspace);
}

export function createAuthoringTask(attachment: AttachmentCheck, workspace = process.cwd()): AuthoringTask {
  const snapshot = createSemanticSnapshot(workspace);
  const at = nowIso();
  const record: AuthoringTaskRecord = {
    storeVersion: AUTHORING_TASK_STORE_VERSION,
    id: attachment.id,
    workspaceIdentity: workspaceIdentity(workspace),
    status: initialStatus(attachment),
    revision: 1,
    direction: null,
    attachment: {
      checkId: attachment.id,
      filename: attachment.template.filename,
      href: `/api/authoring/task?id=${attachment.id}`,
      sizeBytes: attachment.template.sizeBytes,
      sha256: attachment.template.sha256,
      checkedAt: attachment.template.checkedAt,
      policy: attachment.policy,
    },
    declarationFingerprint: snapshot.fingerprint,
    modelRuns: 0,
    maxModelRuns: AUTHORING_MAX_MODEL_RUNS,
    activeRun: null,
    origin: 'new',
    messages: [],
    drafts: { ingest: null, export: null },
    confirmation: null,
    publication: null,
    failure: attachment.status === 'ready' ? null : {
      code: attachment.status.toUpperCase().replaceAll('-', '_'),
      message: attachment.refusal ?? '附件检查未通过',
    },
    createdAt: at,
    updatedAt: at,
  };
  writeAtomic(recordPath(workspace, record.id), record);
  return hydrate(record, workspace);
}

/** Creates a business authoring task from an existing checked attachment. */
export async function startAuthoringTask(options: {
  attachmentId?: string;
  filename?: string;
  bytes?: Buffer;
  workspace?: string;
}): Promise<AuthoringTask> {
  const workspace = options.workspace ?? process.cwd();
  let attachment: AttachmentCheck | null;
  if (options.attachmentId) {
    attachment = getAttachmentCheck(options.attachmentId, workspace);
  } else {
    if (!options.filename || !options.bytes) {
      throw new AuthoringTaskError('TASK_CHECK_REQUIRED', '需要已检查附件或 filename + bytes');
    }
    const { createTemplateTask } = await import('./attachment.ts');
    attachment = await createTemplateTask(options.filename, options.bytes, workspace);
  }
  if (!attachment) throw new AuthoringTaskError('TASK_ATTACHMENT_INVALID', '附件检查记录不存在');
  if (attachment.status !== 'ready' || !attachment.projection) {
    throw new AuthoringTaskError(
      'TASK_ATTACHMENT_INVALID',
      attachment.refusal ?? '附件安全检查未通过，不能建立规格制定任务',
    );
  }
  return createAuthoringTask(attachment, workspace);
}

/** Recover legacy ready checks as a new task; failed checks never gain a direction. */
export function recoverAuthoringTask(taskId: string, workspace = process.cwd()): AuthoringTask {
  const attachment = getAttachmentCheck(taskId, workspace);
  if (!attachment) throw new AuthoringTaskError('TASK_NOT_FOUND', '附件检查记录不存在');
  if (attachment.status !== 'ready' || !attachment.projection) {
    throw new AuthoringTaskError(
      'TASK_ATTACHMENT_INVALID',
      attachment.refusal ?? '附件安全检查未通过，不能建立规格制定任务',
    );
  }
  try {
    const existing = readRecord(taskId, workspace);
    return hydrate(existing, workspace);
  } catch (error) {
    if (!(error instanceof AuthoringTaskError) || error.code !== 'TASK_NOT_FOUND') throw error;
  }
  const recovered = createAuthoringTask(attachment, workspace);
  const legacy = readRecord(taskId, workspace);
  legacy.origin = 'legacy-check';
  return persist(legacy, workspace);
}

function persistUnderLock(task: AuthoringTaskRecord, workspace: string): AuthoringTask {
  const expectedRevision = task.revision;
  const current = readRecord(task.id, workspace);
  if (current.revision !== expectedRevision) {
    throw new AuthoringTaskError(
      'TASK_REVISION_CONFLICT',
      `任务已被其他操作更新（当前修订 ${current.revision}）`,
    );
  }
  task.revision = expectedRevision + 1;
  task.updatedAt = nowIso();
  writeAtomic(recordPath(workspace, task.id), task);
  return hydrate(task, workspace);
}

function persist(task: AuthoringTaskRecord, workspace: string): AuthoringTask {
  return withRecordLock(task.id, workspace, () => persistUnderLock(task, workspace));
}

function persistLeaseHeartbeatUnderLock(
  task: AuthoringTaskRecord,
  workspace: string,
): AuthoringTask {
  task.updatedAt = nowIso();
  writeAtomic(recordPath(workspace, task.id), task);
  return hydrate(task, workspace);
}

function assertRevision(task: AuthoringTaskRecord, expectedRevision: number): void {
  if (!Number.isInteger(expectedRevision) || expectedRevision !== task.revision) {
    throw new AuthoringTaskError(
      'TASK_REVISION_CONFLICT',
      `任务已被其他操作更新（当前修订 ${task.revision}）`,
    );
  }
}

function assertMutable(task: AuthoringTaskRecord, publishing = false): void {
  if (task.status === 'generating' && !publishing) {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '规格发布中，请先恢复发布');
  }
  if (task.status === 'cancelled' || task.status === 'retained') {
    throw new AuthoringTaskError('TASK_CANCELLED', '任务已取消或保留，迟到写入不再生效');
  }
  if (task.status === 'completed' || task.status === 'rejected') {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', `任务状态 ${task.status} 不允许修改`);
  }
}

function assertNoActiveRun(task: AuthoringTaskRecord, allowExpired = false): void {
  if (!task.activeRun) return;
  if (allowExpired
    && Date.parse(task.activeRun.expiresAt) <= Date.now()
    && !sameProcess(task.activeRun)) return;
  throw new AuthoringTaskError(
    'TASK_REVISION_CONFLICT',
    `任务有运行中的模型调用（租约 ${task.activeRun.id}）`,
  );
}

export function selectAuthoringDirection(options: {
  taskId: string;
  expectedRevision: number;
  direction: AuthoringDirection;
  workspace?: string;
}): AuthoringTask {
  const workspace = options.workspace ?? process.cwd();
  const task = readRecord(options.taskId, workspace);
  assertRevision(task, options.expectedRevision);
  assertMutable(task);
  assertNoActiveRun(task, true);
  task.activeRun = null;
  if (task.status !== 'awaiting-direction') {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '当前任务不能选择方向');
  }
  if (options.direction !== 'ingest' && options.direction !== 'export') {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '方向只能是 ingest / export');
  }
  const snapshot = createSemanticSnapshot(workspace);
  if (snapshot.issues.some((entry) => entry.level === 'error')) {
    throw new AuthoringTaskError(
      'TASK_SEMANTIC_INVALID',
      '工作区声明存在错误，先修复或把声明变更列入候选审阅',
    );
  }
  task.direction = options.direction;
  task.status = 'conversing';
  task.declarationFingerprint = snapshot.fingerprint;
  return persist(task, workspace);
}

export function appendAuthoringMessage(options: {
  taskId: string;
  expectedRevision: number;
  role: AuthoringMessage['role'];
  kind: AuthoringMessage['kind'];
  text: string;
  name?: string;
  callId?: string;
  providerMessage?: unknown;
  workspace?: string;
}): AuthoringTask {
  const workspace = options.workspace ?? process.cwd();
  const task = readRecord(options.taskId, workspace);
  assertRevision(task, options.expectedRevision);
  assertMutable(task);
  if (typeof options.text !== 'string' || !options.text.trim() || options.text.length > 20_000) {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '消息必须是非空文本且不超过 20000 字符');
  }
  if (!['user', 'assistant', 'tool'].includes(options.role)
    || !['message', 'tool-call', 'tool-result'].includes(options.kind)) {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '消息角色或类型不合法');
  }
  task.messages.push({
    sequence: task.messages.length + 1,
    role: options.role,
    kind: options.kind,
    text: options.text,
    ...(options.name ? { name: options.name } : {}),
    ...(options.callId ? { callId: options.callId } : {}),
    ...(options.providerMessage === undefined
      ? {}
      : { providerMessage: structuredClone(options.providerMessage) }),
    createdAt: nowIso(),
  });
  return persist(task, workspace);
}

export function replaceAuthoringMessages(options: {
  taskId: string;
  expectedRevision: number;
  messages: AuthoringMessage[];
  workspace?: string;
}): AuthoringTask {
  const workspace = options.workspace ?? process.cwd();
  const task = readRecord(options.taskId, workspace);
  assertRevision(task, options.expectedRevision);
  assertMutable(task);
  if (!Array.isArray(options.messages) || options.messages.length > 2000) {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '任务消息记录不合法');
  }
  task.messages = options.messages.map((message, index) => ({
    ...structuredClone(message),
    sequence: index + 1,
  }));
  return persist(task, workspace);
}

/**
 * Atomically reserves one model run and takes the task's single-run lease.
 * The lease prevents two local processes from entering provider work at once.
 */
export function acquireAuthoringModelLease(options: {
  taskId: string;
  expectedRevision: number;
  workspace?: string;
  now?: number;
}): AuthoringModelLease {
  const workspace = options.workspace ?? process.cwd();
  return withRecordLock(options.taskId, workspace, () => {
    const task = readRecord(options.taskId, workspace);
    assertRevision(task, options.expectedRevision);
    assertMutable(task);
    assertNoActiveRun(task, true);
    if (task.status !== 'conversing' && task.status !== 'awaiting-confirmation') {
      throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '当前任务不能运行模型');
    }
    if (task.modelRuns >= task.maxModelRuns) {
      throw new AuthoringTaskError('TASK_BUDGET_EXHAUSTED', '任务模型调用预算已用尽');
    }
    const now = options.now ?? Date.now();
    const at = new Date(now).toISOString();
    task.modelRuns += 1;
    task.activeRun = {
      id: randomUUID(),
      pid: process.pid,
      processStart: processStartTime(process.pid),
      revision: task.revision,
      modelRun: task.modelRuns,
      acquiredAt: at,
      heartbeatAt: at,
      expiresAt: new Date(now + AUTHORING_MODEL_LEASE_MS).toISOString(),
    };
    const acquired = persistUnderLock(task, workspace);
    const leaseId = acquired.task.activeRun!.id;
    let released = false;
    const owned = () => {
      const current = readRecord(options.taskId, workspace);
      if (current.status === 'failed' && !current.activeRun) {
        throw new AuthoringTaskError('TASK_REVISION_CONFLICT', '模型运行已结束');
      }
      if (!current.activeRun || current.activeRun.id !== leaseId) {
        throw new AuthoringTaskError(
          'TASK_REVISION_CONFLICT',
          '模型运行租约已失效或已被取消',
        );
      }
      return current;
    };
    return {
      id: leaseId,
      taskId: acquired.task.id,
      modelRun: acquired.task.modelRuns,
      revision: acquired.task.revision,
      renew: () => {
        return withRecordLock(options.taskId, workspace, () => {
          owned();
          const renewed = readRecord(options.taskId, workspace);
          const now = Date.now();
          renewed.activeRun!.heartbeatAt = new Date(now).toISOString();
          renewed.activeRun!.expiresAt = new Date(now + AUTHORING_MODEL_LEASE_MS).toISOString();
          // Lease renewal is operational metadata; it must not advance the
          // revision the in-flight model uses for proposal conflict checks.
          return persistLeaseHeartbeatUnderLock(renewed, workspace);
        });
      },
      assertOwned: () => hydrate(owned(), workspace),
      release: () => {
        return withRecordLock(options.taskId, workspace, () => {
          if (released) return getAuthoringTask(options.taskId, workspace);
          const current = readRecord(options.taskId, workspace);
          // Cancellation, provider failure or lease takeover may already have
          // cleared or replaced the run. Release is idempotent and must never
          // delete another process's lease.
          if (!current.activeRun || current.activeRun.id !== leaseId) {
            released = true;
            return hydrate(current, workspace);
          }
          const currentRevision = current.revision;
          current.activeRun = null;
          const result = persistUnderLock(current, workspace);
          released = true;
          if (result.task.revision !== currentRevision + 1) {
            throw new AuthoringTaskError('TASK_STORE_INVALID', '任务释放租约后修订号异常');
          }
          return result;
        });
      },
    };
  });
}

/** Backward-compatible budget-only helper; new authoring sessions use the lease. */
export function reserveAuthoringModelRun(options: {
  taskId: string;
  expectedRevision: number;
  workspace?: string;
}): AuthoringTask {
  const lease = acquireAuthoringModelLease(options);
  return lease.release();
}

export function saveAuthoringDraft(options: {
  taskId: string;
  expectedRevision: number;
  direction: AuthoringDirection;
  yaml: string;
  summary?: unknown;
  declarationReview?: Array<{ path: string; before: string | null; after: string | null }>;
  candidateState?: SemanticCandidateState | null;
  assistantText?: string;
  failed?: boolean;
  diagnostics?: AuthoringDiagnostic[];
  unresolved?: string[];
  workspace?: string;
}): AuthoringTask {
  const workspace = options.workspace ?? process.cwd();
  const task = readRecord(options.taskId, workspace);
  assertRevision(task, options.expectedRevision);
  assertMutable(task);
  if (task.direction !== options.direction) {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '草稿方向与任务方向不一致');
  }
  if (typeof options.yaml !== 'string' || !options.yaml.trim()
    || Buffer.byteLength(options.yaml) > 1024 * 1024) {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '草稿 YAML 必须非空且不超过 1MB');
  }
  const current = task.drafts[options.direction];
  if (options.failed) {
    const failed = {
      version: Math.max(
        task.failedDrafts?.[options.direction]?.version ?? 0,
        current?.version ?? 0,
      ) + 1,
      contentHash: sha(options.yaml),
      yaml: options.yaml,
      summary: options.summary === undefined ? null : structuredClone(options.summary),
      declarationReview: structuredClone(options.declarationReview ?? []),
      candidateState: options.candidateState ? structuredClone(options.candidateState) : null,
      assistantText: options.assistantText ?? current?.assistantText ?? '',
      createdAt: nowIso(),
      diagnostics: structuredClone(options.diagnostics ?? []),
      unresolved: [...(options.unresolved ?? [])],
    };
    task.failedDrafts = { ...(task.failedDrafts ?? {}), [options.direction]: failed };
    task.status = 'conversing';
    task.confirmation = null;
    return persist(task, workspace);
  }
  task.drafts[options.direction] = {
    version: (current?.version ?? 0) + 1,
    contentHash: sha(options.yaml),
    yaml: options.yaml,
    summary: options.summary === undefined ? null : structuredClone(options.summary),
    declarationReview: structuredClone(options.declarationReview ?? []),
    candidateState: options.candidateState ? structuredClone(options.candidateState) : null,
    assistantText: options.assistantText ?? '',
    createdAt: nowIso(),
    diagnostics: structuredClone(options.diagnostics ?? []),
    unresolved: [...(options.unresolved ?? [])],
  };
  if (task.failedDrafts?.[options.direction]) {
    delete task.failedDrafts[options.direction];
    if (!Object.values(task.failedDrafts).some(Boolean)) delete task.failedDrafts;
  }
  task.status = draftReadyForConfirmation(task.drafts[options.direction])
    ? 'awaiting-confirmation'
    : 'conversing';
  task.confirmation = null;
  return persist(task, workspace);
}

export function updateAuthoringDraftAssistantText(options: {
  taskId: string;
  expectedRevision: number;
  direction: AuthoringDirection;
  assistantText: string;
  workspace?: string;
}): AuthoringTask {
  const workspace = options.workspace ?? process.cwd();
  const task = readRecord(options.taskId, workspace);
  assertRevision(task, options.expectedRevision);
  assertMutable(task);
  const draft = task.drafts[options.direction];
  if (!draft) throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '当前方向没有可更新摘要的草稿');
  if (draft.assistantText === options.assistantText) return hydrate(task, workspace);
  draft.assistantText = options.assistantText;
  task.confirmation = null;
  // Session-owned draft updates keep the model-run lease intact.
  return withRecordLock(task.id, workspace, () => persistUnderLock(task, workspace));
}

export function markAuthoringFailed(options: {
  taskId: string;
  expectedRevision: number;
  code: string;
  message: string;
  workspace?: string;
}): AuthoringTask {
  const workspace = options.workspace ?? process.cwd();
  const task = readRecord(options.taskId, workspace);
  assertRevision(task, options.expectedRevision);
  assertMutable(task);
  task.activeRun = null;
  task.status = 'failed';
  task.failure = { code: options.code, message: options.message };
  return withRecordLock(task.id, workspace, () => persistUnderLock(task, workspace));
}

export function cancelAuthoringTask(options: {
  taskId: string;
  expectedRevision: number;
  retain?: boolean;
  workspace?: string;
}): AuthoringTask {
  const workspace = options.workspace ?? process.cwd();
  const task = readRecord(options.taskId, workspace);
  assertRevision(task, options.expectedRevision);
  if (task.status === 'completed' || task.status === 'generating') {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '已完成任务不能取消');
  }
  task.status = options.retain ? 'retained' : 'cancelled';
  task.activeRun = null;
  task.confirmation = null;
  const cancelled = persist(task, workspace);
  if (!options.retain) {
    fs.rmSync(path.dirname(recordPath(workspace, task.id)), { recursive: true, force: true });
  }
  return cancelled;
}

/**
 * Explicit crash recovery. This only clears an expired lease after the caller
 * has confirmed the recorded process is gone; a live process is never evicted.
 */
export function clearExpiredAuthoringLease(options: {
  taskId: string;
  expectedRevision: number;
  workspace?: string;
  processAlive?: (pid: number) => boolean;
  now?: number;
}): AuthoringTask {
  const workspace = options.workspace ?? process.cwd();
  const isAlive = options.processAlive;
  const task = readRecord(options.taskId, workspace);
  assertRevision(task, options.expectedRevision);
  if (!task.activeRun) {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '任务没有模型运行租约');
  }
  if (Date.parse(task.activeRun.expiresAt) > (options.now ?? Date.now())) {
    throw new AuthoringTaskError('TASK_REVISION_CONFLICT', '模型运行租约尚未过期');
  }
  if (isAlive ? isAlive(task.activeRun.pid) : sameProcess(task.activeRun)) {
    throw new AuthoringTaskError('TASK_REVISION_CONFLICT', '记录中的模型进程仍在运行');
  }
  task.activeRun = null;
  return persist(task, workspace);
}

export function inspectAuthoringLease(
  taskId: string,
  workspace = process.cwd(),
  now = Date.now(),
): AuthoringLeaseRecovery {
  const task = readRecord(taskId, workspace);
  const processAlive = task.activeRun ? sameProcess(task.activeRun) : false;
  return {
    taskId,
    leaseId: task.activeRun?.id ?? null,
    pid: task.activeRun?.pid ?? null,
    expiresAt: task.activeRun?.expiresAt ?? null,
    expired: task.activeRun ? Date.parse(task.activeRun.expiresAt) <= now : false,
    processAlive,
  };
}

export function resumeAuthoringTask(options: {
  taskId: string;
  expectedRevision: number;
  workspace?: string;
}): AuthoringTask {
  const workspace = options.workspace ?? process.cwd();
  const task = readRecord(options.taskId, workspace);
  assertRevision(task, options.expectedRevision);
  if (!['retained', 'failed'].includes(task.status)) {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '只有保留或失败的任务可以恢复');
  }
  if (task.activeRun) {
    if (Date.parse(task.activeRun.expiresAt) <= Date.now() && !sameProcess(task.activeRun)) {
      task.activeRun = null;
    }
  }
  if (task.activeRun) {
    throw new AuthoringTaskError('TASK_REVISION_CONFLICT', '任务仍有模型运行租约，请先确认进程已退出');
  }
  const hasFailedCandidate = Boolean(task.direction && task.failedDrafts?.[task.direction]);
  task.status = task.direction
    ? (!hasFailedCandidate && draftReadyForConfirmation(task.drafts[task.direction])
      ? 'awaiting-confirmation'
      : 'conversing')
    : 'awaiting-direction';
  task.failure = null;
  return persist(task, workspace);
}

/** Cancellation removes unpublished copies only after the local user asks for it. */
export function purgeUnpublishedAuthoringTask(options: {
  taskId: string;
  expectedRevision: number;
  workspace?: string;
}): void {
  const workspace = options.workspace ?? process.cwd();
  const task = readRecord(options.taskId, workspace);
  assertRevision(task, options.expectedRevision);
  if (task.status !== 'cancelled' && task.status !== 'rejected') {
    throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '只有取消或拒绝的任务可以清理');
  }
  if (task.activeRun && Date.parse(task.activeRun.expiresAt) > Date.now()) {
    throw new AuthoringTaskError('TASK_REVISION_CONFLICT', '任务仍有有效的模型运行租约');
  }
  if (task.activeRun && sameProcess(task.activeRun)) {
    throw new AuthoringTaskError('TASK_REVISION_CONFLICT', '记录中的模型进程仍在运行');
  }
  fs.rmSync(path.dirname(recordPath(workspace, task.id)), { recursive: true, force: true });
}

export function authoringTaskView(task: AuthoringTask): AuthoringTaskView {
  const {
    workspaceIdentity: _identity,
    activeRun: _activeRun,
    ...record
  } = task.task;
  const semantic = structuredClone(task.semantic);
  const safeDraft = (draft: AuthoringDraft | AuthoringDraftContent | null | undefined) => draft ? {
    version: draft.version,
    contentHash: draft.contentHash,
    summary: structuredClone(draft.summary),
    declarationReview: draft.declarationReview.map((change) => ({
      path: change.path,
      action: change.before === null ? 'create' as const
        : change.after === null ? 'delete' as const : 'replace' as const,
    })),
    diagnostics: structuredClone(draft.diagnostics),
    unresolved: [...draft.unresolved],
    assistantText: draft.assistantText,
    createdAt: draft.createdAt,
  } : null;
  const drafts = {
    ingest: safeDraft(record.drafts.ingest),
    export: safeDraft(record.drafts.export),
  };
  const failedDrafts = record.failedDrafts
    ? {
      ingest: safeDraft(record.failedDrafts.ingest),
      export: safeDraft(record.failedDrafts.export),
    }
    : undefined;
  return {
    task: {
      ...structuredClone(record),
      drafts,
      ...(failedDrafts ? { failedDrafts } : {}),
    },
    attachment: { ...task.task.attachment },
    semantic: structuredClone(semantic),
    declarationStale: semantic.fingerprint !== task.task.declarationFingerprint,
  };
}

/** Local confirmation/publication transitions; caller holds workspace coordination. */
export function setAuthoringPublication(options: {
  taskId: string; expectedRevision: number; workspace: string;
  confirmation: AuthoringConfirmation; publication: AuthoringPublication | null;
}): AuthoringTask {
  const task = readRecord(options.taskId, options.workspace);
  assertRevision(task, options.expectedRevision);
  assertMutable(task, true);
  if (task.activeRun) throw new AuthoringTaskError('TASK_TRANSITION_INVALID', '模型运行中不能发布');
  task.confirmation = structuredClone(options.confirmation);
  task.publication = structuredClone(options.publication);
  task.status = options.publication?.status === 'completed' ? 'completed' : 'generating';
  return persist(task, options.workspace);
}
export function listAuthoringTasks(workspace = process.cwd()): AuthoringTask[] {
  const root = rootOf(workspace);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter(validId).flatMap((id) => {
    try { return [getAuthoringTask(id, workspace)]; }
    catch (error) { if ((error as {code?: string}).code === 'TASK_NOT_FOUND') return []; throw error; }
  }).sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
}
