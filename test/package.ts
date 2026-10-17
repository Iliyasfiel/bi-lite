/** Actual tarball installation and one isolated CLI/Web/skill workflow. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { openBrowser } from '../src/runtime/web.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bi-lite-test-')));
const env = { ...process.env };
delete env.BILITE_WORKSPACE;
delete env.BILITE_DB;
for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run with npm run package:check');
const workspace = path.join(temporary, '业务 工作区');
const caller = path.join(temporary, 'caller');
fs.mkdirSync(caller);
let child: ReturnType<typeof spawn> | undefined;
let childExit: Promise<number | null>;
let logs = '';

function command(args: string[], cwd = caller, extraEnv = {}, expected = 0, input?: string) {
  const result = spawnSync(process.execPath, args, {
    cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 60000, input,
    maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, result.stderr || result.stdout);
  return result.stdout;
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function start(entry: string, port: number) {
  logs = '';
  // Exercise the real CLI's signal handler without relying on Windows kill(),
  // which terminates a process immediately rather than delivering SIGINT.
  const hook = 'process.on("message",m=>{if(m==="interrupt"){process.disconnect();process.emit("SIGINT")}})';
  child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(hook),
    entry, '--workspace', workspace, 'web', '--port', String(port), '--no-open'], {
    cwd: caller, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout?.on('data', (data) => { logs += data; });
  child.stderr?.on('data', (data) => { logs += data; });
  childExit = new Promise((resolve, reject) => { child!.once('error', reject); child!.once('exit', resolve); });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(logs || 'Web exited before readiness');
    try {
      const state = JSON.parse(fs.readFileSync(path.join(workspace, '.bilite/service.json'), 'utf8'));
      if (state.pid === child.pid) return;
    } catch {}
    await delay(75);
  }
  throw new Error('Web readiness timeout: ' + logs);
}

async function stop(graceful: boolean) {
  if (!child || child.exitCode !== null) return;
  if (graceful) child.send!('interrupt');
  else child.kill('SIGKILL');
  const timer = setTimeout(() => child?.kill('SIGKILL'), 10000);
  try { const code = await childExit; if (graceful) assert.equal(code, 0, logs); }
  finally { clearTimeout(timer); }
  child = undefined;
}

try {
  const packed = JSON.parse(command([npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root));
  const pack = Array.isArray(packed) ? packed[0] : Object.values(packed)[0] as { filename: string; files: { path: string }[] };
  const paths = pack.files.map((file: { path: string }) => file.path);
  assert.ok(!paths.some((file: string) => /(?:^|\/)(?:dev|development)(?:\/|\.)|\.test\.js$/.test(file)));
  assert.ok(paths.includes('dist/server.js') && paths.includes('dist/skill/install.js'));
  assert.ok(!paths.some((file: string) => /^(data|output|test|src|metrics)\//.test(file) || /\.duckdb|\.xlsx$|\.bilite\//.test(file)));
  const installation = path.join(temporary, 'installation');
  const npmConfig = path.join(temporary, 'npmrc');
  fs.writeFileSync(npmConfig, '');
  command([npm, 'install', path.join(temporary, pack.filename), '--prefix', installation,
    '--userconfig', npmConfig, '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--fetch-retries=0', '--fetch-timeout=15000',
    ...(process.env.BILITE_TEST_REGISTRY ? ['--registry', process.env.BILITE_TEST_REGISTRY] : []),
    ...(process.env.BILITE_TEST_OFFLINE ? ['--offline'] : [])], caller);
  const installed = path.join(installation, 'node_modules/bi-lite');
  const entry = path.join(installed, 'bin/bilite.mjs');
  const cli = (args: string[], cwd = caller, extra = {}, expected = 0) => command([entry, ...args], cwd, extra, expected);
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(installed, 'src')), false);
  assert.match(cli(['--version']), /\d+\.\d+\.\d+/);
  assert.match(cli(['skill', '--help']), /install/);
  const configHome = path.join(temporary, 'authoring-config');
  const authoring = JSON.parse(command(
    [entry, 'authoring', 'setup', '--api-key-stdin'],
    caller,
    { XDG_CONFIG_HOME: configHome },
    0,
    'sk-package-test\n',
  ));
  assert.equal(authoring.modelId, 'deepseek-flash');
  const authoringStatus = JSON.parse(cli(['authoring', 'status'], caller, { XDG_CONFIG_HOME: configHome }));
  assert.equal(authoringStatus.ready, true);
  assert.equal(authoringStatus.apiKey.source, 'credential-file');
  const authoringPreview = JSON.parse(cli(['authoring', 'test'], caller, { XDG_CONFIG_HOME: configHome }));
  assert.equal(authoringPreview.sent, false);
  assert.equal(authoringPreview.modelId, 'deepseek-flash');
  cli(['init', workspace]);
  const at = (...args: string[]) => cli(['--workspace', workspace, ...args]);
  const empty = JSON.parse(at('catalog', 'dump'));
  assert.equal(empty.objects.length, 0);
  assert.equal(fs.existsSync(path.join(workspace, '.agents')), false);

  const port = await unusedPort();
  await start(entry, port);
  const url = `http://127.0.0.1:${port}`;
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.ok(!(await page.text()).includes('devReset'));
  assert.equal((await fetch(url + '/api/dev/reset', { method: 'POST' })).status, 404);
  assert.equal((await (await fetch(url + '/api/workspace')).json()).empty, true);
  const firstPid = child!.pid;
  at('web', '--no-open');
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, '.bilite/service.json'), 'utf8')).pid, firstPid);
  const other = path.join(temporary, 'other');
  cli(['init', other]);
  cli(['--workspace', other, 'web', '--port', String(port), '--no-open'], caller, {}, 1);
  assert.equal(fs.existsSync(path.join(other, '.bilite/db.lock')), false);
  assert.equal((await fetch(url + '/api/workspace/preset', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).status, 200);
  assert.equal((await (await fetch(url + '/api/workspace')).json()).empty, false);
  fs.cpSync(path.join(root, 'test/config/metrics'), path.join(workspace, 'metrics'), { recursive: true });
  for (const dir of ['ingest', 'specs']) fs.cpSync(path.join(root, dir), path.join(workspace, dir), { recursive: true });
  command([path.join(root, 'test/make-fixtures.ts')], workspace);
  const source = 'ingest/万元经营接入.yaml';
  assert.equal(JSON.parse(at('ingest', 'lint', source)).willBeRejected, false);
  assert.equal(JSON.parse(at('ingest', 'dry-run', source)).candidateRows, 80);
  assert.equal(JSON.parse(at('ingest', 'run', source)).inserted, 80);
  assert.equal(JSON.parse(at('render', 'specs/月度保送表.yaml', '--out', 'packed.xlsx')).cellsWritten, 20);
  assert.equal(JSON.parse(at('replay', source)).ok, true);
  assert.equal((await (await fetch(url + '/api/batches')).json())[0].row_count, 80);

  const skill = JSON.parse(at('skill', 'install'));
  const skillFile = path.join(skill.path, 'SKILL.md');
  assert.equal(fs.lstatSync(skill.path).isSymbolicLink(), false);
  fs.appendFileSync(skillFile, '\nUser changes\n');
  const changed = fs.readFileSync(skillFile, 'utf8');
  cli(['--workspace', workspace, 'skill', 'install'], caller, {}, 1);
  assert.equal(fs.readFileSync(skillFile, 'utf8'), changed);
  fs.writeFileSync(path.join(skill.path, 'notes.txt'), 'retain');
  at('skill', 'install', '--force');
  assert.equal(fs.readFileSync(path.join(skill.path, 'notes.txt'), 'utf8'), 'retain');
  assert.equal(fs.readFileSync(skillFile, 'utf8').includes('User changes'), false);
  assert.ok(JSON.parse(fs.readFileSync(path.join(skill.path, '.bilite-skill.json'), 'utf8')).engineVersion);
  const codexHome = path.join(temporary, 'codex-home');
  const userSkill = JSON.parse(cli(['skill', 'install', '--scope', 'user'], caller, { CODEX_HOME: codexHome }));
  assert.equal(userSkill.path, path.join(codexHome, 'skills/bi-lite-ingest'));
  await stop(true);
  assert.equal(fs.existsSync(path.join(workspace, '.bilite/service.json')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.bilite/db.lock')), false);
  assert.equal(JSON.parse(at('replay', source)).ok, true);

  const resetResult = spawnSync(process.execPath, [entry, '--workspace', workspace, 'dev', 'reset', '--confirm', '业务 工作区'], {
    cwd: caller, env: { ...env, BILITE_DEV_RESET: 'allow' }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(resetResult.status, 2, resetResult.stderr || resetResult.stdout);
  assert.match(String(resetResult.stderr), /未知命令/);
  assert.notEqual(JSON.parse(at('catalog', 'dump')).objects.length, 0);
  await start(entry, port);
  await stop(false);
  if (process.platform === 'win32') {
    // A stale owner may have recorded an 8.3 or differently cased path to this same directory.
    for (const name of ['service.json', 'db.lock']) {
      const file = path.join(workspace, '.bilite', name);
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.workspace = path.resolve(workspace).toUpperCase();
      fs.writeFileSync(file, JSON.stringify(state));
    }
  }
  assert.equal(JSON.parse(at('catalog', 'dump')).drift.length, 0);
  assert.equal(fs.existsSync(path.join(workspace, '.bilite/service.json')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.bilite/db.lock')), false);

  let warning = '';
  const launcher = (exitCode: number) => (() => {
    const process = new EventEmitter();
    queueMicrotask(() => process.emit('exit', exitCode));
    return process;
  }) as unknown as typeof spawn;
  await openBrowser(url, { out() {}, err: (text) => { warning += text; } }, launcher(0));
  assert.equal(warning, '');
  await openBrowser(url, { out() {}, err: (text) => { warning += text; } }, launcher(1));
  assert.ok(warning.includes(url));
  console.log('安装包验收通过：独立安装、空工作区、Web/CLI 导入出表重放、skill 保护及停机/崩溃恢复。');
} finally {
  if (child) { child.kill('SIGKILL'); await childExit!.catch(() => undefined); }
  assert.ok(temporary.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
  fs.rmSync(temporary, { recursive: true, force: true });
}
