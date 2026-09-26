/**
 * MCP stdio 服务端（docs/需求与架构.md §7）
 *
 * ★ 为什么手写而不用官方 SDK（实测决策，见 §3）：
 *   官方 `@modelcontextprotocol/server@2.1.0` 只拉 2 个包，但共 **16MB**（zod 占 8MB）。
 *   而本协议面极小 —— 实测握手序列只有四个方法：
 *     initialize → notifications/initialized → tools/list → tools/call
 *   本项目已有「手写零框架 HTTP 层」的先例（src/server.ts），零依赖是既定纪律。
 *   漂移风险用 e2e 实测对冲：e2e 第 13 阶段用 DSH 自带的真实 MCP 客户端连本服务。
 *
 * ★ 两个必须记住的协议细节（DSH 客户端用 versionNegotiation: {mode:'auto'}）：
 *   ① `server/discover` **必须回一个 JSON-RPC 错误**才能触发 legacy 回落 ——
 *      沉默不答会让探测窗口超时，而不是回落。这里回 -32601 Method not found。
 *   ② `initialize` 要回客户端请求的版本（若在已知列表内），否则回自己的最新版。
 *
 * ★ 分帧：换行分隔的 JSON-RPC 2.0（`JSON.stringify(msg) + "\n"`）。
 *   stdout 是协议通道 —— **任何 console.log 都会破坏协议**，日志一律走 stderr。
 */
import * as db from '../db/index.ts';
import { TOOLS, toolListPayload, callTool } from './tools.ts';

/** 本服务声明支持的协议版本（与官方 SUPPORTED_PROTOCOL_VERSIONS 对齐） */
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07'];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SERVER_INFO = { name: 'bi-lite', version: '0.1.0' };

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** 写一帧到 stdout（唯一允许直接写 stdout 的地方） */
function send(msg: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

function reply(id: string | number | null | undefined, result: unknown) {
  send({ id: id ?? null, result });
}

function replyError(id: string | number | null | undefined, code: number, message: string, data?: unknown) {
  send({ id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function log(...args: unknown[]) {
  console.error('[bi-lite mcp]', ...args);
}

/** 处理一条消息。通知书（无 id）不回包。 */
async function handle(msg: JsonRpcMessage): Promise<void> {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    // ① 现代版探测：必须回错误才会让客户端回落 legacy（保持沉默 = 超时）
    case 'server/discover':
      return replyError(id, -32601, 'Method not found');

    // ② 标准握手
    case 'initialize': {
      const requested = String((params as { protocolVersion?: string } | undefined)?.protocolVersion ?? '');
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
      return;
    }

    // 通知书：客户端确认初始化完成，无需回应
    case 'notifications/initialized':
      log('initialized');
      return;

    case 'ping':
      if (!isNotification) reply(id, {});
      return;

    case 'tools/list':
      reply(id, { tools: toolListPayload() });
      return;

    case 'tools/call': {
      const name = String((params as { name?: string } | undefined)?.name ?? '');
      const args = ((params as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {}) as Record<string, unknown>;
      log(`call ${name}(${Object.keys(args).join(', ')})`);

      const outcome = await callTool(name, args);
      reply(id, {
        content: [{ type: 'text', text: outcome.text }],
        isError: !outcome.ok,
      });
      return;
    }

    // 其余（resources/*、prompts/* 等）—— 本服务不提供，明确拒绝
    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
      return;
  }
}

/** 启动 stdio 循环。返回一个 Promise，在 stdin 关闭时 resolve。 */
export async function serveStdio(): Promise<void> {
  await db.open();
  log(`就绪，${TOOLS.length} 个工具：${TOOLS.map((t) => t.name).join(', ')}`);

  let buffer = '';
  process.stdin.setEncoding('utf8');

  return new Promise<void>((resolve) => {
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      // 换行分帧；'\r' 要剥掉（Windows 客户端可能发 CRLF）
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;

        let msg: JsonRpcMessage;
        try {
          msg = JSON.parse(line) as JsonRpcMessage;
        } catch (e) {
          // 解析失败无法知道 id，只能作为错误发出去
          replyError(null, -32700, `Parse error: ${(e as Error).message}`);
          continue;
        }

        // 逐条处理，但不阻塞读取循环
        handle(msg).catch((e) => {
          log('handler error:', (e as Error).message);
          if (msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, (e as Error).message);
        });
      }
    });

    process.stdin.on('end', () => {
      log('stdin 关闭，退出');
      db.close();
      resolve();
    });
  });
}

// 直接运行：node src/mcp/server.ts
if (import.meta.main) {
  await serveStdio();
}
