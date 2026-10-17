import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { acquireWorkspaceLock } from '../src/runtime/service.ts';

const ENGINE_ROOT = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const BUSINESS = ['models', 'metrics', 'ingest', 'specs', 'templates', 'drafts', 'data', 'output'];
const INTERNAL = ['authoring', 'cache', 'logs'];
const RUNTIME = ['db.lock', 'lock.guard', 'service.json'];

export interface ResetPlan {
  workspace: string;
  confirm: string;
  removed: string[];
  retained: string[];
  fingerprint: string;
}

function stat(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function identityOf(input: string) {
  const raw = path.resolve(input);
  if (stat(raw)?.isSymbolicLink()) throw new Error('工作区不能是符号链接');
  const workspace = fs.realpathSync(raw);
  if ([path.parse(workspace).root, fs.realpathSync(os.homedir()), ENGINE_ROOT].includes(workspace)) {
    throw new Error('拒绝清理系统、用户或引擎源码目录');
  }
  if (['.git', 'package.json', 'node_modules'].some((name) => stat(path.join(workspace, name)))) {
    throw new Error('reset 只允许独立业务工作区');
  }
  const file = path.join(workspace, 'bilite.config.json');
  if (!stat(file)?.isFile() || stat(file)?.isSymbolicLink()) throw new Error('工作区标识不存在或为链接');
  const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (identity.workspace !== true || identity.version !== 1) throw new Error('工作区标识无效');
  return { workspace, file, identity };
}

export function enableDevelopmentWorkspace(input: string) {
  const { workspace, file, identity } = identityOf(input);
  fs.writeFileSync(file, JSON.stringify({ ...identity, development: true }, null, 2) + '\n');
  return { workspace, development: true };
}

/** Validate every deletion target before modifying any business file. */
export function planReset(input: string): ResetPlan {
  const { workspace, identity } = identityOf(input);
  if (identity.development !== true) throw new Error('请先用 bilite dev enable 明确标记测试工作区');
  const unknown = fs.readdirSync(workspace).filter((name) => ![...BUSINESS, '.bilite', 'bilite.config.json'].includes(name));
  if (unknown.length) throw new Error(`工作区含未知文件，未清理：${unknown.join('、')}`);
  const runtimeDir = path.join(workspace, '.bilite');
  const runtimeStat = stat(runtimeDir);
  if (runtimeStat && (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink())) throw new Error('.bilite 必须是普通目录');
  if (runtimeStat) {
    const unknownRuntime = fs.readdirSync(runtimeDir).filter((name) => ![...INTERNAL, ...RUNTIME].includes(name));
    if (unknownRuntime.length) throw new Error(`.bilite 含未知文件，未清理：${unknownRuntime.join('、')}`);
  }
  const db = path.resolve(workspace, process.env.BILITE_DB ?? 'data/bi.duckdb');
  if (!db.startsWith(path.join(workspace, 'data') + path.sep)) throw new Error('数据库必须位于本工作区 data/ 内');
  const manifest: unknown[] = [identity];
  let visited = 0;
  function inspect(file: string) {
    const entry = stat(file);
    if (!entry) return;
    if (++visited > 100000) throw new Error('清理范围过大，请先人工检查');
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error('清理范围含链接或特殊文件，未清理');
    manifest.push([path.relative(workspace, file), entry.size, entry.mtimeMs, entry.ino]);
    if (entry.isDirectory()) for (const name of fs.readdirSync(file).sort()) inspect(path.join(file, name));
  }
  const removed = [...BUSINESS, ...INTERNAL.map((name) => `.bilite/${name}`)].filter((name) => stat(path.join(workspace, name)));
  for (const name of removed) {
    if (!stat(path.join(workspace, name))?.isDirectory()) throw new Error(`受管路径不是目录：${name}`);
    inspect(path.join(workspace, name));
  }
  return { workspace, confirm: path.basename(workspace), removed, retained: ['bilite.config.json', '运行时所有者状态', '工作区外的供应商配置'],
    fingerprint: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') };
}

export async function resetDevelopmentWorkspace(input: string, confirm: string) {
  const plan = planReset(input);
  if (confirm !== plan.confirm) throw new Error('确认值必须等于目标工作区名，未清理');
  const lock = await acquireWorkspaceLock(plan.workspace, 150);
  try {
    const current = planReset(input);
    if (current.fingerprint !== plan.fingerprint) throw new Error('清理范围已变化，请重新预览');
    for (const name of current.removed) fs.rmSync(path.join(current.workspace, name), { recursive: true });
    for (const name of BUSINESS) fs.mkdirSync(path.join(current.workspace, name), { recursive: true });
    return { ...current, reinitialized: BUSINESS };
  } finally { lock.release(); }
}

export async function runDevelopmentCommand(argv: string[], workspace: string): Promise<number> {
  if (argv.length === 1 || argv.includes('--help')) {
    console.log('源码开发命令：dev enable | dev reset [--confirm 工作区名]\n不带 --confirm 时只预览；请先停止该工作区的 Web 服务。');
    return 0;
  }
  if (argv[1] === 'enable' && argv.length === 2) {
    console.log(JSON.stringify(enableDevelopmentWorkspace(workspace), null, 2));
    return 0;
  }
  if (argv[1] !== 'reset' || !(argv.length === 2 || (argv.length === 4 && argv[2] === '--confirm'))) {
    throw new Error('用法：dev reset [--confirm 工作区名]');
  }
  const plan = planReset(workspace);
  if (argv.length === 2) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  console.error(JSON.stringify(plan, null, 2));
  console.log(JSON.stringify(await resetDevelopmentWorkspace(workspace, argv[3]), null, 2));
  return 0;
}
