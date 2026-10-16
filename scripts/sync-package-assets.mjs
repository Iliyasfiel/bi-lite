#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jobs = [
  { src: path.join(root, 'src/web'), dest: path.join(root, 'dist/web'), exts: new Set(['.html', '.js', '.css']) },
  { src: path.join(root, 'skills'), dest: path.join(root, 'dist/skills') },
];

for (const job of jobs) {
  if (!job.dest.startsWith(root + path.sep)) throw new Error('Asset target outside package');
  fs.rmSync(job.dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(job.dest), { recursive: true });
  fs.cpSync(job.src, job.dest, {
    recursive: true,
    filter: (source) => fs.statSync(source).isDirectory() || !job.exts || job.exts.has(path.extname(source)),
  });
}
