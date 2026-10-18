/** Reset uses temporary workspaces and real owner locks; never a business database. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enableTestWorkspace, planWorkspaceReset, resetWorkspace } from '../src/runtime/reset.ts';
import { acquireWorkspaceLock } from '../src/runtime/service.ts';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bilite-reset-')));
const workspace = path.join(root, 'testing');
const outside = path.join(root, 'provider-config');
const oldDb = process.env.BILITE_DB;
delete process.env.BILITE_DB;
try {
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'auth.json'), 'fake credential');
  fs.writeFileSync(path.join(workspace, 'bilite.config.json'), JSON.stringify({ workspace: true, version: 1 }));
  fs.mkdirSync(path.join(workspace, 'models'));
  fs.writeFileSync(path.join(workspace, 'models/test.yml'), 'fake model');
  fs.mkdirSync(path.join(workspace, 'data'));
  fs.writeFileSync(path.join(workspace, 'data/source.xlsx'), 'fake source');
  assert.throws(() => planWorkspaceReset(workspace), /reset enable/);
  enableTestWorkspace(workspace);
  const plan = planWorkspaceReset(workspace);
  assert.ok(plan.removed.includes('models'));
  assert.ok(fs.existsSync(path.join(workspace, 'models/test.yml')));
  await assert.rejects(resetWorkspace(workspace, 'wrong'), /确认值/);
  const lock = await acquireWorkspaceLock(workspace);
  try {
    await assert.rejects(resetWorkspace(workspace, 'testing'), /执行锁超时/);
    assert.ok(fs.existsSync(path.join(workspace, 'models/test.yml')));
    assert.ok(fs.existsSync(path.join(workspace, '.bilite/db.lock')));
  } finally { lock.release(); }
  fs.symlinkSync(outside, path.join(workspace, 'data/link'), 'dir');
  await assert.rejects(resetWorkspace(workspace, 'testing'), /链接/);
  assert.ok(fs.existsSync(path.join(workspace, 'models/test.yml')));
  fs.unlinkSync(path.join(workspace, 'data/link'));
  process.env.BILITE_DB = path.join(root, 'external.duckdb');
  await assert.rejects(resetWorkspace(workspace, 'testing'), /数据库/);
  delete process.env.BILITE_DB;
  await resetWorkspace(workspace, 'testing');
  assert.equal(fs.existsSync(path.join(workspace, 'models/test.yml')), false);
  assert.equal(fs.existsSync(path.join(workspace, '.bilite/db.lock')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'auth.json'), 'utf8'), 'fake credential');
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, 'bilite.config.json'), 'utf8')).development, true);
  for (const dir of ['models', 'metrics', 'ingest', 'specs', 'templates', 'drafts', 'data', 'output']) {
    assert.deepEqual(fs.readdirSync(path.join(workspace, dir)), []);
  }
  console.log('测试区 reset 验收通过：预览、真实锁、链接/越界拒绝和配置保留。');
} finally {
  if (oldDb === undefined) delete process.env.BILITE_DB; else process.env.BILITE_DB = oldDb;
  fs.rmSync(root, { recursive: true, force: true });
}
