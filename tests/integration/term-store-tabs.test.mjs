/**
 * termStore 终端面板集成测试（C5 v2）：tab 模型、关闭策略（右邻居/左右/全部）、
 * 面板显隐联动、高度记忆、shell 探测与标题序号、输出订阅。
 * esbuild 内存打包 src/client/terminal/termStore.ts（CJS），注入 fetch /
 * window.localStorage 打桩，逐用例独立实例（模块级单例隔离）。
 *
 * 运行：node tests/integration/term-store-tabs.test.mjs
 */
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundled = buildSync({
  entryPoints: [join(root, 'src', 'client', 'terminal', 'termStore.ts')],
  bundle: true,
  format: 'cjs',
  write: false,
  platform: 'neutral',
});
const storeCode = bundled.outputFiles[0].text;

const API = '/api/dsk-develop-ui/terminal';
const HEIGHT_KEY = 'dsk-develop-ui.termHeight';
const SHELL_KEY = 'dsk-develop-ui.terminalShell';

const DEFAULT_SHELLS = [
  { id: 'powershell', title: 'PowerShell', available: true },
  { id: 'pwsh', title: 'PowerShell 7', available: false },
  { id: 'cmd', title: '命令提示符', available: true },
  { id: 'bash', title: 'Git Bash', available: true },
];

/** 虚拟世界：内存 PTY 会话表 + fetch 路由 + localStorage。
 *  read 长轮询真实挂起（waiter 队列），pushOutput/exitSession 驱动唤醒；
 *  opts.failCreate 模拟创建失败；opts.shells 覆盖探测结果。 */
function makeWorld(opts = {}) {
  const shells = opts.shells ?? DEFAULT_SHELLS;
  const calls = [];
  const storage = opts.storage ?? new Map();
  let createSeq = 0;
  const sessions = new Map(); // id -> { seq, output:[{seq,data}], waiters:[], exited }

  const windowStub = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
  };
  const respond = (ok, status, data) => ({ ok, status, json: async () => data });
  const flush = (s) => {
    for (const wake of s.waiters.splice(0)) wake();
  };

  async function fetchStub(url, fetchOpts = {}) {
    const body = fetchOpts.body ? JSON.parse(fetchOpts.body) : undefined;
    calls.push({ url, body });

    if (url === `${API}/shells`) return respond(true, 200, { shells });
    if (url === `${API}/create`) {
      if (opts.failCreate === true) {
        return respond(false, 400, { error: 'shell not installed', code: 'TERM_SHELL_UNAVAILABLE' });
      }
      createSeq += 1;
      const id = `t${createSeq}`;
      sessions.set(id, { seq: 0, output: [], waiters: [], exited: false });
      const spec = shells.find((s) => s.id === body.shell);
      return respond(true, 200, { id, title: spec?.title ?? body.shell, cursor: 0 });
    }
    if (url === `${API}/input` || url === `${API}/resize`) {
      if (!sessions.has(body.id)) return respond(false, 404, { error: 'session not found', code: 'TERM_SESSION_NOT_FOUND' });
      return respond(true, 200, { ok: true });
    }
    if (url === `${API}/kill`) {
      const s = sessions.get(body.id);
      if (s) {
        s.exited = true;
        flush(s);
      }
      return respond(true, 200, { ok: true });
    }
    if (url.startsWith(`${API}/read?`)) {
      const params = new URL(url, 'http://localhost').searchParams;
      const id = params.get('id');
      const after = Number(params.get('after'));
      const s = sessions.get(id);
      if (!s) return respond(false, 404, { error: 'session not found', code: 'TERM_SESSION_NOT_FOUND' });
      // 真实挂起：直到 pushOutput / exitSession / kill 唤醒
      return new Promise((resolve) => {
        s.waiters.push(() => {
          const fresh = s.output.filter((c) => c.seq > after);
          const cursor = fresh.length > 0 ? fresh[fresh.length - 1].seq : after;
          resolve(respond(true, 200, { data: fresh.map((c) => c.data).join(''), cursor, exited: s.exited, dropped: false }));
        });
      });
    }
    return respond(false, 404, { error: `unknown route: ${url}` });
  }

  function pushOutput(id, data) {
    const s = sessions.get(id);
    s.seq += 1;
    s.output.push({ seq: s.seq, data });
    flush(s);
  }
  function exitSession(id) {
    const s = sessions.get(id);
    s.exited = true;
    flush(s);
  }

  return { calls, storage, sessions, window: windowStub, fetch: fetchStub, pushOutput, exitSession };
}

/** 每个用例独立 store 实例（模块级状态隔离） */
function freshStore(world) {
  const module = { exports: {} };
  new Function('module', 'exports', 'window', 'fetch', 'setTimeout', storeCode)(
    module,
    module.exports,
    world.window,
    world.fetch,
    (fn) => setTimeout(fn, 0),
  );
  return module.exports;
}

/* ── 微型断言框架 ── */
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✅ ${name}`);
    })
    .catch((cause) => {
      failed += 1;
      failures.push({ name, cause });
      console.log(`  ❌ ${name}: ${cause.message}`);
    });
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? 'assertion failed');
}
function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg ?? 'eq'}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const countCalls = (world, route) => world.calls.filter((c) => c.url.includes(route)).length;

/** 建 N 个 cmd 终端，返回 store 与 id 列表（标题 命令提示符 1..N） */
async function makeTerms(store, n, cwd = 'C:/proj') {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    await store.createTerm('cmd', cwd);
    ids.push(store.getTermState().activeId);
  }
  return ids;
}

const suite = [];

/* ── A. 面板显隐与新建 ── */
suite.push(['A1 初始状态：空 tabs、面板关闭、默认高度 260', async () => {
  const s = freshStore(makeWorld());
  const st = s.getTermState();
  eq(st.tabs.length, 0); eq(st.activeId, null); eq(st.panelOpen, false); eq(st.height, 260);
}]);

suite.push(['A2 首次打开面板自动创建首个终端（默认 cmd，cwd=工作区）', async () => {
  const w = makeWorld(); const s = freshStore(w);
  s.setPanelOpen(true, 'C:/proj');
  await sleep(10);
  const st = s.getTermState();
  eq(st.panelOpen, true);
  eq(st.tabs.length, 1, '应自动创建首个终端');
  eq(st.tabs[0].title, '命令提示符 1');
  eq(st.activeId, st.tabs[0].id);
  const create = w.calls.find((c) => c.url === `${API}/create`);
  eq(create.body.shell, 'cmd'); eq(create.body.cwd, 'C:/proj');
}]);

suite.push(['A3 无工作区路径：打开面板但不创建终端', async () => {
  const w = makeWorld(); const s = freshStore(w);
  s.setPanelOpen(true, undefined);
  await sleep(10);
  const st = s.getTermState();
  eq(st.panelOpen, true); eq(st.tabs.length, 0, '无 cwd 不应创建');
  eq(countCalls(w, 'create'), 0);
}]);

suite.push(['A4 shell 全部不可用：报 createError，不创建', async () => {
  const w = makeWorld({ shells: DEFAULT_SHELLS.map((s) => ({ ...s, available: false })) });
  const s = freshStore(w);
  s.setPanelOpen(true, 'C:/proj');
  await sleep(10);
  eq(s.getTermState().tabs.length, 0);
  assert(s.getTermState().createError !== null, '应设置 createError');
}]);

suite.push(['A5 lastShell 记忆：预置 cmd → 自动创建用 cmd', async () => {
  const storage = new Map([[SHELL_KEY, 'cmd']]);
  const w = makeWorld({ storage }); const s = freshStore(w);
  s.setPanelOpen(true, 'C:/proj');
  await sleep(10);
  const create = w.calls.find((c) => c.url === `${API}/create`);
  eq(create.body.shell, 'cmd');
  eq(s.getTermState().tabs[0].title, '命令提示符 1');
}]);

suite.push(['A6 标题序号：同 shell 递增、跨 shell 独立、创建后记忆 lastShell', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await s.createTerm('cmd', 'C:/proj');
  await s.createTerm('cmd', 'C:/proj');
  await s.createTerm('powershell', 'C:/proj');
  const titles = s.getTermState().tabs.map((t) => t.title);
  eq(titles.join(','), '命令提示符 1,命令提示符 2,PowerShell 1');
  eq(s.getTermState().lastShell, 'powershell');
  eq(w.storage.get(SHELL_KEY), 'powershell', 'lastShell 应持久化');
}]);

suite.push(['A7 创建失败：createError 设置、不产生 tab、creating 复位', async () => {
  const w = makeWorld({ failCreate: true }); const s = freshStore(w);
  await s.createTerm('cmd', 'C:/proj');
  const st = s.getTermState();
  eq(st.tabs.length, 0);
  eq(st.creating, false);
  assert(st.createError !== null && st.createError.includes('not installed'), `createError 应含错误信息，实际 ${st.createError}`);
}]);

suite.push(['A8 defaultShell 回退链：默认 cmd；cmd 不可用时回退第一个可用项', async () => {
  const w1 = makeWorld({
    shells: DEFAULT_SHELLS.map((s) => (s.id === 'powershell' ? { ...s, available: false } : s)),
  });
  const s1 = freshStore(w1);
  await s1.ensureShells();
  eq(s1.defaultShell(), 'cmd', 'powershell 不可用不影响 cmd 默认');
  const w2 = makeWorld({
    shells: DEFAULT_SHELLS.map((s) => (s.id === 'cmd' ? { ...s, available: false } : s)),
  });
  const s2 = freshStore(w2);
  await s2.ensureShells();
  eq(s2.defaultShell(), 'powershell', 'cmd 不可用时回退第一个可用项');
}]);

/* ── B. 关闭策略（镜像文件内容 Tab 语义） ── */
suite.push(['B1 ✕ 关闭活动 tab → 右邻居激活', async () => {
  const w = makeWorld(); const s = freshStore(w);
  const [t1, t2, t3] = await makeTerms(s, 3);
  s.activateTerm(t2);
  s.closeTerm(t2);
  eq(s.getTermState().activeId, t3, '右邻居应激活');
  eq(s.getTermState().tabs.map((t) => t.id).join(','), `${t1},${t3}`);
}]);

suite.push(['B2 关闭最右活动 tab → 左邻居激活', async () => {
  const w = makeWorld(); const s = freshStore(w);
  const [t1, t2] = await makeTerms(s, 2);
  s.activateTerm(t2);
  s.closeTerm(t2);
  eq(s.getTermState().activeId, t1);
}]);

suite.push(['B3 关闭非活动 tab → activeId 不变', async () => {
  const w = makeWorld(); const s = freshStore(w);
  const [t1, t2] = await makeTerms(s, 2);
  s.activateTerm(t2);
  s.closeTerm(t1);
  eq(s.getTermState().activeId, t2);
  eq(s.getTermState().tabs.length, 1);
}]);

suite.push(['B4 关闭最后一个 tab → 面板自动隐藏', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await s.createTerm('cmd', 'C:/proj');
  const id = s.getTermState().activeId;
  s.closeTerm(id);
  const st = s.getTermState();
  eq(st.tabs.length, 0); eq(st.activeId, null); eq(st.panelOpen, false);
}]);

suite.push(['B5 全部关闭：kill 全部远端会话 + 面板隐藏', async () => {
  const w = makeWorld(); const s = freshStore(w);
  const ids = await makeTerms(s, 3);
  s.closeAllTerms();
  eq(s.getTermState().tabs.length, 0);
  eq(s.getTermState().panelOpen, false);
  const kills = w.calls.filter((c) => c.url === `${API}/kill`).map((c) => c.body.id);
  eq(kills.join(','), ids.join(','), '每个会话都应收到 kill');
}]);

suite.push(['B6 关闭左侧/右侧全部（含非活动锚点，对齐文件 Tab H1-H2）', async () => {
  const w = makeWorld(); const s = freshStore(w);
  const [t1, t2, t3, t4] = await makeTerms(s, 4);
  s.activateTerm(t1);
  s.closeTermsRight(t2); // 非活动锚点
  eq(s.getTermState().tabs.map((t) => t.id).join(','), `${t1},${t2}`);
  eq(s.getTermState().activeId, t1, '锚点左侧的活动 tab 不受影响');
  s.closeTermsLeft(t2);
  eq(s.getTermState().tabs.map((t) => t.id).join(','), t2);
  eq(s.getTermState().activeId, t2, '活动 tab 被关后回退锚点');
}]);

suite.push(['B7 closeTerm 调用远端 kill（body id 正确）', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await s.createTerm('cmd', 'C:/proj');
  const id = s.getTermState().activeId;
  s.closeTerm(id);
  await sleep(5);
  const kill = w.calls.find((c) => c.url === `${API}/kill`);
  eq(kill.body.id, id);
}]);

/* ── C. 面板联动与高度 ── */
suite.push(['C1 再开面板：已有 tab 时不重复创建（会话保留）', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await s.createTerm('cmd', 'C:/proj');
  const before = countCalls(w, 'create');
  s.setPanelOpen(false);
  s.setPanelOpen(true, 'C:/proj');
  await sleep(10);
  eq(countCalls(w, 'create'), before, '已有 tab 再开不应重建');
  eq(s.getTermState().tabs.length, 1);
}]);

suite.push(['C2 setHeight 钳制 120–480 + localStorage 记忆', async () => {
  const w = makeWorld(); const s = freshStore(w);
  s.setHeight(50);
  eq(s.getTermState().height, 120);
  s.setHeight(9999);
  eq(s.getTermState().height, 480);
  eq(w.storage.get(HEIGHT_KEY), '480');
  s.setHeight(300);
  eq(s.getTermState().height, 300);
}]);

suite.push(['C3 高度记忆：storage 预置 999 → 初始 480；预置 200 → 初始 200', async () => {
  const w1 = makeWorld({ storage: new Map([[HEIGHT_KEY, '999']]) });
  eq(freshStore(w1).getTermState().height, 480);
  const w2 = makeWorld({ storage: new Map([[HEIGHT_KEY, '200']]) });
  eq(freshStore(w2).getTermState().height, 200);
}]);

suite.push(['C4 activateTerm 切换活动 tab；未知 id 不变', async () => {
  const w = makeWorld(); const s = freshStore(w);
  const [t1, t2] = await makeTerms(s, 2);
  s.activateTerm(t1);
  eq(s.getTermState().activeId, t1);
  s.activateTerm('nope');
  eq(s.getTermState().activeId, t1);
  s.activateTerm(t2);
  eq(s.getTermState().activeId, t2);
}]);

/* ── D. 输出订阅与退出标记 ── */
suite.push(['D1 onTermData 接收 host 输出，cursor 推进', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await s.createTerm('cmd', 'C:/proj');
  const id = s.getTermState().activeId;
  const received = [];
  const off = s.onTermData(id, (d) => received.push(d));
  await sleep(5); // 等首个 read 挂起
  w.pushOutput(id, 'C:\\proj> ');
  await sleep(5);
  eq(received.join(''), 'C:\\proj> ');
  const reads = w.calls.filter((c) => c.url.startsWith(`${API}/read?`));
  assert(reads.some((c) => c.url.includes('after=1')), 'cursor 应推进到 1');
  off();
}]);

suite.push(['D2 远端 exited → tab 标记「已退出」，read 循环终止', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await s.createTerm('cmd', 'C:/proj');
  const id = s.getTermState().activeId;
  await sleep(5);
  w.exitSession(id);
  await sleep(5);
  eq(s.getTermState().tabs[0].exited, true);
  const readsBefore = countCalls(w, 'read?');
  await sleep(10);
  eq(countCalls(w, 'read?'), readsBefore, 'exited 后不应再发 read');
}]);

/* ── 运行 ── */
console.log('--- termStore 终端面板测试 ---');
for (const [name, fn] of suite) await test(name, fn);
console.log(`\n结果：${passed}/${passed + failed} 通过`);
if (failed > 0) {
  for (const f of failures) console.error(`\n[FAIL] ${f.name}\n`, f.cause);
  process.exit(1);
}
