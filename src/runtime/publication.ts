import fs from 'node:fs';
import path from 'node:path';

export const publicationBarrier = (workspace: string) => path.join(workspace, '.bilite/spec-publication.json');
const generationFile = (workspace: string) => path.join(workspace, '.bilite/spec-generation');
export function assertPublicationReadable(workspace = process.cwd()): void {
  if (fs.existsSync(publicationBarrier(workspace))) {
    throw new Error('SPEC_PUBLICATION_PENDING: 规格发布尚未完成，请用 bilite spec 原样表路径 恢复后再执行。');
  }
}
export function publicationGeneration(workspace: string): string {
  try { return fs.readFileSync(generationFile(workspace), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
export function withPublishedFiles<T>(workspace: string, read: () => T): T {
  assertPublicationReadable(workspace);
  const generation = publicationGeneration(workspace);
  const value = read();
  assertPublicationReadable(workspace);
  if (generation !== publicationGeneration(workspace)) throw new Error('SPEC_PUBLICATION_CHANGED: 规格在读取期间变化，请重试。');
  return value;
}
export function recordPublicationGeneration(workspace: string, id: string): void {
  const file = generationFile(workspace);
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, id, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
