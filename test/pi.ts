import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {
  AuthoringAuthError,
  AuthoringConfigError,
  defaultAuthoringAuthPath,
  defaultAuthoringConfig,
  defaultAuthoringConfigPath,
  loadAuthoringConfig,
  resolveAuthoringApiKey,
  runtimeFromAuthoringConfig,
  writeAuthoringConfig,
  writeAuthoringCredential,
} from '../src/authoring/config.ts';
import { buildAuthoringTurnInput } from '../src/authoring/context.ts';
import { checkAuthoringRuntime, probeAuthoringProtocol, runAuthoringTurn } from '../src/authoring/pi.ts';

const turn = {
  systemPrompt: '只处理空白模板的结构讨论，不接收业务金额。',
  userText: '请说明这个模板的行列结构。',
};

const runtimeFor = (faux: ReturnType<typeof fauxProvider>, maxToolTurns = 2) => ({
  apiKey: 'fake-api-key',
  providerStreams: faux.provider,
  maxToolTurns,
});

{
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage('不应调用模型')]);
  const controller = new AbortController();
  controller.abort();
  const result = await runAuthoringTurn({ ...turn, signal: controller.signal }, runtimeFor(faux));
  assert.equal(result.stopReason, 'aborted');
  assert.equal(result.requestCount, 0);
  assert.equal(faux.state.callCount, 0);
}

{
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('submit_spec_proposal', { kind: 'report', note: '模板结构已确认' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage('请确认主体范围和报告期间。'),
  ]);
  const result = await runAuthoringTurn(turn, runtimeFor(faux), {
    task: { id: 'task-pi', sha256: 'template-hash' },
  });
  assert.equal(result.text, '请确认主体范围和报告期间。');
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.requestCount, 2);
  assert.deepEqual(result.proposals, [{ kind: 'report', note: '模板结构已确认' }]);
  assert.deepEqual(result.toolResults, [{
    name: 'submit_spec_proposal',
    blocked: false,
    reason: '已记录提案草稿：report',
  }]);
}

{
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: 'noop' })], { stopReason: 'toolUse' }),
  ]);
  const result = await runAuthoringTurn(turn, runtimeFor(faux, 1));
  assert.equal(result.text, '');
  assert.equal(result.stopReason, 'toolUse');
  assert.deepEqual(result.toolResults, [{
    name: 'bash',
    blocked: true,
    reason: 'Tool bash not found',
  }]);
}

{
  const faux = fauxProvider({ tokensPerSecond: 5, tokenSize: { min: 20, max: 20 } });
  faux.setResponses([fauxAssistantMessage('x'.repeat(400))]);
  const controller = new AbortController();
  const pending = runAuthoringTurn({ ...turn, signal: controller.signal }, runtimeFor(faux, 1));
  setTimeout(() => controller.abort(), 5);
  const result = await pending;
  assert.equal(result.stopReason, 'aborted');
  assert.equal(faux.state.callCount, 1);
}

assert.equal((await checkAuthoringRuntime({ apiKey: 'fake-api-key' })).runtimeConfigured, true);
assert.equal((await checkAuthoringRuntime({})).authStatus, 'missing');

{
  const probe = await probeAuthoringProtocol({
    modelId: 'fake-chat',
    maxTokens: 321,
    timeoutMs: 4_321,
    maxRetries: 0,
    maxRetryDelayMs: 123,
  });
  assert.equal(probe.requestCount, 1);
  assert.equal(probe.modelId, 'fake-chat');
  assert.equal(probe.maxTokens ?? probe.maxCompletionTokens, 321);
  assert.deepEqual(probe.tools.map((tool) => ({ type: tool.type, name: tool.function?.name })), [
    { type: 'function', name: 'submit_spec_proposal' },
  ]);
  assert.equal(probe.timeoutMs, 4_321);
  assert.equal(probe.maxRetries, 0);
  assert.equal(probe.maxRetryDelayMs, 123);
  assert.equal(probe.text, '官方适配器联测通过');
  assert.equal(probe.stopReason, 'stop');
  assert.equal(JSON.stringify(probe).includes('offline-probe-key'), false);
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-lite-authoring-'));
  try {
    const file = path.join(dir, 'authoring.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      api: 'openai-completions',
      baseUrl: 'https://example.com/v1/',
      modelId: 'fake-model',
      apiKeyEnv: 'BILITE_AUTHORING_FAKE_KEY',
    }), { mode: 0o600 });
    const config = loadAuthoringConfig({ file });
    const authFile = path.join(dir, 'authoring-auth.json');
    assert.equal(config.baseUrl, 'https://example.com/v1');
    assert.equal(config.modelId, 'fake-model');
    assert.equal(config.apiKeyEnv, 'BILITE_AUTHORING_FAKE_KEY');
    assert.equal(
      runtimeFromAuthoringConfig(config, { BILITE_AUTHORING_FAKE_KEY: 'fake-key' }, { authFile }).apiKey,
      'fake-key',
    );
    assert.throws(
      () => runtimeFromAuthoringConfig(config, {}, { authFile }),
      (error) => error instanceof AuthoringAuthError && error.code === 'AUTHORING_API_KEY_MISSING',
    );
    writeAuthoringCredential('stored-key', { file: authFile });
    assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);
    assert.equal(runtimeFromAuthoringConfig(config, {}, { authFile }).apiKey, 'stored-key');
    assert.equal(resolveAuthoringApiKey(config, { authFile }).source, 'credential-file');
    assert.equal(
      runtimeFromAuthoringConfig(config, { BILITE_AUTHORING_FAKE_KEY: 'env-key' }, { authFile }).apiKey,
      'env-key',
    );
    if (process.platform !== 'win32') {
      fs.chmodSync(authFile, 0o644);
      assert.throws(
        () => resolveAuthoringApiKey(config, { authFile }),
        (error) => error instanceof AuthoringAuthError && error.code === 'AUTHORING_AUTH_INSECURE',
      );
      fs.chmodSync(authFile, 0o600);
    }
    assert.equal(
      defaultAuthoringConfigPath({ BILITE_AUTHORING_CONFIG: file }, 'darwin', dir),
      file,
    );
    assert.equal(
      defaultAuthoringAuthPath({ BILITE_AUTHORING_CONFIG: file }, 'darwin', dir),
      path.join(dir, 'authoring-auth.json'),
    );

    const written = path.join(dir, 'written.json');
    const preset = defaultAuthoringConfig();
    assert.equal(preset.modelId, 'deepseek-flash');
    writeAuthoringConfig(preset, { file: written });
    assert.deepEqual(loadAuthoringConfig({ file: written }), preset);

    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      api: 'openai-completions',
      baseUrl: 'https://example.com/v1',
      modelId: 'fake-model',
      skills: '/tmp/should-not-load',
    }), { mode: 0o600 });
    assert.throws(
      () => loadAuthoringConfig({ file }),
      (error) => error instanceof AuthoringConfigError && error.code === 'AUTHORING_CONFIG_INVALID',
    );

    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      api: 'openai-completions',
      baseUrl: 'https://example.com/v1',
      modelId: 'fake-model',
      apiKeyEnv: 'PATH',
    }), { mode: 0o600 });
    assert.throws(
      () => loadAuthoringConfig({ file }),
      (error) => error instanceof AuthoringConfigError && error.code === 'AUTHORING_CONFIG_INVALID',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const projection = {
    policy: 'blank-structure-projection-v2',
    sheets: [{
      id: 'sheet-1',
      label: '报表',
      usedRange: 'A1:B2',
      mergedCells: ['A1:B1'],
      cells: [
        { ref: 'A1', text: '指标' },
        { ref: 'B1', formula: true },
        { ref: 'A2', text: '营业收入' },
      ],
      localPath: '/secret/sheet.xlsx',
    }],
    anchors: [{ label: 'DATA_START', sheetId: 'sheet-1', ref: 'A2' }],
    omittedHiddenSheets: 1,
    localPath: '/secret/template.xlsx',
  };
  const task = {
    id: 'task-context',
    taskType: 'report',
    status: 'ready',
    template: {
      attachmentId: 'attachment',
      filename: 'secret-template.xlsx',
      sizeBytes: 1,
      sha256: 'hash',
      path: '/secret/template.xlsx',
      checkedAt: new Date(0).toISOString(),
    },
    projection,
    policy: 'blank-structure-projection-v2',
    createdAt: new Date(0).toISOString(),
    revision: 1,
  };
  const input = buildAuthoringTurnInput(task, '请识别这个模板。');
  const serialized = JSON.stringify(input.preview);
  assert.equal(serialized.includes('/secret'), false);
  assert.equal(serialized.includes('secret-template.xlsx'), false);
  assert.equal(serialized.includes('公式正文'), false);
  assert.equal(input.preview.projection.sheets[0].cells[1].formula, true);
  assert.equal(input.preview.projection.omittedHiddenSheets, 1);
  assert.equal(input.preview.userText, '请识别这个模板。');
  assert.throws(
    () => buildAuthoringTurnInput({ ...task, status: 'template-rejected', projection: null }, '继续'),
    /AUTHORING_TASK_NOT_READY/,
  );
}

await assert.rejects(
  runAuthoringTurn({ ...turn }, { apiKey: 'fake-key', maxRetries: -1 }),
  /maxRetries must be a non-negative integer/,
);

console.log('pi SDK 收口与助手配置验收通过：协议适配、预算、取消、工具、配置和发送 DTO。');
