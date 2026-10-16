import fs from 'node:fs';
import path from 'node:path';

export const SERVICE_PROTOCOL = 1;
export interface ServiceState {
  protocolVersion: number;
  workspace: string;
  database: string;
  instanceId: string;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}
const statePath = (workspace: string) => path.join(workspace, '.bilite/service.json');
export function writeServiceState(state: ServiceState): void {
  fs.mkdirSync(path.dirname(statePath(state.workspace)), { recursive: true });
  const temporary = statePath(state.workspace) + '.' + state.instanceId;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, statePath(state.workspace));
}
export function readServiceState(workspace: string): ServiceState | null {
  try { return JSON.parse(fs.readFileSync(statePath(workspace), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('运行状态损坏，请核对 .bilite/service.json');
  }
}
export function clearServiceState(workspace: string, instanceId: string): void {
  if (readServiceState(workspace)?.instanceId === instanceId) fs.unlinkSync(statePath(workspace));
}
