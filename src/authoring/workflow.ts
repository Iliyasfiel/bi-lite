/**
 * 单入口规格制定流程（`bilite spec <Excel路径>`）。
 *
 * 契约见 docs/需求与架构.md §7.1 与 docs/开发计划.md §2.7：
 * 本地安全检查 → 复用/新建任务 → 选择方向 → 连续会话与候选草稿 →
 * 实际业务摘要与文件差异 → 本地明确确认 → preparePublication / publishConfirmedPlan。
 *
 * 纪律（改之前先读）：
 *  1. 路径由 bin 预解析；本模块只做兜底解析，不切工作区、不初始化工作区。
 *  2. 全程只用结构投影、用户文字与工作区 YAML 声明；不加载 DuckDB、不查业务表、不执行 SQL。
 *  3. 发布只能由本机明确操作触发：对话里的“好的”参与语义修订，但绝不发布。
 *  4. EOF、Ctrl-C 都给“保留/清理”结论；失败保留最近有效草稿并在同一入口重试。
 *
 * 可测注入只有两项：`runtime`（供应商运行时，验收用替身 stream）与
 * `ask`（逐行输入，null = EOF）。其余一律调用真实模块。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  PROJECTION_POLICY,
  createTemplateTask,
  getAuthoringTask as getAttachmentCheck,
  type AuthoringTask as AttachmentCheck,
} from './attachment.ts';
import {
  defaultAuthoringAuthPath,
  defaultAuthoringConfig,
  defaultAuthoringConfigPath,
  loadAuthoringConfig,
  runtimeFromAuthoringConfig,
  writeAuthoringConfig,
  writeAuthoringCredential,
  type AuthoringConfig,
} from './config.ts';
import { createAuthoringTerminal } from './interactive.ts';
import { inspectAuthoringTask, previewAuthoringSend } from './inspect.ts';
import { readSecretLine } from './input.ts';
import type { PiRuntimeOptions } from './pi.ts';
import {
  preparePublication,
  publishConfirmedPlan,
  recoverPublication,
  type PublicationFile,
  type PublicationPlan,
} from './publish.ts';
import { runSharedAuthoringTurn } from './session.ts';
import {
  cancelAuthoringTask,
  getAuthoringTask,
  listAuthoringTasks,
  resumeAuthoringTask,
  selectAuthoringDirection,
  startAuthoringTask,
  type AuthoringDirection,
  type AuthoringTask,
} from './tasks.ts';
import type { AuthoringDraft, AuthoringDraftContent } from './tasks.ts';

export type SpecWorkflowResult =
  | 'completed'
  | 'retained'
  | 'cancelled'
  | 'rejected'
  | 'failed';

export interface SpecWorkflowInput {
  workspace: string;
  input: Readable;
  output: Writable;
  /** Defaults to process.stderr: prompts stay on output, progress on error. */
  error?: Writable;
  /** Provider runtime; when omitted the local authoring config is used. */
  runtime?: PiRuntimeOptions;
  /** Test adapter: resolves one line without a TTY; null means EOF. */
  ask?: (prompt: string) => Promise<string | null>;
}

export type SpecWorkflowOptions = SpecWorkflowInput & { excel: string };

interface WorkflowState {
  workspace: string;
  excel: string;
  runtime: PiRuntimeOptions | undefined;
  terminal: ReturnType<typeof createAuthoringTerminal>;
  out: (text: string) => void;
  err: (text: string) => void;
  interrupt: { requested: boolean; count: number; controller: AbortController | null };
}

interface PlanAttempt {
  plan: PublicationPlan | null;
  reason: string | null;
}

type TaskChoice =
  | { kind: 'new' }
  | { kind: 'task'; task: AuthoringTask }
  | { kind: 'completed-exit' };

const VALID_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const STALE_DECLARATION = 'DECLARATION_FINGERPRINT_STALE';
const ABORTED_TURN = 'AUTHORING_TURN_ABORTED';
const MAX_LISTED_TASKS = 8;
/** 与 src/spec/blank.ts `readCheckedTemplate` 的模板体积上限保持一致。 */
const MAX_WORKBOOK_BYTES = 32 * 1024 * 1024;

const short = (hash: string | null) => (hash === null ? '无' : `${hash.slice(0, 12)}…`);
const truncate = (text: string, limit: number) =>
  (text.length > limit ? `${text.slice(0, limit)}…` : text);

function readRegularFile(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('需要具体的 .xlsx 文件，不能是链接、目录或其他特殊文件');
  }
  if (!stat.size) throw new Error('文件为空，不是可用的 .xlsx 模板');
  if (stat.size > MAX_WORKBOOK_BYTES) {
    throw new Error(`文件超出模板上限（${Math.round(MAX_WORKBOOK_BYTES / 1024 / 1024)}MB），请拆分后重试`);
  }
  return fs.readFileSync(file);
}

/** Reuses an identical prior check instead of re-checking the same snapshot. */
function findPriorCheck(workspace: string, digest: string, policy: string): AttachmentCheck | null {
  const root = path.join(path.resolve(workspace), '.bilite/authoring');
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!VALID_ID.test(entry)) continue;
    let check: AttachmentCheck | null;
    try {
      check = getAttachmentCheck(entry, workspace);
    } catch {
      continue; // 损坏的检查记录只意味着这次重新检查同一快照。
    }
    if (check && check.template.sha256 === digest && check.policy === policy) return check;
  }
  return null;
}

export async function runSpecWorkflow(options: SpecWorkflowOptions): Promise<SpecWorkflowResult>;
export async function runSpecWorkflow(
  excel: string,
  options: SpecWorkflowInput,
): Promise<SpecWorkflowResult>;
export async function runSpecWorkflow(
  excelOrOptions: string | SpecWorkflowOptions,
  maybeOptions?: SpecWorkflowInput,
): Promise<SpecWorkflowResult> {
  const input: SpecWorkflowOptions = typeof excelOrOptions === 'string'
    ? { ...(maybeOptions as SpecWorkflowInput), excel: excelOrOptions }
    : excelOrOptions;
  const terminal = createAuthoringTerminal({
    input: input.input,
    output: input.output,
    error: input.error ?? process.stderr,
    ask: input.ask,
  });
  const state: WorkflowState = {
    workspace: path.resolve(input.workspace),
    excel: path.resolve(input.excel),
    runtime: input.runtime,
    terminal,
    out: terminal.out,
    err: terminal.err,
    interrupt: { requested: false, count: 0, controller: null },
  };
  const detach = terminal.onInterrupt(() => {
    state.interrupt.count += 1;
    state.interrupt.requested = true;
    if (state.interrupt.controller) {
      state.interrupt.controller.abort();
      state.err('已请求中止当前模型调用。');
    } else {
      state.err('已请求中止。');
    }
  });
  try {
    return await runEntry(state);
  } finally {
    detach();
    terminal.close();
  }
}

async function runEntry(state: WorkflowState): Promise<SpecWorkflowResult> {
  const { out, err } = state;

  // 崩溃或中断留下的发布记录先恢复，避免读到半套规格。
  try {
    const recovered = await recoverPublication(state.workspace);
    if (recovered) {
      out('检测到未完成的规格发布，已按发布记录恢复完成。');
      printPublication(state, recovered);
      return 'completed';
    }
  } catch (error) {
    err(`未完成的规格发布无法恢复：${(error as Error).message}`);
    return 'failed';
  }

  let bytes: Buffer;
  try {
    bytes = readRegularFile(state.excel);
  } catch (error) {
    err((error as NodeJS.ErrnoException).code === 'ENOENT'
      ? `文件不存在：${state.excel}`
      : `无法读取待检查文件：${(error as Error).message}`);
    return 'failed';
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  out('bi-lite 规格制定：本地检查 → 方向 → 连续对话 → 本地确认发布（不读取数据库）');
  out(`待检查文件：${path.basename(state.excel)}（${bytes.length} 字节，sha256=${short(digest)}）`);
  out(`工作区：${state.workspace}`);

  let check = findPriorCheck(state.workspace, digest, PROJECTION_POLICY);
  if (!check) {
    try {
      check = await createTemplateTask(path.basename(state.excel), bytes, state.workspace);
    } catch (error) {
      err(`本地检查未能完成：${(error as Error).message}`);
      return 'failed';
    }
  }
  if (check.status !== 'ready' || !check.projection) {
    out(`本地安全检查未通过（${check.status}）；已停止，未调用模型，也未创建任务。`);
    out(check.refusal ?? '文件不是可用的空白结构样表。');
    return 'rejected';
  }
  out('本地安全检查通过：只使用结构投影，不发送文件字节、路径或公式正文。');

  const matches = listAuthoringTasks(state.workspace).filter((task) =>
    task.task.attachment.sha256 === digest && task.task.attachment.policy === check!.policy);
  const stale = matches.filter((task) =>
    task.task.status !== 'completed' && isDeclarationStale(task));
  if (stale.length) {
    out(`工作区声明已变化，${stale.length} 个未完成任务不再适用；本次按当前声明新建任务。`);
  }
  const reusable = matches.filter((task) =>
    task.task.status === 'completed' || !isDeclarationStale(task));

  let task: AuthoringTask | null = null;
  if (reusable.length) {
    const choice = await chooseTask(state, reusable);
    if (choice === null) {
      out('已中止本次入口；未新建任务，已有任务保持不变。');
      return 'retained';
    }
    if (choice.kind === 'completed-exit') return 'completed';
    task = choice.kind === 'new' ? null : choice.task;
  }
  if (!task) {
    let fresh = check;
    if (taskRecordExists(state, fresh.id)) {
      // 同一检查记录已被任务占用（例如“新建修订”）：用同一快照重新检查一次。
      try {
        fresh = await createTemplateTask(path.basename(state.excel), bytes, state.workspace);
      } catch (error) {
        err(`重新检查失败：${(error as Error).message}`);
        return 'failed';
      }
      if (fresh.status !== 'ready' || !fresh.projection) {
        out(`本地安全检查未通过（${fresh.status}）；未创建任务。`);
        out(fresh.refusal ?? '文件不是可用的空白结构样表。');
        return 'rejected';
      }
    }
    try {
      task = await startAuthoringTask({ attachmentId: fresh.id, workspace: state.workspace });
      out(`已建立规格制定任务 ${task.task.id}（状态 ${task.task.status}）。`);
    } catch (error) {
      err(`建立任务失败：${(error as Error).message}`);
      return 'failed';
    }
  }

  if (task.task.status === 'retained' || task.task.status === 'failed') {
    try {
      task = resumeAuthoringTask({
        taskId: task.task.id,
        expectedRevision: task.task.revision,
        workspace: state.workspace,
      });
      out(`已恢复任务 ${task.task.id}（状态 ${task.task.status}）。`);
    } catch (error) {
      err(`无法继续该任务：${(error as Error).message}`);
      return 'failed';
    }
  }

  if (task.task.status === 'awaiting-direction') {
    const direction = await askDirection(state);
    if (direction === null) return await retain(state, task, '未选择方向；任务已保留，未发布。');
    try {
      task = selectAuthoringDirection({
        taskId: task.task.id,
        expectedRevision: task.task.revision,
        direction,
        workspace: state.workspace,
      });
    } catch (error) {
      err(`无法选择方向：${(error as Error).message}`);
      return await retain(state, task, '任务已保留，未发布。');
    }
    out(`方向：${directionLabel(direction)}。`);
  }
  if (!task.task.direction) {
    err('任务没有可用方向，无法继续。');
    return await retain(state, task, '任务已保留，未发布。');
  }

  let runtime: PiRuntimeOptions;
  try {
    runtime = await resolveRuntime(state);
  } catch (error) {
    err(`助手配置不可用：${(error as Error).message}`);
    return await retain(state, task, '任务已保留，未发布；配置就绪后再运行同一命令即可继续。');
  }

  return await conversation(state, task, runtime);
}

async function chooseTask(state: WorkflowState, matches: AuthoringTask[]): Promise<TaskChoice | null> {
  const { out, terminal } = state;
  out('该文件已有同内容哈希、同检查政策的任务：');
  const listed = matches.slice(0, MAX_LISTED_TASKS);
  listed.forEach((task, index) => out(`  ${index + 1} ${describeTask(task)}`));
  if (matches.length > listed.length) {
    out(`  …另有 ${matches.length - listed.length} 个任务未列出。`);
  }
  out('  0 新建任务（按当前文件重新检查并制定新规格）');
  for (;;) {
    const answer = await terminal.ask('继续原任务请选序号，新建输入 0：');
    if (answer === null || state.interrupt.requested) return null;
    const text = answer.trim();
    if (/^(0|新建|新修订|new)$/i.test(text)) return { kind: 'new' };
    const index = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    const picked = Number.isInteger(index) && index >= 1 && index <= listed.length
      ? listed[index - 1]
      : null;
    if (!picked) {
      out(`未识别选择，请输入 0 或 1-${listed.length}。`);
      continue;
    }
    if (picked.task.status === 'completed') {
      const again = await showCompletedTask(state, picked);
      return again ? { kind: 'new' } : { kind: 'completed-exit' };
    }
    return { kind: 'task', task: picked };
  }
}

async function showCompletedTask(state: WorkflowState, task: AuthoringTask): Promise<boolean> {
  const { out, terminal } = state;
  out(`该文件已有已完成的规格任务（${task.task.updatedAt}，方向 ${directionLabel(task.task.direction)}）：`);
  printPublication(state, task);
  for (;;) {
    const answer = await terminal.ask('针对当前文件新建修订请输入“新建”，直接回车退出：');
    if (answer === null || state.interrupt.requested) return false;
    const text = answer.trim();
    if (!text) return false;
    if (/^(新建|新修订|0|new)$/i.test(text)) return true;
    out('未识别选择：输入“新建”重新制定，或直接回车退出。');
  }
}

async function askDirection(state: WorkflowState): Promise<AuthoringDirection | null> {
  const { out, terminal } = state;
  out('请选择规格方向：');
  out('  1 制定接入规格（保存到 ingest/）');
  out('  2 制定导出规格（保存到 specs/，并关联 templates/ 的空白 Excel）');
  for (;;) {
    const answer = await terminal.ask('输入 1（接入）或 2（导出）：');
    if (answer === null || state.interrupt.requested) return null;
    const text = answer.trim();
    if (/^(1|接入|ingest)$/i.test(text)) return 'ingest';
    if (/^(2|导出|export)$/i.test(text)) return 'export';
    out('未识别方向，请输入 1（接入）或 2（导出）。');
  }
}

async function resolveRuntime(state: WorkflowState): Promise<PiRuntimeOptions> {
  if (state.runtime) return state.runtime;
  const { out, err } = state;
  const configFile = defaultAuthoringConfigPath();
  const authFile = defaultAuthoringAuthPath();
  let config: AuthoringConfig;
  try {
    config = loadAuthoringConfig({ file: configFile });
    return runtimeFromAuthoringConfig(config, process.env, { authFile });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'AUTHORING_CONFIG_MISSING' && code !== 'AUTHORING_API_KEY_MISSING') throw error;
    out('本机还没有助手供应商配置，现在在入口内配置；密钥只写入本机凭据文件，不写入工作区。');
    if (code === 'AUTHORING_CONFIG_MISSING') {
      config = defaultAuthoringConfig();
      writeAuthoringConfig(config, { file: configFile });
    } else {
      config = loadAuthoringConfig({ file: configFile });
    }
  }
  const key = await state.terminal.releaseInput(() => readSecretLine('API key（输入不回显）: ', err));
  if (!key) throw new Error('API key 不能为空');
  writeAuthoringCredential(key, { file: authFile });
  out(`已保存助手配置 ${config.baseUrl} / ${config.modelId}；未做网络连通性检查。`);
  return runtimeFromAuthoringConfig(config, process.env, { authFile });
}

async function conversation(
  state: WorkflowState,
  initial: AuthoringTask,
  runtime: PiRuntimeOptions,
): Promise<SpecWorkflowResult> {
  const { out, err, terminal } = state;
  let task = initial;
  for (;;) {
    task = refresh(state, task);
    const review = inspectAuthoringTask(task);
    let line: string;
    if (review.readyForConfirmation) {
      const attempt = attemptPlan(state, task);
      showReview(state, task, review, attempt);
      const answer = await terminal.ask(menuPrompt(attempt));
      if (state.interrupt.requested) return await finishOnInterrupt(state, task);
      if (answer === null) return await retain(state, task, '输入已结束（EOF）：任务已保留，未发布。');
      const choice = parseMenu(answer);
      if (choice === 'detail') {
        showDetail(state, task, review, attempt);
        continue;
      }
      if (choice === 'confirm') {
        if (!attempt.plan) {
          err('当前候选还不能保存；请先继续修改。');
          continue;
        }
        // 只授权本次审阅展示的计划；publishConfirmedPlan 在写锁内再次核验其哈希与绑定。
        const published = await confirmPublish(state, task, attempt.plan);
        if (published) return published;
        continue;
      }
      if (choice === 'stash') {
        return await retain(state, task, '任务已暂存保留，未发布；再次运行同一命令可在入口内继续。');
      }
      if (choice === 'cancel') return await cancelAndPurge(state, task);
      if (choice === 'modify') {
        // 序号 1 只表示回到对话，不把“1”本身当成语义修改发给模型。
        const request = await terminal.ask('请输入修改要求（回车返回菜单）：');
        if (state.interrupt.requested) return await finishOnInterrupt(state, task);
        if (request === null) return await retain(state, task, '输入已结束（EOF）：任务已保留，未发布。');
        line = request.trim();
        if (!line) continue;
      } else {
        // 普通对话文字（含“好的”）参与语义修订，绝不作为发布授权。
        line = answer.trim();
        if (!line) continue;
      }
    } else {
      const answer = await terminal.ask(`spec ${task.task.revision}> `);
      if (state.interrupt.requested) return await finishOnInterrupt(state, task);
      if (answer === null) return await retain(state, task, '输入已结束（EOF）：任务已保留，未发布。');
      line = answer.trim();
      if (!line) continue;
    }

    let preview;
    try {
      preview = previewAuthoringSend(task, line, runtime.maxPromptChars);
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes(STALE_DECLARATION)) {
        err('工作区模型/指标声明已变化，本任务不能继续；请重新运行同一命令重新检查。');
        return await retain(state, task, '任务已保留，未发布。');
      }
      err(`发送前检查失败：${message}`);
      continue;
    }
    err(`发送预览：${preview.promptChars} 字符，sha256=${short(preview.promptSha256)}`);

    state.interrupt.requested = false;
    const controller = new AbortController();
    state.interrupt.controller = controller;
    let streamed = false;
    let result;
    try {
      result = await runSharedAuthoringTurn({
        taskId: task.task.id,
        expectedRevision: task.task.revision,
        userText: line,
        workspace: state.workspace,
        runtime,
        signal: controller.signal,
        onTextDelta: (delta) => {
          streamed = true;
          terminal.write(delta);
        },
      });
    } catch (error) {
      state.interrupt.controller = null;
      err(`本轮未完成：${(error as Error).message}（任务已保留，可在同一入口重试）`);
      task = refresh(state, task);
      continue;
    }
    state.interrupt.controller = null;
    if (streamed && result.text.trim()) terminal.write('\n');
    else if (result.text.trim()) out(result.text);
    task = result.task;

    if (state.interrupt.requested || result.errorMessage === ABORTED_TURN) {
      return await finishOnInterrupt(state, task);
    }
    if (result.errorMessage) {
      err(`模型调用失败：${result.errorMessage}`);
      const resumed = resumeIfNeeded(state, task);
      if (!resumed) return await retain(state, task, '任务已保留，未发布。');
      task = resumed;
      out('任务已保留，可在同一入口重试。');
      continue;
    }

    const after = inspectAuthoringTask(task);
    if (isDeclarationStale(task)) {
      err('工作区模型/指标声明已变化，本任务不能继续；请重新运行同一命令重新检查。');
      return await retain(state, task, '任务已保留，未发布。');
    }
    if (after.failedDraft) {
      err(`最近一次候选未通过：${diagnosticCodes(after.failedDraft)}（已保留上一版有效草稿）`);
    }
    if (after.draft) {
      out(`草稿 v${after.draft.version}｜诊断 ${after.draft.diagnostics.length} 项｜` +
        `未决 ${after.draft.unresolved.length} 项｜状态 ${task.task.status}`);
    } else if (!after.failedDraft) {
      out('本轮没有候选草稿；请说明主体、指标、期间、单位与布局。');
    }
  }
}

function attemptPlan(state: WorkflowState, task: AuthoringTask): PlanAttempt {
  try {
    return { plan: preparePublication(task.task.id, state.workspace), reason: null };
  } catch (error) {
    return { plan: null, reason: (error as Error).message };
  }
}

function showReview(
  state: WorkflowState,
  task: AuthoringTask,
  review: ReturnType<typeof inspectAuthoringTask>,
  attempt: PlanAttempt,
): void {
  const { out, err } = state;
  const draft = review.draft;
  out('');
  out(`任务 ${task.task.id}｜方向 ${directionLabel(task.task.direction)}｜` +
    `状态 ${task.task.status}｜修订 ${task.task.revision}`);
  if (draft) {
    out(`草稿 v${draft.version}｜诊断 ${draft.diagnostics.length} 项｜未决 ${draft.unresolved.length} 项`);
    const summary = attempt.plan?.summary ?? draft.summary;
    out(`业务摘要：${summary === null ? '（候选未生成摘要）' : JSON.stringify(summary)}`);
    if (draft.unresolved.length) out(`未决项：${draft.unresolved.join('；')}`);
    if (draft.declarationReview.length) {
      out(`声明差异：${draft.declarationReview.map(describeChange).join('；')}`);
    }
  } else {
    out('尚无候选草稿。');
  }
  if (review.failedDraft) {
    err(`最近一次候选未通过：${diagnosticCodes(review.failedDraft)}（已保留上一版有效草稿）`);
  }
  if (attempt.plan) {
    out(`正式文件（相对工作区，共 ${attempt.plan.files.length} 个）：`);
    for (const file of attempt.plan.files) out(`  ${actionLabel(file)} ${file.path}`);
  } else if (attempt.reason) {
    err(`当前候选还不能生成发布计划：${attempt.reason}`);
  }
}

function showDetail(
  state: WorkflowState,
  task: AuthoringTask,
  review: ReturnType<typeof inspectAuthoringTask>,
  attempt: PlanAttempt,
): void {
  const draft = review.draft;
  // 最终绑定内容以发布计划的文件字节为准（接入去 source、导出绑 templates/<id>.xlsx）。
  const specFile = attempt.plan?.files.find((file) =>
    file.path.startsWith('ingest/') || file.path.startsWith('specs/')) ?? null;
  state.out(JSON.stringify({
    taskId: task.task.id,
    workspace: state.workspace,
    direction: task.task.direction,
    status: task.task.status,
    revision: task.task.revision,
    attachment: {
      filename: task.attachment.template.filename,
      sha256: task.attachment.template.sha256,
      policy: task.attachment.policy,
      checkedAt: task.attachment.template.checkedAt,
    },
    draft: draft ? {
      version: draft.version,
      contentHash: draft.contentHash,
      yaml: draft.yaml,
      summary: draft.summary,
      unresolved: draft.unresolved,
      diagnostics: draft.diagnostics,
      declarationDiff: draft.declarationReview.map((change) => ({
        path: change.path,
        action: change.before === null ? 'create' : change.after === null ? 'delete' : 'replace',
        before: change.before,
        after: change.after,
      })),
    } : null,
    failedDraft: review.failedDraft ? {
      version: review.failedDraft.version,
      diagnostics: review.failedDraft.diagnostics,
      unresolved: review.failedDraft.unresolved,
    } : null,
    readyForConfirmation: review.readyForConfirmation,
    publication: task.task.publication,
    boundSpec: specFile && specFile.content !== null
      ? { path: specFile.path, yaml: Buffer.from(specFile.content, 'base64').toString('utf8') }
      : null,
    files: attempt.plan ? attempt.plan.files.map((file) => ({
      path: file.path,
      action: actionOf(file),
      beforeHash: file.beforeHash,
      afterHash: file.afterHash,
    })) : null,
    publicationBlockedBy: attempt.reason,
  }, null, 2));
}

function menuPrompt(attempt: PlanAttempt): string {
  return [
    '请选择下一步：',
    '  1 继续修改',
    '  2 查看详情（业务摘要与文件差异）',
    attempt.plan
      ? '  3 确认保存（本地确认并发布规格）'
      : `  3 确认保存（当前不可用：${truncate(attempt.reason ?? '候选未就绪', 120)}）`,
    '  4 暂存退出（保留未发布任务）',
    '  5 取消（清理未发布副本）',
    '输入序号（普通对话文字会继续交给助手，不会发布）：',
  ].join('\n');
}

function parseMenu(value: string):
  | 'modify'
  | 'detail'
  | 'confirm'
  | 'stash'
  | 'cancel'
  | null {
  const text = value.trim();
  if (/^(1|继续修改|继续|修改)$/.test(text)) return 'modify';
  if (/^(2|详情|查看详情)$/.test(text)) return 'detail';
  if (/^(3|确认保存|确认|保存|发布)$/.test(text)) return 'confirm';
  if (/^(4|暂存退出|暂存|退出)$/.test(text)) return 'stash';
  if (/^(5|取消|清理)$/.test(text)) return 'cancel';
  return null;
}

async function confirmPublish(
  state: WorkflowState,
  task: AuthoringTask,
  plan: PublicationPlan,
): Promise<SpecWorkflowResult | null> {
  const { out, err } = state;
  out(`按本次审阅展示的计划写入 ${plan.files.length} 个文件：`);
  for (const file of plan.files) out(`  ${actionLabel(file)} ${file.path}`);
  let published: AuthoringTask;
  try {
    published = await publishConfirmedPlan(plan, state.workspace);
  } catch (error) {
    err(`发布未完成：${(error as Error).message}`);
    let recovered: AuthoringTask | null;
    try {
      recovered = await recoverPublication(state.workspace);
    } catch (recoverError) {
      err(`恢复未完成的发布失败：${(recoverError as Error).message}`);
      return 'failed';
    }
    if (recovered) {
      out('已按发布记录恢复并完成本次保存。');
      printPublication(state, recovered);
      return 'completed';
    }
    out('未留下未完成的发布记录；草稿仍保留，可在同一入口重试。');
    return null;
  }
  out('规格已保存。');
  printPublication(state, published);
  return 'completed';
}

async function finishOnInterrupt(
  state: WorkflowState,
  task: AuthoringTask,
): Promise<SpecWorkflowResult> {
  const { out, terminal } = state;
  state.interrupt.requested = false;
  const seen = state.interrupt.count;
  out('已中止当前请求。请选择如何结束当前任务：');
  out('  1 保留任务（保存恢复副本，可再次运行同一命令继续，未发布）');
  out('  2 清理未发布副本（删除任务记录与附件快照，不改动原始文件）');
  const answer = await terminal.ask('输入 1/保留 保留任务，直接回车默认清理：');
  if (state.interrupt.count > seen) {
    out('再次收到中止信号：默认保留任务。');
    return await retain(state, task, '任务已保留，未发布。');
  }
  if (answer === null) return await retain(state, task, '输入已结束：任务已保留，未发布。');
  const text = answer.trim();
  if (!text) {
    out('按默认清理未发布副本。');
    return await cancelAndPurge(state, task);
  }
  if (/^(1|保留|retain|y|yes)$/i.test(text)) {
    return await retain(state, task, '任务已保留，未发布。');
  }
  if (/^(2|清理|取消|cancel|n|no)$/i.test(text)) {
    out('按选择清理未发布副本。');
    return await cancelAndPurge(state, task);
  }
  out('未识别选择，按保留处理。');
  return await retain(state, task, '任务已保留，未发布。');
}

async function retain(
  state: WorkflowState,
  task: AuthoringTask,
  note: string,
): Promise<SpecWorkflowResult> {
  state.out(note);
  try {
    if (task.task.status !== 'retained') {
      cancelAuthoringTask({
        taskId: task.task.id,
        expectedRevision: task.task.revision,
        retain: true,
        workspace: state.workspace,
      });
    }
    state.out(`任务 ${task.task.id} 已保留（未发布）；再次运行同一命令可在入口内继续。`);
    return 'retained';
  } catch (error) {
    state.err(`保留任务失败：${(error as Error).message}`);
    return 'failed';
  }
}

async function cancelAndPurge(
  state: WorkflowState,
  task: AuthoringTask,
): Promise<SpecWorkflowResult> {
  try {
    cancelAuthoringTask({
      taskId: task.task.id,
      expectedRevision: task.task.revision,
      retain: false,
      workspace: state.workspace,
    });
    state.out('已取消任务并清理未发布副本；原始文件未改动。');
    return 'cancelled';
  } catch (error) {
    state.err(`取消失败：${(error as Error).message}`);
    return 'failed';
  }
}

function refresh(state: WorkflowState, task: AuthoringTask): AuthoringTask {
  try {
    return getAuthoringTask(task.task.id, state.workspace);
  } catch {
    return task;
  }
}

function resumeIfNeeded(state: WorkflowState, task: AuthoringTask): AuthoringTask | null {
  if (task.task.status !== 'failed' && task.task.status !== 'retained') return task;
  try {
    return resumeAuthoringTask({
      taskId: task.task.id,
      expectedRevision: task.task.revision,
      workspace: state.workspace,
    });
  } catch (error) {
    state.err(`无法在同一入口继续：${(error as Error).message}`);
    return null;
  }
}

function taskRecordExists(state: WorkflowState, taskId: string): boolean {
  try {
    getAuthoringTask(taskId, state.workspace);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'TASK_NOT_FOUND') return false;
    throw error;
  }
}

function isDeclarationStale(task: AuthoringTask): boolean {
  return task.semantic.fingerprint !== task.task.declarationFingerprint;
}

function directionLabel(direction: AuthoringDirection | null): string {
  if (direction === 'ingest') return '接入规格';
  if (direction === 'export') return '导出规格';
  return '未选择';
}

function actionOf(file: PublicationFile): '新增' | '覆盖' | '删除' {
  if (file.beforeHash === null) return '新增';
  if (file.afterHash === null) return '删除';
  return '覆盖';
}

function actionLabel(file: PublicationFile): string {
  return actionOf(file).padEnd(2, ' ');
}

function describeChange(change: { path: string; before: string | null; after: string | null }): string {
  const label = change.before === null ? '新增' : change.after === null ? '删除' : '覆盖';
  return `${label} ${change.path}`;
}

function diagnosticCodes(draft: AuthoringDraft | AuthoringDraftContent): string {
  const codes = draft.diagnostics.map((entry) => entry.code).filter(Boolean);
  return codes.length ? codes.join('、') : '无诊断码';
}

function describeTask(task: AuthoringTask): string {
  const draft = task.task.direction ? task.task.drafts[task.task.direction] : null;
  const parts = [
    `状态 ${task.task.status}`,
    `方向 ${directionLabel(task.task.direction)}`,
    `修订 ${task.task.revision}`,
    `更新 ${task.task.updatedAt}`,
  ];
  if (draft) {
    parts.push(`草稿 v${draft.version}`, `未决 ${draft.unresolved.length}`);
    if (draft.summary !== null) parts.push(`摘要 ${truncate(JSON.stringify(draft.summary), 80)}`);
  }
  if (task.task.publication) parts.push(`已发布 ${task.task.publication.files.length} 个文件`);
  return parts.join('｜');
}

function printPublication(state: WorkflowState, task: AuthoringTask): void {
  const publication = task.task.publication;
  if (!publication) {
    state.out('该任务没有发布记录。');
    return;
  }
  state.out(`已发布 ${publication.files.length} 个文件（${publication.completedAt}）：`);
  for (const file of publication.files) {
    state.out(`  ${file.path}  sha256=${file.sha256.slice(0, 12)}…`);
  }
  state.out(task.task.direction === 'export'
    ? '后续本地执行：用该导出规格与空白模板在本机运行 bilite render 生成导出报表（本入口不取数）。'
    : '后续本地执行：选择接入报表后在本机运行 bilite ingest dry-run 试运行，确认后再 ingest run（本入口不读库）。');
}
