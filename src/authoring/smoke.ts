import type { AuthoringTask } from './attachment.ts';
import { buildAuthoringTurnInput } from './context.ts';
import { runAuthoringTurn, type PiRunResult, type PiRuntimeOptions } from './pi.ts';

export const AUTHORING_SMOKE_USER_TEXT = '只回复“配置可用”，不要提交提案。';

export function authoringSmokeTask(): AuthoringTask {
  const at = new Date(0).toISOString();
  return {
    id: 'authoring-smoke',
    taskType: 'report',
    status: 'ready',
    template: {
      attachmentId: 'offline-smoke',
      filename: 'smoke.xlsx',
      sizeBytes: 0,
      sha256: 'offline-smoke',
      path: '/local-only/not-sent.xlsx',
      checkedAt: at,
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
    createdAt: at,
    revision: 1,
  };
}

export async function runAuthoringSmoke(runtime: PiRuntimeOptions): Promise<PiRunResult> {
  const task = authoringSmokeTask();
  const input = buildAuthoringTurnInput(task, AUTHORING_SMOKE_USER_TEXT);
  return runAuthoringTurn(input, runtime, {
    task: { id: task.id, sha256: task.template.sha256 },
  });
}
