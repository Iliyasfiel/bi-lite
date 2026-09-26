/**
 * 本地 Web 服务（docs/需求与架构.md §8、F1/F5/F6）
 *
 * 纪律：
 *   - 零框架、零外部服务。node:http + 静态文件，一个进程。
 *   - **所有 Web 查询都以 audience='human' 发出** —— Web 是人的界面，人看精确值。
 *     agent 那条路（分档值 + 阈值）走 MCP，不在这里（§6.2.2 铁律 10）。
 *   - 导入链路完全不经过 LLM（铁律 7）：文件只落在本地磁盘 → DuckDB。
 *
 * 上传实现：不用 multipart（要引依赖），改为**原始二进制 body + X-Filename 头**。
 * 前端用 File API 直接读成 ArrayBuffer 发过来，省掉一整层解析。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as db from './db/index.ts';
import { stage, commit, readLongTable } from './import/longtable.ts';
import { catalog, queryMetrics, QueryRefused, type MetricsQuery } from './semantic/query.ts';
import { parseSpec, SpecError } from './spec/types.ts';
import { compileBlock, runCompiled, planOf } from './spec/compile.ts';
import { renderTemplate, type RenderBlock } from './render/excel.ts';
import { toEChartsOption, chartShape, chartInputFromMetrics, type ChartSpec } from './render/chart.ts';

const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT ?? 4319);
const WEB_DIR = path.join(import.meta.dirname, 'web');
const UPLOAD_DIR = 'data/uploads';
const OUTPUT_DIR = 'output';

// ---------------- 工具 ----------------

/** 只允许读 src/web 下的白名单文件，杜绝路径穿越 */
const STATIC_WHITELIST = new Set(['index.html', 'app.js', 'style.css']);

function json(res: http.ServerResponse, code: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > maxBytes) throw new Error(`请求体过大（上限 ${Math.round(maxBytes / 1024)}KB）`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const body = await readBody(req);
  if (!body.length) return {} as T;
  return JSON.parse(body.toString('utf8')) as T;
}

/** 查询参数来自浏览器，任何字符串都可能包含路径成分 —— 取 basename 兜底 */
function safeName(name: string): string {
  return path.basename(name).replace(/[^\w\u4e00-\u9fa5.\-]/g, '_');
}

function listSpecs() {
  if (!fs.existsSync('specs')) return [];
  return fs
    .readdirSync('specs')
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => {
      const full = path.join('specs', f);
      try {
        const spec = parseSpec(fs.readFileSync(full, 'utf8'));
        return { file: full, id: spec.id, title: spec.title ?? spec.id, sheets: spec.sheets.length };
      } catch (e) {
        return { file: full, id: f, title: f, sheets: 0, error: (e as Error).message };
      }
    });
}

// ---------------- 路由 ----------------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

const routes: Record<string, Handler> = {
  /** 元数据目录（维度/口径/指标/公司）—— 零金额，可安全下发到浏览器 */
  'GET /api/catalog': async (_req, res) => {
    json(res, 200, await catalog());
  },

  /** 导入批次列表（可追溯，N4） */
  'GET /api/batches': async (_req, res) => {
    const rows = await db.query(
      `SELECT batch_id, source_file, row_count, imported_at, status
       FROM import_batch ORDER BY imported_at DESC LIMIT 50`,
    );
    json(res, 200, rows);
  },

  /** 自由查询 —— **固定 human 视角**（人看精确值） */
  'POST /api/query': async (req, res) => {
    const body = await readJson<Partial<MetricsQuery>>(req);
    try {
      const result = await queryMetrics({ ...(body as MetricsQuery), audience: 'human' });
      json(res, 200, result);
    } catch (e) {
      if (e instanceof QueryRefused) return json(res, 200, { refused: true, reason: e.reason, message: e.message });
      throw e;
    }
  },

  /** 同一份查询 → ECharts option（含数值，只回浏览器）+ 形状描述（不含数值） */
  'POST /api/chart': async (req, res) => {
    const body = await readJson<{ query: MetricsQuery; chart?: Partial<ChartSpec> }>(req);
    const chart: ChartSpec = { type: 'bar', ...(body.chart ?? {}) };
    const metrics = await queryMetrics({ ...body.query, audience: 'human' });
    const input = chartInputFromMetrics(metrics);
    json(res, 200, {
      option: toEChartsOption(chart, input),
      shape: chartShape(chart, input),
      meta: metrics.meta,
    });
  },

  /** 导入第一步：STAGED 校验（写入临时文件，不动数据库） */
  'POST /api/import/stage': async (req, res) => {
    const rawName = String(req.headers['x-filename'] ?? '上传.xlsx');
    const name = safeName(decodeURIComponent(rawName));
    if (!name) return json(res, 400, { error: '缺少文件名' });

    const buf = await readBody(req, 32 * 1024 * 1024);
    if (!buf.length) return json(res, 400, { error: '文件为空' });

    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const dest = path.join(UPLOAD_DIR, `${Date.now()}-${name}`);
    fs.writeFileSync(dest, buf);

    const sheet = req.headers['x-sheet'] ? decodeURIComponent(String(req.headers['x-sheet'])) : undefined;
    const staged = await stage(dest, sheet);
    json(res, 200, staged);
  },

  /** 导入第二步：提交（写维度 + 事实表 + Parquet 归档） */
  'POST /api/import/commit': async (req, res) => {
    const { batchId, file, sheet, autoCreateDims } = await readJson<{
      batchId: string; file: string; sheet?: string; autoCreateDims?: boolean;
    }>(req);

    // 文件路径必须落在上传目录内，避免被伪造成任意路径
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) {
      return json(res, 400, { error: '文件不在上传目录内' });
    }

    const rows = await readLongTable(resolved, sheet);
    const result = await commit(batchId, rows, { autoCreateDims: autoCreateDims !== false });
    let archived = true;
    try {
      const { archiveParquet } = await import('./import/longtable.ts');
      await archiveParquet(batchId);
    } catch (e) {
      // 归档失败不影响主链路（查询不依赖 Parquet），但绝不静默 —— 见 §4.4
      archived = false;
      console.error(`[归档] 批次 ${batchId} 的 Parquet 归档失败:`, (e as Error).message);
    }
    json(res, 200, { ...result, archived });
  },

  /** 已注册报表列表（specs/*.yaml） */
  'GET /api/specs': async (_req, res) => {
    json(res, 200, listSpecs());
  },

  /** 报表预览：出坐标计划（不含金额）+ 矩阵（含数值，给浏览器） */
  'POST /api/report/preview': async (req, res) => {
    const { specFile, params } = await readJson<{ specFile: string; params?: Record<string, string | number> }>(req);
    const spec = parseSpec(fs.readFileSync(specFile, 'utf8'));
    const p = { ...(spec.params ?? {}), ...(params ?? {}) };

    const results = [];
    const sheets = [];
    for (const sheet of spec.sheets) {
      const blocks = [];
      for (const b of sheet.blocks) {
        const compiled = compileBlock(b, p);
        const result = await runCompiled(compiled, (sql) => db.query(sql));
        blocks.push({ anchor: b.anchor, chart: b.chart, ...result });
        results.push({ sheet: sheet.name, anchor: String(typeof b.anchor === 'object' ? b.anchor.name : b.anchor), rowLabels: result.rowLabels, colLabels: result.colLabels });
      }
      sheets.push({ name: sheet.name, blocks });
    }

    json(res, 200, {
      spec: { id: spec.id, title: spec.title, template: spec.template },
      params: p,
      sheets,
      plan: planOf(spec, results),                       // ← 不含金额，可给 agent
      charts: sheets.flatMap((s) =>
        s.blocks.filter((b) => b.chart).map((b) => {
          const chart = b.chart as ChartSpec;
          const input = { rowLabels: b.rowLabels, colLabels: b.colLabels, matrix: b.matrix };
          return { sheet: s.name, option: toEChartsOption(chart, input), shape: chartShape(chart, input) };
        }),
      ),
    });
  },

  /** 渲染 Excel（模板填充，保版式） */
  'POST /api/report/render': async (req, res) => {
    const { specFile, params, output } = await readJson<{
      specFile: string; params?: Record<string, string | number>; output?: string;
    }>(req);

    const spec = parseSpec(fs.readFileSync(specFile, 'utf8'));
    const p = { ...(spec.params ?? {}), ...(params ?? {}) };
    if (!spec.template) return json(res, 400, { error: 'spec 未声明 template' });
    if (!fs.existsSync(spec.template)) return json(res, 400, { error: `模板不存在: ${spec.template}` });

    const blocks: RenderBlock[] = [];
    for (const sheet of spec.sheets) {
      for (const b of sheet.blocks) {
        const compiled = compileBlock(b, p);
        const result = await runCompiled(compiled, (sql) => db.query(sql));
        blocks.push({
          sheet: sheet.name,
          anchor: b.anchor,
          colLabels: result.colLabels,
          rows: result.matrix.map((m) => ({ label: m.label, values: m.values })),
          format: b.value.format,
          writeRowLabels: false,   // 模板已预置行标签
          writeColLabels: false,   // 模板已预置列标签
        });
      }
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outName = output ? safeName(output) : `${safeName(spec.id)}-${p.year ?? ''}${String(p.month ?? '').padStart(2, '0')}.xlsx`;
    const outPath = path.join(OUTPUT_DIR, outName);

    const result = await renderTemplate(spec.template, outPath, blocks);
    json(res, 200, { ...result, download: `/download/${encodeURIComponent(outName)}` });
  },
};

/** 渲染产物下载（只允许 output/ 下的文件） */
async function serveDownload(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const name = safeName(decodeURIComponent(url.pathname.replace('/download/', '')));
  const full = path.join(OUTPUT_DIR, name);
  if (!fs.existsSync(full)) return json(res, 404, { error: '文件不存在' });
  res.writeHead(200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  fs.createReadStream(full).pipe(res);
}

function serveStatic(res: http.ServerResponse, url: URL) {
  // ECharts 从 node_modules 直供 —— 离线可用，不引 CDN（N3 本地优先）
  if (url.pathname === '/vendor/echarts.min.js') {
    const p = require.resolve('echarts/dist/echarts.min.js');
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'max-age=3600' });
    return fs.createReadStream(p).pipe(res);
  }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.replace('/static/', '');
  if (!STATIC_WHITELIST.has(name)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  const full = path.join(WEB_DIR, name);
  if (!fs.existsSync(full)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.css') ? 'text/css' : 'application/javascript';
  res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const key = `${req.method} ${url.pathname}`;

  const handler = routes[key];
  const run = handler
    ? () => handler(req, res)
    : url.pathname.startsWith('/download/')
      ? () => serveDownload(req, res, url)
      : () => { serveStatic(res, url); return Promise.resolve(); };

  run().catch((e) => {
    const err = e as Error;
    if (err instanceof SpecError) return json(res, 400, { error: `spec 校验失败: ${err.message}` });
    console.error(`[${key}]`, err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  });
});

/** 启动服务。端口传 0 时由内核分配（测试用），返回实际端口。 */
export async function start(port = PORT): Promise<number> {
  await db.open();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : port;
}

export function stop() {
  server.close();
}

// 只在直接运行时自动启动（被 import 时不监听，便于测试在进程内起服务）
if (import.meta.main) {
  const port = await start();
  console.log(`bi-lite → http://127.0.0.1:${port}`);
  console.log('（只监听本机回环，数据不出本机）');
}
