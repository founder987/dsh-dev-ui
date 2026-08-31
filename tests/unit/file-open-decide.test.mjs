/**
 * 聊天内打开文件 · 决策单元测试（T2）。
 * 运行：node tests/unit/file-open-decide.test.mjs（需先 pnpm build 产出 lib/fileopen/decide.js）
 */
import { decideOpenPath, isInsideWorkspace, normalizePathForCompare } from '../../lib/fileopen/decide.js';
import assert from 'node:assert/strict';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✅ ${name}`);
}

const CWD = 'C:/Users/me/project';

console.log('--- normalizePathForCompare ---');
{
  assert.equal(normalizePathForCompare('C:\\Users\\me\\project\\src\\a.ts'), 'C:/Users/me/project/src/a.ts');
  assert.equal(normalizePathForCompare('C:/proj/src/'), 'C:/proj/src');
  assert.equal(normalizePathForCompare('C:/proj///'), 'C:/proj');
  ok('N1 反斜杠→正斜杠 + 去尾斜杠');
}

console.log('--- isInsideWorkspace ---');
{
  assert.equal(isInsideWorkspace(`${CWD}/src/a.ts`, CWD), true);
  assert.equal(isInsideWorkspace(CWD, CWD), true, '等于 cwd 视为工作区内');
  assert.equal(isInsideWorkspace(`${CWD}x/src/a.ts`, CWD), false, '前缀相似目录不算（C:/projx 不命中 C:/proj）');
  assert.equal(isInsideWorkspace('C:/Users/me/other/a.ts', CWD), false);
  assert.equal(isInsideWorkspace('C:/Users/me/project', undefined), false, '无 cwd → false');
  assert.equal(isInsideWorkspace('C:/Users/me/project/src/a.ts', ''), false, '空 cwd → false');
  assert.equal(isInsideWorkspace(`${CWD.replaceAll('/', '\\')}\\src\\a.ts`, `${CWD.replaceAll('/', '\\')}`), true, 'Windows 反斜杠路径');
  ok('W1 工作区判定 + 边界');
}

console.log('--- decideOpenPath ---');
{
  assert.equal(decideOpenPath({ type: 'file' }, `${CWD}/src/a.ts`, CWD), 'dsh');
  assert.equal(decideOpenPath({ type: 'directory' }, `${CWD}/src`, CWD), 'system', '目录回落系统');
  assert.equal(decideOpenPath({ type: 'file' }, 'C:/Users/me/other/a.ts', CWD), 'system', '工作区外回落系统');
  assert.equal(decideOpenPath(undefined, `${CWD}/src/a.ts`, CWD), 'system', 'stat 失败回落系统');
  assert.equal(decideOpenPath({ type: 'file' }, `${CWD}/src/a.ts`, undefined), 'system', '无 cwd 回落系统');
  assert.equal(decideOpenPath({ type: 'file' }, `${CWD}/src/a.ts`, 'C:/other'), 'system');
  assert.equal(decideOpenPath({ type: 'file' }, `${CWD.replaceAll('/', '\\')}\\src\\a.ts`, CWD), 'dsh', '反斜杠路径文件');
  ok('D1 决策矩阵（文件/目录/工作区外/失败/无 cwd）');
}

console.log(`\n全部通过：${passed} 项断言`);
