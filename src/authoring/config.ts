import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PiRuntimeOptions } from './pi.ts';

export const AUTHORING_CONFIG_VERSION = 1;
export const AUTHORING_AUTH_VERSION = 1;
export const AUTHORING_PROVIDER_ID = 'bi-lite-authoring';
export const DEFAULT_AUTHORING_API_KEY_ENV = 'BILITE_AUTHORING_API_KEY';
export const DEFAULT_AUTHORING_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_AUTHORING_MODEL_ID = 'deepseek-flash';
const MAX_CONFIG_BYTES = 16 * 1024;
const MAX_AUTH_BYTES = 16 * 1024;
const MAX_API_KEY_LENGTH = 8 * 1024;
const CONFIG_KEYS = new Set(['version', 'api', 'baseUrl', 'modelId', 'apiKeyEnv']);
const AUTH_KEYS = new Set(['version', 'provider', 'credential']);
const CREDENTIAL_KEYS = new Set(['type', 'key']);

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

export class AuthoringAuthError extends Error {
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

export function defaultAuthoringAuthPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  if (env.BILITE_AUTHORING_AUTH) return path.resolve(env.BILITE_AUTHORING_AUTH);
  return path.join(
    path.dirname(defaultAuthoringConfigPath(env, platform, home)),
    'authoring-auth.json',
  );
}

export function defaultAuthoringConfig(overrides: {
  modelId?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
} = {}): AuthoringConfig {
  return validateAuthoringConfig({
    version: AUTHORING_CONFIG_VERSION,
    api: 'openai-completions',
    baseUrl: overrides.baseUrl ?? DEFAULT_AUTHORING_BASE_URL,
    modelId: overrides.modelId ?? DEFAULT_AUTHORING_MODEL_ID,
    apiKeyEnv: overrides.apiKeyEnv ?? DEFAULT_AUTHORING_API_KEY_ENV,
  });
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
  return validateAuthoringConfig(raw);
}

function validateAuthoringConfig(raw: unknown): AuthoringConfig {
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

export function writeAuthoringConfig(
  config: AuthoringConfig,
  options: { file?: string } = {},
): string {
  const file = options.file ?? defaultAuthoringConfigPath();
  const validated = validateAuthoringConfig(config);
  writePrivateJson(file, {
    version: validated.version,
    api: validated.api,
    baseUrl: validated.baseUrl,
    modelId: validated.modelId,
    apiKeyEnv: validated.apiKeyEnv,
  });
  return file;
}

export interface AuthoringApiKey {
  key: string;
  source: 'environment' | 'credential-file';
  env?: string;
  file?: string;
}

export function resolveAuthoringApiKey(
  config: AuthoringConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    authFile?: string;
  } = {},
): AuthoringApiKey {
  const env = options.env ?? process.env;
  const fromEnv = env[config.apiKeyEnv];
  if (fromEnv) {
    return { key: fromEnv, source: 'environment', env: config.apiKeyEnv };
  }
  const file = options.authFile ?? defaultAuthoringAuthPath(env);
  const key = readAuthoringCredential(file);
  if (!key) {
    throw new AuthoringAuthError(
      'AUTHORING_API_KEY_MISSING',
      `缺少环境变量 ${config.apiKeyEnv}，也没有已保存的 API key；先运行 bilite authoring setup`,
    );
  }
  return { key, source: 'credential-file', file };
}

export function writeAuthoringCredential(
  key: string,
  options: { file?: string } = {},
): string {
  const file = options.file ?? defaultAuthoringAuthPath();
  const value = normalizeApiKey(key);
  writePrivateJson(file, {
    version: AUTHORING_AUTH_VERSION,
    provider: AUTHORING_PROVIDER_ID,
    credential: { type: 'api_key', key: value },
  });
  return file;
}

function readAuthoringCredential(file: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new AuthoringAuthError('AUTHORING_AUTH_INVALID', `无法读取助手凭据: ${file}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AuthoringAuthError('AUTHORING_AUTH_INVALID', '助手凭据必须是普通文件，不能是链接或目录');
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new AuthoringAuthError(
      'AUTHORING_AUTH_INSECURE',
      `助手凭据权限过宽，请执行 chmod 600 ${file}`,
    );
  }
  if (stat.size > MAX_AUTH_BYTES) {
    throw new AuthoringAuthError('AUTHORING_AUTH_INVALID', '助手凭据超过 16KB 上限');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new AuthoringAuthError('AUTHORING_AUTH_INVALID', '助手凭据不是有效 JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthoringAuthError('AUTHORING_AUTH_INVALID', '助手凭据必须是 JSON 对象');
  }
  const record = raw as Record<string, unknown>;
  const unknown = Object.keys(record).filter((entry) => !AUTH_KEYS.has(entry));
  if (unknown.length) {
    throw new AuthoringAuthError('AUTHORING_AUTH_INVALID', `助手凭据包含不支持的字段: ${unknown.join(', ')}`);
  }
  if (record.version !== AUTHORING_AUTH_VERSION || record.provider !== AUTHORING_PROVIDER_ID) {
    throw new AuthoringAuthError('AUTHORING_AUTH_UNSUPPORTED', '助手凭据版本或供应商标识不受支持');
  }
  if (!record.credential || typeof record.credential !== 'object' || Array.isArray(record.credential)) {
    throw new AuthoringAuthError('AUTHORING_AUTH_INVALID', '助手凭据缺少 credential');
  }
  const credential = record.credential as Record<string, unknown>;
  const credentialUnknown = Object.keys(credential).filter((entry) => !CREDENTIAL_KEYS.has(entry));
  if (credentialUnknown.length) {
    throw new AuthoringAuthError(
      'AUTHORING_AUTH_INVALID',
      `助手凭据包含不支持的 credential 字段: ${credentialUnknown.join(', ')}`,
    );
  }
  if (credential.type !== 'api_key') {
    throw new AuthoringAuthError('AUTHORING_AUTH_UNSUPPORTED', '当前只支持 api_key 凭据');
  }
  return normalizeApiKey(credential.key);
}

function normalizeApiKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthoringAuthError('AUTHORING_AUTH_INVALID', 'API key 必须是非空文本');
  }
  const key = value.trim();
  if (!key || key.length > MAX_API_KEY_LENGTH || /[\x00-\x1f\x7f]/.test(key)) {
    throw new AuthoringAuthError('AUTHORING_AUTH_INVALID', 'API key 必须是非空文本且不超过 8KB');
  }
  return key;
}

function writePrivateJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${file} 必须是普通文件，不能是链接或目录`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

export function runtimeFromAuthoringConfig(
  config: AuthoringConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: { authFile?: string } = {},
): PiRuntimeOptions {
  const resolved = resolveAuthoringApiKey(config, { env, authFile: options.authFile });
  return {
    apiKey: resolved.key,
    baseUrl: config.baseUrl,
    modelId: config.modelId,
  };
}
