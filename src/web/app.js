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
let staged = null;   // 待提交的批次

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
    html += `<p class="hint">以下名称是第一次出现，提交时会自动建档。
      若只是别名（如「集团有限公司」vs「集团公司」），请先改数据源或建别名映射 —— 
      否则同一家公司会被拆成两条主数据。</p>
      <div class="issue warn"><span class="lv">新</span><span>${unknown.join('、')}</span></div>`;
  }
  html += s.issues.length
    ? s.issues.map((i) => `<div class="issue ${i.level}">
        <span class="lv">${i.level === 'error' ? '错误' : '提醒'}</span>
        <span>${i.row ? `第 ${i.row} 行：` : ''}${i.message}</span></div>`).join('')
    : '<p class="hint">没有任何问题。</p>';

  $('stageIssues').innerHTML = html;
  $('doCommit').disabled = failed;
  $('doCommit').textContent = `确认无误，提交入库（${s.rowCount.toLocaleString()} 行）`;
}

$('cancelImport').addEventListener('click', () => {
  staged = null;
  $('stageCard').classList.add('hidden');
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
      body: JSON.stringify({ batchId: staged.batchId, file: staged.file, autoCreateDims: true }),
    });
    $('stageIssues').innerHTML = `<div class="issue"><span class="lv">成功</span>
      <span>写入 ${res.inserted.toLocaleString()} 行；新建公司 ${res.createdCompanies.length} 个、指标 ${res.createdMetrics.length} 个。</span></div>`;
    $('doCommit').textContent = '已提交';
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
    <textarea id="specYaml" spellcheck="false">${esc(inf.yaml)}</textarea>
    <div class="actions" style="margin-top:8px">
      <button class="primary" id="saveSpec">保存到 specs/</button>
      <span class="hint" id="saveMsg"></span>
    </div>`;

  $('tplResult').innerHTML = html;
  $('saveSpec').addEventListener('click', saveSpec);
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
    $('tplResult').insertAdjacentHTML('beforeend',
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
  hashTab();
})();
