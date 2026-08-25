/**
 * terminal 服务单元测试（C5-1）：shell 白名单探测、会话生命周期、长轮询读取。
 * 运行：node tests/unit/terminal.test.mjs（需先 pnpm build 产出 lib/terminal.js）
 */
import { TerminalService, SHELL_SPECS, TermError } from '../../lib/terminal.js';
import assert from 'node:assert/strict';

/** fake PTY：同步可控的数据/退出注入 */
function makeFakePty() {
  const pty = {
    written: [],
    resized: [],
    killed: false,
    dataListeners: [],
    exitListeners: [],
    write(d) { pty.written.push(d); },
    resize(c, r) { pty.resized.push([c, r]); },
    kill() { pty.killed = true; },
    onData(cb) { pty.dataListeners.push(cb); },
    onExit(cb) { pty.exitListeners.push(cb); },
    emitData(d) { for (const cb of pty.dataListeners) cb(d); },
    emitExit(code) { for (const cb of pty.exitListeners) cb({ exitCode: code }); },
  };
  return pty;
}

/** mock ctx.fs：dirs 为存在的目录集合 */
function mockFs(dirs = ['C:/proj']) {
  return {
    resolve: async (p) => ({ targetKey: p, displayPath: p }),
    stat: async (t) => (dirs.includes(t.targetKey) ? { version: '1', type: 'directory', size: 0 } : undefined),
    processPath: (t) => t.targetKey,
  };
}

/** 收集 factory 调用 */
function makeFactory() {
  const calls = [];
  const ptys = [];
  const factory = (file, args, opts) => {
    const pty = makeFakePty();
    calls.push({ file, args, opts });
    ptys.push(pty);
    return pty;
  };
  return { factory, calls, ptys };
}

const ALL_EXIST = () => true;
const NONE_EXIST = () => false;

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✅ ${name}`);
}

async function expectTermError(name, fn, code) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof TermError, `[${name}] 应为 TermError，实际 ${error}`);
    assert.equal(error.code, code, `[${name}] 错误码应为 ${code}，实际 ${error.code}`);
    ok(name);
    return;
  }
  assert.fail(`[${name}] 应抛出 ${code}`);
}

console.log('--- terminal 服务测试 ---');

// T1. listShells：按 exists 探测可用性，覆盖全部白名单项
{
  const { factory } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: (p) => p.includes('powershell.exe') });
  const shells = svc.listShells();
  assert.equal(shells.length, SHELL_SPECS.length, '应返回全部白名单 shell');
  const ps = shells.find((s) => s.id === 'powershell');
  const cmd = shells.find((s) => s.id === 'cmd');
  assert.equal(ps.available, true, 'powershell 应可用');
  assert.equal(cmd.available, false, 'cmd 应不可用');
  ok('T1 listShells 可用性探测');
}

// T2. create：未知 shell → TERM_SHELL_UNKNOWN
{
  const { factory } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: ALL_EXIST });
  await expectTermError('T2 未知 shell', () => svc.create({ shell: 'zsh', cwd: 'C:/proj' }), 'TERM_SHELL_UNKNOWN');
}

// T3. create：shell 候选路径均不存在 → TERM_SHELL_UNAVAILABLE
{
  const { factory } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: NONE_EXIST });
  await expectTermError('T3 shell 未安装', () => svc.create({ shell: 'cmd', cwd: 'C:/proj' }), 'TERM_SHELL_UNAVAILABLE');
}

// T4. create：cwd 不存在 → TERM_CWD_INVALID
{
  const { factory } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(['C:/proj']), ptyFactory: factory, exists: ALL_EXIST });
  await expectTermError('T4 cwd 无效', () => svc.create({ shell: 'cmd', cwd: 'C:/nope' }), 'TERM_CWD_INVALID');
}

// T5. create 成功：返回 id/title/cursor=0；factory 收到可执行路径、processPath cwd、钳制后的尺寸
{
  const { factory, calls } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: ALL_EXIST });
  const result = await svc.create({ shell: 'powershell', cwd: 'C:/proj', cols: 1, rows: 99999 });
  assert.ok(typeof result.id === 'string' && result.id.length > 0, '应返回会话 id');
  assert.equal(result.title, 'PowerShell');
  assert.equal(result.cursor, 0);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].file.endsWith('powershell.exe'), `file 应为 powershell.exe，实际 ${calls[0].file}`);
  assert.equal(calls[0].opts.cwd, 'C:/proj');
  assert.ok(calls[0].opts.cols >= 2 && calls[0].opts.cols <= 500, 'cols 应被钳制');
  assert.ok(calls[0].opts.rows >= 2 && calls[0].opts.rows <= 500, 'rows 应被钳制');
  ok('T5 create 成功 + 参数校验');
}

// T6. input：写入 PTY；未知会话 → TERM_SESSION_NOT_FOUND
{
  const { factory, ptys } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: ALL_EXIST });
  const { id } = await svc.create({ shell: 'cmd', cwd: 'C:/proj' });
  svc.input(id, 'dir\r');
  assert.deepEqual(ptys[0].written, ['dir\r']);
  await expectTermError('T6 未知会话 input', async () => svc.input('nope', 'x'), 'TERM_SESSION_NOT_FOUND');
  ok('T6 input 写入');
}

// T7. read：已有缓冲数据 → 立即返回，cursor 推进
{
  const { factory, ptys } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: ALL_EXIST });
  const { id, cursor } = await svc.create({ shell: 'cmd', cwd: 'C:/proj' });
  ptys[0].emitData('C:\\proj> ');
  const r = await svc.read(id, cursor, 1000);
  assert.equal(r.data, 'C:\\proj> ');
  assert.ok(r.cursor > cursor, 'cursor 应推进');
  assert.equal(r.exited, false);
  assert.equal(r.dropped, false);
  ok('T7 read 立即返回缓冲数据');
}

// T8. read 长轮询：hold 期间来数据 → 立即唤醒返回
{
  const { factory, ptys } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: ALL_EXIST });
  const { id, cursor } = await svc.create({ shell: 'cmd', cwd: 'C:/proj' });
  const start = Date.now();
  const pending = svc.read(id, cursor, 5000);
  setTimeout(() => ptys[0].emitData('hello'), 30);
  const r = await pending;
  assert.equal(r.data, 'hello');
  assert.ok(Date.now() - start < 2000, '应在数据到达时提前返回');
  ok('T8 read 长轮询提前唤醒');
}

// T9. read 超时：无数据 → holdMs 后返回空，cursor 不变
{
  const { factory } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: ALL_EXIST });
  const { id, cursor } = await svc.create({ shell: 'cmd', cwd: 'C:/proj' });
  const start = Date.now();
  const r = await svc.read(id, cursor, 60);
  assert.equal(r.data, '');
  assert.equal(r.cursor, cursor);
  assert.equal(r.exited, false);
  assert.ok(Date.now() - start >= 50, '应至少 hold 到超时');
  ok('T9 read 超时返回空');
}

// T10. 进程退出：read 返回剩余数据 + exited=true；耗尽后 read 返回 exited=true
{
  const { factory, ptys } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: ALL_EXIST });
  const { id, cursor } = await svc.create({ shell: 'cmd', cwd: 'C:/proj' });
  ptys[0].emitData('bye');
  ptys[0].emitExit(0);
  const r1 = await svc.read(id, cursor, 1000);
  assert.equal(r1.data, 'bye');
  assert.equal(r1.exited, true);
  const r2 = await svc.read(id, r1.cursor, 60);
  assert.equal(r2.data, '');
  assert.equal(r2.exited, true);
  ok('T10 退出标记传递');
}

// T11. kill：挂起的 read 以 exited=true 唤醒；之后操作 → TERM_SESSION_NOT_FOUND
{
  const { factory, ptys } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: ALL_EXIST });
  const { id, cursor } = await svc.create({ shell: 'cmd', cwd: 'C:/proj' });
  const pending = svc.read(id, cursor, 5000);
  svc.kill(id);
  assert.equal(ptys[0].killed, true, 'pty 应被 kill');
  const r = await pending;
  assert.equal(r.exited, true, '挂起 read 应以 exited 唤醒');
  await expectTermError('T11 kill 后 read', () => svc.read(id, 0, 10), 'TERM_SESSION_NOT_FOUND');
  await expectTermError('T11 kill 后 input', async () => svc.input(id, 'x'), 'TERM_SESSION_NOT_FOUND');
}

// T12. resize：钳制并转发
{
  const { factory, ptys } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: ALL_EXIST });
  const { id } = await svc.create({ shell: 'cmd', cwd: 'C:/proj' });
  svc.resize(id, 120, 40);
  assert.deepEqual(ptys[0].resized, [[120, 40]]);
  svc.resize(id, 1, 99999);
  const [c, r] = ptys[0].resized[1];
  assert.ok(c >= 2 && c <= 500 && r >= 2 && r <= 500, 'resize 尺寸应被钳制');
  ok('T12 resize 转发');
}

// T13. 缓冲有界：超出上限丢弃最旧数据，落后 cursor 的读取标记 dropped
{
  const { factory, ptys } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: ALL_EXIST, maxBufferChars: 100 });
  const { id, cursor } = await svc.create({ shell: 'cmd', cwd: 'C:/proj' });
  ptys[0].emitData('x'.repeat(60));
  ptys[0].emitData('y'.repeat(60));
  const r = await svc.read(id, cursor, 1000);
  assert.equal(r.dropped, true, '落后读取应标记 dropped');
  assert.ok(r.data.includes('y'), '应包含最新数据');
  ok('T13 缓冲有界 + dropped');
}

// T14. 会话上限：超过 MAX_SESSIONS → TERM_TOO_MANY_SESSIONS
{
  const { factory } = makeFactory();
  const svc = new TerminalService({ fs: mockFs(), ptyFactory: factory, exists: ALL_EXIST, maxSessions: 2 });
  await svc.create({ shell: 'cmd', cwd: 'C:/proj' });
  await svc.create({ shell: 'cmd', cwd: 'C:/proj' });
  await expectTermError('T14 会话上限', () => svc.create({ shell: 'cmd', cwd: 'C:/proj' }), 'TERM_TOO_MANY_SESSIONS');
}

console.log(`\n全部通过：${passed} 项断言`);
