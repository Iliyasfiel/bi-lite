import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const baseline = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim();
let failed = false;
const report = (level, text) => {
  console.log(`${level.padEnd(4)} ${text}`);
  if (level === 'FAIL') failed = true;
};

report(process.versions.node === baseline ? 'OK' : 'WARN',
  `Node ${process.versions.node}; development baseline ${baseline} (.node-version)`);
if (Number(process.versions.node.split('.')[0]) < Number(baseline.split('.')[0])) {
  report('FAIL', 'Switch to the development baseline before troubleshooting native TypeScript.');
}
report('INFO', `${process.platform}/${process.arch}; platform validation scope is documented in CONTRIBUTING.md.`);
const npmVersion = process.env.npm_config_user_agent?.match(/(?:^| )npm\/(\S+)/)?.[1];
report(npmVersion ? 'INFO' : 'WARN', npmVersion ? `npm ${npmVersion}` : 'Run via npm run doctor to include the npm version.');
for (const tool of ['git', 'rg']) {
  const result = spawnSync(tool, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  report(result.status === 0 ? 'OK' : tool === 'git' ? 'FAIL' : 'WARN',
    result.status === 0 ? result.stdout.split(/\r?\n/)[0] : `${tool} unavailable${tool === 'rg' ? ' (optional search tool)' : ''}`);
}

let dependenciesReady = true;
const declared = { ...pkg.dependencies, ...pkg.devDependencies };
const locked = { ...lock.packages?.['']?.dependencies, ...lock.packages?.['']?.devDependencies };
for (const dependency of Object.keys(declared)) {
  try {
    if (declared[dependency] !== locked[dependency]) throw new Error('package.json and package-lock.json declarations differ');
    let entry;
    try {
      entry = require.resolve(`${dependency}/package.json`);
    } catch (error) {
      if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && error.code !== 'ERR_MODULE_NOT_FOUND' && error.code !== 'MODULE_NOT_FOUND') throw error;
      const manifestFile = path.join(root, 'node_modules', dependency, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (manifest.name !== dependency) throw new Error('package metadata missing');
      entry = manifestFile;
    }
    let directory = path.dirname(entry);
    let installed;
    for (;;) {
      const file = path.join(directory, 'package.json');
      if (fs.existsSync(file)) {
        const candidate = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (candidate.name === dependency) { installed = candidate; break; }
      }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error('package metadata missing');
      directory = parent;
    }
    const expected = lock.packages?.[`node_modules/${dependency}`]?.version;
    if (!expected || installed.version !== expected) throw new Error(`installed ${installed.version}, locked ${expected ?? 'missing'}`);
    report('OK', `${dependency} ${installed.version}`);
  } catch (error) {
    dependenciesReady = false;
    report('FAIL', `${dependency}: ${error.message}; run npm ci on this device.`);
  }
}

if (dependenciesReady) {
  try {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const db = await DuckDBInstance.create(':memory:', { enable_external_access: 'false', memory_limit: '128MB' });
    db.closeSync();
    report('OK', 'DuckDB native driver starts in memory; no workspace database opened.');
  } catch (error) { report('FAIL', `DuckDB native driver: ${error.message}; check OS/CPU and reinstall locked dependencies.`); }
}
for (const variable of ['BILITE_WORKSPACE', 'BILITE_DB']) {
  if (process.env[variable]) report('WARN', `${variable} is set; confirm its destination before manual operations (value omitted).`);
}
console.log(failed ? 'Environment needs attention. See CONTRIBUTING.md.' : 'Environment checks passed. See CONTRIBUTING.md for validation commands.');
process.exitCode = failed ? 1 : 0;
