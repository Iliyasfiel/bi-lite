import { randomUUID } from 'node:crypto';
import type { RuntimePeer } from './service.ts';
import type { CliIO } from '../cli.ts';

export async function forwardInvocation(peer: RuntimePeer, argv: readonly string[], io: CliIO): Promise<number> {
  const operationId = randomUUID();
  try {
    const response = await fetch(`${peer.url}/api/operations`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${peer.state.token}` },
      body: JSON.stringify({ operationId, workspace: peer.state.workspace, instanceId: peer.state.instanceId, argv }),
      redirect: 'error',
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    if (body.operationId !== operationId || ![0, 1, 2].includes(body.code) || typeof body.stdout !== 'string' || typeof body.stderr !== 'string') throw new Error('服务响应无效');
    io.out(body.stdout); io.err(body.stderr);
    return body.code;
  } catch (error) {
    io.err(`操作 ${operationId}：连接中断或响应无效，执行结果未知；不会自动重试。${(error as Error).message}\n`);
    io.err(`服务仍在运行时可用 bilite operation status ${operationId} 核对状态；服务重启后结合导入批次核对。\n`);
    return 1;
  }
}
