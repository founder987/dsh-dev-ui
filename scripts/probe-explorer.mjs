/**
 * 本地验证 explorer/rundll32 命令行为（C12 诊断，不入库）。
 * 运行：node scripts/probe-explorer.mjs
 */
import { spawn } from 'node:child_process';
import { resolveSystemOpenCommand } from '../lib/system-open.js';

const FILE = 'E:\\trae-file\\deepseek-harness-client\\README.md';
const DIR = 'E:\\trae-file\\deepseek-harness-client';

function trySpawn(file, args, label) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      console.log(`  [${label}] timeout 3s (no spawn event, no error)`);
      resolve();
    }, 3000);
    child.once('error', (err) => {
      clearTimeout(timer);
      console.log(`  [${label}] ERROR: ${err.code} ${err.message}`);
      resolve();
    });
    child.once('spawn', () => {
      clearTimeout(timer);
      console.log(`  [${label}] SPAWNED pid=${child.pid}`);
      child.unref();
      resolve();
    });
  });
}

const cases = [
  { label: 'file reveal (select)', cmd: resolveSystemOpenCommand('file', 'reveal', FILE) },
  { label: 'dir reveal (open dir)', cmd: resolveSystemOpenCommand('directory', 'reveal', DIR) },
  { label: 'file open (default app)', cmd: resolveSystemOpenCommand('file', 'open', FILE) },
  { label: 'file choose-app', cmd: resolveSystemOpenCommand('file', 'choose-app', FILE) },
];

for (const c of cases) {
  console.log(`--- ${c.label} ---`);
  console.log('  command:', JSON.stringify(c.cmd));
  if (c.cmd !== null) await trySpawn(c.cmd.file, c.cmd.args, c.label);
}
console.log('done');
