/**
 * askFeed 聊天区增强集成测试（C7）：
 *  - extractUserQuestions：会话快照 chat.nodes → 用户提问队列（升序、连续去重、守卫）
 *  - createAskFeed：list→current→session 订阅链、引用稳定快照、降级
 *  - recallMove：↑↓ 历史回显状态机（暂存/遍历/恢复/越界）
 *
 * esbuild 内存打包 src/client/conversation/askFeed.ts（CJS，无 React 依赖）。
 * 运行：node tests/integration/ask-feed.test.mjs
 */
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundled = buildSync({
  entryPoints: [join(root, 'src', 'client', 'conversation', 'askFeed.ts')],
  bundle: true,
  format: 'cjs',
  write: false,
  platform: 'neutral',
});
const mod = { exports: {} };
new Function('module', 'exports', bundled.outputFiles[0].text)(mod, mod.exports);
const { extractUserQuestions, createAskFeed, recallMove, RECALL_IDLE } = mod.exports;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

/** 构造官方 chatNode 形状的用户/非用户节点 */
function userNode(key, seq, content, kind = 'user') {
  return [key, { key, kind, id: key, anchorSeq: seq, visibility: 'visible', data: { kind, seq, time: seq, content, source: { kind: 'user' } } }];
}

/* ── A 组：extractUserQuestions ── */

test('A1 提取用户提问并按 seq 升序', () => {
  const chat = {
    nodes: new Map([
      userNode('u1', 1, '第一个问题'),
      ['a1', { key: 'a1', kind: 'assistant-step', visibility: 'visible', data: { blocks: [] } }],
      userNode('u2', 5, '第二个问题'),
      userNode('s1', 8, '中途引导', 'steering'),
    ]),
  };
  assert.deepEqual(extractUserQuestions(chat), ['第一个问题', '第二个问题', '中途引导']);
});

test('A2 连续重复提问去重，非连续保留', () => {
  const chat = {
    nodes: new Map([
      userNode('u1', 1, '同上'),
      userNode('u2', 2, '同上'),
      userNode('u3', 3, '换个'),
      userNode('u4', 4, '同上'),
    ]),
  };
  assert.deepEqual(extractUserQuestions(chat), ['同上', '换个', '同上']);
});

test('A3 隐藏节点与空内容被过滤', () => {
  const hidden = userNode('u1', 1, '不可见');
  hidden[1].visibility = 'hidden';
  const empty = userNode('u2', 2, '   ');
  const nonStr = userNode('u3', 3, { blocks: [] });
  const chat = { nodes: new Map([hidden, empty, nonStr, userNode('u4', 4, '有效')]) };
  assert.deepEqual(extractUserQuestions(chat), ['有效']);
});

test('A4 结构漂移降级为空数组', () => {
  assert.deepEqual(extractUserQuestions(undefined), []);
  assert.deepEqual(extractUserQuestions({}), []);
  assert.deepEqual(extractUserQuestions({ nodes: null }), []);
  assert.deepEqual(extractUserQuestions({ nodes: 'not-a-map' }), []);
});

/* ── B 组：createAskFeed 订阅链 ── */

/** fake snapshot store（对齐 createSnapshotStore 面） */
function fakeStore(initial) {
  let snap = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => snap,
    set: (next) => {
      snap = next;
      for (const fn of listeners) fn();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** fake SessionRuntime 面 */
function fakeSessions() {
  const list = fakeStore({ current: undefined });
  const sessions = new Map();
  return { list, manager: { sessions }, _list: list, _sessions: sessions };
}

function fakeSession(chat) {
  const store = fakeStore({ chat });
  return { subscribe: store.subscribe, getSnapshot: store.getSnapshot, _set: store.set };
}

test('B1 无 sessions 绑定时快照为空且可订阅', () => {
  const feed = createAskFeed();
  assert.equal(feed.getSnapshot().sessionId, undefined);
  assert.deepEqual(feed.getSnapshot().questions, []);
  const seen = [];
  feed.subscribe(() => seen.push(1));
  assert.deepEqual(seen, []);
});

test('B2 选定会话后输出该会话提问队列', () => {
  const s = fakeSessions();
  const feed = createAskFeed();
  feed.bindSessions(s);
  const sess = fakeSession({ nodes: new Map([userNode('u1', 1, '问题一')]) });
  s.manager.sessions.set('sess-1', sess);
  s.list.set({ current: 'sess-1' });
  assert.equal(feed.getSnapshot().sessionId, 'sess-1');
  assert.deepEqual(feed.getSnapshot().questions, ['问题一']);
});

test('B3 会话内新提问到达即更新，切换会话重置队列', () => {
  const s = fakeSessions();
  const feed = createAskFeed();
  feed.bindSessions(s);
  const sess1 = fakeSession({ nodes: new Map([userNode('u1', 1, '一')]) });
  const sess2 = fakeSession({ nodes: new Map([userNode('u2', 1, '二甲'), userNode('u3', 2, '二乙')]) });
  s.manager.sessions.set('sess-1', sess1);
  s.manager.sessions.set('sess-2', sess2);
  s.list.set({ current: 'sess-1' });
  sess1._set({ chat: { nodes: new Map([userNode('u1', 1, '一'), userNode('u4', 3, '一·二')]) } });
  assert.deepEqual(feed.getSnapshot().questions, ['一', '一·二']);
  s.list.set({ current: 'sess-2' });
  assert.equal(feed.getSnapshot().sessionId, 'sess-2');
  assert.deepEqual(feed.getSnapshot().questions, ['二甲', '二乙']);
});

test('B4 快照引用稳定（useSyncExternalStore 契约）', () => {
  const s = fakeSessions();
  const feed = createAskFeed();
  feed.bindSessions(s);
  const sess = fakeSession({ nodes: new Map([userNode('u1', 1, '稳')]) });
  s.manager.sessions.set('sess-1', sess);
  s.list.set({ current: 'sess-1' });
  const a = feed.getSnapshot();
  sess._set({ chat: { nodes: new Map([userNode('u1', 1, '稳')]) } }); // 同内容刷新
  assert.equal(feed.getSnapshot(), a);
});

test('B5 current 指向不存在的会话 → 空队列不抛错', () => {
  const s = fakeSessions();
  const feed = createAskFeed();
  feed.bindSessions(s);
  s.list.set({ current: 'ghost' });
  assert.equal(feed.getSnapshot().sessionId, 'ghost');
  assert.deepEqual(feed.getSnapshot().questions, []);
});

test('B6 绑定面缺失（无 manager）→ 静默降级', () => {
  const feed = createAskFeed();
  feed.bindSessions({ list: fakeStore({ current: 'x' }) });
  assert.deepEqual(feed.getSnapshot().questions, []);
});

/* ── C 组：recallMove ↑↓ 回显状态机 ── */

test('C1 空历史：↑↓ 均放行', () => {
  assert.equal(recallMove(RECALL_IDLE, -1, [], '').draft, null);
  assert.equal(recallMove(RECALL_IDLE, 1, [], '').draft, null);
});

test('C2 首次 ↑：暂存草稿并回显最近一条', () => {
  const r = recallMove(RECALL_IDLE, -1, ['甲', '乙'], '写到一半');
  assert.equal(r.draft, '乙');
  assert.deepEqual(r.state, { active: true, index: 1, stash: '写到一半' });
});

test('C3 未回显时 ↓ 放行', () => {
  const r = recallMove(RECALL_IDLE, 1, ['甲'], '');
  assert.equal(r.draft, null);
  assert.equal(r.state.active, false);
});

test('C4 回显中 ↑ 到顶停留，↓ 越过最新恢复暂存', () => {
  let st = RECALL_IDLE;
  let r = recallMove(st, -1, ['甲', '乙'], ''); // → 乙
  st = r.state;
  r = recallMove(st, -1, ['甲', '乙'], ''); // → 甲
  assert.equal(r.draft, '甲');
  st = r.state;
  r = recallMove(st, -1, ['甲', '乙'], ''); // 到顶停留
  assert.equal(r.draft, '甲');
  st = r.state;
  r = recallMove(st, 1, ['甲', '乙'], ''); // → 乙
  assert.equal(r.draft, '乙');
  st = r.state;
  r = recallMove(st, 1, ['甲', '乙'], ''); // 越过最新 → 恢复暂存（空草稿）
  assert.equal(r.draft, '');
  assert.equal(r.state.active, false);
});

test('C5 回显期间历史队列变长（新提问入列）不崩', () => {
  const r1 = recallMove(RECALL_IDLE, -1, ['甲'], '暂存');
  assert.equal(r1.draft, '甲');
  const r2 = recallMove(r1.state, 1, ['甲', '乙'], '暂存'); // 越过原队尾但在新队列内
  assert.equal(r2.draft, '乙');
  const r3 = recallMove(r2.state, 1, ['甲', '乙'], '暂存');
  assert.equal(r3.draft, '暂存');
  assert.equal(r3.state.active, false);
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
