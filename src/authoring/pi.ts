import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import { createModels, createProvider, envApiKeyAuth, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { AssistantMessageEventStream, TranscriptContext } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Tool } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

export type { Agent, Model };

export interface PiRuntimeOptions {
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  contextWindow?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  maxToolTurns?: number;
  maxPromptChars?: number;
  providerStreams?: ProviderStreams;
  streamOptions?: Pick<SimpleStreamOptions, 'timeoutMs' | 'maxRetries' | 'maxRetryDelayMs' | 'onResponse' | 'fetch'>;
}

export type ProviderStreams = {
  stream?: StreamFunction;
  streamSimple?: StreamFunction;
};

type StreamFunction = (
  model: Model<'openai-completions'>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface AuthoringTurnContext {
  task: { id: string; sha256: string };
}

type AssistantMessageRecord = {
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
};

export interface PiRunOptions {
  systemPrompt: string;
  userText: string;
  tools?: Tool[];
  signal?: AbortSignal;
}

export interface PiRunResult {
  text: string;
  proposals: Array<{ kind: string; note: string }>;
  toolResults: Array<{ name: string; blocked: boolean; reason?: string }>;
  stopReason: string | undefined;
  errorMessage: string | undefined;
  requestCount: number;
}

export interface AuthoringProtocolProbe {
  baseUrl: string;
  modelId: string;
  apiKeyPresent: boolean;
  maxTokens: number | undefined;
  maxCompletionTokens: number | undefined;
  tools: Array<{ type: string; function?: { name?: string } }>;
  timeoutMs: number | undefined;
  maxRetries: number | undefined;
  maxRetryDelayMs: number | undefined;
  requestCount: number;
  text: string;
  stopReason: string | undefined;
}

export interface PiRuntimeCheck {
  runtimeConfigured: boolean;
  source: 'request-api-key' | 'environment';
  providerId: string;
  modelId: string;
  baseUrl: string;
  authStatus: 'configured' | 'missing';
}

type AgentToolEndEvent = {
  toolName: string;
  isError?: boolean;
  result?: { content?: Array<{ type?: unknown; text?: unknown }> };
};

export const SUBMIT_SPEC_PROPOSAL_TOOL_NAME = 'submit_spec_proposal';

type SpecProposalDetails = { kind?: unknown; note?: unknown };

const submitSpecProposalTool: Tool = {
  name: SUBMIT_SPEC_PROPOSAL_TOOL_NAME,
  label: '提交规格修改提案',
  description: 'Submit a structured authoring proposal. It does not import data or register a report.',
  parameters: Type.Object({
    kind: Type.String({ description: 'Proposal kind, e.g. ingest or report.' }),
    note: Type.String({ description: 'Short human-readable proposal note.' }),
  }),
  execute: async (_toolCallId, params) => ({
    content: [{ type: 'text', text: `已记录提案草稿：${params.kind}` }],
    details: { ...params },
  }),
};

const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com/v1',
  modelId: 'deepseek-chat',
  contextWindow: 128_000,
  maxTokens: 8_192,
  timeoutMs: 120_000,
  maxRetries: 1,
  maxRetryDelayMs: 5_000,
  maxToolTurns: 6,
  maxPromptChars: 24_000,
};

/**
 * Minimal conversational runtime for authoring. It intentionally registers no
 * global providers, configuration files, skills, extensions, MCP servers, or
 * built-in coding tools.
 */
export function createAuthoringModels(options: PiRuntimeOptions = {}) {
  const model: Model<'openai-completions'> = {
    id: options.modelId ?? DEFAULTS.modelId,
    name: options.modelId ?? DEFAULTS.modelId,
    api: 'openai-completions',
    provider: 'bi-lite-authoring',
    baseUrl: options.baseUrl ?? DEFAULTS.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: options.contextWindow ?? DEFAULTS.contextWindow,
    maxTokens: options.maxTokens ?? DEFAULTS.maxTokens,
  };
  const provider = createProvider({
    id: model.provider,
    name: 'bi-lite authoring provider',
    baseUrl: model.baseUrl,
    auth: options.apiKey
      ? {
          apiKey: {
            name: 'bi-lite authoring provider',
            resolve: async () => ({ auth: { apiKey: options.apiKey } }),
          },
        }
      : envApiKeyAuth('bi-lite authoring provider', ['BILITE_AUTHORING_API_KEY']),
    models: [model],
    api: options.providerStreams ?? openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  const selected = models.getModel(model.provider, model.id);
  if (!selected) throw new Error('pi authoring model is unavailable');
  return { models, model: selected };
}

export async function runAuthoringTurn(
  options: PiRunOptions,
  runtime: PiRuntimeOptions = {},
  context?: AuthoringTurnContext,
): Promise<PiRunResult> {
  if (!options.userText.trim()) throw new Error('user text is required');
  const maxTokens = runtime.maxTokens ?? DEFAULTS.maxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('maxTokens must be a positive integer');
  const timeoutMs = runtime.timeoutMs ?? DEFAULTS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeoutMs must be a positive integer');
  const maxRetries = runtime.maxRetries ?? DEFAULTS.maxRetries;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error('maxRetries must be a non-negative integer');
  const maxRetryDelayMs = runtime.maxRetryDelayMs ?? DEFAULTS.maxRetryDelayMs;
  if (!Number.isInteger(maxRetryDelayMs) || maxRetryDelayMs < 0) {
    throw new Error('maxRetryDelayMs must be a non-negative integer');
  }
  if (runtime.contextWindow !== undefined && (!Number.isInteger(runtime.contextWindow) || runtime.contextWindow < 1)) {
    throw new Error('contextWindow must be a positive integer');
  }
  const maxToolTurns = runtime.maxToolTurns ?? DEFAULTS.maxToolTurns;
  if (!Number.isInteger(maxToolTurns) || maxToolTurns < 1) throw new Error('maxToolTurns must be a positive integer');
  const maxPromptChars = runtime.maxPromptChars ?? DEFAULTS.maxPromptChars;
  if (!Number.isInteger(maxPromptChars) || maxPromptChars < 1) throw new Error('maxPromptChars must be a positive integer');
  if (options.systemPrompt.length + options.userText.length > maxPromptChars) {
    throw new Error('AUTHORING_CONTEXT_TOO_LARGE');
  }
  if (options.signal?.aborted) {
    return {
      text: '',
      proposals: [],
      toolResults: [],
      stopReason: 'aborted',
      errorMessage: 'AUTHORING_TURN_ABORTED',
      requestCount: 0,
    };
  }
  const { models, model } = createAuthoringModels(runtime);
  const streamOptions: SimpleStreamOptions = {
    timeoutMs,
    maxRetries,
    maxRetryDelayMs,
    ...runtime.streamOptions,
  };
  const baseTools = options.tools ?? [submitSpecProposalTool];
  const tools = context ? baseTools.map((tool) => tool.name === SUBMIT_SPEC_PROPOSAL_TOOL_NAME ? ({
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await submitSpecProposalTool.execute(toolCallId, params, signal, onUpdate);
      return { ...result, details: { ...result.details, task: context.task } };
    },
  }) : tool) : baseTools;
  const state = {
    model,
    thinkingLevel: 'off' as const,
    messages: [],
    tools,
    systemPrompt: options.systemPrompt,
  };
  let requestCount = 0;
  let finalAssistant: AssistantMessageRecord | undefined;
  const proposals: Array<{ kind: string; note: string }> = [];
  const toolResults: Array<{ name: string; blocked: boolean; reason?: string }> = [];
  const agent = new Agent({
    initialState: state,
    streamFn: ((requestModel, context, options) => models.streamSimple(requestModel, context, {
      ...options,
      fetch: streamOptions.fetch ?? options?.fetch,
      timeoutMs: streamOptions.timeoutMs ?? options?.timeoutMs,
      maxRetries: streamOptions.maxRetries ?? options?.maxRetries,
      maxRetryDelayMs: streamOptions.maxRetryDelayMs ?? options?.maxRetryDelayMs,
      onResponse: streamOptions.onResponse ?? options?.onResponse,
    })) satisfies StreamFn,
    getApiKey: () => runtime.apiKey,
    transformContext: async (messages, signal) => {
      options.signal?.throwIfAborted();
      signal?.throwIfAborted();
      if (JSON.stringify(messages).length > (runtime.maxPromptChars ?? DEFAULTS.maxPromptChars) * 2) {
        throw new Error('AUTHORING_CONTEXT_TOO_LARGE');
      }
      return messages;
    },
    toolExecution: 'sequential',
    sessionId: `authoring-${Date.now().toString(36)}`,
    beforeToolCall: async ({ toolCall }) => toolCall.name === SUBMIT_SPEC_PROPOSAL_TOOL_NAME
      ? undefined
      : { block: true, reason: 'only submit_spec_proposal is allowed', terminate: true },
    afterToolCall: async ({ toolCall, result }) => {
      if (toolCall.name !== SUBMIT_SPEC_PROPOSAL_TOOL_NAME || !(result.details as SpecProposalDetails)) return undefined;
      const details = result.details as SpecProposalDetails;
      if (typeof details.kind !== 'string' || typeof details.note !== 'string') return undefined;
      proposals.push({ kind: details.kind, note: details.note });
      return undefined;
    },
  });
  agent.finishTurn = async ({ message }) => {
    requestCount += 1;
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return { action: 'end' };
    if (options.signal?.aborted || requestCount >= maxToolTurns) return { action: 'end' };
    return undefined;
  };
  agent.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      finalAssistant = event.message as AssistantMessageRecord;
    } else if (event.type === 'tool_execution_end') {
      const toolEvent = event as unknown as AgentToolEndEvent;
      toolResults.push({
        name: toolEvent.toolName,
        blocked: Boolean(toolEvent.isError),
        reason: typeof toolEvent.result?.content?.[0]?.text === 'string' ? toolEvent.result.content[0].text : undefined,
      });
    }
  });
  const abortRun = () => agent.abort();
  options.signal?.addEventListener('abort', abortRun, { once: true });
  try {
    const prompt = agent.prompt(options.userText);
    if (options.signal?.aborted) agent.abort();
    await prompt;
    await agent.waitForIdle();
  } finally {
    options.signal?.removeEventListener('abort', abortRun);
  }
  const content = Array.isArray(finalAssistant?.content) ? finalAssistant!.content : [];
  const text = content
    .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return {
    text,
    proposals,
    toolResults,
    stopReason: typeof finalAssistant?.stopReason === 'string' ? finalAssistant.stopReason : undefined,
    errorMessage: typeof finalAssistant?.errorMessage === 'string' ? finalAssistant.errorMessage : undefined,
    requestCount,
  };
}

export async function checkAuthoringRuntime(runtime: PiRuntimeOptions = {}): Promise<PiRuntimeCheck> {
  const { models, model } = createAuthoringModels(runtime);
  const auth = await models.getAuth(model).catch(() => undefined);
  return {
    runtimeConfigured: Boolean(auth),
    source: runtime.apiKey ? 'request-api-key' : 'environment',
    providerId: model.provider,
    modelId: model.id,
    baseUrl: model.baseUrl,
    authStatus: auth ? 'configured' : 'missing',
  };
}

/** Offline protocol check: run the official adapter against a controlled fetch. */
export async function probeAuthoringProtocol(
  runtime: PiRuntimeOptions = {},
): Promise<AuthoringProtocolProbe> {
  let requestCount = 0;
  let payload: Record<string, unknown> | undefined;
  let observedOptions: SimpleStreamOptions | undefined;
  const fetchFn: typeof globalThis.fetch = async (_url, init) => {
    requestCount += 1;
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const chunk = {
      id: 'chatcmpl-probe',
      object: 'chat.completion.chunk',
      created: 1,
      model: runtime.modelId ?? DEFAULTS.modelId,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: '官方适配器联测通过' },
        finish_reason: 'stop',
      }],
    };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const official = openAICompletionsApi();
  const providerStreams: ProviderStreams = {
    stream: official.stream,
    streamSimple: (requestModel, context, options) => {
      observedOptions = options;
      return official.streamSimple(requestModel, context, options);
    },
  };
  const result = await runAuthoringTurn({
    systemPrompt: '只讨论空白模板结构。',
    userText: '请确认当前请求只包含受控结构。',
  }, {
    ...runtime,
    apiKey: runtime.apiKey ?? 'offline-probe-key',
    providerStreams,
    maxTokens: runtime.maxTokens ?? 321,
    streamOptions: { ...runtime.streamOptions, fetch: fetchFn },
  }, { task: { id: 'protocol-probe', sha256: 'offline-probe' } });
  const tools = Array.isArray(payload?.tools) ? payload.tools as AuthoringProtocolProbe['tools'] : [];
  return {
    baseUrl: runtime.baseUrl ?? DEFAULTS.baseUrl,
    modelId: runtime.modelId ?? DEFAULTS.modelId,
    apiKeyPresent: Boolean(observedOptions?.apiKey),
    maxTokens: payload?.max_tokens as number | undefined,
    maxCompletionTokens: payload?.max_completion_tokens as number | undefined,
    tools,
    timeoutMs: observedOptions?.timeoutMs,
    maxRetries: observedOptions?.maxRetries,
    maxRetryDelayMs: observedOptions?.maxRetryDelayMs,
    requestCount,
    text: result.text,
    stopReason: result.stopReason,
  };
}
