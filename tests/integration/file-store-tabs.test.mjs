/**
 * fileStore 多标签 + 沙箱授权集成测试。
 * esbuild 内存打包 src/client/filetree/fileStore.ts（CJS），注入 fetch /
 * window.localStorage / setTimeout 打桩，逐用例独立实例（模块级单例隔离）。
 *
 * 运行：node tests/integration/file-store-tabs.test.mjs
 */
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundled = buildSync({
  entryPoints: [join(root, 'src', 'client', 'filetree', 'fileStore.ts')],
  bundle: true,
  format: 'cjs',
  write: false,
  platform: 'neutral',
});
const storeCode = bundled.outputFiles[0].text;

const API = '/api/dsh-develop-ui';

/** 虚拟世界：内存文件系统 + fetch 路由 + localStorage + 沙箱拒绝目录集合。
 *  legacyRuntime=true 模拟旧版运行时（writeText 不识别第 5 参 sandboxPolicy，
 *  host 传 sandboxRoot 无效，仍被会话策略拒绝 → 走 /permission 重试回退）。 */
function makeWorld(sharedStorage, opts) {
  const legacy = opts?.legacyRuntime === true;
  const files = new Map(); // path -> { content, version }
  const denied = new Set(); // 被沙箱拒绝的目录
  const calls = []; // fetch 调用日志 { url, body }
  const storage = sharedStorage ?? new Map();

  const windowStub = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
  };

  const respond = (ok, status, data) => ({ ok, status, json: async () => data });

  async function fetchStub(url, opts = {}) {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ url, body });

    if (url.startsWith(`${API}/fs/read-text?path=`)) {
      const path = decodeURIComponent(url.slice(`${API}/fs/read-text?path=`.length));
      const file = files.get(path);
      if (!file) return respond(false, 404, { error: `not found: ${path}` });
      return respond(true, 200, { content: file.content, version: file.version });
    }
    if (url.startsWith(`${API}/fs/read-image?path=`)) {
      return respond(true, 200, { dataUrl: 'data:image/png;base64,AAAA' });
    }
    if (url === `${API}/fs/write-text`) {
      const { path, content, expectedVersion, sandboxRoot } = body;
      const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
      // 模拟 host 白名单：sandboxRoot 为本次调用的 workspaceRoot，路径在其下即放行
      const whitelisted =
        !legacy &&
        typeof sandboxRoot === 'string' &&
        (path.startsWith(sandboxRoot + '/') || path.startsWith(sandboxRoot + '\\'));
      if (denied.has(dir) && !whitelisted) {
        return respond(false, 403, { error: `cannot write "${path}": file access denied under workspace-write mode`, code: 'FS_SANDBOX_DENIED' });
      }
      const file = files.get(path);
      if (file && file.version !== expectedVersion) {
        return respond(false, 409, { error: 'version conflict', code: 'FS_VERSION_CONFLICT' });
      }
      const version = String(Number(expectedVersion || '0') + 1);
      files.set(path, { content, version });
      return respond(true, 200, { version });
    }
    if (url === `${API}/md/render`) return respond(true, 200, { html: '<p>md</p>' });
    if (url === `${API}/highlight`) return respond(true, 200, { html: '<pre>hl</pre>' });
    return respond(false, 404, { error: `unknown route: ${url}` });
  }

  // 重试循环加速：1.5s → 0ms（保持异步时序）
  const timeout = (fn) => setTimeout(fn, 0);

  return { files, denied, calls, storage, window: windowStub, fetch: fetchStub, timeout };
}

/** 每个用例独立 store 实例（模块级状态隔离） */
function freshStore(world) {
  const module = { exports: {} };
  new Function('module', 'exports', 'window', 'fetch', 'setTimeout', storeCode)(
    module,
    module.exports,
    world.window,
    world.fetch,
    world.timeout,
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

/** 预置文件并打开 */
async function openText(store, world, path, content = 'hello', version = '1') {
  world.files.set(path, { content, version });
  await store.openFile(path);
}

const suite = [];

/* ── A. 打开 / 标签模型 ── */
suite.push(['A1 初始状态为空', async () => {
  const s = freshStore(makeWorld());
  const st = s.getFileState();
  eq(st.tabs.length, 0); eq(st.activePath, ''); eq(st.editorOpen, false);
}]);

suite.push(['A2 openFile 文本：追加标签并激活', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt', 'hello', '1');
  const st = s.getFileState();
  eq(st.tabs.join(','), '/w/a.txt'); eq(st.activePath, '/w/a.txt');
  eq(st.editorOpen, true);
  eq(st.byPath['/w/a.txt'].content, 'hello');
  eq(st.byPath['/w/a.txt'].version, '1');
}]);

suite.push(['A3 openFile 已打开：不重读、保留未保存编辑', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.setContent('edited');
  const before = countCalls(w, 'read-text');
  await s.openFile('/w/a.txt');
  eq(countCalls(w, 'read-text'), before, 'read-text 调用次数不应增加');
  eq(s.getFileState().byPath['/w/a.txt'].content, 'edited');
  eq(s.getFileState().byPath['/w/a.txt'].dirty, true);
}]);

suite.push(['A4 openFile md：isMd 且触发渲染', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/README.md', '# hi', '1');
  await sleep(5);
  const tab = s.getFileState().byPath['/w/README.md'];
  eq(tab.isMd, true); eq(tab.isCode, false);
  assert(countCalls(w, 'md/render') >= 1, 'md/render 应被调用');
  eq(tab.mdHtml, '<p>md</p>');
}]);

suite.push(['A5 openFile 代码：isCode 且触发高亮', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/app.ts', 'const a=1', '1');
  await sleep(5);
  const tab = s.getFileState().byPath['/w/app.ts'];
  eq(tab.isCode, true);
  assert(countCalls(w, '/highlight') >= 1, 'highlight 应被调用');
  eq(tab.codeHtml, '<pre>hl</pre>');
}]);

suite.push(['A6 openFile 图片：image 视图（不走 read-text）', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await s.openFile('/w/pic.png');
  const tab = s.getFileState().byPath['/w/pic.png'];
  eq(tab.viewMode, 'image');
  eq(tab.imageSrc, 'data:image/png;base64,AAAA');
  eq(countCalls(w, 'read-text'), 0);
}]);

suite.push(['A7 openFile 读取失败：设置 error 且不追加标签', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await s.openFile('/w/missing.txt');
  const st = s.getFileState();
  eq(st.tabs.length, 0);
  assert(st.error.includes('not found'), `error 应含 not found，实际 ${st.error}`);
}]);

suite.push(['A8 openFile 多文件：tabs 顺序 = 打开顺序', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt'); await openText(s, w, '/w/c.txt');
  eq(s.getFileState().tabs.join(','), '/w/a.txt,/w/b.txt,/w/c.txt');
  eq(s.getFileState().activePath, '/w/c.txt');
}]);

suite.push(['A9 activateTab 切换活动标签', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt');
  s.activateTab('/w/a.txt');
  eq(s.getFileState().activePath, '/w/a.txt');
}]);

suite.push(['A10 activateTab 未知路径忽略', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.activateTab('/w/nope.txt');
  eq(s.getFileState().activePath, '/w/a.txt');
}]);

/* ── B. 关闭 ── */
suite.push(['B1 closeTab 活动标签：激活右邻居', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt'); await openText(s, w, '/w/c.txt');
  s.activateTab('/w/a.txt');
  s.closeTab('/w/a.txt');
  eq(s.getFileState().activePath, '/w/b.txt');
  eq(s.getFileState().tabs.join(','), '/w/b.txt,/w/c.txt');
}]);

suite.push(['B2 closeTab 活动最右：激活左邻居', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt');
  s.closeTab('/w/b.txt');
  eq(s.getFileState().activePath, '/w/a.txt');
}]);

suite.push(['B3 closeTab 非活动标签：active 不变、byPath 删除', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt'); await openText(s, w, '/w/c.txt');
  s.closeTab('/w/a.txt');
  eq(s.getFileState().activePath, '/w/c.txt');
  eq(s.getFileState().byPath['/w/a.txt'], undefined);
}]);

suite.push(['B4 closeTab 最后一个：内容列隐藏', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.closeTab('/w/a.txt');
  const st = s.getFileState();
  eq(st.tabs.length, 0); eq(st.activePath, ''); eq(st.editorOpen, false);
}]);

suite.push(['B5 closeAllTabs：全清 + 内容列隐藏', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt');
  s.closeAllTabs();
  const st = s.getFileState();
  eq(st.tabs.length, 0); eq(st.editorOpen, false);
  eq(Object.keys(st.byPath).length, 0);
}]);

suite.push(['B6 closeTabsLeft：保留目标及右侧', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt'); await openText(s, w, '/w/c.txt');
  s.closeTabsLeft('/w/b.txt');
  eq(s.getFileState().tabs.join(','), '/w/b.txt,/w/c.txt');
  eq(s.getFileState().byPath['/w/a.txt'], undefined);
}]);

suite.push(['B7 closeTabsRight：保留目标及左侧', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt'); await openText(s, w, '/w/c.txt');
  s.closeTabsRight('/w/b.txt');
  eq(s.getFileState().tabs.join(','), '/w/a.txt,/w/b.txt');
}]);

suite.push(['B8 closeTabsLeft 于首标签：无操作', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt');
  s.closeTabsLeft('/w/a.txt');
  eq(s.getFileState().tabs.length, 2);
}]);

/* ── C. 编辑状态 ── */
suite.push(['C1 setContent：标脏并清空片段选区', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.setSelectedSnippet('frag');
  s.setContent('new text');
  const tab = s.getFileState().byPath['/w/a.txt'];
  eq(tab.content, 'new text'); eq(tab.dirty, true); eq(tab.selectedSnippet, '');
}]);

suite.push(['C2 setContent 无活动标签：静默忽略', async () => {
  const s = freshStore(makeWorld());
  s.setContent('x'); // 不抛错即通过
  eq(s.getFileState().tabs.length, 0);
}]);

suite.push(['C3 setViewMode 切换视图', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/README.md');
  s.setViewMode('preview');
  eq(s.getFileState().byPath['/w/README.md'].viewMode, 'preview');
}]);

suite.push(['C4 setSelectedSnippet 记录片段', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.setSelectedSnippet('sel');
  eq(s.getFileState().byPath['/w/a.txt'].selectedSnippet, 'sel');
}]);

suite.push(['C5 setEditorOpen 最小化/展开', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.setEditorOpen(false);
  eq(s.getFileState().editorOpen, false);
  eq(s.getFileState().tabs.length, 1, '最小化不清标签');
  s.setEditorOpen(true);
  eq(s.getFileState().editorOpen, true);
}]);

suite.push(['C6 setCodeHtml 写入活动标签', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/app.ts');
  s.setCodeHtml('<pre>x</pre>');
  eq(s.getFileState().byPath['/w/app.ts'].codeHtml, '<pre>x</pre>');
}]);

/* ── D. 保存 / 重载 ── */
suite.push(['D1 saveFile 成功：saved + 版本更新 + dirty 清除', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt', 'hello', '1');
  s.setContent('v2 content');
  const outcome = await s.saveFile();
  eq(outcome, 'saved');
  const tab = s.getFileState().byPath['/w/a.txt'];
  eq(tab.dirty, false); eq(tab.version, '2');
  eq(w.files.get('/w/a.txt').content, 'v2 content');
}]);

suite.push(['D2 saveFile 版本冲突：failed + saveFailed + error', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt', 'hello', '1');
  w.files.set('/w/a.txt', { content: 'external', version: '3' }); // 外部升版本
  const outcome = await s.saveFile();
  eq(outcome, 'failed');
  const tab = s.getFileState().byPath['/w/a.txt'];
  eq(tab.saveFailed, true);
  assert(s.getFileState().error.includes('保存失败'), 'error 应提示保存失败');
}]);

suite.push(['D3 saveFile 无活动标签：failed', async () => {
  const s = freshStore(makeWorld());
  eq(await s.saveFile(), 'failed');
}]);

suite.push(['D4 saveFile 成功后 md 触发重渲染', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/README.md', '# a', '1');
  await sleep(5);
  const before = countCalls(w, 'md/render');
  await s.saveFile();
  await sleep(5);
  assert(countCalls(w, 'md/render') > before, '保存后应重新渲染 md');
}]);

suite.push(['D5 reloadFile：强制重读刷新内容/版本', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt', 'hello', '1');
  s.setContent('dirty edit');
  w.files.set('/w/a.txt', { content: 'disk new', version: '5' });
  await s.reloadFile('/w/a.txt');
  const tab = s.getFileState().byPath['/w/a.txt'];
  eq(tab.content, 'disk new'); eq(tab.version, '5'); eq(tab.dirty, false);
}]);

suite.push(['D6 reloadFile 未打开路径：走 openFile', async () => {
  const w = makeWorld(); const s = freshStore(w);
  w.files.set('/w/a.txt', { content: 'x', version: '1' });
  await s.reloadFile('/w/a.txt');
  await sleep(5);
  eq(s.getFileState().tabs.join(','), '/w/a.txt');
}]);

/* ── E. 订阅 ── */
suite.push(['E1 subscribe：patch 后通知且快照换引用', async () => {
  const w = makeWorld(); const s = freshStore(w);
  let notified = 0;
  const off = s.subscribeFile(() => { notified += 1; });
  const before = s.getFileState();
  await openText(s, w, '/w/a.txt');
  const after = s.getFileState();
  assert(notified >= 1, '应收到通知');
  assert(before !== after, '快照应换引用');
  off();
}]);

/* ── F. 沙箱授权流 ── */
suite.push(['F1 未信任目录被拒：弹授权提示 + sandbox-denied', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/x/a.txt', 'hello', '1');
  s.setContent('edited');
  w.denied.add('/x');
  const outcome = await s.saveFile();
  eq(outcome, 'sandbox-denied');
  const st = s.getFileState();
  eq(st.sandboxPrompt.path, '/x/a.txt'); eq(st.sandboxPrompt.dir, '/x');
  assert(st.error.includes('信任此文件夹'), `error 应引导信任，实际 ${st.error}`);
  eq(st.byPath['/x/a.txt'].dirty, true, '未保存内容保留');
}]);

suite.push(['F2 trustDir：持久化信任并进入重试状态', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/x/a.txt', 'hello', '1');
  w.denied.add('/x');
  await s.saveFile();
  s.trustDir('/x');
  eq(w.storage.get('dsh-develop-ui.trustedDirs'), '["/x"]');
  const st = s.getFileState();
  eq(st.sandboxPrompt, null, '提示应关闭');
  eq(st.sandboxRetry.dir, '/x');
  s.cancelSandboxApproval();
}]);

suite.push(['F3 信任后自动重试：白名单直写成功（无需 /permission）', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/x/a.txt', 'hello', '1');
  s.setContent('v2');
  w.denied.add('/x');
  await s.saveFile();
  s.trustDir('/x');
  await sleep(20); // 第一轮重试即携带 sandboxRoot 直写成功
  const tab = s.getFileState().byPath['/x/a.txt'];
  eq(tab.dirty, false, '自动重试应完成保存');
  eq(tab.version, '2');
  eq(s.getFileState().sandboxRetry, null, '成功后停止重试');
  const retryWrite = w.calls.filter((c) => c.url === `${API}/fs/write-text`).pop();
  eq(retryWrite.body.sandboxRoot, '/x', '重试应携带 sandboxRoot 白名单');
  assert(w.denied.has('/x'), '全程无需放开会话权限');
}]);

suite.push(['F3b 已信任目录首次保存：直接携带 sandboxRoot 即成功', async () => {
  const shared = new Map([['dsh-develop-ui.trustedDirs', '["/x"]']]);
  const w = makeWorld(shared); const s = freshStore(w);
  await openText(s, w, '/x/a.txt', 'hello', '1');
  s.setContent('v2');
  w.denied.add('/x');
  const outcome = await s.saveFile();
  eq(outcome, 'saved', '已信任目录应白名单直写成功');
  eq(s.getFileState().sandboxPrompt, null);
  eq(s.getFileState().sandboxRetry, null, '无需重试');
}]);

suite.push(['F4 cancelSandboxApproval：清除提示并停止重试', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/x/a.txt', 'hello', '1');
  s.setContent('edited');
  w.denied.add('/x');
  await s.saveFile();
  s.trustDir('/x');
  s.cancelSandboxApproval();
  const st = s.getFileState();
  eq(st.sandboxPrompt, null); eq(st.sandboxRetry, null);
  await sleep(15);
  eq(s.getFileState().byPath['/x/a.txt'].dirty, true, '取消后不再自动保存');
}]);

suite.push(['F5 旧运行时（不识别 sandboxRoot）：已信任再拒直接进重试 + /permission 提示', async () => {
  const w = makeWorld(undefined, { legacyRuntime: true }); const s = freshStore(w);
  await openText(s, w, '/x/a.txt', 'hello', '1');
  w.denied.add('/x');
  await s.saveFile();           // 首次：弹提示
  s.trustDir('/x');             // 信任（进重试）
  s.cancelSandboxApproval();    // 用户暂停重试
  const outcome = await s.saveFile(); // 再次保存：白名单参数被旧运行时忽略，仍被拒
  eq(outcome, 'sandbox-denied');
  const st = s.getFileState();
  eq(st.sandboxPrompt, null, '已信任目录不再弹提示');
  eq(st.sandboxRetry.dir, '/x', '直接进入重试');
  assert(st.error.includes('/permission'), `error 应提示 /permission，实际 ${st.error}`);
  s.cancelSandboxApproval();
}]);

suite.push(['F6 重试中版本冲突：停止重试并呈现错误', async () => {
  const w = makeWorld(undefined, { legacyRuntime: true }); const s = freshStore(w);
  await openText(s, w, '/x/a.txt', 'hello', '1');
  w.denied.add('/x');
  await s.saveFile();
  s.trustDir('/x');
  // 用户放开权限，但外部已把文件改为 v3（与标签内 v1 冲突）
  w.denied.delete('/x');
  w.files.set('/x/a.txt', { content: 'external', version: '3' });
  await sleep(20);
  eq(s.getFileState().sandboxRetry, null, '非沙箱错误应停止重试');
  eq(s.getFileState().byPath['/x/a.txt'].saveFailed, true);
  assert(s.getFileState().error.includes('保存失败'), '应呈现版本冲突错误');
}]);

suite.push(['F7 切换活动标签：取消授权流程', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/x/a.txt', 'hello', '1');
  await openText(s, w, '/w/b.txt', 'world', '1');
  s.activateTab('/x/a.txt');
  w.denied.add('/x');
  await s.saveFile();
  eq(s.getFileState().sandboxPrompt.dir, '/x');
  s.activateTab('/w/b.txt');
  eq(s.getFileState().sandboxPrompt, null, '切标签应关闭授权提示');
}]);

suite.push(['F8 信任列表跨会话恢复（localStorage）', async () => {
  const shared = new Map();
  const w1 = makeWorld(shared); const s1 = freshStore(w1);
  await openText(s1, w1, '/x/a.txt', 'hello', '1');
  w1.denied.add('/x');
  await s1.saveFile();
  s1.trustDir('/x');
  s1.cancelSandboxApproval();

  // 新实例（新会话）：同一 localStorage → 信任恢复，白名单直写成功
  const w2 = makeWorld(shared); const s2 = freshStore(w2);
  await openText(s2, w2, '/x/a.txt', 'hello', '1');
  s2.setContent('v2');
  w2.denied.add('/x');
  const outcome = await s2.saveFile();
  eq(outcome, 'saved', '恢复的信任应直接白名单保存成功');
  eq(s2.getFileState().sandboxPrompt, null);
  eq(s2.getFileState().sandboxRetry, null);
  const write = w2.calls.filter((c) => c.url === `${API}/fs/write-text`).pop();
  eq(write.body.sandboxRoot, '/x', '请求应携带恢复的信任目录');
}]);

suite.push(['F9 工作区文件保存不受信任流影响', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt', 'hello', '1');
  s.setContent('ok');
  eq(await s.saveFile(), 'saved');
  eq(s.getFileState().sandboxPrompt, null);
  eq(s.getFileState().sandboxRetry, null);
}]);

/* ── H. 右键菜单锚点语义（C4 依赖的 store 契约）── */
suite.push(['H1 closeTabsLeft 以非活动标签为锚', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt'); await openText(s, w, '/w/c.txt');
  // 活动标签是 c，右键 b → 关闭 b 左侧（a）
  s.closeTabsLeft('/w/b.txt');
  eq(s.getFileState().tabs.join(','), '/w/b.txt,/w/c.txt');
  eq(s.getFileState().activePath, '/w/c.txt', '活动标签不受影响');
}]);

suite.push(['H2 closeTabsRight 以非活动标签为锚且含 dirty：拦截确认', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt'); await openText(s, w, '/w/c.txt');
  s.setContent('edited c'); // c 为活动标签
  s.activateTab('/w/a.txt');
  // 右键 a（活动）→ 关闭右侧全部（b、c），c dirty → 拦截
  s.closeTabsRight('/w/a.txt');
  const st = s.getFileState();
  eq(st.tabs.length, 3, '确认前不关闭');
  eq(st.pendingClose.paths.join(','), '/w/b.txt,/w/c.txt');
  eq(st.pendingClose.dirtyPaths.join(','), '/w/c.txt');
}]);

/* ── G. dirty 关闭确认 ── */
suite.push(['G1 关闭 dirty 标签：拦截并弹确认', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.setContent('edited');
  s.closeTab('/w/a.txt');
  const st = s.getFileState();
  eq(st.tabs.length, 1, 'dirty 标签不应直接关闭');
  eq(st.pendingClose.dirtyPaths.join(','), '/w/a.txt');
}]);

suite.push(['G2 确认「不保存」：直接关闭丢弃修改', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.setContent('edited');
  s.closeTab('/w/a.txt');
  await s.confirmPendingClose('discard');
  eq(s.getFileState().tabs.length, 0);
  eq(w.files.get('/w/a.txt').content, 'hello', '不应写盘');
}]);

suite.push(['G3 确认「保存并关闭」：先落盘再关闭', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.setContent('v2');
  s.closeTab('/w/a.txt');
  await s.confirmPendingClose('save');
  eq(s.getFileState().tabs.length, 0);
  eq(w.files.get('/w/a.txt').content, 'v2', '应先保存');
}]);

suite.push(['G4 取消确认：标签保留且 dirty 保留', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.setContent('edited');
  s.closeTab('/w/a.txt');
  s.cancelPendingClose();
  const st = s.getFileState();
  eq(st.tabs.length, 1);
  eq(st.pendingClose, null);
  eq(st.byPath['/w/a.txt'].dirty, true);
}]);

suite.push(['G5 非 dirty 关闭：不弹确认直接关闭', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.closeTab('/w/a.txt');
  eq(s.getFileState().tabs.length, 0);
  eq(s.getFileState().pendingClose, null);
}]);

suite.push(['G6 closeAllTabs 含 dirty：确认仅列 dirty 文件', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt'); await openText(s, w, '/w/c.txt');
  s.activateTab('/w/b.txt');
  s.setContent('edited b');
  s.closeAllTabs();
  const st = s.getFileState();
  eq(st.tabs.length, 3, '确认前不应关闭');
  eq(st.pendingClose.paths.length, 3);
  eq(st.pendingClose.dirtyPaths.join(','), '/w/b.txt');
}]);

suite.push(['G7 closeTabsRight 含 dirty：同样走确认', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt'); await openText(s, w, '/w/b.txt');
  s.setContent('edited b'); // b 为活动标签
  s.activateTab('/w/a.txt');
  s.closeTabsRight('/w/a.txt');
  eq(s.getFileState().tabs.length, 2, '确认前不关闭');
  eq(s.getFileState().pendingClose.paths.join(','), '/w/b.txt');
}]);

suite.push(['G8 确认保存但保存失败：该标签保留不关闭', async () => {
  const w = makeWorld(); const s = freshStore(w);
  await openText(s, w, '/w/a.txt');
  s.setContent('v2');
  w.files.set('/w/a.txt', { content: 'external', version: '9' }); // 制造冲突
  s.closeTab('/w/a.txt');
  await s.confirmPendingClose('save');
  eq(s.getFileState().tabs.length, 1, '保存失败应保留标签');
  eq(s.getFileState().pendingClose, null);
}]);
console.log(`file-store-tabs: ${suite.length} 个用例\n`);
for (const [name, fn] of suite) await test(name, fn);

console.log(`\n结果：${passed}/${suite.length} 通过`);
if (failed > 0) {
  console.log('失败用例：');
  for (const f of failures) console.log(`  - ${f.name}: ${f.cause.message}`);
  process.exit(1);
}
console.log('ALL PASS');
