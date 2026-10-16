import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const name = 'bi-lite-ingest';
const marker = '.bilite-skill.json';
const templateFiles = ['SKILL.md', 'AGENT-PROMPT.md'];

/** Copies are independent of npm's installation path and never change MCP settings. */
export function installSkill(options: { scope: 'project' | 'user'; force: boolean }) {
  const base = options.scope === 'project' ? process.cwd() : path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  const parent = path.join(base, options.scope === 'project' ? '.agents/skills' : 'skills');
  const target = path.join(parent, name);
  const source = path.join(packageRoot, fs.existsSync(path.join(packageRoot, 'src/cli.ts')) ? 'skills' : 'dist/skills', name);
  const { version } = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const files = Object.fromEntries(templateFiles.map((file) => [file, fs.readFileSync(path.join(source, file))]));
  const hashes = Object.fromEntries(Object.entries(files).map(([file, data]) => [file, createHash('sha256').update(data).digest('hex')]));

  // Refuse links in the destination chain so --force cannot modify another checkout.
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (fs.existsSync(dir) || isLink(dir)) {
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`skill 目标包含链接，请先选择普通目录：${dir}`);
    }
    if (dir === path.parse(dir).root) break;
  }
  let previousVersion = '未记录';
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new Error(`skill 目标不是目录：${target}`);
    try { previousVersion = JSON.parse(fs.readFileSync(path.join(target, marker), 'utf8')).engineVersion ?? previousVersion; } catch {}
    if (!options.force) throw new Error(`skill 已存在：${target}（已有版本 ${previousVersion}，模板版本 ${version}）。未修改文件；确认覆盖模板文件请加 --force。`);
  }

  fs.mkdirSync(parent, { recursive: true });
  const lock = path.join(parent, '.bilite-skill-install.lock');
  const fd = fs.openSync(lock, 'wx');
  const suffix = randomUUID();
  const stage = path.join(parent, `.bilite-skill-stage-${suffix}`);
  const backup = path.join(parent, `.bilite-skill-backup-${suffix}`);
  let moved = false;
  try {
    // Recheck under the lock; another installer may have completed meanwhile.
    if (fs.existsSync(target) && !options.force) throw new Error(`skill 已存在，未覆盖：${target}`);
    if (fs.existsSync(target)) {
      rejectLinks(target);
      fs.cpSync(target, stage, { recursive: true });
    } else fs.mkdirSync(stage);
    for (const [file, data] of Object.entries(files)) fs.writeFileSync(path.join(stage, file), data);
    fs.writeFileSync(path.join(stage, marker), JSON.stringify({
      schemaVersion: 1, name, engineVersion: version, files: hashes,
    }, null, 2) + '\n');
    if (fs.existsSync(target)) { fs.renameSync(target, backup); moved = true; }
    try { fs.renameSync(stage, target); }
    catch (error) { if (moved) { fs.renameSync(backup, target); moved = false; } throw error; }
    if (moved) fs.rmSync(backup, { recursive: true });
    return { ok: true, scope: options.scope, path: target, engineVersion: version, previousVersion,
      note: '已安装独立副本；更新需显式重装，不修改 MCP 或全局设置。' };
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function isLink(file: string): boolean {
  try { return fs.lstatSync(file).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function rejectLinks(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`已有 skill 包含链接，未覆盖：${path.join(dir, entry.name)}`);
    if (entry.isDirectory()) rejectLinks(path.join(dir, entry.name));
  }
}
