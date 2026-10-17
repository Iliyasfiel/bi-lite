import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PiRuntimeOptions } from './pi.ts';

export const AUTHORING_CONFIG_VERSION = 1;
export const DEFAULT_AUTHORING_API_KEY_ENV = 'BILITE_AUTHORING_API_KEY';
const MAX_CONFIG_BYTES = 16 * 1024;
const CONFIG_KEYS = new Set(['version', 'api', 'baseUrl', 'modelId', 'apiKeyEnv']);

export interface AuthoringConfig {
  version: typeof AUTHORING_CONFIG_VERSION;
  api: 'openai-completions';
  baseUrl: string;
  modelId: string;
  apiKeyEnv: string;
}

export class AuthoringConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function defaultAuthoringConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  if (env.BILITE_AUTHORING_CONFIG) return path.resolve(env.BILITE_AUTHORING_CONFIG);
  if (platform === 'win32') {
    return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'bilite', 'authoring.json');
  }
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'bilite', 'authoring.json');
}

export function loadAuthoringConfig(options: {
  file?: string;
  env?: NodeJS.ProcessEnv;
} = {}): AuthoringConfig {
  const env = options.env ?? process.env;
  const file = options.file ?? defaultAuthoringConfigPath(env);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AuthoringConfigError('AUTHORING_CONFIG_MISSING', `助手配置不存在: ${file}`);
    }
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', `无法读取助手配置: ${file}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', '助手配置必须是普通文件，不能是链接或目录');
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', '助手配置超过 16KB 上限');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', '助手配置不是有效 JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', '助手配置必须是 JSON 对象');
  }
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length) {
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', `助手配置包含不支持的字段: ${unknown.join(', ')}`);
  }
  if (record.version !== AUTHORING_CONFIG_VERSION) {
    throw new AuthoringConfigError('AUTHORING_CONFIG_UNSUPPORTED', '助手配置版本不受支持');
  }
  if (record.api !== 'openai-completions') {
    throw new AuthoringConfigError('AUTHORING_CONFIG_UNSUPPORTED', '当前只支持 openai-completions 协议');
  }
  if (typeof record.modelId !== 'string' || !record.modelId.trim() || record.modelId.length > 200) {
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', 'modelId 必须是非空文本');
  }
  if (typeof record.baseUrl !== 'string') {
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', 'baseUrl 必须是 URL');
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(record.baseUrl);
  } catch {
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', 'baseUrl 必须是有效 URL');
  }
  const loopback = baseUrl.hostname === '127.0.0.1' || baseUrl.hostname === 'localhost' || baseUrl.hostname === '::1';
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && loopback)) {
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', 'baseUrl 必须使用 HTTPS；本机回环端点可使用 HTTP');
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', 'baseUrl 不能包含凭据、查询参数或片段');
  }
  const apiKeyEnv = record.apiKeyEnv ?? DEFAULT_AUTHORING_API_KEY_ENV;
  if (typeof apiKeyEnv !== 'string' || !/^BILITE_AUTHORING_[A-Z0-9_]+$/.test(apiKeyEnv)) {
    throw new AuthoringConfigError('AUTHORING_CONFIG_INVALID', 'apiKeyEnv 必须使用 BILITE_AUTHORING_ 前缀');
  }
  return {
    version: AUTHORING_CONFIG_VERSION,
    api: 'openai-completions',
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    modelId: record.modelId.trim(),
    apiKeyEnv,
  };
}

export function runtimeFromAuthoringConfig(
  config: AuthoringConfig,
  env: NodeJS.ProcessEnv = process.env,
): PiRuntimeOptions {
  const apiKey = env[config.apiKeyEnv];
  if (!apiKey) {
    throw new AuthoringConfigError('AUTHORING_API_KEY_MISSING', `缺少环境变量 ${config.apiKeyEnv}`);
  }
  return {
    apiKey,
    baseUrl: config.baseUrl,
    modelId: config.modelId,
  };
}
