import {
  defaultAuthoringConfigPath,
  loadAuthoringConfig,
  runtimeFromAuthoringConfig,
} from '../src/authoring/config.ts';
import { buildAuthoringTurnInput } from '../src/authoring/context.ts';
import { runAuthoringTurn } from '../src/authoring/pi.ts';

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((arg) => arg !== '--preview' && arg !== '--send');
if (unknown.length || args.size > 1) {
  console.error('用法: npm run test:pi:live -- --preview | --send');
  process.exit(1);
}
const send = args.has('--send');

const now = new Date(0).toISOString();
const task = {
  id: 'pi-live-smoke',
  taskType: 'report' as const,
  status: 'ready' as const,
  template: {
    attachmentId: 'offline-smoke',
    filename: 'smoke.xlsx',
    sizeBytes: 0,
    sha256: 'offline-smoke',
    path: '/local-only/not-sent.xlsx',
    checkedAt: now,
  },
  projection: {
    policy: 'blank-only-projection-v1',
    sheets: [{
      id: 'sheet-1',
      label: '示例报表',
      usedRange: 'A1:B2',
      mergedCells: ['A1:B1'],
      cells: [
        { ref: 'A1', text: '指标' },
        { ref: 'B1', text: '本年累计' },
        { ref: 'A2', text: '营业收入' },
      ],
    }],
    anchors: [],
    omittedHiddenSheets: 0,
  },
  policy: 'blank-only-projection-v1',
  createdAt: now,
  revision: 1,
};

const input = buildAuthoringTurnInput(task, '只回复“配置可用”，不要提交提案。');
const config = loadAuthoringConfig();
const keyPresent = Boolean(process.env[config.apiKeyEnv]);

if (!send) {
  console.log(JSON.stringify({
    config: {
      file: defaultAuthoringConfigPath(),
      api: config.api,
      baseUrl: config.baseUrl,
      modelId: config.modelId,
      apiKeyEnv: config.apiKeyEnv,
      keyPresent,
    },
    preview: input.preview,
  }, null, 2));
} else {
  const result = await runAuthoringTurn({
    ...input,
  }, runtimeFromAuthoringConfig(config), {
    task: { id: task.id, sha256: task.template.sha256 },
  });
  console.log(JSON.stringify({
    text: result.text,
    stopReason: result.stopReason,
    errorMessage: result.errorMessage,
    requestCount: result.requestCount,
    proposalCount: result.proposals.length,
    toolResults: result.toolResults.map((item) => ({ name: item.name, blocked: item.blocked })),
  }, null, 2));
}
