import type { AuthoringTask, TemplateProjection } from './attachment.ts';
import { runAuthoringTurn, type PiRunOptions, type PiRunResult, type PiRuntimeOptions } from './pi.ts';

export const AUTHORING_SYSTEM_PROMPT = [
  '你是 bi-lite 的内置规格助手，只处理空白模板的结构澄清与规格提案。',
  '不要声称已注册规格、已确认版本或已导入数据；这些动作只能由人工在本地入口完成。',
  '只使用提供的模板结构投影和用户文字。不要请求业务金额、源文件、任意路径、SQL 或 shell。',
  '需要更多业务语义时先提问。需要提交修改时只能调用 submit_spec_proposal。',
].join('\n');

export interface AuthoringSendPreview {
  prompt: string;
  projection: TemplateProjection;
  userText: string;
}

export interface AuthoringTurnInput extends PiRunOptions {
  preview: AuthoringSendPreview;
}

export function projectContextForModel(projection: TemplateProjection): TemplateProjection {
  return {
    policy: projection.policy,
    sheets: projection.sheets.map((sheet) => ({
      id: sheet.id,
      label: sheet.label,
      usedRange: sheet.usedRange,
      mergedCells: [...sheet.mergedCells],
      cells: sheet.cells.map((cell) => ({
        ref: cell.ref,
        ...(cell.text === undefined ? {} : { text: cell.text }),
        ...(cell.formula ? { formula: true as const } : {}),
      })),
    })),
    anchors: projection.anchors.map((anchor) => ({
      label: anchor.label,
      sheetId: anchor.sheetId,
      ref: anchor.ref,
    })),
    omittedHiddenSheets: projection.omittedHiddenSheets,
  };
}

export function buildAuthoringTurnInput(
  task: AuthoringTask,
  userText: string,
  maxPromptChars = 24_000,
): AuthoringTurnInput {
  if (task.status !== 'ready' || !task.projection) {
    throw new Error('AUTHORING_TASK_NOT_READY');
  }
  const projection = projectContextForModel(task.projection);
  const prompt = `${AUTHORING_SYSTEM_PROMPT}\n\n模板结构投影（JSON）：\n${JSON.stringify(projection)}`;
  const input: AuthoringTurnInput = {
    systemPrompt: prompt,
    userText,
    preview: { prompt: AUTHORING_SYSTEM_PROMPT, projection, userText },
  };
  if (prompt.length + userText.length > maxPromptChars) throw new Error('AUTHORING_CONTEXT_TOO_LARGE');
  return input;
}

export async function runAuthoringTaskTurn(
  task: AuthoringTask,
  userText: string,
  runtime: PiRuntimeOptions,
  signal?: AbortSignal,
): Promise<PiRunResult> {
  const input = buildAuthoringTurnInput(task, userText, runtime.maxPromptChars);
  return runAuthoringTurn({ ...input, signal }, runtime, {
    task: { id: task.id, sha256: task.template.sha256 },
  });
}
