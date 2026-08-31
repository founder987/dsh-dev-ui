/**
 * 聊天内打开文件 · 拦截器单元测试（T3）。
 * 运行：node tests/unit/file-open-interceptor.test.mjs（需先 pnpm build 产出 lib/fileopen/interceptor.js）
 */
import { installOpenPathInterceptor } from '../../lib/fileopen/interceptor.js';
import assert from 'node:assert/strict';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✅ ${name}`);
}

/** 记录调用序列的 fake workspaces */
function makeWorkspaces() {
  const calls = [];
  return {
    calls,
    openPath: async (p) => {
      calls.push(['orig', p]);
    },
  };
}

const CWD = 'C:/proj';
const deps = {
  statPath: async (p) => {
    if (p.includes('/good')) return { type: 'file' };
    if (p.includes('/dir')) return { type: 'directory' };
    return undefined;
  },
  openInDsh: async (p) => {
    depsCalls.push(['dsh', p]);
  },
  currentCwd: () => CWD,
};
const depsCalls = [];

console.log('--- 拦截分流 ---');
{
  const ws = makeWorkspaces();
  const handle = installOpenPathInterceptor(ws, deps);

  await ws.openPath(`${CWD}/good.ts`); // 文件 + 工作区 → dsh
  await ws.openPath(`${CWD}/dir`); // 目录 → 系统
  await ws.openPath('C:/outside/good.ts'); // 工作区外 → 系统
  await ws.openPath(`${CWD}/good.ts`); // 再点一次仍是 dsh

  assert.deepEqual(depsCalls, [
    ['dsh', `${CWD}/good.ts`],
    ['dsh', `${CWD}/good.ts`],
  ]);
  assert.deepEqual(ws.calls, [
    ['orig', `${CWD}/dir`],
    ['orig', 'C:/outside/good.ts'],
  ]);
  ok('I1 dsh/system 分流正确');

  handle.restore();
  depsCalls.length = 0;
  ws.calls.length = 0;
  await ws.openPath(`${CWD}/good.ts`);
  assert.deepEqual(depsCalls, []);
  assert.deepEqual(ws.calls, [['orig', `${CWD}/good.ts`]]);
  ok('I2 restore 恢复原方法');
}

console.log('--- 防重复安装 ---');
{
  const ws = makeWorkspaces();
  const first = installOpenPathInterceptor(ws, deps);
  const second = installOpenPathInterceptor(ws, deps);
  second.restore(); // noop：不应移除第一次的包装

  await ws.openPath(`${CWD}/good.ts`);
  assert.deepEqual(depsCalls, [['dsh', `${CWD}/good.ts`]], '第一次包装仍生效');
  assert.deepEqual(ws.calls, []);

  first.restore();
  depsCalls.length = 0;
  ws.calls.length = 0;
  await ws.openPath(`${CWD}/good.ts`);
  assert.deepEqual(depsCalls, [], 'restore 后不再拦截');
  assert.deepEqual(ws.calls, [['orig', `${CWD}/good.ts`]]);
  ok('I3 幂等安装 + 恢复');
}

console.log('--- stat 失败 / openInDsh 失败 ---');
{
  const ws = makeWorkspaces();
  const failDeps = {
    statPath: async () => {
      throw new Error('stat boom');
    },
    openInDsh: async (p) => {
      depsCalls.push(['dsh', p]);
      throw new Error('open boom');
    },
    currentCwd: () => CWD,
  };
  const handle = installOpenPathInterceptor(ws, failDeps);
  await ws.openPath(`${CWD}/good.ts`); // stat 失败 → 系统
  assert.deepEqual(ws.calls, [['orig', `${CWD}/good.ts`]]);
  handle.restore();

  const ws2 = makeWorkspaces();
  const okStatFailOpen = {
    statPath: async () => ({ type: 'file' }),
    openInDsh: async (p) => {
      depsCalls.push(['dsh', p]);
      throw new Error('open boom');
    },
    currentCwd: () => CWD,
  };
  const handle2 = installOpenPathInterceptor(ws2, okStatFailOpen);
  await ws2.openPath(`${CWD}/good.ts`); // openInDsh 失败被吞，不冒泡
  assert.deepEqual(ws2.calls, []);
  assert.deepEqual(depsCalls, [['dsh', `${CWD}/good.ts`]]);
  handle2.restore();
  ok('I4 异常路径：stat 失败回落系统、openInDsh 失败静默');
}

console.log(`\n全部通过：${passed} 项断言`);
