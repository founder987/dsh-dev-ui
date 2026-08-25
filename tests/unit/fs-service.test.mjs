/**
 * fs-service 单元测试：隐藏目录过滤（HIDDEN_DIR_NAMES）
 * 运行：node tests/unit/fs-service.test.mjs（需先 pnpm build 产出 lib/fs-service.js）
 */
import { listDir } from '../../lib/fs-service.js';
import assert from 'node:assert/strict';

/** mock ctx.fs（仅 listDir 路径） */
function mockFs(entries) {
  return {
    resolve: async (path) => ({ targetKey: path, displayPath: path }),
    listDir: async () => entries,
  };
}

let passed = 0;
function check(name, actual, expectNames, notContain = []) {
  const names = actual.map((e) => e.name);
  assert.deepEqual(names, expectNames, `[${name}] 期望 ${JSON.stringify(expectNames)}，实际 ${JSON.stringify(names)}`);
  for (const n of notContain) {
    assert.ok(!names.includes(n), `[${name}] 不应包含 ${n}`);
  }
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('--- fs-service 隐藏目录过滤测试 ---');

// 1. 过滤隐藏目录（.git / node_modules / .DS_Store / .dsh）
const fs1 = mockFs([
  { name: '.git', type: 'directory' },
  { name: 'node_modules', type: 'directory' },
  { name: '.DS_Store', type: 'file' },
  { name: '.dsh', type: 'directory' },
  { name: 'src', type: 'directory' },
  { name: 'package.json', type: 'file' },
  { name: '.gitignore', type: 'file' },
]);
const r1 = await listDir(fs1, 'C:/proj');
check('过滤隐藏目录', r1, ['src', 'package.json', '.gitignore'], ['.git', 'node_modules', '.DS_Store', '.dsh']);

// 2. 保留普通隐藏文件（.gitignore 等）
check('保留隐藏文件', r1, ['src', 'package.json', '.gitignore']);

// 3. 空目录
const r2 = await listDir(mockFs([]), 'C:/empty');
check('空目录返回空数组', r2, []);

// 4. 目录优先排序（过滤后仍保留 isDir 标志）
assert.ok(r1.find((e) => e.name === 'src')?.isDir === true, '[4] src 应为目录');
assert.ok(r1.find((e) => e.name === 'package.json')?.isDir === false, '[4] package.json 应为文件');
passed += 1;
console.log('  ✅ 目录/文件标志保留');

console.log(`\n全部通过：${passed} 项断言`);
