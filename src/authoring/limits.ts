/** Local resource budget in characters; independent of a provider's token window. */
export const DEFAULT_AUTHORING_MAX_PROMPT_CHARS = 1_000_000;

export function assertAuthoringContextSize(chars: number, limit = DEFAULT_AUTHORING_MAX_PROMPT_CHARS): void {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('maxPromptChars must be a positive safe integer');
  if (chars > limit) {
    throw new Error(`AUTHORING_CONTEXT_TOO_LARGE: 本地上下文预算超限（${chars}/${limit} 字符），并非供应商 token 窗口耗尽；任务已保留，可调整助手配置 maxPromptChars 后继续。`);
  }
}
