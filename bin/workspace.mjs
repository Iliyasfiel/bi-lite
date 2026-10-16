import fs from 'node:fs';
import path from 'node:path';

export function locateWorkspace(explicit, cwd = process.cwd()) {
  if (explicit !== undefined) {
    const target = path.resolve(cwd, explicit);
    validateWorkspace(target);
    return fs.realpathSync(target);
  }
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'bilite.config.json'))) {
      validateWorkspace(dir);
      return fs.realpathSync(dir);
    }
    if (path.dirname(dir) === dir) break;
  }
  validateWorkspace(cwd);
  return fs.realpathSync(cwd);
}

function validateWorkspace(dir) {
  const config = path.join(dir, 'bilite.config.json');
  if (fs.existsSync(config)) {
    const value = JSON.parse(fs.readFileSync(config, 'utf8'));
    if (value.workspace !== true || value.version !== 1) throw new Error(`Invalid workspace config: ${config}`);
  } else if (!fs.existsSync(path.join(dir, 'models'))) {
    throw new Error('当前目录不是 bi-lite 工作区。请运行 bilite init 或指定 --workspace <目录>。');
  }
}

export function initializeWorkspace(args, base, root) {
  let targetArg;
  let preset;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === '--preset' || token.startsWith('--preset=')) {
      if (preset !== undefined) throw new Error('--preset 不能重复');
      preset = token === '--preset' ? args[++i] : token.slice('--preset='.length);
      if (preset !== 'finance') throw new Error('--preset 需要 finance');
    } else if (token.startsWith('-') || targetArg !== undefined) {
      throw new Error('用法：bilite init [目录] [--preset finance]');
    } else targetArg = token;
  }
  const target = path.resolve(base ?? '.', targetArg ?? '.');
  const identity = path.join(target, 'bilite.config.json');
  const existing = fs.existsSync(identity);
  if (existing) {
    validateWorkspace(target);
    if (!preset) throw new Error(`工作区已初始化，未修改任何文件：${target}`);
  } else if (fs.existsSync(path.join(target, 'models'))) {
    throw new Error(`目标已有 models，未修改任何文件：${target}`);
  }
  if (existing && preset) {
    const models = path.join(target, 'models');
    if (fs.existsSync(models) && fs.readdirSync(models).length > 0) throw new Error(`已有模型，未修改任何文件：${models}`);
  }
  const dirs = ['models', 'metrics', 'ingest', 'specs', 'templates', 'data', 'output'];
  for (const name of dirs) {
    const file = path.join(target, name);
    if (fs.existsSync(file) && !fs.statSync(file).isDirectory()) throw new Error(`目录位置已有文件：${file}`);
  }
  const presetDir = path.join(root, 'assets/presets/finance/models');
  let files = [];
  if (preset) {
    files = fs.readdirSync(presetDir).filter((name) => /\.ya?ml$/.test(name));
    // Check every destination before copying any files.
    const models = path.join(target, 'models');
    if (fs.existsSync(models) && fs.readdirSync(models).length) throw new Error(`已有模型，未覆盖：${models}`);
  }
  fs.mkdirSync(target, { recursive: true });
  for (const name of dirs) fs.mkdirSync(path.join(target, name), { recursive: true });
  for (const name of files) fs.copyFileSync(path.join(presetDir, name), path.join(target, 'models', name), fs.constants.COPYFILE_EXCL);
  if (!existing) fs.writeFileSync(identity, JSON.stringify({ workspace: true, version: 1 }, null, 2) + '\n', { flag: 'wx' });
  return { ok: true, workspace: target, preset: preset ?? null, note: '未导入数据；指标由工作区自行声明。' };
}
