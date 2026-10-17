#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { initializeWorkspace, locateWorkspace } from './workspace.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
let workspace = process.env.BILITE_WORKSPACE;
let code = 0;
let cli;
// Source checkout keeps running TypeScript even after a package build.
const engine = fs.existsSync(path.join(root, 'src/cli.ts')) ? 'src' : 'dist';
const extension = engine === 'src' ? 'ts' : 'js';
const moduleUrl = (name) => pathToFileURL(path.join(root, engine, `${name}.${extension}`)).href;
try {
  if (args[0] === '--workspace' || args[0] === '-C') {
    args.shift();
    if (!args[0] || args[0].startsWith('-')) throw new Error('--workspace 需要工作区目录');
    workspace = args.shift();
  } else if (args[0]?.startsWith('--workspace=')) {
    workspace = args.shift().slice('--workspace='.length);
    if (!workspace) throw new Error('--workspace 需要工作区目录');
  }
  if (args[0] === 'init') {
    if (args.slice(1).some((arg) => ['--help', '-h'].includes(arg))) {
      console.log('用法：bilite init [目录] [--preset finance]\n默认建立空工作区；finance 添加财务模型，已有文件不覆盖。');
    } else console.log(JSON.stringify(initializeWorkspace(args.slice(1), workspace, root), null, 2));
  } else if (engine === 'src' && args[0] === 'dev') {
    const { runDevelopmentCommand } = await import(new URL('../dev/reset.ts', import.meta.url).href);
    const target = workspace === undefined ? locateWorkspace(undefined) : path.resolve(workspace);
    code = await runDevelopmentCommand(args, target);
  } else {
    const help = args.length === 0 || ['help', '--help', '-h', '--version', '-v', 'version'].includes(args[0]) || args.includes('--help') || args.includes('-h');
    const userSkill = args[0] === 'skill' && args[1] === 'install'
      && args.some((arg, i) => arg === '--scope' && args[i + 1] === 'user');
    const globalConfig = args[0] === 'authoring';
    if (!help && !userSkill && !globalConfig) process.chdir(locateWorkspace(workspace));
    const invocation = await import(moduleUrl('runtime/invocation'));
    const business = await import(moduleUrl('cli'));
    cli = business;
    code = await invocation.runStandalone(args, business.processIO());
  }
} catch (error) {
  console.error(`bilite: ${error.message}`);
  code = 2;
}
process.exitCode = code;
