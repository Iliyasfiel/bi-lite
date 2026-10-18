import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import XLSXPopulate from 'xlsx-populate';
import {
  applySemanticChanges,
  createSemanticSnapshot,
  semanticProjection,
} from '../src/authoring/semantic.ts';
import {
  AUTHORING_MODEL_LEASE_MS,
  acquireAuthoringModelLease,
  appendAuthoringMessage,
  authoringTaskView,
  cancelAuthoringTask,
  clearExpiredAuthoringLease,
  getAuthoringTask,
  listAuthoringTasks,
  inspectAuthoringLease,
  markAuthoringFailed,
  recoverAuthoringTask,
  reserveAuthoringModelRun,
  resumeAuthoringTask,
  saveAuthoringDraft,
  selectAuthoringDirection,
  startAuthoringTask,
  type AuthoringTask,
} from '../src/authoring/tasks.ts';
import { validateCandidate, validateExportCandidate } from '../src/authoring/candidates.ts';
import { applyAuthoringProposal } from '../src/authoring/proposals.ts';
import { runSharedAuthoringTurn } from '../src/authoring/session.ts';
import { runInteractiveAuthoring } from '../src/authoring/interactive.ts';
import { inspectAuthoringTask, previewAuthoringSend } from '../src/authoring/inspect.ts';
import { createTemplateTask } from '../src/authoring/attachment.ts';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { serializeAuthoringContext } from '../src/authoring/pi.ts';
import { DEFAULT_AUTHORING_MAX_PROMPT_CHARS } from '../src/authoring/limits.ts';
import { contractExamples } from '../src/authoring/contract.ts';
import { preparePublication, publishConfirmedPlan, recoverPublication } from '../src/authoring/publish.ts';
import { assertPublicationReadable } from '../src/runtime/publication.ts';
import { loadMetrics } from '../src/metrics/definitions.ts';
import { runSpecWorkflow } from '../src/authoring/workflow.ts';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-lite-authoring-a-'));

function initWorkspace(): void {
  fs.writeFileSync(path.join(workspace, 'bilite.config.json'), JSON.stringify({
    workspace: true,
    version: 1,
  }), { flag: 'wx' });
  for (const dir of ['models', 'metrics', 'ingest', 'specs', 'templates', 'data', 'output']) {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  }
}

async function blankTemplate(): Promise<Buffer> {
  const workbook = await XLSXPopulate.fromBlankAsync();
  workbook.sheet(0).name('报送表');
  workbook.sheet(0).cell('A1').value('指标');
  workbook.sheet(0).cell('B1').value('本年累计');
  workbook.sheet(0).cell('A2').value('营业收入');
  workbook.sheet(0).cell('B2').formula('A2*1');
  return Buffer.from(await workbook.outputAsync());
}

function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

try {
  assert.equal(
    process.moduleLoadList.some((entry) => entry.includes('@duckdb')),
    false,
    '规格制定测试不应加载 DuckDB',
  );
  initWorkspace();
  // Reproduce the user's first turn on the actual blank 18-period template.
  // Preview and provider must count the same single system prompt and tool set.
  const realTemplate = await startAuthoringTask({ filename: '18期经营报送模板.xlsx',
    bytes: fs.readFileSync(new URL('../templates/18期经营报送模板.xlsx', import.meta.url)), workspace });
  let realTask = selectAuthoringDirection({ taskId: realTemplate.task.id,
    expectedRevision: realTemplate.task.revision, direction: 'ingest', workspace });
  const realPreview = previewAuthoringSend(realTask, 'hello?');
  const realFaux = fauxProvider();
  realFaux.setResponses([(context) => {
    assert.equal(context.messages.filter(m => m.role === 'system').length, 1);
    assert.deepEqual(getCurrentTools(context.messages).map(t => t.name), ['submit_authoring_proposal']);
    assert.equal(serializeAuthoringContext(context.messages).length, realPreview.promptChars);
    const now = getAuthoringTask(realTask.task.id, workspace);
    return fauxAssistantMessage([fauxToolCall('submit_authoring_proposal', {
      expectedRevision: now.task.revision, expectedDraftVersion: null, direction: 'ingest',
      yaml: `id: draft\nsheets: []\n#${'x'.repeat(80_000)}\n`,
      declarationChanges: [], unresolved: [], note: '本地诊断后继续澄清。',
    })], { stopReason: 'toolUse' });
  }, context => {
    const chars = serializeAuthoringContext(context.messages).length;
    assert.ok(chars > 24_000 && chars < DEFAULT_AUTHORING_MAX_PROMPT_CHARS);
    assert.ok(context.messages.some(m => m.role === 'toolResult'));
    return fauxAssistantMessage('请说明接入表的主体、期间与指标。');
  }]);
  const realTurn = await runSharedAuthoringTurn({ taskId: realTask.task.id,
    expectedRevision: realTask.task.revision, userText: 'hello?', workspace,
    runtime: { apiKey: 'fake', providerStreams: realFaux.provider } });
  assert.equal(realTurn.errorMessage, undefined);
  assert.equal(realFaux.state.callCount, 2);
  realTask = appendAuthoringMessage({ taskId: realTask.task.id,
    expectedRevision: realTurn.task.task.revision, role: 'assistant', kind: 'message',
    text: '长历史', providerMessage: fauxAssistantMessage('x'.repeat(DEFAULT_AUTHORING_MAX_PROMPT_CHARS)), workspace });
  assert.throws(() => previewAuthoringSend(realTask, '继续'), /本地上下文预算超限.*非供应商/);
  await assert.rejects(runSharedAuthoringTurn({ taskId: realTask.task.id,
    expectedRevision: realTask.task.revision, userText: '继续', workspace,
    runtime: { apiKey: 'fake', providerStreams: realFaux.provider } }), /AUTHORING_CONTEXT_TOO_LARGE/);
  assert.equal(getAuthoringTask(realTask.task.id, workspace).task.modelRuns, 1);
  const empty = createSemanticSnapshot(workspace);
  // The examples shown to the model must satisfy the actual declaration and
  // spec validators; they must never be installed as business defaults.
  const guideCandidate = applySemanticChanges(empty, empty.fingerprint, [
    ...contractExamples.models.map(file => ({ path: `models/${file.name}`, content: file.text })),
    ...contractExamples.metrics.map(file => ({ path: `metrics/${file.file}`, content: file.text })),
  ]);
  assert.deepEqual(guideCandidate.issues, []);
  for (const direction of ['ingest', 'export'] as const) {
    const checked = validateCandidate(direction, contractExamples[`${direction}Spec`], guideCandidate);
    assert.equal(checked.ok, true, JSON.stringify(checked.diagnostics));
  }
  assert.deepEqual(empty.facts, []);
  assert.deepEqual(empty.metrics, []);
  assert.deepEqual(empty.issues, []);
  assert.equal(fs.existsSync(path.join(workspace, 'data/authoring.duckdb')), false);

  const rejected = await createTemplateTask('损坏.xlsx', Buffer.from('not an xlsx'), workspace);
  assert.equal(rejected.status, 'template-unsupported');
  assert.equal(fs.existsSync(rejected.template.path), false);

  const task = await startAuthoringTask({
    filename: '空白报送模板.xlsx',
    bytes: await blankTemplate(),
    workspace,
  });
  assert.equal(task.task.status, 'awaiting-direction');
  assert.equal(task.task.direction, null);
  assert.equal(task.task.modelRuns, 0);
  assert.equal(task.attachment.projection?.sheets[0]?.cells.some((cell) =>
    cell.text === '营业收入'), true);
  assert.equal(JSON.stringify(semanticProjection(createSemanticSnapshot(workspace)))
    .includes(task.attachment.template.path), false);

  assert.throws(
    () => selectAuthoringDirection({
      taskId: task.task.id,
      expectedRevision: task.task.revision - 1,
      direction: 'export',
      workspace,
    }),
    /修订/,
  );

  const directed = selectAuthoringDirection({
    taskId: task.task.id,
    expectedRevision: task.task.revision,
    direction: 'export',
    workspace,
  });
  assert.equal(directed.task.status, 'conversing');
  assert.equal(directed.task.direction, 'export');

  const reserved = reserveAuthoringModelRun({
    taskId: task.task.id,
    expectedRevision: directed.task.revision,
    workspace,
  });
  assert.equal(reserved.task.modelRuns, 1);
  assert.throws(
    () => reserveAuthoringModelRun({
      taskId: task.task.id,
      expectedRevision: directed.task.revision,
      workspace,
    }),
    /修订/,
  );

  const withMessage = appendAuthoringMessage({
    taskId: task.task.id,
    expectedRevision: reserved.task.revision,
    role: 'user',
    kind: 'message',
    text: '指标列使用本年累计，报告期为 2026-06。',
    workspace,
  });
  assert.deepEqual(withMessage.task.messages.map((message) =>
    [message.sequence, message.role, message.text]), [
    [1, 'user', '指标列使用本年累计，报告期为 2026-06。'],
  ]);

  const draft = saveAuthoringDraft({
    taskId: task.task.id,
    expectedRevision: withMessage.task.revision,
    direction: 'export',
    yaml: 'id: draft\ntemplate: templates/empty.xlsx\nsheets: []\n',
    diagnostics: [{ code: 'SHEET_NO_BLOCK', at: 'sheets', message: '至少需要一个 sheet。' }],
    unresolved: ['主体范围尚未确定'],
    workspace,
  });
  assert.equal(draft.task.drafts.export?.version, 1);
  assert.equal(draft.task.status, 'conversing');

  const cancelled = cancelAuthoringTask({
    taskId: task.task.id,
    expectedRevision: draft.task.revision,
    retain: true,
    workspace,
  });
  assert.equal(cancelled.task.status, 'retained');
  assert.throws(
    () => saveAuthoringDraft({
      taskId: task.task.id,
      expectedRevision: cancelled.task.revision,
      direction: 'export',
      yaml: 'id: late\nsheets: []\n',
      workspace,
    }),
    /modelRuns|取消|保留/,
  );
  assert.equal(cancelled.task.status, 'retained');

  const resumed = resumeAuthoringTask({
    taskId: task.task.id,
    expectedRevision: cancelled.task.revision,
    workspace,
  });
  assert.equal(resumed.task.status, 'conversing');
  assert.equal(getAuthoringTask(task.task.id, workspace).task.drafts.export?.version, 1);

  const failed = markAuthoringFailed({
    taskId: task.task.id,
    expectedRevision: resumed.task.revision,
    code: 'PROVIDER_FAILURE',
    message: '供应商请求失败',
    workspace,
  });
  assert.equal(failed.task.status, 'failed');
  assert.equal(failed.task.drafts.export?.version, 1);

  const recovered = recoverAuthoringTask(task.task.id, workspace);
  assert.equal(recovered.task.origin, 'new');
  assert.equal(recovered.task.status, 'failed');

  const modelText = `kind: fact
title: 空白报送事实
grain: [fin_month, period_from, company_id, metric_id, scenario, ccy]
queryDefaults: { scenario: 实际, ccy: 人民币 }
windowFrom: period_from
calibers:
  - { name: 本年累计, from: year_start }
keys:
  - { name: fin_month, type: date, key: true, notNull: true, semantic: period }
  - { name: period_from, type: date, key: true, notNull: true }
  - { name: company_id, type: varchar, role: dim_fk, key: true, refs: dim_company, notNull: true }
  - { name: metric_id, type: varchar, role: dim_fk, key: true, refs: dim_metric, notNull: true }
  - { name: scenario, type: varchar, key: true, notNull: true, semantic: scenario }
  - { name: ccy, type: varchar, key: true, notNull: true, semantic: ccy }
measures:
  - { name: amount, type: "decimal(18,2)", unit: 元, semantic: money }
provenance:
  - { name: batch_id, type: varchar }
`;
  const company = `kind: dimension
title: 主体
keys:
  - { name: id, type: varchar, key: true, notNull: true }
  - { name: name, type: varchar, notNull: true }
`;
  const metric = `kind: dimension
title: 指标
keys:
  - { name: id, type: varchar, key: true, notNull: true }
  - { name: name, type: varchar, notNull: true }
`;
  const metricYaml = `metrics:
  - id: revenue
    name: 营业收入
    unit: 元
    category: 规模指标
    fact: fact_reporting
`;

  const candidate = applySemanticChanges(empty, empty.fingerprint, [
    { path: 'models/fact_reporting.yml', content: modelText },
    { path: 'models/dim_company.yml', content: company },
    { path: 'models/dim_metric.yml', content: metric },
    { path: 'metrics/reporting.yml', content: metricYaml },
  ]);
  assert.deepEqual(candidate.issues, []);
  assert.deepEqual(candidate.facts.map((fact) => fact.name), ['fact_reporting']);
  assert.deepEqual(candidate.definitions.map((def) => def.id), ['revenue']);
  assert.equal(fs.existsSync(path.join(workspace, 'models/fact_reporting.yml')), false);
  assert.equal(fs.existsSync(path.join(workspace, 'metrics/reporting.yml')), false);

  const ingestYaml = `id: reporting
source: data/empty.xlsx
target: fact_reporting
sheets:
  - name: 报送表
    blocks:
      - anchor: D2
        rows:
          - { col: A, dim: company }
          - { col: B, dim: metric }
        values:
          columns: [D]
          periodTypes: [本年累计]
          transforms:
            - { fromUnit: 万元, toUnit: 元 }
        keys:
          - { col: C, as: period }
          - { as: scenario, value: 实际 }
          - { as: ccy, value: 人民币 }
`;
  const ingest = validateCandidate('ingest', ingestYaml, candidate);
  assert.equal(ingest.ok, true, JSON.stringify(ingest, null, 2));
  assert.equal(ingest.summary?.fact, 'fact_reporting');
  assert.ok(ingest.summary?.transforms.some((value) => value.includes('万元 → 元')));

  const exportYaml = `id: reporting
template: templates/empty.xlsx
fact: fact_reporting
params:
  year: 2026
  month: 6
sheets:
  - name: 报送表
    blocks:
      - anchor: B2
        rows:
          dim: metric
          order: [revenue]
        cols:
          dim: period_type
          order: [本年累计]
        value:
          measure: amount
          agg: sum
        scope:
          company:
            filter:
              name: 示例公司
          time:
            year: "{{year}}"
            month: "{{month}}"
`;
  const report = validateCandidate('export', exportYaml, candidate);
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(report.summary?.fact, 'fact_reporting');
  assert.deepEqual(report.summary?.metrics, ['revenue']);

  const formulaProtected = validateExportCandidate(exportYaml, candidate, {
    sheets: [{
      name: '报送表',
      usedRange: 'A1:E10',
      mergedCells: ['A2:B2'],
      formulaCells: ['B2'],
    }],
    anchors: [],
  });
  assert.equal(formulaProtected.ok, false);
  assert.deepEqual(formulaProtected.summary?.fillAreas, ['报送表!B2: 1 行 × 1 列']);
  assert.deepEqual(formulaProtected.summary?.protectedFormulaCells, ['报送表!B2']);
  assert.ok(formulaProtected.diagnostics.some((entry) =>
    entry.code === 'FORMULA_CELL_COLLISION' && entry.message.includes('B2')));
  assert.ok(formulaProtected.diagnostics.some((entry) =>
    entry.code === 'MERGED_CELL_COLLISION' && entry.message.includes('B2')));

  const outOfBounds = validateExportCandidate(exportYaml, candidate, {
    sheets: [{
      name: '报送表',
      usedRange: 'A1:A1',
      mergedCells: [],
      formulaCells: [],
    }],
    anchors: [],
  });
  assert.equal(outOfBounds.ok, false);
  assert.ok(outOfBounds.diagnostics.some((entry) => entry.code === 'FILL_RANGE_OUT_OF_BOUNDS'));

  const proposalTask = await startAuthoringTask({
    filename: '提案模板.xlsx',
    bytes: await blankTemplate(),
    workspace,
  });
  const proposalDirected = selectAuthoringDirection({
    taskId: proposalTask.task.id,
    expectedRevision: proposalTask.task.revision,
    direction: 'ingest',
    workspace,
  });
  const exportTask = await startAuthoringTask({
    filename: '导出提案模板.xlsx',
    bytes: await blankTemplate(),
    workspace,
  });
  const exportDirected = selectAuthoringDirection({
    taskId: exportTask.task.id,
    expectedRevision: exportTask.task.revision,
    direction: 'export',
    workspace,
  });
  const exportProposal = applyAuthoringProposal({
    expectedRevision: exportDirected.task.revision,
    expectedDraftVersion: null,
    direction: 'export',
    yaml: exportYaml,
    declarationChanges: [
      { path: 'models/fact_reporting.yml', content: modelText },
      { path: 'models/dim_company.yml', content: company },
      { path: 'models/dim_metric.yml', content: metric },
      { path: 'metrics/reporting.yml', content: metricYaml },
    ],
    unresolved: [],
    note: '检查导出填充区与模板公式。',
  }, {
    taskId: exportTask.task.id,
    direction: 'export',
    expectedRevision: exportDirected.task.revision,
    candidateFingerprint: exportDirected.task.declarationFingerprint,
    workspace,
  });
  assert.equal(exportProposal.task.task.drafts.export, null);
  assert.ok(exportProposal.validation.diagnostics.some((entry) =>
    entry.code === 'FORMULA_CELL_COLLISION'));
  const firstProposal = applyAuthoringProposal({
    expectedRevision: proposalDirected.task.revision,
    expectedDraftVersion: null,
    direction: 'ingest',
    yaml: 'id: broken\ntarget: fact_reporting\nsheets:\n  - name: 报送表\n    columns: []\n    row_blocks: []\n',
    declarationChanges: [],
    unresolved: [],
    note: '先提交一个待诊断的候选。',
  }, {
    taskId: proposalTask.task.id,
    direction: 'ingest',
    expectedRevision: proposalDirected.task.revision,
    candidateFingerprint: proposalDirected.task.declarationFingerprint,
    workspace,
  });
  assert.equal(firstProposal.validation.ok, false);
  assert.equal(firstProposal.task.task.drafts.ingest, null);
  assert.ok(firstProposal.validation.diagnostics.some((entry) => entry.code === 'SHEET_NO_BLOCK'));
  assert.equal(firstProposal.task.task.messages.at(-1)?.kind, 'tool-result');

  const secondProposal = applyAuthoringProposal({
    expectedRevision: firstProposal.task.task.revision,
    expectedDraftVersion: null,
    direction: 'ingest',
    yaml: ingestYaml,
    declarationChanges: [
      { path: 'models/fact_reporting.yml', content: modelText },
      { path: 'models/dim_company.yml', content: company },
      { path: 'models/dim_metric.yml', content: metric },
      { path: 'metrics/reporting.yml', content: metricYaml },
    ],
    unresolved: [],
    note: '按诊断补齐候选并声明所需模型。',
  }, {
    taskId: proposalTask.task.id,
    direction: 'ingest',
    expectedRevision: firstProposal.task.task.revision,
    candidateFingerprint: proposalDirected.task.declarationFingerprint,
    workspace,
  });
  assert.equal(secondProposal.validation.ok, true, JSON.stringify(secondProposal, null, 2));
  assert.equal(secondProposal.task.task.drafts.ingest?.version, 1);
  assert.equal(secondProposal.task.task.drafts.ingest?.declarationReview.length, 4);
  assert.equal(secondProposal.task.task.drafts.ingest?.candidateState?.facts.length, 1);
  assert.equal(secondProposal.task.task.messages.length, 1);
  assert.equal(secondProposal.task.task.status, 'awaiting-confirmation');
  assert.equal(fs.existsSync(path.join(workspace, 'models/fact_reporting.yml')), false);
  const preview = previewAuthoringSend(secondProposal.task, '继续核对期间。');
  assert.equal(preview.draftVersion, 1);
  assert.equal(preview.sendRevision, secondProposal.task.task.revision + 2);
  assert.equal(preview.sendModelRun, secondProposal.task.task.modelRuns + 1);
  assert.ok(preview.prompt.includes(`"revision":${preview.sendRevision}`));
  assert.ok(preview.prompt.includes(`"used":${preview.sendModelRun}`));
  assert.equal(preview.prompt.includes(workspace), false);
  assert.equal(preview.promptSha256.length, 64);
  assert.equal(inspectAuthoringTask(secondProposal.task).draft?.yaml, ingestYaml);
  assert.throws(
    () => applyAuthoringProposal({
      expectedRevision: secondProposal.task.task.revision,
      expectedDraftVersion: 99,
      direction: 'ingest',
      yaml: ingestYaml,
      declarationChanges: [],
      unresolved: [],
      note: '过期草稿版本不应生效。',
    }, {
      taskId: proposalTask.task.id,
      direction: 'ingest',
      expectedRevision: secondProposal.task.task.revision,
      workspace,
    }),
    /草稿版本|PROPOSAL_REVISION_STALE/,
  );

  const failedRevision = applyAuthoringProposal({
    expectedRevision: secondProposal.task.task.revision,
    expectedDraftVersion: 1,
    direction: 'ingest',
    yaml: 'id: broken\ntarget: fact_reporting\nsheets:\n  - name: 报送表\n    blocks:\n      - anchor: D2\n        rows: [{ col: A, dim: company }, { col: B, dim: metric }]\n',
    declarationChanges: [],
    unresolved: [],
    note: '尝试失败后保留上一版有效草稿。',
  }, {
    taskId: proposalTask.task.id,
    direction: 'ingest',
    expectedRevision: secondProposal.task.task.revision,
    candidateFingerprint: secondProposal.task.task.declarationFingerprint,
    workspace,
  });
  assert.equal(failedRevision.validation.ok, false);
  assert.equal(failedRevision.task.task.status, 'conversing');
  assert.equal(failedRevision.task.task.drafts.ingest?.yaml, ingestYaml);
  assert.equal(failedRevision.task.task.drafts.ingest?.version, 1);
  assert.equal(failedRevision.task.task.failedDrafts?.ingest?.diagnostics.some((entry) =>
    entry.code === 'VALUES_NO_COLUMNS'), true);

  const lease = acquireAuthoringModelLease({
    taskId: failedRevision.task.task.id,
    expectedRevision: failedRevision.task.task.revision,
    workspace,
  });
  assert.throws(
    () => acquireAuthoringModelLease({
      taskId: failedRevision.task.task.id,
      expectedRevision: lease.revision,
      workspace,
    }),
    /运行中的模型调用/,
  );
  const renewedLease = lease.renew();
  assert.equal(renewedLease.task.revision, lease.revision);
  const released = lease.release();
  assert.equal(released.task.activeRun, null);
  assert.equal(released.task.modelRuns, failedRevision.task.task.modelRuns + 1);

  const staleLease = acquireAuthoringModelLease({
    taskId: failedRevision.task.task.id,
    expectedRevision: released.task.revision,
    workspace,
    now: Date.now() - AUTHORING_MODEL_LEASE_MS - 1,
  });
  assert.equal(inspectAuthoringLease(failedRevision.task.task.id, workspace).expired, true);
  assert.equal(inspectAuthoringLease(failedRevision.task.task.id, workspace).processAlive, true);
  assert.equal(getAuthoringTask(
    failedRevision.task.task.id,
    workspace,
  ).task.activeRun?.processStart !== undefined, true);
  assert.throws(
    () => clearExpiredAuthoringLease({
      taskId: failedRevision.task.task.id,
      expectedRevision: staleLease.revision,
      workspace,
      processAlive: () => true,
    }),
    /仍在运行/,
  );
  const clearedStaleLease = clearExpiredAuthoringLease({
    taskId: failedRevision.task.task.id,
    expectedRevision: staleLease.revision,
    workspace,
    processAlive: () => false,
  });
  assert.equal(clearedStaleLease.task.activeRun, null);
  assert.throws(
    () => clearExpiredAuthoringLease({
      taskId: failedRevision.task.task.id,
      expectedRevision: clearedStaleLease.task.revision,
      workspace,
    }),
    /没有模型运行租约/,
  );
  assert.throws(
    () => staleLease.renew(),
    /租约已失效/,
  );
  const recoveredLease = acquireAuthoringModelLease({
    taskId: failedRevision.task.task.id,
    expectedRevision: clearedStaleLease.task.revision,
    workspace,
  });
  assert.notEqual(recoveredLease.id, staleLease.id);
  const afterLeaseRecovery = recoveredLease.release();
  assert.equal(afterLeaseRecovery.task.activeRun, null);

  const concurrentTask = await startAuthoringTask({
    filename: '并发检查模板.xlsx',
    bytes: await blankTemplate(),
    workspace,
  });
  const concurrentDirected = selectAuthoringDirection({
    taskId: concurrentTask.task.id,
    expectedRevision: concurrentTask.task.revision,
    direction: 'export',
    workspace,
  });
  const concurrentFaux = fauxProvider({ tokensPerSecond: 5, tokenSize: { min: 20, max: 20 } });
  concurrentFaux.setResponses([fauxAssistantMessage('x'.repeat(400))]);
  const concurrentController = new AbortController();
  const firstConcurrent = runSharedAuthoringTurn({
    taskId: concurrentDirected.task.id,
    expectedRevision: concurrentDirected.task.revision,
    userText: '并发占锁检查。',
    workspace,
    runtime: {
      apiKey: 'fake',
      providerStreams: concurrentFaux.provider,
      maxToolTurns: 2,
    },
    signal: concurrentController.signal,
  });
  const whileRunning = getAuthoringTask(concurrentDirected.task.id, workspace);
  assert.ok(whileRunning.task.activeRun);
  await assert.rejects(
    runSharedAuthoringTurn({
      taskId: concurrentDirected.task.id,
      expectedRevision: whileRunning.task.revision,
      userText: '第二个请求不应进入模型。',
      workspace,
      runtime: {
        apiKey: 'fake',
        providerStreams: fauxProvider().provider,
      },
    }),
    /运行中的模型调用|TASK_REVISION_CONFLICT/,
  );
  concurrentController.abort();
  await firstConcurrent;
  assert.equal(getAuthoringTask(concurrentDirected.task.id, workspace).task.activeRun, null);

  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage('请说明报告期间和场景。')]);
  const sessionTurn = await runSharedAuthoringTurn({
    taskId: failedRevision.task.task.id,
    expectedRevision: afterLeaseRecovery.task.revision,
    userText: '报告期为 2026 年 6 月，场景为实际。',
    workspace,
    runtime: {
      apiKey: 'fake',
      providerStreams: faux.provider,
      maxToolTurns: 2,
    },
  });
  assert.equal(sessionTurn.text, '请说明报告期间和场景。');
  assert.equal(sessionTurn.task.task.modelRuns, 4);
  assert.equal(sessionTurn.task.task.activeRun, null);
  assert.equal(getAuthoringTask(sessionTurn.task.task.id, workspace).task.activeRun, null);
  assert.throws(
    () => cancelAuthoringTask({
      taskId: sessionTurn.task.task.id,
      expectedRevision: sessionTurn.task.task.revision - 1,
      retain: true,
      workspace,
    }),
    /修订/,
  );
  assert.ok(sessionTurn.task.task.messages.some((message) => message.role === 'assistant'));
  assert.ok(sessionTurn.task.task.drafts.ingest?.assistantText.includes('报告期间'));
  assert.equal(JSON.stringify(authoringTaskView(sessionTurn.task)).includes(workspace), false);

  const nextFaux = fauxProvider();
  nextFaux.setResponses([fauxAssistantMessage('请确认是否使用人民币。')]);
  const nextTurn = await runSharedAuthoringTurn({
    taskId: sessionTurn.task.task.id,
    expectedRevision: sessionTurn.task.task.revision,
    userText: '继续完善。',
    workspace,
    runtime: {
      apiKey: 'fake',
      providerStreams: nextFaux.provider,
      maxToolTurns: 2,
    },
  });
  assert.equal(nextTurn.text, '请确认是否使用人民币。');
  assert.deepEqual(nextTurn.task.task.messages.filter((message) => message.kind === 'message')
    .map((message) => [message.role, message.text]), [
    ['user', '报告期为 2026 年 6 月，场景为实际。'],
    ['assistant', '请说明报告期间和场景。'],
    ['user', '继续完善。'],
    ['assistant', '请确认是否使用人民币。'],
  ]);
  assert.equal(nextTurn.task.task.modelRuns, 5);

  const interactiveFaux = fauxProvider();
  interactiveFaux.setResponses([fauxAssistantMessage('交互模式回复。')]);
  const interactiveInput = new PassThrough();
  const interactiveOutput = new PassThrough();
  const interactiveError = new PassThrough();
  let interactiveLog = '';
  interactiveOutput.on('data', (chunk) => { interactiveLog += chunk.toString(); });
  const interactiveLines = ['继续核对交互模式。', '/review', '/quit'];
  const interactivePending = runInteractiveAuthoring({
    taskId: nextTurn.task.task.id,
    expectedRevision: nextTurn.task.task.revision,
    workspace,
    input: interactiveInput,
    output: interactiveOutput,
    error: interactiveError,
    ask: async () => interactiveLines.shift() ?? null,
    runtime: {
      apiKey: 'fake',
      providerStreams: interactiveFaux.provider,
      maxToolTurns: 2,
    },
  });
  const interactiveTurn = await interactivePending;
  assert.equal(interactiveTurn.reason, 'quit');
  assert.equal(interactiveTurn.task.task.modelRuns, 6);
  assert.match(interactiveLog, /交互模式回复/);
  assert.match(interactiveLog, /"taskId"/);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const abortedRevision = interactiveTurn.task.task.revision;
  const abortedTurn = await runSharedAuthoringTurn({
    taskId: interactiveTurn.task.task.id,
    expectedRevision: abortedRevision,
    userText: '不应占用预算',
    workspace,
    runtime: {
      apiKey: 'fake',
      providerStreams: fauxProvider().provider,
    },
    signal: alreadyAborted.signal,
  });
  assert.equal(abortedTurn.stopReason, 'aborted');
  assert.equal(abortedTurn.requestCount, 0);
  assert.equal(abortedTurn.task.task.revision, abortedRevision);
  assert.equal(abortedTurn.task.task.modelRuns, 6);
  assert.equal(getAuthoringTask(interactiveTurn.task.task.id, workspace).task.activeRun, null);
  await assert.rejects(
    runSharedAuthoringTurn({
      taskId: interactiveTurn.task.task.id,
      expectedRevision: abortedRevision,
      userText: '这段上下文应在占用预算前被拒绝。',
      workspace,
      runtime: {
        apiKey: 'fake',
        providerStreams: fauxProvider().provider,
        maxPromptChars: 1,
      },
    }),
    /AUTHORING_CONTEXT_TOO_LARGE/,
  );
  assert.equal(getAuthoringTask(interactiveTurn.task.task.id, workspace).task.modelRuns, 6);
  assert.equal(JSON.stringify(authoringTaskView(getAuthoringTask(
    interactiveTurn.task.task.id,
    workspace,
  ))).includes('activeRun'), false);

  const late = cancelAuthoringTask({
    taskId: interactiveTurn.task.task.id,
    expectedRevision: interactiveTurn.task.task.revision,
    workspace,
  });
  assert.throws(
    () => appendAuthoringMessage({
      taskId: late.task.id,
      expectedRevision: late.task.revision,
      role: 'assistant',
      kind: 'message',
      text: '迟到回复',
      workspace,
    }),
    /任务不存在/,
  );
  assert.throws(() => getAuthoringTask(late.task.id, workspace), /任务不存在/);

  const projectionText = JSON.stringify(semanticProjection(candidate.snapshot));
  assert.equal(projectionText.includes(workspace), false);
  assert.throws(
    () => applySemanticChanges(empty, empty.fingerprint, [
      { path: '../escape.yml', content: 'bad' },
    ]),
    /越界/,
  );

  fs.writeFileSync(path.join(workspace, 'models/fact_reporting.yml'), modelText);
  const changedSnapshot = createSemanticSnapshot(workspace);
  assert.notEqual(changedSnapshot.fingerprint, empty.fingerprint);
  const staleTask = getAuthoringTask(task.task.id, workspace);
  assert.equal(authoringTaskView(staleTask).declarationStale, true);
  assert.throws(
    () => previewAuthoringSend(staleTask, '不应发送'),
    /DECLARATION_FINGERPRINT_STALE/,
  );
  assert.throws(
    () => applySemanticChanges(changedSnapshot, empty.fingerprint, []),
    /声明/,
  );
  fs.rmSync(path.join(workspace, 'models/fact_reporting.yml'));

  // One representative run repairs a failed proposal in the same model turn,
  // then repeats identical user text without losing provider tool receipts.
  const continuous = await startAuthoringTask({ filename: '连续修订.xlsx', bytes: await blankTemplate(), workspace });
  let continuousTask = selectAuthoringDirection({ taskId: continuous.task.id,
    expectedRevision: continuous.task.revision, direction: 'ingest', workspace });
  const declarationChanges = [
    { path: 'models/fact_reporting.yml', content: modelText },
    { path: 'models/dim_company.yml', content: company },
    { path: 'models/dim_metric.yml', content: metric },
    { path: 'metrics/reporting.yml', content: metricYaml },
  ];
  const proposalResponse = (broken: boolean, stale = false) => {
    const now = getAuthoringTask(continuous.task.id, workspace);
    return fauxAssistantMessage([fauxToolCall('submit_authoring_proposal', {
      expectedRevision: stale ? 0 : now.task.revision,
      expectedDraftVersion: now.task.drafts.ingest?.version ?? null,
      direction: 'ingest', yaml: broken ? 'id: broken\nsheets: []\n' : ingestYaml,
      declarationChanges, unresolved: [], note: '按本地诊断修订。',
    })], { stopReason: 'toolUse' });
  };
  const continuousFaux = fauxProvider();
  continuousFaux.setResponses([() => proposalResponse(false, true), () => proposalResponse(true), () => proposalResponse(false),
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'fixture provider failure' })]);
  continuousTask = (await runSharedAuthoringTurn({ taskId: continuous.task.id,
    expectedRevision: continuousTask.task.revision, userText: '继续', workspace,
    runtime: { apiKey: 'fake', providerStreams: continuousFaux.provider, maxToolTurns: 4 },
  })).task;
  assert.equal(continuousTask.task.status, 'failed');
  const receiptCount = continuousTask.task.messages.filter(m => m.kind === 'tool-result').length;
  assert.equal(receiptCount, 3);
  continuousTask = resumeAuthoringTask({ taskId: continuous.task.id,
    expectedRevision: continuousTask.task.revision, workspace });
  assert.equal(continuousTask.task.status, 'awaiting-confirmation');
  continuousFaux.setResponses([fauxAssistantMessage('继续核对。')]);
  continuousTask = (await runSharedAuthoringTurn({ taskId: continuous.task.id,
    expectedRevision: continuousTask.task.revision, userText: '继续', workspace,
    runtime: { apiKey: 'fake', providerStreams: continuousFaux.provider },
  })).task;
  assert.equal(continuousTask.task.messages.filter(m => m.role === 'user' && m.text === '继续').length, 2);
  assert.equal(continuousTask.task.messages.filter(m => m.kind === 'tool-result').length, receiptCount);

  // Both directions publish in isolated empty workspaces. Fail midway through
  // the multi-file ingest commit and verify the read barrier and recovery.
  for (const direction of ['ingest', 'export'] as const) {
    const target = path.join(workspace, `publish-${direction}`);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'bilite.config.json'), '{"workspace":true,"version":1}');
    for (const dir of ['models', 'metrics', 'ingest', 'specs', 'templates', 'data', 'output']) fs.mkdirSync(path.join(target, dir));
    const wb = await XLSXPopulate.fromBlankAsync();
    wb.sheet(0).name('报送表').cell('A1').value('指标');
    wb.sheet(0).cell('A2').value('营业收入');
    wb.sheet(0).cell('B1').value('本年累计');
    wb.sheet(0).cell('B2').style('numberFormat', '#,##0.00');
    const started = await startAuthoringTask({ filename: '发布模板.xlsx', bytes: Buffer.from(await wb.outputAsync()), workspace: target });
    const selected = selectAuthoringDirection({ taskId: started.task.id, expectedRevision: started.task.revision, direction, workspace: target });
    let proposed = applyAuthoringProposal({ expectedRevision: selected.task.revision, expectedDraftVersion: null,
      direction, yaml: direction === 'ingest' ? ingestYaml : exportYaml, declarationChanges, unresolved: [], note: '准备正式保存。',
    }, { taskId: started.task.id, expectedRevision: selected.task.revision, direction, workspace: target }).task;
    const stalePlan = preparePublication(started.task.id, target);
    proposed = applyAuthoringProposal({ expectedRevision: proposed.task.revision, expectedDraftVersion: 1,
      direction, yaml: direction === 'ingest' ? ingestYaml : exportYaml, declarationChanges: [], unresolved: [], note: '重新确认当前版本。',
    }, { taskId: started.task.id, expectedRevision: proposed.task.revision, direction, workspace: target }).task;
    await assert.rejects(publishConfirmedPlan(stalePlan, target), /PUBLICATION_STALE/);
    const plan = preparePublication(started.task.id, target);
    assert.equal(plan.files.filter(f => f.path.startsWith('models/') || f.path.startsWith('metrics/')).length, 4);
    if (direction === 'ingest') {
      await assert.rejects(publishConfirmedPlan(plan, target, n => { if (n === 2) throw new Error('injected commit interruption'); }), /injected/);
      assert.throws(() => assertPublicationReadable(target), /SPEC_PUBLICATION_PENDING/);
      assert.throws(() => loadMetrics(path.join(target, 'metrics')), /SPEC_PUBLICATION_PENDING/);
      const generating = getAuthoringTask(started.task.id, target);
      assert.throws(() => cancelAuthoringTask({ taskId: started.task.id, expectedRevision: generating.task.revision, workspace: target }), /不能取消/);
      assert.equal((await recoverPublication(target))?.task.status, 'completed');
    } else {
      assert.equal((await publishConfirmedPlan(plan, target)).task.status, 'completed');
      assert.ok(fs.existsSync(path.join(target, 'templates/reporting.xlsx')));
    }
    assert.equal((await publishConfirmedPlan(plan, target)).task.status, 'completed');
    assert.equal(await recoverPublication(target), null);
    assertPublicationReadable(target);
    assert.equal(fs.readdirSync(path.join(target, 'data')).length, 0, '发布不创建数据库');
    const text = fs.readFileSync(path.join(target, direction === 'ingest' ? 'ingest/reporting.yaml' : 'specs/reporting.yaml'), 'utf8');
    assert.match(text, /fact_reporting/);
    if (direction === 'ingest') assert.doesNotMatch(text, /^source:/m);

    const flowRoot = path.join(workspace, `workflow-${direction}`);
    fs.mkdirSync(flowRoot);
    fs.writeFileSync(path.join(flowRoot, 'bilite.config.json'), '{"workspace":true,"version":1}');
    for (const dir of ['models', 'metrics', 'ingest', 'specs', 'templates', 'data', 'output']) fs.mkdirSync(path.join(flowRoot, dir));
    const excel = path.join(workspace, `中文 空白 ${direction}.xlsx`);
    fs.writeFileSync(excel, Buffer.from(await wb.outputAsync()));
    const flowProvider = fauxProvider();
    flowProvider.setResponses([() => {
      const now = listAuthoringTasks(flowRoot)[0];
      return fauxAssistantMessage([fauxToolCall('submit_authoring_proposal', {
        expectedRevision: now.task.revision, expectedDraftVersion: null, direction,
        yaml: direction === 'ingest' ? ingestYaml : exportYaml,
        declarationChanges, unresolved: [], note: '单入口候选。',
      })], { stopReason: 'toolUse' });
    }, fauxAssistantMessage('请审阅当前候选。'), fauxAssistantMessage('继续核对当前候选。')]);
    let log = '';
    const flowOutput = new PassThrough();
    flowOutput.on('data', chunk => { log += chunk.toString(); });
    const baseOptions = { excel, workspace: flowRoot, input: new PassThrough(),
      output: flowOutput, error: flowOutput,
      runtime: { apiKey: 'fake', providerStreams: flowProvider.provider, maxToolTurns: 4 } };
    if (direction === 'ingest') {
      const initialLines = ['1'];
      assert.equal(await runSpecWorkflow({ ...baseOptions, ask: async () => initialLines.shift() ?? null }), 'retained');
      assert.equal(listAuthoringTasks(flowRoot)[0].task.status, 'retained');
      assert.equal(flowProvider.state.callCount, 0);
    }
    const lines = direction === 'ingest' ? ['1', '按样表制定。', '好的', '2', '3'] : ['2', '按样表制定。', '2', '3'];
    assert.equal(await runSpecWorkflow({ ...baseOptions, ask: async () => lines.shift() ?? null }), 'completed', log);
    assert.match(log, /规格已保存/);
    assert.equal(listAuthoringTasks(flowRoot)[0].task.modelRuns, direction === 'ingest' ? 2 : 1);
    assert.ok(fs.existsSync(path.join(flowRoot, direction === 'ingest' ? 'ingest/reporting.yaml' : 'specs/reporting.yaml')));
    assert.equal(fs.readdirSync(path.join(flowRoot, 'data')).length, 0);
  }

  const latest = getAuthoringTask(task.task.id, workspace);
  assert.ok(latest.task.messages.length >= 1);
  assert.equal(latest.task.drafts.export?.contentHash.length, 64);
  assert.equal(JSON.stringify(latest.attachment.projection).includes('formulaText'), false);
  assert.equal(JSON.stringify(authoringTaskView(latest)).includes('sourceName'), false);
  assert.equal(JSON.stringify(authoringTaskView(latest)).includes('\nid: broken'), false);
  assert.equal(JSON.stringify(authoringTaskView(latest)).includes('kind: fact'), false);
  assert.equal(JSON.stringify(authoringTaskView(latest)).includes('"before"'), false);
  assert.equal(JSON.stringify(authoringTaskView(latest)).includes(latest.attachment.template.path), false);

  const record = path.join(workspace, '.bilite/authoring', task.task.id, 'authoring-task.json');
  const changed: AuthoringTask['task'] = jsonCopy(latest.task);
  changed.workspaceIdentity = 'another-workspace';
  fs.writeFileSync(record, JSON.stringify(changed));
  assert.throws(
    () => getAuthoringTask(task.task.id, workspace),
    /不属于当前工作区/,
  );

  const cli = await import('../src/cli.ts');
  assert.deepEqual(cli.parseCliArgs(['authoring', 'preview', 'task-id', '--text', '下一轮']), {
    kind: 'authoring-preview',
    taskId: 'task-id',
    userText: '下一轮',
  });
  assert.deepEqual(cli.parseCliArgs(['authoring', 'review', 'task-id']), {
    kind: 'authoring-review',
    taskId: 'task-id',
  });
  assert.equal(cli.parseCliArgs(['authoring', 'chat', 'task-id', '--revision', '3']).kind,
    'authoring-chat');

  console.log('规格制定核心验收通过：检查、方向、修订、预算、连续会话、模板填充保护、恢复取消与声明快照。');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
