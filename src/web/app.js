/**
 * bi-lite Web 前端 —— 零框架、零构建。
 *
 * 三块：数据导入（F1）、看板查询（F6）、报表报送（F3/F4/F5）。
 * 安全：本页所有查询都以 audience='human' 发出（服务端强制），金额精确展示 ——
 *       因为这个页面的读者是人，不是 LLM。agent 走 MCP，看的是分档值（§6.2.2）。
 */
'use strict';

const $ = (id) => document.getElementById(id);
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok || body.error) throw new Error(body.error ?? `HTTP ${r.status}`);
  return body;
};
const fmt = (n) => (n === null || n === undefined)
  ? '—'
  : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ═══════════════ 页签 ═══════════════
function activateTab(name) {
  const btn = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!btn) return;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
  if (chart) chart.resize();
  reportCharts.forEach((c) => c.resize());
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    location.hash = btn.dataset.tab;      // 可分享/可刷新，也是 e2e 截图的入口
    activateTab(btn.dataset.tab);
  });
});

const hashTab = () => activateTab((location.hash || '').replace('#', '') || 'import');
window.addEventListener('hashchange', hashTab);

// ═══════════════ 1. 数据导入 ═══════════════
//
// 两条路并存，**主路径在上、旧路径在下**：
//   · 主路径 = 接入规格（`src/ingest/`）：形状写在 YAML 里，换一份表不用改代码。
//   · 旧路径 = 长表导入（`src/import/`，待退场）：形状写死在代码里。
// 前端**不做任何判据** —— 诊断、干跑、落库都调服务端那三个路由，它们又都调
// `diagnoseIngest` / `runIngest`。页面只负责把结论摆清楚，否则判据就漂了（铁律 17）。

// ───────── 主路径：接入规格（声明式）─────────
let igSource = null;      // 刚上传的源文件 { file, name, size }
let igPlan = null;        // 最近一次干跑结果（或落库被拦下的结果）
let igDecisions = {};     // key = `${kind}|${raw}` → { kind, raw, action, targetId }
let igSpecs = [];         // ingest/ 下已定稿的规格（带文本，供载入编辑器）

const igYaml = () => $('igYaml').value;
const igDkey = (kind, raw) => `${kind}|${raw}`;

/** 按当前规格与快照，这次会落多少行事实。
 *  干跑不写库，所以只能从形状里推：坐标总数 − 凑不齐坐标的。 */
const igWillWrite = (res) =>
  ((res && res.shape && res.shape.blocks) || []).reduce(
    (n, b) => n + (b.coordinates.total - b.coordinates.incomplete), 0,
  );

function igStatus(text, cls) {
  const el = $('igStatus');
  el.textContent = text;
  el.className = `pill ${cls || ''}`;
}

/** 还有几个名字没拍板 —— 落库按钮的放行条件就是它归零 */
function igPending() {
  const need = (igPlan && igPlan.needsDecision) || [];
  return need.filter((d) => !igDecisions[igDkey(d.kind, d.raw)]).length;
}

function igSyncRun() {
  const n = igPending();
  const btn = $('igRun');
  btn.disabled = n > 0;
  btn.textContent = n > 0 ? `还有 ${n} 个名称待确认` : `确认无误，落库（${igWillWrite(igPlan).toLocaleString()} 行）`;
}

// —— 源文件：先落到白名单目录，再让规格的 source 指过去 ——
$('igPick').addEventListener('click', () => $('igFile').click());
$('igFile').addEventListener('change', (e) => { if (e.target.files[0]) igUploadSource(e.target.files[0]); });
{
  const dz = $('igDrop');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.remove('over');
  }));
  dz.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) igUploadSource(e.dataTransfer.files[0]); });
}

async function igUploadSource(file) {
  $('igFileMsg').textContent = `${file.name}（${(file.size / 1024).toFixed(0)} KB）· 上传中…`;
  try {
    // 与旧路径同一套路：原始二进制 body + X-Filename 头（不为上传引 multipart 依赖）
    const res = await fetch('/api/ingest/upload', {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' },
      body: await file.arrayBuffer(),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    igSource = body;
    $('igFileMsg').textContent = `${file.name}（${(file.size / 1024).toFixed(0)} KB）· 已上传`;
    $('igSource').classList.remove('hidden');
    $('igSourcePath').textContent = body.file;
    $('igPointMsg').textContent = '';
    igStatus('源文件已就位', 'ok');
  } catch (e) {
    igSource = null;
    $('igSource').classList.add('hidden');
    $('igFileMsg').textContent = `上传失败：${e.message}`;
  }
}

/**
 * 把规格顶层的 `source:` 指向刚上传的文件。
 *
 * ★ 只认**顶层**那一行（不缩进的 `source:`），找不到就明说 —— 不替人凭空插一行结构。
 *   静默改写 YAML 比让人自己补一行危险得多：改错了没人看得见。
 */
$('igPoint').addEventListener('click', () => {
  const p = igSource && igSource.file;
  if (!p) return;
  if (/^source\s*:/m.test(igYaml())) {
    $('igYaml').value = igYaml().replace(/^source\s*:.*$/m, `source: ${p}`);
    $('igPointMsg').textContent = '已改 source 那一行（在下面编辑器里可见）';
  } else {
    $('igPointMsg').innerHTML =
      `这份 YAML 里没有顶层的 <code>source:</code> 行，请自己加一行：<code>source: ${esc(p)}</code>`;
  }
  runIgLint();
});

// —— 规格：载入已定稿的，或自己写 ——
async function igLoadSpecs() {
  try {
    igSpecs = await api('/api/ingest/specs');
    $('igSpecs').innerHTML = '<option value="">（不载入，直接在下面写）</option>' +
      igSpecs.map((s) => `<option value="${esc(s.file)}">${esc(s.id)}</option>`).join('');
  } catch {
    igSpecs = [];   // 一份都没定稿过不是错误
  }
}

$('igSpecs').addEventListener('change', () => {
  const hit = igSpecs.find((s) => s.file === $('igSpecs').value);
  if (!hit) return;
  $('igYaml').value = hit.yaml;
  igResetPlan();
  runIgLint();
});

// —— 边改边诊断：把"落库时被拒"提前成"打字时就看见哪里错" ——
let igLintTimer = null;
function scheduleIgLint() { clearTimeout(igLintTimer); igLintTimer = setTimeout(runIgLint, 250); }
$('igYaml').addEventListener('input', scheduleIgLint);

async function runIgLint() {
  const box = $('igLint');
  const yaml = igYaml();
  if (!yaml.trim()) {
    box.innerHTML = '';
    $('igDryRun').disabled = true;
    $('igSave').disabled = true;
    igStatus('未开始', '');
    return;
  }
  box.innerHTML = '<span class="hint">检查中…</span>';
  let d;
  try {
    d = await api('/api/ingest/lint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml }),
    });
  } catch (e) {
    box.innerHTML = `<span class="hint">诊断失败：${esc(e.message)}</span>`;
    return;
  }

  $('igDryRun').disabled = d.willBeRejected;
  $('igSave').disabled = d.willBeRejected;

  if (d.parseError) {
    igStatus('YAML 语法错', 'err');
    box.innerHTML = `<div class="issue err"><span class="lv">YAML 语法</span><span>${esc(d.parseError)}</span></div>`;
    return;
  }
  const errs = d.errors || [];
  const warns = d.warnings || [];
  if (d.willBeRejected) {
    igStatus(`${errs.length} 处要先改`, 'err');
    box.innerHTML = `<div class="issue err"><span class="lv">不能跑</span>
      <span>有 ${errs.length} 处必须先改 —— 结构不对时跑进去也只会一行不落地被拒。</span></div>` +
      errs.map((i) => `<div class="issue err"><span class="lv">错误</span>
        <span><code>${esc(i.at)}</code>：${esc(i.message)}${
        i.hint ? `<br><span class="ev">→ ${esc(i.hint)}</span>` : ''}</span></div>`).join('');
    return;
  }
  igStatus('可以干跑', 'ok');
  box.innerHTML = warns.length
    ? `<div class="issue warn"><span class="lv">可跑</span>
         <span>结构没问题，但有 ${warns.length} 条提醒（不挡干跑）。</span></div>` +
      warns.map((i) => `<div class="issue warn"><span class="lv">提醒</span>
        <span><code>${esc(i.at)}</code>：${esc(i.message)}</span></div>`).join('')
    : '<div class="issue ok"><span class="lv">通过</span><span>结构没问题，可以干跑。</span></div>';
}

function igResetPlan() {
  igPlan = null;
  igDecisions = {};
  $('igPlanCard').classList.add('hidden');
  $('igPlan').innerHTML = '';
  $('igDecisions').innerHTML = '';
  $('igRunMsg').textContent = '';
}

// —— 干跑：形状 + 主数据判定，一次库都不写 ——
$('igDryRun').addEventListener('click', async () => {
  const btn = $('igDryRun');
  btn.disabled = true;
  btn.textContent = '干跑中…';
  igDecisions = {};       // 新一轮干跑 → 丢掉上一轮的决定
  try {
    const res = await api('/api/ingest/dry-run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: igYaml(), decisions: [] }),
    });
    igPlan = res;
    renderIgPlan(res);
  } catch (e) {
    $('igLint').insertAdjacentHTML('afterbegin',
      `<div class="issue err"><span class="lv">干跑失败</span><span>${esc(e.message)}</span></div>`);
  } finally {
    btn.disabled = false;
    btn.textContent = '干跑（不写库）';
  }
});

function igBlockHtml(b) {
  const vals = b.valueColumns.map((v) => `${v.col}${v.header ? `（${v.header}）` : ''} → ${v.periodType || '⚠ 没有口径'}`);
  const skips = b.skipped.map((s) => `${s.col}（${s.why}）`);
  const period = b.period ? `${b.period.year}-${String(b.period.month).padStart(2, '0')}（${b.period.evidence}）` : '—';
  return `<div class="spec-item" style="display:block">
    <div class="meta">
      <b>sheet「${esc(b.sheet)}」· 锚点 ${esc(b.anchor)}</b>
      <span>表头第 ${b.headerRow} 行 · ${b.dataRows} 行数据 × ${b.valueColumns.length} 个值列
        = ${b.coordinates.total} 个坐标${
        b.coordinates.incomplete ? `（其中 ${b.coordinates.incomplete} 个凑不齐坐标，落不了库）` : ''}</span>
    </div>
    <table class="mini" style="margin-top:8px">
      <tr><th>行键</th><td>${b.rows.map((r) => `${r.col} → ${esc(r.dim)}`).join('、')}</td></tr>
      <tr><th>值列</th><td>${vals.map((v) => esc(v)).join('、') || '—'}</td></tr>
      ${b.skipped.length ? `<tr><th>跳过</th><td>${skips.map((s) => esc(s)).join('、')}</td></tr>` : ''}
      <tr><th>期数</th><td>${esc(period)}</td></tr>
      ${b.dropped.length ? `<tr><th>丢掉的行</th><td>${
        b.dropped.map((d) => `第 ${d.row} 行「${esc(d.label)}」—— ${esc(d.by)}`).join('、')}</td></tr>` : ''}
    </table>
  </div>`;
}

function igPlanLists(res) {
  const out = [];
  const wc = res.willCreate || [];
  if (wc.length) {
    out.push(`<h3 class="sec">这次会新建的主数据（${wc.length}）</h3>
      <div class="issue warn"><span class="lv">新建</span><span>${
        wc.map((w) => `${w.kind === 'company' ? '公司' : '指标'}「${esc(w.raw)}」`).join('、')}</span></div>
      <p class="hint">只有在它<strong>确实是新的</strong>时才该新建：库里已有同一家的另一种写法时，
        新建会把那家公司的钱拆成两半。</p>`);
  }
  const mg = res.merged || [];
  if (mg.length) {
    out.push(`<h3 class="sec">自动归并的写法（${mg.length}）</h3>
      <div class="issue ok"><span class="lv">归并</span><span>${
        mg.map((m) => `「${esc(m.raw)}」→「${esc(m.target)}」（${m.rows} 行）`).join('、')}</span></div>`);
  }
  return out.join('');
}

function renderIgPlan(res) {
  $('igPlanCard').classList.remove('hidden');
  const errs = res.errors || [];

  if (res.refused || errs.length) {
    $('igPlanStatus').textContent = '跑不了';
    $('igPlanStatus').className = 'pill err';
    $('igPlan').innerHTML = (res.note ? `<p class="hint">${esc(res.note)}</p>` : '') +
      errs.map((i) => `<div class="issue err"><span class="lv">错误</span>
        <span><code>${esc(i.code)}</code> @ <code>${esc(i.at)}</code>：${esc(i.message)}${
        i.hint ? `<br><span class="ev">→ ${esc(i.hint)}</span>` : ''}</span></div>`).join('');
    $('igDecisions').innerHTML = '';
    $('igRun').disabled = true;
    $('igRun').textContent = '确认无误，落库';
    igStatus('干跑被拒', 'err');
    return;
  }

  const blocks = (res.shape && res.shape.blocks) || [];
  const need = res.needsDecision || [];
  $('igPlanStatus').textContent = need.length ? `${need.length} 个名字待你拍板` : '可以落库';
  $('igPlanStatus').className = `pill ${need.length ? 'warn' : 'ok'}`;

  $('igPlan').innerHTML = `
    <div class="kv">
      <div><div class="k">会写入的事实行</div><div class="v">${igWillWrite(res).toLocaleString()}</div></div>
      <div><div class="k">数据区</div><div class="v">${blocks.length}</div></div>
      <div><div class="k">空值格（不落库）</div><div class="v">${(res.emptyMeasureCells || 0).toLocaleString()}</div></div>
      <div><div class="k">会新建主数据</div><div class="v">${(res.willCreate || []).length}</div></div>
      <div><div class="k">自动归并写法</div><div class="v">${(res.merged || []).length}</div></div>
    </div>
    ${res.note ? `<p class="hint">${esc(res.note)}</p>` : ''}
    ${blocks.map(igBlockHtml).join('')}
    ${igPlanLists(res)}`;

  renderIgDecisions(need);
  igSyncRun();
  igStatus(need.length ? '待拍板' : '可落库', need.length ? 'warn' : 'ok');
}

/**
 * 把「疑似同一家」的名字交给人拍板（铁律 16）。
 *
 * ★ 与旧路径那张卡片是同一个立场：**合并两家公司比不合并危险得多**。
 *   不合并时数字明显不对、人会来查；错合并则报表看起来完全正常，没人会来查。
 *   所以候选必须带 `why`（判断依据）—— 不给人看依据的推荐等于让他们猜。
 */
function renderIgDecisions(need) {
  if (!need.length) { $('igDecisions').innerHTML = ''; return; }

  const card = (d) => {
    const cur = igDecisions[igDkey(d.kind, d.raw)];
    const cands = d.candidates || [];
    const opts = cands.map((c) => `<option value="${esc(c.id)}"${cur && cur.targetId === c.id ? ' selected' : ''}>${
      esc(c.name)}（${esc(c.why)}）</option>`).join('');
    return `<div class="decide" data-key="${esc(igDkey(d.kind, d.raw))}">
      <div class="decide-head">
        <strong>${esc(d.raw)}</strong>
        <span class="tag">${d.kind === 'company' ? '公司' : '指标'}</span>
        <span class="tag">${d.rows} 行</span>
        ${cur ? `<span class="pill ok">${cur.action === 'merge' ? '并入已有' : '确认新建'}</span>` : ''}
      </div>
      <div class="decide-body">
        <label>并入已有主数据
          <select class="decide-target">${opts || '<option value="">（没有相近的已有主数据）</option>'}</select>
        </label>
        <button class="decide-merge"${cands.length ? '' : ' disabled'}>并入</button>
        <button class="decide-new">确认是新建</button>
      </div>
      <p class="hint">候选里没有正确的目标，就说明它确实是新的 —— 选「确认是新建」。
        选「并入」后这个写法会被记住，下个月自动命中，不再问你。</p>
    </div>`;
  };

  $('igDecisions').innerHTML = `<div class="decide-wrap">
    <h3>待确认名称 <span class="pill warn">${need.length}</span></h3>
    <p class="hint">这些名字第一次出现，但看起来与已有主数据相近。请逐个确认：
      是同一家的不同写法（并入），还是确实是一家新公司（新建）。
      合并两家不同的公司会把它们的钱静默加在一起 —— 而报表看起来完全正常，没人会来查。</p>
    ${need.map(card).join('')}
  </div>`;

  const refresh = () => {
    renderIgDecisions(igPlan.needsDecision);
    // ★ 卡片顶上那颗状态胶囊也要跟着改。只放行按钮而不改胶囊的话，
    //   人会看到「1 个名字待你拍板」和已经可用的落库按钮同时出现 ——
    //   同一类"决定记下了、界面没同步"的 bug 本仓库栽过一次（§6.2 第 2 条）。
    const n = igPending();
    const ps = $('igPlanStatus');
    if (ps) {
      ps.textContent = n > 0 ? `${n} 个名字待你拍板` : '可以落库';
      ps.className = `pill ${n > 0 ? 'warn' : 'ok'}`;
    }
    igSyncRun();
  };
  $('igDecisions').querySelectorAll('.decide').forEach((el) => {
    const key = el.dataset.key;
    const [kind, raw] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    el.querySelector('.decide-merge').addEventListener('click', () => {
      const targetId = el.querySelector('.decide-target').value;
      if (!targetId) return;
      igDecisions[key] = { kind, raw, action: 'merge', targetId };
      refresh();
    });
    el.querySelector('.decide-new').addEventListener('click', () => {
      igDecisions[key] = { kind, raw, action: 'create' };
      refresh();
    });
  });
}

// —— 落库：把决定一起交上去；服务端仍会独立复核一遍 ——
$('igRun').addEventListener('click', async () => {
  if (!igPlan) return;
  const btn = $('igRun');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '落库中…';
  try {
    const res = await api('/api/ingest/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: igYaml(), decisions: Object.values(igDecisions) }),
    });

    // 服务端可能回一个「还需要人拍板」的中间态（HTTP 200，不是错误）：
    // 那种情况它一行都没写。把它当待办渲染出来，而不是当成失败。
    if (!res.ok) {
      igPlan = res;
      renderIgPlan(res);
      if ((res.needsDecision || []).length) $('igRunMsg').textContent = '还差几个决定 —— 补齐后再点一次。';
      return;
    }

    const merged = (res.merged || []).length
      ? `；自动归并 ${res.merged.length} 个写法（${res.merged.map((m) => `${esc(m.raw)}→${esc(m.target)}`).join('、')}）`
      : '';
    $('igPlan').insertAdjacentHTML('afterbegin', `<div class="issue ok"><span class="lv">已落库</span>
      <span>批次 <code>${esc(res.batchId)}</code>：写入 ${res.inserted.toLocaleString()} 行；
      新建公司 ${res.createdCompanies.length} 个、指标 ${res.createdMetrics.length} 个${merged}。
      ${res.archived === false ? '<strong>⚠️ Parquet 归档失败，请查看服务端日志</strong>' : ''}</span></div>`);
    $('igRunMsg').textContent = '已落库。上面的干跑结果保留着供对照。';
    // 卡片顶上的胶囊也交代清楚，别让「1 个名字待你拍板」留在已经落完库的画面上
    $('igPlanStatus').textContent = '已落库';
    $('igPlanStatus').className = 'pill ok';
    igStatus('已落库', 'ok');
    btn.textContent = '已落库';
    igPlan = null;
    igDecisions = {};
    await Promise.all([loadBatches(), loadCatalog(), igLoadSpecs()]);
  } catch (e) {
    $('igRunMsg').textContent = `落库失败：${e.message}`;
    btn.disabled = false;
    btn.textContent = label;
  }
});

// —— 定稿：先校验再落盘（拒绝把跑不了的规格写进仓库）——
$('igSave').addEventListener('click', async () => {
  const btn = $('igSave');
  btn.disabled = true;
  btn.textContent = '保存中…';
  $('igSaveMsg').textContent = '';
  try {
    const res = await api('/api/ingest/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml: igYaml() }),
    });
    $('igSaveMsg').textContent = `已保存 ${res.file}`;
    await igLoadSpecs();
  } catch (e) {
    $('igSaveMsg').textContent = '';
    $('igLint').insertAdjacentHTML('afterbegin',
      `<div class="issue err"><span class="lv">拒绝保存</span><span>${esc(e.message)}</span></div>`);
  } finally {
    btn.disabled = false;
    btn.textContent = '保存到 ingest/';
  }
});

// ───────── 旧路径：长表导入（待退场）─────────
let staged = null;   // 待提交的批次
let decisions = {};  // key = `${kind}|${raw}` → {action, targetId}

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { if (e.target.files[0]) upload(e.target.files[0]); });

const dz = $('dropzone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
  e.preventDefault(); dz.classList.remove('over');
}));
dz.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });

async function upload(file) {
  $('filename').textContent = `${file.name}（${(file.size / 1024).toFixed(0)} KB）· 校验中…`;
  $('stageCard').classList.add('hidden');
  decisions = {};   // 换文件就丢弃上一批的决定
  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/import/stage', {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' },
      body: buf,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    staged = { ...body, file: body.sourceFile, filename: file.name };
    renderStage(staged);
  } catch (e) {
    $('filename').textContent = `校验失败：${e.message}`;
  }
}

function renderStage(s) {
  $('stageCard').classList.remove('hidden');

  const statusEl = $('stageStatus');
  const failed = s.status === 'error';
  statusEl.textContent = failed ? '校验未通过' : '校验通过';
  statusEl.className = `pill ${failed ? 'err' : 'ok'}`;

  const unknown = [...s.unknownCompanies, ...s.unknownMetrics];
  $('stageSummary').innerHTML = `
    <div class="kv">
      <div><div class="k">数据行</div><div class="v">${s.rowCount.toLocaleString()}</div></div>
      <div><div class="k">未识别公司</div><div class="v">${s.unknownCompanies.length}</div></div>
      <div><div class="k">未识别指标</div><div class="v">${s.unknownMetrics.length}</div></div>
      <div><div class="k">未注册口径</div><div class="v">${s.unknownPeriodTypes.length}</div></div>
    </div>`;

  let html = '';
  if (unknown.length) {
    html += `<p class="hint">以下名称是第一次出现，提交时会自动建档。若只是别名，请在下方「待确认名称」里并入已有主数据 —— 否则同一家公司会被拆成两条主数据，它的钱也会被拆成两半。</p>
      <div class="issue warn"><span class="lv">新</span><span>${unknown.join('、')}</span></div>`;
  }
  html += s.issues.length
    ? s.issues.map((i) => `<div class="issue ${i.level}">
        <span class="lv">${i.level === 'error' ? '错误' : '提醒'}</span>
        <span>${i.row ? `第 ${i.row} 行：` : ''}${i.message}</span></div>`).join('')
    : '<p class="hint">没有任何问题。</p>';

  $('stageIssues').innerHTML = html;
  renderUnresolved(s.unresolved);
  syncCommitButton();
}

/**
 * 把「还有几个名字待确认」同步到提交按钮上。
 *
 * ★ 必须同时被 `renderStage()` 和确认卡片的 `refresh()` 调用。
 *   只在 renderStage 里更新的话，人点完「并入」按钮文案不会变、
 *   按钮仍然是 disabled —— 人会觉得"点了没反应"，而其实决定已经记下了。
 */
function syncCommitButton() {
  const btn = $('doCommit');
  const n = pendingCount();
  btn.disabled = (staged?.status === 'error') || n > 0;
  btn.textContent = n > 0
    ? `还有 ${n} 个名称待确认`
    : `确认无误，提交入库（${(staged?.rowCount ?? 0).toLocaleString()} 行）`;
}

// ── 主数据对齐：把「疑似同一家」的名字交给人拍板（§10 R1）──
// 安全立场：**合并两家公司比不合并危险得多**。不合并时数字明显不对、人会来查；
// 错合并则报表看起来完全正常，没人会来查。所以只有纯格式差异（Tier 1）自动归并，
// 其余一律停下来问人。人确认一次写进 dim_alias，下月自动命中。
const dkey = (kind, raw) => `${kind}|${raw}`;

const pendingCount = () => {
  const u = (staged && staged.unresolved) || { companies: [], metrics: [] };
  return [...u.companies, ...u.metrics].filter((d) => !decisions[dkey(d.kind, d.raw)]).length;
};

function renderUnresolved(u) {
  const all = [...(u?.companies ?? []), ...(u?.metrics ?? [])];
  if (!all.length) { $('stageDecisions').innerHTML = ''; return; }

  const card = (d) => {
    const cur = decisions[dkey(d.kind, d.raw)];
    const opts = d.candidates.map((c) => `<option value="${esc(c.id)}"${cur?.targetId === c.id ? ' selected' : ''}>
        ${esc(c.name)}（${c.why}）</option>`).join('');
    return `<div class="decide" data-key="${esc(dkey(d.kind, d.raw))}">
      <div class="decide-head">
        <strong>${esc(d.raw)}</strong>
        <span class="tag">${d.kind === 'company' ? '公司' : '指标'}</span>
        <span class="tag">${d.rows} 行</span>
        ${cur ? `<span class="pill ok">${cur.action === 'merge' ? '并入已有' : '确认新建'}</span>` : ''}
      </div>
      <div class="decide-body">
        <label>并入已有主数据
          <select class="decide-target">${opts}</select>
        </label>
        <button class="decide-merge"${d.candidates.length ? '' : ' disabled'}>并入</button>
        <button class="decide-new">确认是新建</button>
      </div>
      <p class="hint">若上面没有正确的目标，说明它确实是新公司 —— 选「确认是新建」。
        选「并入」后这个写法会被记住，下个月自动归并，不再问。</p>
    </div>`;
  };

  $('stageDecisions').innerHTML = `
    <div class="decide-wrap">
      <h3>待确认名称 <span class="pill warn">${all.length}</span></h3>
      <p class="hint">这些名字第一次出现，但看起来与已有主数据相近。请逐个确认：
        是同一家的不同写法（并入），还是确实是一家新公司（新建）。</p>
      ${all.map(card).join('')}
    </div>`;

  const refresh = () => {
    renderUnresolved(staged.unresolved);
    syncCommitButton();   // 决定了就要立刻放行提交按钮，否则人以为「点了没反应」
  };
  $('stageDecisions').querySelectorAll('.decide').forEach((el) => {
    const key = el.dataset.key;
    const [kind, raw] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    el.querySelector('.decide-merge').addEventListener('click', () => {
      const targetId = el.querySelector('.decide-target').value;
      if (!targetId) return;
      decisions[key] = { kind, raw, action: 'merge', targetId };
      refresh();
    });
    el.querySelector('.decide-new').addEventListener('click', () => {
      decisions[key] = { kind, raw, action: 'create' };
      refresh();
    });
  });
}

$('cancelImport').addEventListener('click', () => {
  staged = null;
  decisions = {};
  $('stageCard').classList.add('hidden');
  $('stageDecisions').innerHTML = '';
  $('filename').textContent = '或把 .xlsx 拖到这里';
});

$('doCommit').addEventListener('click', async () => {
  if (!staged) return;
  const btn = $('doCommit');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const res = await api('/api/import/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        batchId: staged.batchId,
        file: staged.file,
        autoCreateDims: true,
        decisions: Object.values(decisions),
      }),
    });

    // 服务端可能回一个「需要人拍板」的中间状态（HTTP 200，不是错误）——
    // 那种情况下它一行都没写，把待确认项渲染出来让人决定，而不是当成失败。
    if (res.pendingConfirm) {
      staged.unresolved = {
        companies: res.needsDecision.filter((d) => d.kind === 'company'),
        metrics: res.needsDecision.filter((d) => d.kind === 'metric'),
      };
      $('stageIssues').innerHTML = `<div class="issue warn"><span class="lv">待确认</span>
        <span>${res.needsDecision.length} 个名称需要你确认后才能提交。为避免把两家公司的钱静默加在一起，
        系统不会替你决定。</span></div>`;
      renderUnresolved(staged.unresolved);
      syncCommitButton();   // 仍有待确认项时保持 disabled，人做完决定才放行
      return;
    }

    const merged = res.merged?.length
      ? `；自动归并 ${res.merged.length} 个写法（${res.merged.map((m) => `${m.raw}→${m.target}`).join('、')}）`
      : '';
    $('stageIssues').innerHTML = `<div class="issue"><span class="lv">成功</span>
      <span>写入 ${res.inserted.toLocaleString()} 行；新建公司 ${res.createdCompanies.length} 个、指标 ${res.createdMetrics.length} 个${merged}。
      ${res.archived === false ? '<strong>⚠️ Parquet 归档失败，请查看服务端日志</strong>' : ''}</span></div>`;
    $('stageDecisions').innerHTML = '';
    $('doCommit').textContent = '已提交';
    decisions = {};
    await Promise.all([loadBatches(), loadCatalog()]);
  } catch (e) {
    $('stageIssues').innerHTML = `<div class="issue error"><span class="lv">失败</span><span>${e.message}</span></div>`;
    btn.disabled = false;
    btn.textContent = '重试提交';
  }
});

async function loadBatches() {
  try {
    const rows = await api('/api/batches');
    $('batches').innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr>
          <th>批次</th><th>来源文件</th><th>行数</th><th>时间</th><th>状态</th>
        </tr></thead><tbody>${rows.map((b) => `<tr>
          <td><code>${b.batch_id}</code></td>
          <td>${esc(b.source_file.split('/').pop())}</td>
          <td class="num">${Number(b.row_count).toLocaleString()}</td>
          <td>${String(b.imported_at).replace('T', ' ').slice(0, 19)}</td>
          <td>${esc(b.status)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="empty">还没有导入过数据。</p>';
  } catch (e) {
    $('batches').innerHTML = `<p class="empty">加载失败：${e.message}</p>`;
  }
}

// ═══════════════ 2. 看板查询 ═══════════════
let CATALOG = null;
let LAST = null;      // 上次查询结果
let chart = null;

async function loadCatalog() {
  CATALOG = await api('/api/catalog');

  $('qGroup').innerHTML = CATALOG.dimensions
    .map((d) => `<option value="${d.name}">${d.label}</option>`).join('');

  $('qCompany').innerHTML = CATALOG.companies
    .map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');

  $('qMetric').innerHTML = CATALOG.metrics
    .map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');

  const periods = CATALOG.periodTypes.filter((p) => !p.derivable);
  $('qPeriod').innerHTML = periods
    .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');

  const years = [...new Set(CATALOG.periodTypes.length ? await fetchYears() : [])];
  $('qYear').innerHTML = `<option value="">全部</option>` +
    years.map((y) => `<option value="${y}">${y}</option>`).join('');

  // 默认选中常用项 —— 让用户一进来就能查到东西
  ['company'].forEach((v) => sel($('qGroup'), v));
  sel($('qMetric'), CATALOG.metrics[0]?.name);
  sel($('qPeriod'), periods[0]?.id);
}

async function fetchYears() {
  try {
    const r = await api('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        measures: [{ metric: CATALOG.metrics[0]?.name ?? '', periodType: CATALOG.periodTypes[0]?.id ?? '' }],
        groupBy: ['year'],
      }),
    });
    return r.groups ? r.groups.map((g) => g.values[0]).filter(Boolean) : [];
  } catch { return []; }
}

const sel = (el, v) => { for (const o of el.options) if (o.value === v) o.selected = true; };
const vals = (el) => [...el.selectedOptions].map((o) => o.value);

$('doQuery').addEventListener('click', async () => {
  const measures = [];
  for (const metric of vals($('qMetric'))) for (const periodType of vals($('qPeriod'))) measures.push({ metric, periodType });
  if (!measures.length) return alert('请至少选择一个指标和一个口径');

  const groupBy = vals($('qGroup'));
  const filter = {};
  if (vals($('qCompany')).length) filter.company = vals($('qCompany'));
  if ($('qYear').value) filter.year = $('qYear').value;

  const btn = $('doQuery');
  btn.disabled = true;
  btn.textContent = '查询中…';
  try {
    const res = await api('/api/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ measures, groupBy, filter }),
    });
    if (res.refused) {
      $('resultCard').classList.remove('hidden');
      $('resultTable').innerHTML = `<p class="empty">已拒绝：${esc(res.message)}</p>`;
      $('resultMeta').textContent = '';
      return;
    }
    LAST = res;
    renderResult(res, groupBy);
  } catch (e) {
    alert(`查询失败：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '查询';
  }
});

function renderResult(res, groupBy) {
  $('resultCard').classList.remove('hidden');
  $('resultMeta').textContent =
    `${res.meta.rowCount} 行 × ${res.columns.length} 列 · ${res.meta.rowCount * res.columns.length} 格`;

  const head = [...groupBy.map((g) => dimLabel(g)), ...res.columns.map((c) => c.label)];
  const body = res.groups.map((g) => `<tr>
      ${g.values.map((v) => `<td>${esc(v ?? '—')}</td>`).join('')}
      ${g.cells.map((c) => `<td class="num">${typeof c === 'number' ? fmt(c) : esc(String(c ?? '—'))}</td>`).join('')}
    </tr>`).join('');

  $('resultTable').innerHTML = `<div class="table-wrap"><table>
    <thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

$('doChart').addEventListener('click', async () => {
  if (!LAST) return;
  const measures = [];
  for (const metric of vals($('qMetric'))) for (const periodType of vals($('qPeriod'))) measures.push({ metric, periodType });
  const filter = {};
  if (vals($('qCompany')).length) filter.company = vals($('qCompany'));
  if ($('qYear').value) filter.year = $('qYear').value;

  try {
    const res = await api('/api/chart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: { measures, groupBy: vals($('qGroup')), filter },
        chart: { type: $('chartType').value, stacked: $('chartStacked').checked },
      }),
    });
    $('chart').classList.remove('hidden');
    if (!chart) chart = echarts.init($('chart'), null, { renderer: 'canvas' });
    chart.setOption(res.option, true);
    chart.resize();
  } catch (e) {
    alert(`出图失败：${e.message}`);
  }
});

window.addEventListener('resize', () => chart && chart.resize());

// ═══════════════ 3. 报表报送 ═══════════════
let currentSpec = null;
const reportCharts = [];

// ── 从模板生成 spec 草稿（§7.2 路径 1）──
let inferred = null;   // { template, specId, yaml, blocks, guessed, unmatched, issues }

$('tplPick').addEventListener('click', () => $('tplFile').click());
$('tplFile').addEventListener('change', (e) => { if (e.target.files[0]) inferTemplate(e.target.files[0]); });

{
  const tdz = $('tplDrop');
  ['dragenter', 'dragover'].forEach((ev) => tdz.addEventListener(ev, (e) => {
    e.preventDefault(); tdz.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => tdz.addEventListener(ev, (e) => {
    e.preventDefault(); tdz.classList.remove('over');
  }));
  tdz.addEventListener('drop', (e) => {
    if (e.dataTransfer.files[0]) inferTemplate(e.dataTransfer.files[0]);
  });
}

async function inferTemplate(file) {
  $('tplMsg').textContent = `${file.name}（${(file.size / 1024).toFixed(0)} KB）· 解析中…`;
  $('tplResult').innerHTML = '';
  try {
    const res = await fetch('/api/template/infer', {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' },
      body: await file.arrayBuffer(),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    inferred = body;
    $('tplMsg').textContent = `${file.name} · 识别出 ${body.blocks.length} 个数据区`;
    renderInference(body);
  } catch (e) {
    // 识别不出数据区是常见的用户错误（模板没有表头），要说清原因而不是静默失败
    $('tplMsg').textContent = '解析失败';
    $('tplResult').innerHTML = `<div class="issue err"><span class="lv">失败</span><span>${esc(e.message)}</span></div>`;
  }
}

function renderInference(inf) {
  let html = '';

  if (inf.issues.length) {
    html += `<h3>需要人工确认（${inf.issues.length}）</h3>`;
    html += inf.issues.map((i) => `<div class="issue ${i.level}">
        <span class="lv">${i.level === 'error' ? '错误' : '提示'}</span>
        <span>${esc(i.sheet)}：${esc(i.message)}</span></div>`).join('');
  }

  if (inf.unmatched.length) {
    const names = inf.unmatched.flatMap((u) => u.names);
    html += `<h3>未识别的名称（${names.length}）</h3>
      <div class="issue warn"><span class="lv">主数据</span><span>${esc(names.join('、'))}</span></div>
      <p class="hint">这些名字不在注册表里。若是别名（如「集团有限公司」vs「集团公司」），
        必须先建映射 —— 否则同一家公司会被拆成两条主数据（文档 R1）。</p>`;
  }

  html += `<h3>识别结果</h3>`;
  for (const b of inf.blocks) {
    // InferredAxis = { dim, order, source, evidence }（见 src/spec/infer.ts）
    const axis = (a, axisName) => `
      <tr>
        <td>${axisName}</td>
        <td><code>${esc(a.dim)}</code></td>
        <td>${a.source === 'guessed'
          ? '<span class="pill err">猜的</span>'
          : '<span class="pill ok">读到的</span>'}</td>
        <td>${a.order.length} 项</td>
        <td class="tiny">${esc(a.order.join('、'))}<br><span class="ev">${esc(a.evidence)}</span></td>
      </tr>`;
    html += `<div class="spec-item" style="display:block">
      <div class="meta"><b>${esc(b.sheet)}</b>
        <span>锚点 <code>${esc(typeof b.anchor === 'object' ? b.anchor.name : b.anchor)}</code> · ${esc(b.anchorNote)}</span></div>
      <table class="mini" style="margin-top:8px">
        <tr><th>轴</th><th>维度</th><th>来源</th><th>数量</th><th>取值 / 依据</th></tr>
        ${axis(b.rows, '行')}
        ${axis(b.cols, '列')}
      </table>
      ${b.excluded.length ? `<p class="hint">已排除 ${b.excluded.length} 行：${
        b.excluded.map((e) => `第 ${e.row} 行${e.label ? `「${esc(e.label)}」` : ''}`).join('、')
      } —— ${esc(b.excluded[0].reason)}</p>` : ''}
    </div>`;
  }

  html += `<h3>spec 草稿</h3>
    <p class="hint">下面是推断出的 YAML。<b>推断只是草稿</b>：请核对带「猜的」标记的轴后再保存。</p>
    <textarea id="specYaml" class="yaml-editor" spellcheck="false">${esc(inf.yaml)}</textarea>
    <div id="specLint" class="spec-lint"></div>
    <div class="actions" style="margin-top:8px">
      <button class="primary" id="saveSpec">保存到 specs/</button>
      <span class="hint" id="saveMsg"></span>
    </div>`;

  $('tplResult').innerHTML = html;
  $('saveSpec').addEventListener('click', saveSpec);
  // ★ 边改边诊断：把"保存时被拒"提前成"打字时就看见哪里错"。
  //   对路径 2（自然语言 → spec）尤其重要 —— agent 写出的草稿常常漏掉指标约束，
  //   而那种错**语法完全合法**，只有诊断能提前发现。
  $('specYaml').addEventListener('input', () => scheduleLint());
  scheduleLint();
}

let lintTimer = null;

/** 防抖：打字时不必每个字符都打一次服务端 */
function scheduleLint() {
  clearTimeout(lintTimer);
  lintTimer = setTimeout(runLint, 250);
}

async function runLint() {
  const box = $('specLint');
  const yaml = $('specYaml')?.value;
  if (!box || !yaml) return;
  box.innerHTML = '<span class="hint">检查中…</span>';
  let d;
  try {
    d = await api('/api/specs/lint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yaml }),
    });
  } catch (e) {
    box.innerHTML = `<span class="hint">诊断失败：${esc(e.message)}</span>`;
    return;
  }

  const btn = $('saveSpec');
  if (btn) btn.disabled = d.willBeRejected;

  if (d.parseError) {
    box.innerHTML = `<div class="issue err"><span class="lv">YAML 语法</span><span>${esc(d.parseError)}</span></div>`;
    return;
  }
  if (d.willBeRejected) {
    // ⚠️ 注意别把 `a + b ? c : d` 写在一起：`+` 比 `?:` 先算，
    //    整个字符串变成条件，永远走真分支。分开放进数组再 join。
    const parts = [
      `<div class="issue err"><span class="lv">无法保存</span>
        <span>这份 spec 有 ${d.errors.length} 处必须先改 —— 否则会算出一个看起来正常、其实是错的数。</span></div>`,
    ];
    for (const i of d.issues.filter((x) => x.level === 'error')) {
      parts.push(`<div class="issue err"><span class="lv">错误</span>
        <span><code>${esc(i.at)}</code>：${esc(i.message)}${
          i.hint ? `<br><span class="ev">→ ${esc(i.hint)}</span>` : ''
        }</span></div>`);
    }
    if (d.unusedParams.length) {
      parts.push(`<div class="issue err"><span class="lv">参数</span>
        <span>params 里的 ${esc(d.unusedParams.join(', '))} 从未被引用 ——
          这通常意味着报表没有按参数过滤时间，会把所有期间加总。</span></div>`);
    }
    box.innerHTML = parts.join('');
    return;
  }
  const warns = d.issues.filter((i) => i.level === 'warn');
  box.innerHTML = warns.length
    ? `<div class="issue warn"><span class="lv">可保存</span>
         <span>结构上没问题，但有 ${warns.length} 条提醒（不挡保存）。</span></div>` +
      warns.map((i) => `<div class="issue warn"><span class="lv">提醒</span>
        <span><code>${esc(i.at)}</code>：${esc(i.message)}</span></div>`).join('')
    : `<div class="issue ok"><span class="lv">通过</span>
         <span>没有发现问题，可以保存。</span></div>`;
}

async function saveSpec() {
  const yaml = $('specYaml').value;
  const id = inferred?.specId ?? '推断的报表';
  $('saveMsg').textContent = '保存中…';
  try {
    const res = await api('/api/specs/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, yaml }),
    });
    $('saveMsg').textContent = `已保存 ${res.file}`;
    await loadSpecs();
  } catch (e) {
    // 校验不通过的 spec 会被服务端拒绝 —— 这是刻意的（防"静默算错"）
    $('saveMsg').textContent = '';
    $('specLint').insertAdjacentHTML('afterbegin',
      `<div class="issue err"><span class="lv">拒绝保存</span><span>${esc(e.message)}</span></div>`);
  }
}

async function loadSpecs() {
  try {
    const specs = await api('/api/specs');
    $('specs').innerHTML = specs.length
      ? specs.map((s) => `<div class="spec-item">
          <div class="meta">
            <b>${esc(s.title)}</b>
            <span><code>${esc(s.file)}</code>${s.error ? ` · <span style="color:var(--err)">${esc(s.error)}</span>` : ` · ${s.sheets} 个 sheet`}</span>
          </div>
          <button ${s.error ? 'disabled' : ''} data-spec="${esc(s.file)}" data-title="${esc(s.title)}">打开</button>
        </div>`).join('')
      : '<p class="empty">specs/ 目录下还没有 .yaml 报表定义。</p>';

    $('specs').querySelectorAll('button[data-spec]').forEach((b) => {
      b.addEventListener('click', () => openSpec(b.dataset.spec, b.dataset.title));
    });
  } catch (e) {
    $('specs').innerHTML = `<p class="empty">加载失败：${e.message}</p>`;
  }
}

async function openSpec(file, title) {
  currentSpec = file;
  $('reportCard').classList.remove('hidden');
  $('reportTitle').textContent = title;
  $('rYear').value = new Date().getFullYear();
  $('rMonth').value = 6;
  $('reportPreview').innerHTML = '';
  $('reportCharts').innerHTML = '';
  $('renderMsg').textContent = '';
  await previewReport();
}

$('doPreview').addEventListener('click', previewReport);

async function previewReport() {
  if (!currentSpec) return;
  try {
    const res = await api('/api/report/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ specFile: currentSpec, params: { year: +$('rYear').value, month: +$('rMonth').value } }),
    });

    $('reportPreview').innerHTML = res.sheets.map((s) => s.blocks.map((b) => `
      <div style="margin-top:14px">
        <p class="hint">sheet「${esc(s.name)}」· 锚点 ${esc(String(typeof b.anchor === 'object' ? b.anchor.name : b.anchor))}</p>
        <div class="table-wrap"><table>
          <thead><tr><th></th>${b.colLabels.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${b.matrix.map((r) => `<tr><td>${esc(r.label)}</td>
            ${r.values.map((v) => `<td class="num">${v === null ? '—' : fmt(v)}</td>`).join('')}</tr>`).join('')}
          </tbody></table></div>
      </div>`).join('')).join('');

    // 图表渲染器：与 Excel 同源，同一份 spec
    reportCharts.forEach((c) => c.dispose());
    reportCharts.length = 0;
    $('reportCharts').innerHTML = res.charts.map((_, i) => `<div id="rc${i}" class="chart"></div>`).join('');
    res.charts.forEach((c, i) => {
      const inst = echarts.init($(`rc${i}`));
      inst.setOption(c.option);
      reportCharts.push(inst);
    });

    $('renderMsg').textContent = `计划：${res.plan.totalCells} 个数据格（预览只含坐标与形状）`;
  } catch (e) {
    $('reportPreview').innerHTML = `<p class="empty">预览失败：${esc(e.message)}</p>`;
  }
}

$('doRender').addEventListener('click', async () => {
  if (!currentSpec) return;
  const btn = $('doRender');
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    const res = await api('/api/report/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ specFile: currentSpec, params: { year: +$('rYear').value, month: +$('rMonth').value } }),
    });
    $('renderMsg').innerHTML = `已写入 ${res.cellsWritten} 格，保留模板原格式 ${res.formatKept} 格。
      <a href="${res.download}">下载 ${res.outputPath.split('/').pop()}</a>${res.warnings.length ? ` · ${res.warnings.join('；')}` : ''}`;
  } catch (e) {
    $('renderMsg').textContent = `导出失败：${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = '导出 Excel';
  }
});

// ═══════════════ 工具 ═══════════════
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function dimLabel(name) {
  return CATALOG?.dimensions.find((d) => d.name === name)?.label ?? name;
}

// ═══════════════ 启动 ═══════════════
(async () => {
  try {
    await loadCatalog();
    $('conn').textContent = '本机运行';
    $('conn').className = 'pill ok';
  } catch (e) {
    $('conn').textContent = `未连接：${e.message}`;
    $('conn').className = 'pill err';
  }
  await loadBatches();
  await loadSpecs();
  await igLoadSpecs();
  hashTab();
})();
