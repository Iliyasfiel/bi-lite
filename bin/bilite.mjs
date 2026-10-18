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
  } else {
    const help = args.length === 0 || ['help', '--help', '-h', '--version', '-v', 'version'].includes(args[0]) || args.includes('--help') || args.includes('-h');
    const userSkill = args[0] === 'skill' && args[1] === 'install'
      && args.some((arg, i) => arg === '--scope' && args[i + 1] === 'user');
    const unboundAuthoring = args[0] === 'authoring'
      && (['setup', 'status', 'test'].includes(args[1]) || args[1] === 'create');
    if (!help && args[0] === 'spec' && args[1] && !args[1].startsWith('-')) {
      args[1] = path.resolve(args[1]);
      try {
        const selected = locateWorkspace(workspace);
        process.env.BILITE_WORKSPACE = selected;
        process.chdir(selected);
      } catch (error) {
        if (workspace !== undefined || !process.stdin.isTTY || fs.existsSync('bilite.config.json')) throw error;
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        let answer;
        try { answer = await rl.question('当前目录没有工作区，是否在此初始化空工作区？输入 是 确认：'); }
        finally { rl.close(); }
        if (answer.trim() !== '是') throw new Error('未初始化工作区');
        initializeWorkspace([], undefined, root);
        process.env.BILITE_WORKSPACE = locateWorkspace(undefined);
      }
    } else if (!help && !userSkill && !unboundAuthoring) process.chdir(locateWorkspace(workspace));
    if (!help && unboundAuthoring && args[1] === 'create' && workspace !== undefined) {
      process.env.BILITE_WORKSPACE = locateWorkspace(workspace);
    }
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
