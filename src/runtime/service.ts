import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SERVICE_PROTOCOL, readServiceState, clearServiceState, type ServiceState } from './workspace.ts';
import { canonicalPath, samePath } from './paths.ts';

export const workspacePath = () => canonicalPath(process.cwd());
export const databasePath = () => canonicalPath(process.env.BILITE_DB ?? 'data/bi.duckdb');

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export interface RuntimePeer { state: ServiceState; url: string }
export async function servicePeer(workspace = workspacePath()): Promise<RuntimePeer | null> {
  const state = readServiceState(workspace);
  if (!state) return null;
  if (!samePath(state.workspace, workspace) || state.protocolVersion !== SERVICE_PROTOCOL) {
    throw new Error('工作区运行状态身份或协议不匹配，请核对 .bilite/service.json');
  }
  if (!processAlive(state.pid)) return null;
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) throw new Error('服务端口无效');
  const url = `http://127.0.0.1:${state.port}`;
  try {
    const response = await fetch(`${url}/api/runtime`, {
      headers: { authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(700), redirect: 'error',
    });
    const body = await response.json();
    if (!response.ok || body.instanceId !== state.instanceId || !samePath(body.workspace, workspace)
      || body.protocolVersion !== SERVICE_PROTOCOL || !samePath(body.database, databasePath())) {
      throw new Error('服务身份或数据库配置不匹配');
    }
    return { state, url };
  } catch (error) {
    throw new Error(`运行状态中的服务无法握手；未直连数据库：${(error as Error).message}`);
  }
}

export interface WorkspaceLock { release: () => void }

// Serialize lock creation and stale-owner cleanup. A crash while holding this short
// filesystem guard fails closed; the guard is never removed based on elapsed time.
function withGuard<T>(workspace: string, action: () => T): T {
  const dir = path.join(workspace, '.bilite');
  fs.mkdirSync(dir, { recursive: true });
  const guard = path.join(dir, 'lock.guard');
  const fd = fs.openSync(guard, 'wx');
  try { return action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(guard); }
}

export async function acquireWorkspaceLock(workspace = workspacePath(), timeoutMs = 5000): Promise<WorkspaceLock> {
  const file = path.join(workspace, '.bilite/db.lock');
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const acquired = withGuard(workspace, () => {
        if (fs.existsSync(file)) {
          const old = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!Number.isInteger(old.pid) || !samePath(old.workspace, workspace)) throw new Error('执行锁损坏或身份不匹配，请核对 .bilite/db.lock');
      if (processAlive(old.pid)) return false;
      const stale = readServiceState(workspace);
      if (stale && processAlive(stale.pid) === false) clearServiceState(workspace, stale.instanceId);
          fs.unlinkSync(file);
        }
        fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token, workspace }) + '\n', { flag: 'wx', mode: 0o600 });
        try {
          const stale = readServiceState(workspace);
          if (stale && !processAlive(stale.pid)) clearServiceState(workspace, stale.instanceId);
        } catch (error) {
          fs.unlinkSync(file);
          throw error;
        }
        return true;
      });
      if (acquired) {
        let released = false;
        return { release: () => {
          if (released) return;
          // The live owner is the only process allowed to release its lock.
          const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (owner.token !== token) throw new Error('执行锁所有者已变化，拒绝删除');
          fs.unlinkSync(file);
          released = true;
        } };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await delay(75);
  } while (Date.now() < deadline);
  throw new Error('等待工作区执行锁超时；请等待当前命令结束或确认 Web 服务状态（.bilite/）。');
}
