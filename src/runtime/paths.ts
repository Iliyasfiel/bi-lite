import fs from 'node:fs';
import path from 'node:path';

/** Native resolution expands Windows 8.3 aliases; missing database files use their real parent. */
export function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  try { return fs.realpathSync.native(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(canonicalPath(parent), path.basename(absolute));
  }
}

export function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}
