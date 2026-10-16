import { acquireWorkspaceLock, servicePeer, workspacePath } from './service.ts';
import { forwardInvocation } from './client.ts';
import { isDatabaseInvocation } from './operations.ts';
import type { CliIO } from '../cli.ts';

export async function runInvocation(argv: readonly string[], io: CliIO): Promise<number> {
  const cli = await import('../cli.ts');
  return cli.main(argv, io);
}

export async function runStandalone(argv: readonly string[], io: CliIO): Promise<number> {
  const cli = await import('../cli.ts');
  if (argv[0] === 'help' && argv[1] === 'web') return (await import('./web.ts')).runWebServer(['web', '--help'], io);
  if (argv[0] === 'web') return (await import('./web.ts')).runWebServer(argv, io);
  if (argv[0] === 'operation') return operationStatus(argv, io);
  const invocation = cli.parseCliArgs(argv);
  if (!isDatabaseInvocation(invocation.kind)) return cli.main(argv, io);
  const workspace = workspacePath();
  const peer = await servicePeer(workspace);
  if (peer) return forwardInvocation(peer, argv, io);
  let lock;
  try { lock = await acquireWorkspaceLock(workspace); }
  catch (error) {
    const ready = await servicePeer(workspace);
    if (ready) return forwardInvocation(ready, argv, io);
    throw error;
  }
  try {
    const afterLock = await servicePeer(workspace);
    if (afterLock) return await forwardInvocation(afterLock, argv, io);
    return await cli.main(argv, io);
  } finally {
    try { (await import('../db/index.ts')).close(); }
    finally { lock.release(); }
  }
}

async function operationStatus(argv: readonly string[], io: CliIO): Promise<number> {
  if (argv.length !== 3 || argv[1] !== 'status' || !/^[a-f0-9-]{36}$/.test(argv[2] ?? '')) {
    io.err('用法：bilite operation status <操作标识>\n'); return 2;
  }
  const peer = await servicePeer();
  if (!peer) { io.out(JSON.stringify({ operationId: argv[2], status: 'unknown' }) + '\n'); return 1; }
  const response = await fetch(`${peer.url}/api/operations/${argv[2]}`, {
    headers: { authorization: `Bearer ${peer.state.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) throw new Error('无法查询操作状态');
  io.out(JSON.stringify(await response.json(), null, 2) + '\n'); return 0;
}
