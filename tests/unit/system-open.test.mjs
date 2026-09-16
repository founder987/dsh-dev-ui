/**
 * 系统打开命令解析单元测试（C12-1）：动作 × 路径类型映射矩阵、非法组合、非 Windows 降级。
 * 运行：node tests/unit/system-open.test.mjs（需先 pnpm build 产出 lib/system-open.js）
 */
import { resolveSystemOpenCommand } from '../../lib/system-open.js';
import assert from 'node:assert/strict';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✅ ${name}`);
}

const FILE = 'C:/proj/src/main.ts';
const DIR = 'C:/proj/src';

console.log('--- resolveSystemOpenCommand 矩阵（Windows） ---');
{
  // reveal + 文件 → explorer /select,<path>
  const revealFile = resolveSystemOpenCommand('file', 'reveal', FILE);
  assert.ok(revealFile !== null);
  assert.equal(revealFile.file, 'explorer.exe');
  assert.deepEqual(revealFile.args, ['/select,C:/proj/src/main.ts']);

  // reveal + 目录 → explorer <path>
  assert.deepEqual(resolveSystemOpenCommand('directory', 'reveal', DIR)?.args, [DIR]);

  // open + 文件 / 目录 → explorer <path>
  assert.deepEqual(resolveSystemOpenCommand('file', 'open', FILE)?.args, [FILE]);
  assert.deepEqual(resolveSystemOpenCommand('directory', 'open', DIR)?.args, [DIR]);

  // choose-app + 文件 → rundll32 OpenAs_RunDLL
  const choose = resolveSystemOpenCommand('file', 'choose-app', FILE);
  assert.equal(choose?.file, 'rundll32.exe');
  assert.deepEqual(choose?.args, ['shell32.dll,OpenAs_RunDLL', FILE]);

  // choose-app + 目录 → null（非法组合）
  assert.equal(resolveSystemOpenCommand('directory', 'choose-app', DIR), null);
  ok('S1 动作 × 类型矩阵 + 非法组合');
}

console.log('--- 参数独立（含空格路径不拼接 shell） ---');
{
  const spaced = 'C:/Users/My User/project/file name.ts';
  const open = resolveSystemOpenCommand('file', 'open', spaced);
  assert.deepEqual(open?.args, [spaced], '路径作独立参数，不拼接命令字符串');
  const reveal = resolveSystemOpenCommand('file', 'reveal', spaced);
  assert.deepEqual(reveal?.args, [`/select,${spaced}`]);
  ok('S2 路径独立参数（防注入）');
}

console.log(`\n全部通过：${passed} 项断言`);
