import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { acquireWorkspaceLock } from '../runtime/service.ts';
import { assertPublicationReadable, publicationBarrier, recordPublicationGeneration } from '../runtime/publication.ts';
import { validateCandidate, validateExportCandidate } from './candidates.ts';
import { candidateFromState, createSemanticSnapshot } from './semantic.ts';
import {
  getAuthoringTask, authoringTemplateGeometry, draftReadyForConfirmation, setAuthoringPublication,
  type AuthoringConfirmation, type AuthoringTask,
} from './tasks.ts';

export interface PublicationFile {
  path: string;
  beforeHash: string | null;
  content: string | null; // base64; null means an explicitly reviewed deletion
  afterHash: string | null;
}
export interface PublicationPlan {
  version: 1;
  taskId: string;
  revision: number;
  direction: 'ingest' | 'export';
  draftVersion: number;
  draftHash: string;
  excelHash: string;
  policy: string;
  declarationFingerprint: string;
  declarationBaselines: Array<{ path: string; sha256: string }>;
  files: PublicationFile[];
  summary: unknown;
  hash: string;
}
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const validId = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
const planHash = (plan: Omit<PublicationPlan, 'hash'> | PublicationPlan) => {
  const { hash: _ignored, ...body } = plan as PublicationPlan;
  return sha(JSON.stringify(body));
};
function safeFile(workspace: string, relative: string): string {
  if (!/^(models|metrics|ingest|specs|templates)\/[\p{L}\p{N}_.-]+\.(ya?ml|xlsx)$/u.test(relative)) {
    throw new Error('PUBLICATION_PATH_INVALID: 正式文件必须位于受管目录');
  }
  const root = path.resolve(workspace);
  const file = path.join(root, relative);
  for (let current = file; ; current = path.dirname(current)) {
    if (fs.existsSync(current) || (() => { try { fs.lstatSync(current); return true; } catch { return false; } })()) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (current === file ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error('PUBLICATION_PATH_INVALID: 发布目标不能是链接或特殊文件');
      }
    }
    if (current === root) break;
  }
  return file;
}
function bytesAt(workspace: string, relative: string): Buffer | null {
  const file = safeFile(workspace, relative);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}
function hashAt(workspace: string, relative: string): string | null {
  const bytes = bytesAt(workspace, relative);
  return bytes === null ? null : sha(bytes);
}
function privateDir(workspace: string, taskId?: string): string {
  const root = path.resolve(workspace);
  const dirs = [path.join(root, '.bilite')];
  if (taskId) dirs.push(path.join(root, '.bilite/authoring'), path.join(root, '.bilite/authoring', taskId));
  for (const dir of dirs) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PUBLICATION_PATH_INVALID: 任务目录不能是链接');
  }
  return dirs[dirs.length - 1];
}
function atomic(file: string, bytes: Buffer | string): void {
  const tmp = file + '.' + randomUUID() + '.tmp';
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export function preparePublication(taskId: string, workspace: string): PublicationPlan {
  assertPublicationReadable(workspace);
  return preparePlan(taskId, workspace);
}
function preparePlan(taskId: string, workspace: string): PublicationPlan {
  const current = getAuthoringTask(taskId, workspace);
  if (current.task.activeRun || current.task.status !== 'awaiting-confirmation' || !current.task.direction) {
    throw new Error('PUBLICATION_NOT_READY: 请先完成修订并结束当前模型运行');
  }
  const direction = current.task.direction;
  const draft = current.task.drafts[direction];
  if (!draftReadyForConfirmation(draft) || current.task.failedDrafts?.[direction]) {
    throw new Error('PUBLICATION_NOT_READY: 仍有失败候选、错误或未决项');
  }
  const snapshot = createSemanticSnapshot(workspace);
  if (snapshot.fingerprint !== current.task.declarationFingerprint) throw new Error('PUBLICATION_STALE: 声明已变化，请重新制定');
  const candidate = candidateFromState(draft!.candidateState!, workspace);
  if (candidate.issues.some((issue) => issue.level === 'error')) throw new Error('PUBLICATION_INVALID: 候选声明未通过校验');
  const doc = parse(draft!.yaml);
  if (!doc || typeof doc.id !== 'string' || !/^[\p{L}\p{N}_-]+$/u.test(doc.id)) {
    throw new Error('PUBLICATION_INVALID: 规格 id 只能使用文字、数字、下划线和连字符');
  }
  const relative = `${direction === 'ingest' ? 'ingest' : 'specs'}/${doc.id}.yaml`;
  const templatePath = `templates/${doc.id}.xlsx`;
  // File selection is a local execution concern, never a model-chosen path.
  if (direction === 'ingest') delete doc.source;
  else doc.template = templatePath;
  const yaml = stringify(doc);
  const catalog = { facts: candidate.facts, metrics: candidate.snapshot.metrics, definitions: candidate.definitions };
  const checked = direction === 'export'
    ? validateExportCandidate(yaml, catalog, authoringTemplateGeometry(current.attachment))
    : validateCandidate(direction, yaml, catalog);
  if (!checked.ok || checked.unresolved.length) throw new Error('PUBLICATION_INVALID: 最终规格仍有静态诊断');
  privateDir(workspace, taskId);
  const attachmentFile = path.join(privateDir(workspace, taskId), 'template.xlsx');
  const stat = fs.lstatSync(attachmentFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('PUBLICATION_STALE: 附件快照无效');
  const attachment = fs.readFileSync(attachmentFile);
  if (sha(attachment) !== current.task.attachment.sha256) throw new Error('PUBLICATION_STALE: 附件快照已变化');
  const desired = new Map<string, Buffer | null>();
  const prior = new Map(snapshot.files.map((f) => [`${f.kind === 'model' ? 'models' : 'metrics'}/${f.name}`, f.text]));
  const next = new Map(candidate.snapshot.files.map((f) => [`${f.kind === 'model' ? 'models' : 'metrics'}/${f.name}`, f.text]));
  for (const name of new Set([...prior.keys(), ...next.keys()])) {
    if (prior.get(name) !== next.get(name)) desired.set(name, next.has(name) ? Buffer.from(next.get(name)!) : null);
  }
  desired.set(relative, Buffer.from(yaml));
  if (direction === 'export') desired.set(templatePath, attachment);
  const files = [...desired].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => ({
    path: name, beforeHash: hashAt(workspace, name),
    content: bytes === null ? null : bytes.toString('base64'), afterHash: bytes === null ? null : sha(bytes),
  }));
  const body: Omit<PublicationPlan, 'hash'> = {
    version: 1, taskId, revision: current.task.revision, direction,
    draftVersion: draft!.version, draftHash: draft!.contentHash, excelHash: current.task.attachment.sha256,
    policy: current.task.attachment.policy, declarationFingerprint: snapshot.fingerprint,
    declarationBaselines: snapshot.files.map(f => ({ path: `${f.kind === 'model' ? 'models' : 'metrics'}/${f.name}`, sha256: f.sha256 })),
    files, summary: checked.summary,
  };
  return { ...body, hash: planHash(body) };
}
interface Journal { version: 1; plan: PublicationPlan; confirmation: AuthoringConfirmation }
const journalFile = (workspace: string, taskId: string) => path.join(privateDir(workspace, taskId), 'publication.json');
function completeJournal(workspace: string, journal: Journal, afterWrite?: (count: number) => void): AuthoringTask {
  const { plan, confirmation } = journal;
  if (plan.hash !== planHash(plan) || !validId(plan.taskId) || !plan.files.length || plan.files.length > 260) {
    throw new Error('PUBLICATION_RECORD_INVALID: 发布记录无效');
  }
  let task = getAuthoringTask(plan.taskId, workspace);
  // A crash may occur after the durable commit intent, before the task transition.
  if (!task.task.confirmation && task.task.revision === plan.revision) {
    if (preparePlan(plan.taskId, workspace).hash !== plan.hash) {
      throw new Error('PUBLICATION_STALE: 恢复前审阅内容已变化');
    }
    task = setAuthoringPublication({ taskId: plan.taskId, expectedRevision: plan.revision,
      workspace, confirmation, publication: null });
  }
  if (task.task.confirmation?.planHash !== plan.hash) throw new Error('PUBLICATION_STALE: 确认记录不匹配');
  const declarationPaths = new Set(plan.declarationBaselines.map(f => f.path));
  for (const f of plan.files) if (/^(models|metrics)\//.test(f.path)) declarationPaths.add(f.path);
  const observed = createSemanticSnapshot(workspace);
  for (const f of observed.files) {
    const name = `${f.kind === 'model' ? 'models' : 'metrics'}/${f.name}`;
    if (!declarationPaths.has(name)) throw new Error('PUBLICATION_CONFLICT: 发布期间声明文件集合已变化');
  }
  for (const f of plan.declarationBaselines) {
    if (!plan.files.some(changed => changed.path === f.path) && hashAt(workspace, f.path) !== f.sha256) {
      throw new Error(`PUBLICATION_CONFLICT: ${f.path} 已被其他操作修改`);
    }
  }
  for (const file of plan.files) {
    const bytes = file.content === null ? null : Buffer.from(file.content, 'base64');
    if ((bytes === null ? null : sha(bytes)) !== file.afterHash) throw new Error('PUBLICATION_RECORD_INVALID: 文件哈希不匹配');
    const now = hashAt(workspace, file.path);
    if (now !== file.beforeHash && now !== file.afterHash) throw new Error(`PUBLICATION_CONFLICT: ${file.path} 已被其他操作修改`);
  }
  let count = 0;
  for (const file of plan.files) {
    const target = safeFile(workspace, file.path);
    if (hashAt(workspace, file.path) !== file.afterHash) {
      if (file.content === null) fs.unlinkSync(target);
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        safeFile(workspace, file.path);
        atomic(target, Buffer.from(file.content, 'base64'));
      }
    }
    afterWrite?.(++count);
  }
  for (const file of plan.files) if (hashAt(workspace, file.path) !== file.afterHash) throw new Error('PUBLICATION_CONFLICT: 提交后核验失败');
  let current = getAuthoringTask(plan.taskId, workspace);
  if (current.task.status !== 'completed') {
    current = setAuthoringPublication({
      taskId: plan.taskId, expectedRevision: current.task.revision, workspace, confirmation,
      publication: { status: 'completed', files: plan.files.filter(f => f.afterHash).map(f => ({path: f.path, sha256: f.afterHash!})), completedAt: new Date().toISOString() },
    });
  }
  recordPublicationGeneration(workspace, plan.hash);
  fs.unlinkSync(publicationBarrier(workspace));
  return current;
}
export async function publishConfirmedPlan(plan: PublicationPlan, workspace: string, afterWrite?: (count: number) => void): Promise<AuthoringTask> {
  // Existing execution lock coordinates CLI/Web and publication, without opening a DB.
  const lock = await acquireWorkspaceLock(workspace, 1000);
  try {
    if (plan.hash !== planHash(plan)) throw new Error('PUBLICATION_STALE: 审阅计划被修改');
    const current = getAuthoringTask(plan.taskId, workspace);
    if (current.task.status === 'completed' && current.task.confirmation?.planHash === plan.hash) {
      for (const f of plan.files) if (hashAt(workspace, f.path) !== f.afterHash) throw new Error('PUBLICATION_CONFLICT: 已发布文件已变化');
      return current;
    }
    const fresh = preparePublication(plan.taskId, workspace);
    if (fresh.hash !== plan.hash) throw new Error('PUBLICATION_STALE: 审阅后发生变化，请重新审阅确认');
    const confirmation: AuthoringConfirmation = {
      direction: plan.direction, draftVersion: plan.draftVersion, draftHash: plan.draftHash,
      excelHash: plan.excelHash, policy: plan.policy, declarationFingerprint: plan.declarationFingerprint,
      confirmedAt: new Date().toISOString(), planHash: plan.hash,
    };
    const journal: Journal = { version: 1, plan, confirmation };
    atomic(journalFile(workspace, plan.taskId), JSON.stringify(journal));
    fs.writeFileSync(publicationBarrier(workspace), JSON.stringify({ version: 1, taskId: plan.taskId, hash: plan.hash }), { flag: 'wx', mode: 0o600 });
    return completeJournal(workspace, journal, afterWrite);
  } finally { lock.release(); }
}
export async function recoverPublication(workspace: string): Promise<AuthoringTask | null> {
  const barrier = publicationBarrier(workspace);
  if (!fs.existsSync(barrier)) return null;
  const lock = await acquireWorkspaceLock(workspace, 1000);
  try {
    const pointer = JSON.parse(fs.readFileSync(barrier, 'utf8'));
    if (!validId(pointer.taskId)) throw new Error('PUBLICATION_RECORD_INVALID: 恢复任务无效');
    const file = journalFile(workspace, pointer.taskId);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('PUBLICATION_RECORD_INVALID');
    const journal: Journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (journal.plan.hash !== pointer.hash) throw new Error('PUBLICATION_RECORD_INVALID: 恢复指针不匹配');
    return completeJournal(workspace, journal);
  } finally { lock.release(); }
}
