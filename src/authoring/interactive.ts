import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import type { PiRuntimeOptions } from './pi.ts';
import { inspectAuthoringTask, previewAuthoringSend } from './inspect.ts';
import { runSharedAuthoringTurn } from './session.ts';
import {
  authoringTaskView,
  cancelAuthoringTask,
  getAuthoringTask,
  type AuthoringTask,
} from './tasks.ts';

export interface InteractiveAuthoringOptions {
  taskId: string;
  expectedRevision: number;
  workspace: string;
  runtime?: PiRuntimeOptions;
  input: Readable;
  output: Writable;
  error: Writable;
  retainOnCancel?: boolean;
  /** Test/session adapters can provide the next line without a terminal. */
  ask?: () => Promise<string | null>;
}

export interface InteractiveAuthoringResult {
  task: AuthoringTask;
  reason: 'quit' | 'cancelled' | 'interrupted';
}

/**
 * Terminal plumbing shared by the step-by-step `authoring chat` loop and the
 * single-entry `bilite spec` workflow. Tests inject `ask` to drive lines
 * without a TTY; `null` always means the input ended (EOF).
 */
export interface AuthoringTerminal {
  /** One line of human-facing output (adds a newline when missing). */
  out: (text: string) => void;
  /** Diagnostics and progress, kept off the primary output where possible. */
  err: (text: string) => void;
  /** Raw write for streamed model text; never appends a newline. */
  write: (text: string) => void;
  /** Writes the prompt, then resolves one line; null means EOF. */
  ask: (prompt: string) => Promise<string | null>;
  /** Registers an interrupt handler; the returned function detaches it. */
  onInterrupt: (handler: () => void) => () => void;
  releaseInput: <T>(read: () => Promise<T>) => Promise<T>;
  close: () => void;
}

export function createAuthoringTerminal(options: {
  input: Readable;
  output: Writable;
  error: Writable;
  ask?: (prompt: string) => Promise<string | null>;
}): AuthoringTerminal {
  const out = (text: string) => void options.output.write(text.endsWith('\n') ? text : `${text}\n`);
  const err = (text: string) => void options.error.write(text.endsWith('\n') ? text : `${text}\n`);
  const write = (text: string) => void options.output.write(text);

  if (options.ask) {
    const handlers = new Set<() => void>();
    const dispatch = () => {
      for (const handler of [...handlers]) handler();
    };
    return {
      out,
      err,
      write,
      ask: (prompt: string) => options.ask!(prompt),
      onInterrupt: (handler) => {
        handlers.add(handler);
        if (handlers.size === 1) process.on('SIGINT', dispatch);
        return () => {
          handlers.delete(handler);
          if (!handlers.size) process.off('SIGINT', dispatch);
        };
      },
      releaseInput: (read) => read(),
      close: () => {},
    };
  }

  let rl: ReturnType<typeof createInterface> | null = null;
  let closed = false;
  let question: AbortController | null = null;
  const handlers = new Set<() => void>();
  const open = () => {
    const current = createInterface({ input: options.input, output: options.output });
    rl = current;
    current.on('close', () => { if (rl === current) closed = true; });
    current.on('SIGINT', () => {
      for (const handler of [...handlers]) handler();
      question?.abort();
    });
    return current;
  };
  open();
  return {
    out, err, write,
    ask: async (prompt: string) => {
      if (closed) return null;
      const current = rl ?? open();
      question = new AbortController();
      const controller = question;
      return new Promise<string | null>((resolve) => {
        let settled = false;
        const onClose = () => finish(null);
        function finish(value: string | null): void {
          if (settled) return;
          settled = true;
          current.off('close', onClose);
          if (question === controller) question = null;
          resolve(value);
        }
        current.once('close', onClose);
        current.question(prompt, { signal: controller.signal }).then(finish, () => finish(null));
      });
    },
    onInterrupt: (handler) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    // The key reader owns stdin exclusively, so the ordinary readline cannot
    // echo credentials or consume its keystrokes.
    releaseInput: async (read) => {
      const previous = rl;
      rl = null;
      previous?.close();
      try { return await read(); }
      finally { if (!closed) open(); }
    },
    close: () => { closed = true; rl?.close(); },
  };
}

/**
 * Terminal loop for one task. Each user line is one model turn; slash commands
 * inspect or end the task without asking the model to approve anything.
 */
export async function runInteractiveAuthoring(
  options: InteractiveAuthoringOptions,
): Promise<InteractiveAuthoringResult> {
  let task = getAuthoringTask(options.taskId, options.workspace);
  if (task.task.revision !== options.expectedRevision) {
    throw new Error(`TASK_REVISION_CONFLICT: 当前修订 ${task.task.revision}`);
  }
  const terminal = createAuthoringTerminal({
    input: options.input,
    output: options.output,
    error: options.error,
    ask: options.ask,
  });
  const io = { out: terminal.out, err: terminal.err };
  io.out([
    `任务 ${task.task.id}`,
    `方向 ${task.task.direction ?? '未选择'}，状态 ${task.task.status}，修订 ${task.task.revision}`,
    '输入内容继续对话；/status 查看状态；/review 查看草稿与差异；/preview 查看发送上下文；',
    '/quit 退出并保留任务；/cancel 取消并清理；/retain 取消并保留恢复副本。',
  ].join('\n'));

  let activeController: AbortController | null = null;
  let interrupted = false;
  const detach = terminal.onInterrupt(() => {
    if (activeController) {
      interrupted = true;
      activeController.abort();
      io.err('已请求中止当前模型调用。');
    } else {
      io.err('当前没有运行中的请求。使用 /cancel、/retain 或 /quit 结束会话。');
    }
  });

  try {
    for (;;) {
      const next = await terminal.ask(`authoring ${task.task.revision}> `);
      if (next === null) return { task, reason: 'quit' };
      const line = next.trim();
      if (!line) continue;
      if (line === '/quit') return { task, reason: 'quit' };
      if (line === '/status') {
        io.out(JSON.stringify(authoringTaskView(task), null, 2));
        continue;
      }
      if (line === '/review') {
        io.out(JSON.stringify(inspectAuthoringTask(task), null, 2));
        continue;
      }
      if (line === '/preview') {
        io.out(JSON.stringify(previewAuthoringSend(task, ''), null, 2));
        continue;
      }
      if (line === '/cancel' || line === '/retain') {
        const retain = line === '/retain';
        const cancelled = cancelAuthoringTask({
          taskId: task.task.id,
          expectedRevision: task.task.revision,
          retain,
          workspace: options.workspace,
        });
        io.out(JSON.stringify(authoringTaskView(cancelled), null, 2));
        return { task: cancelled, reason: 'cancelled' };
      }

      const preview = previewAuthoringSend(task, line, options.runtime?.maxPromptChars);
      io.err(`发送预览：${preview.promptChars} 字符，sha256=${preview.promptSha256}`);
      activeController = new AbortController();
      interrupted = false;
      let streamedText = false;
      const result = await runSharedAuthoringTurn({
        taskId: task.task.id,
        expectedRevision: task.task.revision,
        userText: line,
        workspace: options.workspace,
        runtime: options.runtime,
        signal: activeController.signal,
        onTextDelta: (delta) => {
          streamedText = true;
          terminal.write(delta);
        },
      });
      activeController = null;
      if (streamedText && result.text.trim()) terminal.write('\n');
      else if (result.text.trim()) io.out(result.text);
      if (result.errorMessage) io.err(`模型调用结束但有错误：${result.errorMessage}`);
      task = result.task;
      if (interrupted) {
        const cancelled = cancelAuthoringTask({
          taskId: task.task.id,
          expectedRevision: task.task.revision,
          retain: options.retainOnCancel ?? false,
          workspace: options.workspace,
        });
        io.out(JSON.stringify(authoringTaskView(cancelled), null, 2));
        return { task: cancelled, reason: 'interrupted' };
      }
      if (result.errorMessage) {
        io.err('任务已保留为失败状态；修复供应商问题后可执行 authoring resume。');
        return { task, reason: 'quit' };
      }
      const review = inspectAuthoringTask(task);
      if (review.draft) {
        io.out(`草稿 v${review.draft.version}，状态 ${task.task.status}，` +
          `诊断 ${review.draft.diagnostics.length} 项，未决 ${review.draft.unresolved.length} 项。`);
      }
    }
  } finally {
    detach();
    terminal.close();
  }
}
