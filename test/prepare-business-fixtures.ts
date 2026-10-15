/** 从版本化假数据恢复本地测试源，不清库、不导入、不覆盖已修改的源文件。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const filename = '经营测试数据_202501-202606.xlsx';
const source = path.join(root, 'test/assets/18期经营测试', filename);
const destination = path.join(root, 'data/testing', filename);
const bytes = fs.readFileSync(source);
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
if (fs.existsSync(destination) && hash(fs.readFileSync(destination)) !== hash(bytes)) {
  throw new Error('本地测试源已修改，未覆盖：' + destination);
}
fs.mkdirSync(path.dirname(destination), { recursive: true });
if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
console.log(JSON.stringify({ ok: true, source: destination, companies: 5, metrics: 6, periods: 18,
  rows: 540, note: '仅准备测试源，数据库未修改。' }, null, 2));
