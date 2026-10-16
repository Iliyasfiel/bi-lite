import { spawn } from 'node:child_process';
import { servicePeer, workspacePath } from './service.ts';
import type { CliIO } from '../cli.ts';

async function openBrowser(url: string, io: CliIO): Promise<void> {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] as const
    : process.platform === 'darwin' ? ['open', [url]] as const : ['xdg-open', [url]] as const;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...args], { windowsHide: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('浏览器启动失败')));
    });
  } catch { io.err(`无法自动打开浏览器，请访问 ${url}\n`); }
}

export async function runWebServer(argv: readonly string[], io: CliIO): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.out('用法：bilite web [--port 4319] [--no-open]\n前台运行，Ctrl+C 停止。\n'); return 0;
  }
  let port = 4319, open = true;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--no-open') open = false;
    else if (argv[i] === '--port') {
      const value = argv[++i] ?? '';
      if (!/^\d+$/.test(value) || +value < 1 || +value > 65535) { io.err('--port 需要 1-65535 的整数\n'); return 2; }
      port = +value;
    } else { io.err(`bilite web: 未知选项 ${argv[i]}\n`); return 2; }
  }
  let url: string;
  const existing = await servicePeer();
  if (existing) {
    url = existing.url;
    io.err(`工作区已有服务（进程 ${existing.state.pid}）：${url}\n`);
  } else {
    const server = await import('../server.ts');
    try { url = `http://127.0.0.1:${await server.start(port)}`; }
    catch (error) {
      const peer = await servicePeer();
      if (peer) { io.err(`工作区已有服务：${peer.url}\n`); if (open) await openBrowser(peer.url, io); return 0; }
      io.err((error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `端口 ${port} 已占用，请通过 --port 选择其他端口。\n` : `${(error as Error).message}\n`);
      return 1;
    }
    const shutdown = () => { void server.stop().catch((error) => { io.err(error.message + '\n'); process.exitCode = 1; }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    io.err(`工作区：${workspacePath()}\nbi-lite → ${url}（Ctrl+C 停止）\n`);
  }
  if (open) await openBrowser(url, io);

  return 0;
}
