import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readCheckedTemplate, TemplateCheckError } from '../spec/blank.ts';
import { templateSchemaOf } from '../spec/template.ts';
import { toRef } from '../render/excel.ts';

export const PROJECTION_POLICY = 'blank-structure-projection-v2';
const MAX_TASK_RECORD_BYTES = 2 * 1024 * 1024;

/** Model-visible layout; paths, raw formulas and parser errors have no fields here. */
export interface TemplateProjection {
  policy: string;
  sheets: Array<{
    id: string;
    label: string | null;
    /** Local-only exact sheet name; omitted from the model projection. */
    sourceName?: string;
    usedRange: string | null;
    mergedCells: string[];
    cells: Array<{ ref: string; text?: string; formula?: true }>;
  }>;
  anchors: Array<{ label: string | null; sheetId: string; ref: string }>;
  omittedHiddenSheets: number;
}

export interface AuthoringTask {
  id: string;
  taskType: 'report';
  status: 'template-rejected' | 'template-unsupported' | 'template-unclear' | 'ready';
  template: {
    attachmentId: string;
    filename: string;
    sizeBytes: number;
    sha256: string;
    path: string;
    checkedAt: string;
  };
  projection: TemplateProjection | null;
  formulaCells: Array<{ sheet: string; ref: string }>;
  hiddenSheets: string[];
  policy: string;
  refusal?: string;
  createdAt: string;
  revision: number;
}

const rootOf = (workspace: string) => path.join(path.resolve(workspace), '.bilite/authoring');
const validId = (id: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
const labelOf = (label: string): string | null => /\p{N}/u.test(label) ? null : label;

export function getAuthoringTask(taskId: string, workspace = process.cwd()): AuthoringTask | null {
  if (!validId(taskId)) return null;
  const file = path.join(rootOf(workspace), taskId, 'task.json');
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TASK_RECORD_BYTES) {
      throw new Error('附件检查记录必须是普通文件且不超过 2MB');
    }
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as AuthoringTask;
    if (!value || value.id !== taskId || value.taskType !== 'report'
      || !Number.isInteger(value.revision) || !value.template || !value.policy) {
      throw new Error('附件检查记录结构不合法');
    }
    return value;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Pure structure projection does not depend on catalog matches or inferred business meaning. */
export function projectCheckedTemplate(workbook: Awaited<ReturnType<typeof readCheckedTemplate>>): TemplateProjection {
  const schema = templateSchemaOf(workbook);
  const projection: TemplateProjection = { policy: PROJECTION_POLICY, sheets: [], anchors: [], omittedHiddenSheets: 0 };
  const sheetIds = new Map<string, string>();
  let labelBytes = 0;
  for (const [index, sheet] of workbook.sheets().entries()) {
    if (sheet.hidden()) { projection.omittedHiddenSheets++; continue; }
    const id = `sheet-${index + 1}`;
    sheetIds.set(sheet.name(), id);
    const layout = schema.sheets[index];
    const cells: TemplateProjection['sheets'][number]['cells'] = [];
    const used = sheet.usedRange();
    if (used) {
      for (let row = used.startCell().rowNumber(); row <= used.endCell().rowNumber(); row++) {
        for (let col = used.startCell().columnNumber(); col <= used.endCell().columnNumber(); col++) {
          const cell = sheet.cell(row, col);
          const value = cell.value();
          const formula = Boolean(cell.formula());
          const text = typeof value === 'string' && value.trim() ? value.trim() : undefined;
          if (!text && !formula) continue;
          labelBytes += text?.length ?? 0;
          if (cells.length >= 10000 || labelBytes > 100000) throw new Error('TEMPLATE_STRUCTURE_TOO_LARGE');
          cells.push({ ref: toRef(row, col), ...(text ? { text } : {}), ...(formula ? { formula: true as const } : {}) });
        }
      }
    }
    projection.sheets.push({
      id,
      label: labelOf(sheet.name()),
      sourceName: sheet.name(),
      usedRange: layout.usedRange,
      mergedCells: layout.mergedCells,
      cells,
    });
  }
  for (const anchor of schema.anchors) {
    const sheetId = anchor.sheet && sheetIds.get(anchor.sheet);
    if (sheetId && anchor.cell) projection.anchors.push({ label: labelOf(anchor.name), sheetId, ref: anchor.cell });
  }
  return projection;
}

/** Local-only template geometry used by candidate validation and release. */
export function checkedFormulaGeometry(
  workbook: Awaited<ReturnType<typeof readCheckedTemplate>>,
): { formulaCells: AuthoringTask['formulaCells']; hiddenSheets: string[] } {
  const formulaCells: AuthoringTask['formulaCells'] = [];
  const hiddenSheets: string[] = [];
  for (const sheet of workbook.sheets()) {
    if (sheet.hidden()) {
      hiddenSheets.push(sheet.name());
      continue;
    }
    const used = sheet.usedRange();
    if (!used) continue;
    for (let row = used.startCell().rowNumber(); row <= used.endCell().rowNumber(); row++) {
      for (let col = used.startCell().columnNumber(); col <= used.endCell().columnNumber(); col++) {
        if (sheet.cell(row, col).formula()) formulaCells.push({ sheet: sheet.name(), ref: toRef(row, col) });
      }
    }
  }
  return { formulaCells, hiddenSheets };
}

export async function createTemplateTask(filename: string, bytes: Buffer, workspace = process.cwd()): Promise<AuthoringTask> {
  const id = randomUUID();
  const dir = path.join(rootOf(workspace), id);
  fs.mkdirSync(dir, { recursive: true });
  const attachmentPath = path.join(dir, 'template.xlsx');
  fs.writeFileSync(attachmentPath, bytes, { flag: 'wx', mode: 0o600 });
  const now = new Date().toISOString();
  const task: AuthoringTask = {
    id, taskType: 'report', status: 'ready', policy: PROJECTION_POLICY, revision: 1, createdAt: now,
    template: { attachmentId: randomUUID(), filename: path.basename(filename), sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), path: attachmentPath, checkedAt: now },
    projection: null,
    formulaCells: [],
    hiddenSheets: [],
  };
  try {
    const workbook = await readCheckedTemplate(bytes);
    const geometry = checkedFormulaGeometry(workbook);
    task.formulaCells = geometry.formulaCells;
    task.hiddenSheets = geometry.hiddenSheets;
    try { task.projection = projectCheckedTemplate(workbook); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'TEMPLATE_STRUCTURE_TOO_LARGE') throw error;
      task.status = 'template-unclear';
      task.refusal = 'TEMPLATE_STRUCTURE_TOO_LARGE: 模板结构超出上下文上限，请拆分模板后继续。';
    }
    if (task.projection && !task.projection.sheets.some((sheet) => sheet.cells.length)) {
      task.status = 'template-unclear';
      task.refusal = 'TEMPLATE_LAYOUT_UNCLEAR: 可见工作表没有可供识别的标签，请补充空白结构样表。';
    }
  } catch (error) {
    if (!(error instanceof TemplateCheckError)) throw error;
    task.status = error.code === 'TEMPLATE_DATA_BLOCKED' ? 'template-rejected' : 'template-unsupported';
    task.refusal = error.message;
  }
  const temporary = path.join(dir, 'task.json.tmp');
  fs.writeFileSync(temporary, JSON.stringify(task, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, path.join(dir, 'task.json'));
  if (task.status !== 'ready') {
    // Rejected or unsupported workbook bytes must not survive the check.
    fs.rmSync(attachmentPath, { force: true });
  }
  return task;
}
