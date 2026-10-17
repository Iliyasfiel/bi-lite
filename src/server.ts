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
import { fileURLToPath } from 'node:url';
import * as db from './db/index.ts';
import type { DimDecision } from './ingest/types.ts';
import { normalizeName, type DimKind } from './ingest/resolve.ts';
import { catalog, queryMetrics, QueryRefused, type MetricsQuery } from './semantic/query.ts';
import { parseSpec, diagnoseSpec, SpecError } from './spec/types.ts';
import { compileBlock, runCompiled, planOf } from './spec/compile.ts';
import { declaredFactsOf, loadModels } from './gen/parse.ts';
import { DEFAULT_TARGET } from './gen/ir.ts';
import { renderReport } from './operations/report.ts';
import { prepareIngest } from './operations/ingest.ts';
import { toEChartsOption, chartShape, chartInputFromMetrics, type ChartSpec } from './render/chart.ts';
import { inferSpec, guessedAxes, type Registry } from './spec/infer.ts';
import { diagnoseIngest, parseIngestSpec, type IngestSpec } from './ingest/types.ts';
import { runIngest } from './ingest/run.ts';
import { masterCatalog } from './ingest/master.ts';
import { createTemplateTask, getAuthoringTask } from './authoring/attachment.ts';
import { SERVICE_PROTOCOL, clearServiceState, writeServiceState } from './runtime/workspace.ts';
import { acquireWorkspaceLock, servicePeer, workspacePath, databasePath } from './runtime/service.ts';
import { runInvocation } from './runtime/invocation.ts';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT ?? 4319);
const WEB_DIR = path.join(import.meta.dirname, 'web');
const UPLOAD_DIR = 'data/uploads';
const OUTPUT_DIR = 'output';
/** 用户上传的待推断模板（临时）；`templates/` 下人工维护的模板才是正式版本 */
const TEMPLATE_UPLOAD_DIR = 'templates/uploads';
/** 已定稿的接入规格（源 Excel → 星型表的映射 YAML） */
const INGEST_DIR = 'ingest';

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
  const facts = declaredFactsOf(); // specs 里可能存着业务线报表（fact: fact_business_line），解析判据要带上声明
  return fs
    .readdirSync('specs')
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => {
      const full = path.join('specs', f);
      try {
        const spec = parseSpec(fs.readFileSync(full, 'utf8'), { facts });
        return { file: full, id: spec.id, title: spec.title ?? spec.id, sheets: spec.sheets.length, params: spec.params ?? {} };
      } catch (e) {
        return { file: full, id: f, title: f, sheets: 0, error: (e as Error).message };
      }
    });
}

// ---------------- 路由 ----------------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

/** 取接入规格文本：优先内联 YAML，其次文件；都没有就是一次明确的 400 */
function loadIngestText(body: { yaml?: string; specFile?: string }): { text: string; from: string } | { error: string } {
  if (body.yaml) return { text: body.yaml, from: '(内联 YAML)' };
  if (body.specFile) {
    if (!fs.existsSync(body.specFile)) return { error: `接入规格文件不存在: ${body.specFile}` };
    return { text: fs.readFileSync(body.specFile, 'utf8'), from: body.specFile };
  }
  return { error: '需要 yaml（接入规格文本）或 specFile（路径）' };
}

/** 接入规格的静态诊断（与 MCP 侧 lint_ingest 同一套判据：diagnoseIngest） */
const diagIngest = prepareIngest;

/** HTTP 路由表，与本地 Web 共用。 */
export const routes: Record<string, Handler> = {
  'GET /api/workspace': async (_req, res) => {
    const ir = loadModels();
    json(res, 200, { workspace: WORKSPACE, modelCount: ir.tables.length, empty: ir.tables.length === 0 });
  },

  'POST /api/authoring/template': async (req, res) => {
    const rawName = String(req.headers['x-filename'] ?? '模板.xlsx');
    const name = safeName(decodeURIComponent(rawName));
    if (!name) return json(res, 400, { error: '缺少文件名' });
    const buf = await readBody(req, 32 * 1024 * 1024);
    if (!buf.length) return json(res, 400, { error: '文件为空' });
    const task = await createTemplateTask(name, buf, WORKSPACE);
    if (task.status === 'template-rejected') return json(res, 403, task);
    if (task.status === 'template-unsupported' || task.status === 'template-unclear') return json(res, 422, task);
    json(res, 200, task);
  },

  'GET /api/authoring/task': async (req, res) => {
    const taskId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? '';
    const task = getAuthoringTask(taskId, WORKSPACE);
    if (!task) return json(res, 404, { error: '任务不存在' });
    json(res, 200, task);
  },

  'POST /api/workspace/preset': async (req, res) => {
    const body = await readJson<Record<string, unknown>>(req);
    if (!body || Object.keys(body).length) return json(res, 400, { error: '此入口只添加财务基础模型，不接受其他配置' });
    try {
      const { initializeWorkspace } = await import('../bin/workspace.mjs');
      const result = initializeWorkspace(['--preset', 'finance'], WORKSPACE, fileURLToPath(new URL('../', import.meta.url)));
      await db.refresh();
      json(res, 200, result);
    } catch (error) { json(res, 400, { error: (error as Error).message }); }
  },

  /** 元数据目录（维度/口径/指标/公司）—— 零金额，可安全下发到浏览器 */
  'GET /api/catalog': async (_req, res) => {
    const result = await catalog();
    const fact = declaredFactsOf().find((f) => f.name === DEFAULT_TARGET);
    const months = fact ? await db.query<{ month: string }>(
      `SELECT DISTINCT strftime(fin_month, '%Y-%m') AS month
       FROM "${fact.name}" WHERE fin_month IS NOT NULL ORDER BY month`,
    ) : [];
    json(res, 200, { ...result, query: { fact: fact?.name ?? null, months: months.map((r) => r.month) } });
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
      const result = await queryMetrics({ ...(body as MetricsQuery), audience: 'human' }, (sql) => db.query(sql), declaredFactsOf());
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
    const metrics = await queryMetrics({ ...body.query, audience: 'human' }, (sql) => db.query(sql), declaredFactsOf());
    const input = chartInputFromMetrics(metrics);
    json(res, 200, {
      option: toEChartsOption(chart, input),
      shape: chartShape(chart, input),
      meta: metrics.meta,
    });
  },

  /** 别名映射清单（§10 R1）—— 人确认过一次的写法，下月自动命中 */
  'GET /api/aliases': async (_req, res) => {
    const { listAliases } = await import('./ingest/resolve.ts');
    json(res, 200, await listAliases());
  },

  /**
   * 手工登记/纠正一条别名映射。
   *
   * 这是"人拍板"的落点：`registerAlias` 会把 `raw` 的规范化键指向 `targetId`，
   * 从此这个写法（以及所有和它只有格式差异的写法）自动归并，**不再出现在未识别清单里**。
   */
  'POST /api/aliases': async (req, res) => {
    const { kind, raw, targetId, note } = await readJson<{
      kind: DimKind; raw: string; targetId: string; note?: string;
    }>(req);
    if (kind !== 'company' && kind !== 'metric') return json(res, 400, { error: 'kind 必须是 company 或 metric' });
    if (!raw || !targetId) return json(res, 400, { error: '缺少 raw 或 targetId' });

    const { registerAlias, loadEntities } = await import('./ingest/resolve.ts');
    // 目标必须真实存在 —— 否则会造出一条指向虚空的别名，将来更难查
    const target = (await loadEntities(kind)).find((e) => e.id === targetId);
    if (!target) return json(res, 400, { error: `目标主数据不存在: ${targetId}` });

    const r = await registerAlias(kind, raw, targetId, note);
    json(res, 200, { ...r, kind, raw, normalized: normalizeName(raw), targetId, targetName: target.name });
  },

  /** 已注册报表列表（`specs/*.yaml`）—— 报表页的"已注册报表"就靠它 */
  'GET /api/specs': async (_req, res) => {
    json(res, 200, listSpecs());
  },

  /**
   * 从模板推断 spec 草稿（§7.2 路径 1）。
   *
   * 与 `/api/ingest/upload` 同一套路：原始二进制 body + `X-Filename` 头，不用 multipart。
   * 上传的模板落在 `templates/uploads/`，与 `templates/` 下人工维护的模板分开，
   * 避免临时上传被当成正式模板版本化（`.gitignore` 只忽略后者）。
   */
  'POST /api/template/infer': async (req, res) => {
    const rawName = String(req.headers['x-filename'] ?? '模板.xlsx');
    const name = safeName(decodeURIComponent(rawName));
    if (!name) return json(res, 400, { error: '缺少文件名' });

    const buf = await readBody(req, 32 * 1024 * 1024);
    if (!buf.length) return json(res, 400, { error: '文件为空' });

    fs.mkdirSync(TEMPLATE_UPLOAD_DIR, { recursive: true });
    const dest = path.join(TEMPLATE_UPLOAD_DIR, `${Date.now()}-${name}`);
    fs.writeFileSync(dest, buf);

    try {
      const cat = await catalog();
      const registry: Registry = {
        metrics: cat.metrics.map((m) => m.name),
        companies: cat.companies.map((c) => c.name),
        periodTypes: cat.periodTypes.map((p) => p.id),
        axisNames: cat.dimensions.map((d) => d.label),
      };
      const r = await inferSpec({ template: dest, registry });
      json(res, 200, {
        template: dest,
        specId: r.spec.id,
        yaml: r.yaml,
        blocks: r.blocks,
        guessed: guessedAxes(r),
        unmatched: r.unmatched,
        issues: r.issues,
      });
    } catch (e) {
      // 推断失败要说清原因（模板识别不出数据区是常见的用户错误，不是内部故障）
      json(res, 422, { error: (e as Error).message, template: dest });
    }
  },

  /** 保存推断出的 spec 到 specs/（人工确认后的一步） */
  /**
   * spec 静态诊断：**在任何数字被算出来之前**告诉人哪里会出错。
   *
   * ★ 与 `/api/specs/save` 用的是同一套判据（`diagnoseSpec` → `lintSpec`）。
   *   两份判据一定会漂移：诊断说没问题、保存却被拒，是最难查的那类 bug。
   *   这里返回 200（诊断本身不是错误），用 `willBeRejected` 表达"能不能存"。
   */
  'POST /api/specs/lint': async (req, res) => {
    const { yaml, specFile } = await readJson<{ yaml?: string; specFile?: string }>(req);
    let text = yaml;
    if (!text && specFile) {
      if (!fs.existsSync(specFile)) return json(res, 404, { error: `spec 文件不存在: ${specFile}` });
      text = fs.readFileSync(specFile, 'utf8');
    }
    if (!text) return json(res, 400, { error: '需要 yaml 或 specFile' });
    const d = diagnoseSpec(text, { facts: declaredFactsOf() });
    json(res, 200, {
      ok: !d.willBeRejected,
      willBeRejected: d.willBeRejected,
      parseError: d.parseError,
      errors: d.errors,
      issues: d.issues,
      unusedParams: d.unusedParams,
    });
  },

  'POST /api/specs/save': async (req, res) => {
    const { id, yaml } = await readJson<{ id?: string; yaml: string }>(req);
    if (!yaml || typeof yaml !== 'string') return json(res, 400, { error: '缺少 yaml' });

    // ★ 定稿前必须过校验 —— 拒绝把"声明了 params 却没用"这类静默算错的 spec 写进仓库
    let spec;
    try {
      spec = parseSpec(yaml, { facts: declaredFactsOf() });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }

    // 文件名以 **YAML 里的 id** 为准，而不是前端传来的 id ——
    // 人可能在文本框里改了 `id:` 那一行，用前端参数会出现"文件名与内容里的 id 不一致"。
    const base = safeName(spec.id || id || '');
    if (!base) return json(res, 400, { error: '非法 id（YAML 里的 id 不能为空且不能全是特殊字符）' });
    fs.mkdirSync('specs', { recursive: true });
    const dest = path.join('specs', `${base}.yaml`);
    fs.writeFileSync(dest, yaml);
    json(res, 200, { file: dest, id: spec.id, title: spec.title ?? spec.id, sheets: spec.sheets.length });
  },

  // ---------------- 接入规格：源 Excel → 星型表 ----------------
  // YAML 由 agent（或人）产出，引擎只负责**确定性执行**与**确定性拒绝**。
  // 这里的三条纪律：诊断 200 + willBeRejected 表达"能不能跑"；干跑不写库；
  // 有歧义的名字整批拒绝、一行都不写（合并两家公司的钱会静默相加，没人会来查）。

  /**
   * 已定稿的接入规格（`ingest/` 下）。
   *
   * ★ 顺带把文本带回去：向导要"载入某份规格进编辑器"。若另开一条 `?file=` 的读文件路由，
   *   就得再写一份"这个路径允不允许读"的判断 —— 而**枚举出来的路径天然是允许的**。
   *   少一处判据，就少一处会漂的判据（铁律 17）。
   */
  'GET /api/ingest/specs': async (_req, res) => {
    const files = fs.existsSync(INGEST_DIR) ? fs.readdirSync(INGEST_DIR).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
    json(
      res,
      200,
      files.map((f) => {
        const file = path.join(INGEST_DIR, f);
        return { file, id: f.replace(/\.ya?ml$/, ''), yaml: fs.readFileSync(file, 'utf8') };
      }),
    );
  },

  /**
   * 上传**源 Excel**：只落盘，不解析、不落库。
   *
   * ★ 为什么必须单独一步：接入规格里的 `source:` 是一个**路径**，而引擎只认白名单内真实
   *   存在的文件（`src/paths.ts` 的 `resolveSource`）。浏览器给不出一个服务端路径，
   *   所以只能先把文件放进来、再让规格指过去。
   * ★ 与 `/api/ingest/upload` 同一套路：原始二进制 body + `X-Filename` 头（不为上传引 multipart）。
   * ★ 这里**不写任何新判据** —— 校验与落库都在接入层那条路上
   *   （`diagnoseIngest` / `runIngest`）；上传层多一道判断就是多一份会漂的判据（铁律 17）。
   *   唯一要保证的是一个**不变式**：落点必须在 `SOURCE_ROOTS` 内，否则这里给出的路径
   *   到了 `source:` 里会被接入层拒 —— 那时报错已经离现场很远了。所以直接问那份唯一判据。
   */
  'POST /api/ingest/upload': async (req, res) => {
    const rawName = String(req.headers['x-filename'] ?? '源文件.xlsx');
    const name = safeName(decodeURIComponent(rawName));
    if (!name) return json(res, 400, { error: '缺少文件名' });

    const buf = await readBody(req, 32 * 1024 * 1024);
    if (!buf.length) return json(res, 400, { error: '文件为空' });

    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const dest = path.join(UPLOAD_DIR, `${Date.now()}-${name}`);
    fs.writeFileSync(dest, buf);

    try {
      const { resolveSource } = await import('./paths.ts');
      resolveSource(dest);
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
    json(res, 200, { file: dest, name, size: buf.length });
  },

  'POST /api/ingest/lint': async (req, res) => {
    const body = await readJson<{ yaml?: string; specFile?: string }>(req);
    const t = loadIngestText(body);
    if ('error' in t) return json(res, 400, t);
    const { d, errors, warnings } = await diagIngest(t.text);
    json(res, 200, {
      from: t.from,
      id: d.spec?.id ?? null,
      source: d.spec?.source ?? null,
      ok: !d.willBeRejected,
      willBeRejected: d.willBeRejected,
      parseError: d.parseError,
      errors,
      warnings,
    });
  },

  'POST /api/ingest/dry-run': async (req, res) => {
    // ★ source 是执行参数（架构 §8.1）：前端"选文件"选的是它，不改写规格 YAML 文本
    const body = await readJson<{ yaml?: string; specFile?: string; decisions?: DimDecision[]; source?: string }>(req);
    const t = loadIngestText(body);
    if ('error' in t) return json(res, 400, t);
    const { cat, d, errors } = await diagIngest(t.text);
    if (d.willBeRejected) return json(res, 200, { ok: false, refused: true, errors });
    json(res, 200, await runIngest(parseIngestSpec(t.text, { periodTypes: cat.periodTypes, facts: cat.facts }), { catalog: cat, planOnly: true, decisions: body.decisions, source: body.source }));
  },

  'POST /api/ingest/run': async (req, res) => {
    const body = await readJson<{ yaml?: string; specFile?: string; decisions?: DimDecision[]; source?: string }>(req);
    const t = loadIngestText(body);
    if ('error' in t) return json(res, 400, t);
    const { cat, d, errors } = await diagIngest(t.text);
    if (d.willBeRejected) return json(res, 200, { ok: false, refused: true, errors });
    json(res, 200, await runIngest(parseIngestSpec(t.text, { periodTypes: cat.periodTypes, facts: cat.facts }), { catalog: cat, decisions: body.decisions, source: body.source }));
  },

  /** 定稿接入规格。与 /api/specs/save 同一纪律：**先校验再落盘**（拒绝把跑不了的规格写进仓库） */
  'POST /api/ingest/save': async (req, res) => {
    const { yaml } = await readJson<{ yaml?: string }>(req);
    if (!yaml || typeof yaml !== 'string') return json(res, 400, { error: '缺少 yaml' });
    let spec: IngestSpec;
    try {
      // ★ 与 dry-run / run 走**同一份判据**（同一个 ctx）：静态放行、落盘就不该被拒。
      //   （这条路由原来没有 catalog 在作用域里 —— 换成 parseIngestSpec(yaml, ctx) 时踩过一次）
      const cat = await masterCatalog();
      spec = parseIngestSpec(yaml, { periodTypes: cat.periodTypes, facts: cat.facts });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
    const base = safeName(spec.id ?? '');
    if (!base) return json(res, 400, { error: '非法 id（YAML 里的 id 不能为空且不能全是特殊字符）' });
    fs.mkdirSync(INGEST_DIR, { recursive: true });
    const dest = path.join(INGEST_DIR, `${base}.yaml`);
    fs.writeFileSync(dest, yaml);
    json(res, 200, { file: dest, id: spec.id, source: spec.source });
  },

  /** 报表预览：出坐标计划（不含金额）+ 矩阵（含数值，给浏览器） */
  'POST /api/report/preview': async (req, res) => {
    const { specFile, params } = await readJson<{ specFile: string; params?: Record<string, string | number> }>(req);
    const spec = parseSpec(fs.readFileSync(specFile, 'utf8'), { facts: declaredFactsOf() });
    const p = { ...(spec.params ?? {}), ...(params ?? {}) };

    const results = [];
    const sheets = [];
    for (const sheet of spec.sheets) {
      const blocks = [];
      for (const b of sheet.blocks) {
        const compiled = compileBlock(b, p, { factName: spec.fact, facts: declaredFactsOf() });
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

    const spec = parseSpec(fs.readFileSync(specFile, 'utf8'), { facts: declaredFactsOf() });
    const p = { ...(spec.params ?? {}), ...(params ?? {}) };
    if (!spec.template) return json(res, 400, { error: 'spec 未声明 template' });
    if (!fs.existsSync(spec.template)) return json(res, 400, { error: `模板不存在: ${spec.template}` });

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outName = output ? safeName(output) : `${safeName(spec.id)}-${p.year ?? ''}${String(p.month ?? '').padStart(2, '0')}.xlsx`;
    const outPath = path.join(OUTPUT_DIR, outName);

    const result = await renderReport(spec, p, outPath);
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

const WORKSPACE = workspacePath();
interface OperationState {
  operationId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  code?: number;
}
interface ServerRuntime {
  instanceId: string;
  token: string;
  chain: Promise<unknown>;
  closing: boolean;
  operations: Map<string, OperationState>;
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
  lock: { release: () => void };
}
let serverRuntime: ServerRuntime | null = null;
let stopping: Promise<void> | null = null;

const server = http.createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    if (res.headersSent) { res.destroy(); return; }
    json(res, error instanceof SpecError ? 400 : 500, { error: (error as Error).message });
  });
});

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const runtime = serverRuntime;
  if (!runtime || runtime.closing) return json(res, 503, { error: '服务正在启动或停止' });
  const address = server.address();
  const host = typeof address === 'object' && address ? '127.0.0.1:' + address.port : '';
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== 'http://' + host)
    || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '来源不允许' });
  const url = new URL(req.url ?? '/', 'http://' + host);
  if (url.pathname === '/api/runtime' || url.pathname.startsWith('/api/operations')) {
    if (req.headers.origin || req.headers.authorization !== 'Bearer ' + runtime.token) {
      return json(res, 401, { error: '本地连接凭据无效' });
    }
    if (url.pathname === '/api/runtime' && req.method === 'GET') {
      return json(res, 200, { protocolVersion: SERVICE_PROTOCOL, workspace: WORKSPACE,
        instanceId: runtime.instanceId, database: databasePath() });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/operations/')) {
      const operationId = url.pathname.slice('/api/operations/'.length);
      return json(res, 200, runtime.operations.get(operationId) ?? { operationId, status: 'unknown' });
    }
    if (req.method !== 'POST' || url.pathname !== '/api/operations') return json(res, 405, { error: 'Method not allowed' });
    if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: '需要 JSON' });
    const body = await readJson<{ operationId?: string; workspace?: string; instanceId?: string; argv?: unknown }>(req);
    if (body.instanceId !== runtime.instanceId || body.workspace !== WORKSPACE) return json(res, 409, { error: '工作区或实例身份不匹配' });
    if (!body.operationId || !/^[a-f0-9-]{36}$/.test(body.operationId)) return json(res, 400, { error: '操作标识无效' });
    if (!Array.isArray(body.argv) || !body.argv.every((arg) => typeof arg === 'string')) return json(res, 400, { error: 'argv 必须为字符串数组' });
    const { parseCliArgs } = await import('./cli.ts');
    const { isDatabaseInvocation } = await import('./runtime/operations.ts');
    if (!isDatabaseInvocation(parseCliArgs(body.argv).kind)) return json(res, 400, { error: '此入口只接受已命名的数据库操作' });
    if (runtime.closing) return json(res, 503, { error: '服务正在停止' });
    if (runtime.operations.has(body.operationId)) return json(res, 409, { error: '操作标识已使用，请查询状态，不要重试' });
    if (runtime.operations.size >= 4096) return json(res, 503, { error: '本实例操作记录已满，请在空闲时重启服务' });
    const state: OperationState = { operationId: body.operationId, status: 'queued' };
    runtime.operations.set(state.operationId, state);
    console.error('[operation]', state.operationId, 'queued');
    const result = await runtime.enqueue(async () => {
      state.status = 'running';
      let stdout = '', stderr = '';
      try {
        const code = await runInvocation(body.argv as string[], { out: (t) => { stdout += t; }, err: (t) => { stderr += t; } });
        state.code = code;
        state.status = code === 0 ? 'completed' : 'failed';
        return { operationId: state.operationId, code, stdout, stderr };
      } catch (error) {
        state.code = 1; state.status = 'failed';
        return { operationId: state.operationId, code: 1, stdout: '', stderr: (error as Error).message + '\n' };
      } finally { console.error('[operation]', state.operationId, state.status); }
    });
    return json(res, 200, result);
  }
  const key = req.method + ' ' + url.pathname;
  const handler = routes[key];
  if (handler) {
    return runtime.enqueue(async () => {
      await db.refresh();
      await handler(req, res);
    });
  }
  if (url.pathname.startsWith('/download/')) return runtime.enqueue(() => serveDownload(req, res, url));
  serveStatic(res, url);
}

/** Own the workspace until all accepted operations and connections have drained. */
export async function start(port = PORT): Promise<number> {
  if (serverRuntime) throw new Error('服务已启动');
  const peer = await servicePeer(WORKSPACE);
  if (peer) throw new Error('同一工作区已有健康 Web 服务：' + peer.url);
  const lock = await acquireWorkspaceLock(WORKSPACE);
  const runtime: ServerRuntime = {
    instanceId: randomUUID(), token: randomUUID(), chain: Promise.resolve(), closing: false, operations: new Map(), lock,
    enqueue: (task) => {
      const next = runtime.chain.then(task);
      runtime.chain = next.catch(() => undefined);
      return next;
    },
  };
  try {
    const afterLock = await servicePeer(WORKSPACE);
    if (afterLock) throw new Error('同一工作区已有健康 Web 服务：' + afterLock.url);
    await db.open();
    serverRuntime = runtime;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.off('listening', onListen); reject(error); };
      const onListen = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(port, '127.0.0.1');
    });
    const actualPort = (server.address() as { port: number }).port;
    writeServiceState({ protocolVersion: SERVICE_PROTOCOL, workspace: WORKSPACE, database: databasePath(),
      instanceId: runtime.instanceId, token: runtime.token, pid: process.pid, port: actualPort, startedAt: new Date().toISOString() });
    stopping = null;
    return actualPort;
  } catch (error) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    serverRuntime = null;
    db.close();
    lock.release();
    throw error;
  }
}

export function stop(): Promise<void> {
  if (stopping) return stopping;
  const runtime = serverRuntime;
  if (!runtime) return Promise.resolve();
  runtime.closing = true;
  stopping = (async () => {
    try {
      await runtime.chain;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
      clearServiceState(WORKSPACE, runtime.instanceId);
    } finally { runtime.lock.release(); serverRuntime = null; }
  })();
  return stopping;
}

if (import.meta.main) {
  void (async () => {
    try {
      const port = await start();
      console.log('bi-lite → http://127.0.0.1:' + port);
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void stop().catch(console.error); });
    } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
  })();
}
