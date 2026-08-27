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
const { extractUserQuestions, extractUserQuestionEntries, createAskFeed, recallMove, pickQuestionAtScroll, RECALL_IDLE } = mod.exports;

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

test('A5 回归：MutableChatNodeStore 式类 Map（非 Map 实例）也能提取', () => {
  // 对齐 ui-conversation ChatSnapshotBuilder：nodes 是普通 class（仅 get/values），
  // 不是原生 Map——instanceof Map 守卫曾误判为空队列（C7 双功能失效根因）
  class FakeNodeStore {
    constructor(entries) { this.byKey = new Map(entries); }
    get(key) { return this.byKey.get(key); }
    values() { return this.byKey.values(); }
  }
  const chat = {
    nodes: new FakeNodeStore([
      userNode('u1', 1, '类Map问题一'),
      userNode('u2', 2, '类Map问题二', 'steering'),
    ]),
  };
  assert.deepEqual(extractUserQuestions(chat), ['类Map问题一', '类Map问题二']);
});

test('A6 回归：content 为 ContentBlock[] 时拼接 text 块（真机形状）', () => {
  // 运行期 data.content 是 [{type:'text', text}]（可含 image 块），不是 string
  const node = (key, seq, content) => [key, {
    key, kind: 'user', id: key, anchorSeq: seq, visibility: 'visible',
    data: { kind: 'user', seq, time: seq, content, source: { kind: 'user' } },
  }];
  const chat = {
    nodes: new Map([
      node('u1', 1, [{ type: 'text', text: '第一段' }, { type: 'image', attachment: {} }, { type: 'text', text: '第二段' }]),
      node('u2', 2, [{ type: 'image', attachment: {} }]), // 纯图片 → 跳过
      node('u3', 3, []), // 空块 → 跳过
      node('u4', 4, [{ type: 'text', text: '  ' }]), // 空白 → 跳过
    ]),
  };
  assert.deepEqual(extractUserQuestions(chat), ['第一段\n第二段']);
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

test('B7 快照 entries 含节点 key（浮层滚动定位用）', () => {
  const s = fakeSessions();
  const feed = createAskFeed();
  feed.bindSessions(s);
  const sess = fakeSession({ nodes: new Map([userNode('u1', 1, '甲'), userNode('u2', 2, '乙')]) });
  s.manager.sessions.set('sess-1', sess);
  s.list.set({ current: 'sess-1' });
  assert.deepEqual(feed.getSnapshot().entries, [
    { key: 'u1', text: '甲' },
    { key: 'u2', text: '乙' },
  ]);
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

/* ── D 组：pickQuestionAtScroll 滚动定位 ── */

test('D1 第一可见行本身是提问行 → 选中它', () => {
  const entries = [{ key: 'q1', text: '一' }, { key: 'q2', text: '二' }];
  assert.equal(pickQuestionAtScroll(entries, ['q1', 'a1', 'q2', 'a2'], 2), 'q2');
});

test('D2 第一可见行是回答行 → 回溯上方最近提问', () => {
  const entries = [{ key: 'q1', text: '一' }, { key: 'q2', text: '二' }];
  assert.equal(pickQuestionAtScroll(entries, ['q1', 'a1', 'a2', 'q2', 'a3'], 2), 'q1');
  assert.equal(pickQuestionAtScroll(entries, ['q1', 'a1', 'a2', 'q2', 'a3'], 4), 'q2');
});

test('D3 第一可见行在所有提问之前 → null（调用方回退第一条）', () => {
  const entries = [{ key: 'q1', text: '一' }];
  assert.equal(pickQuestionAtScroll(entries, ['ctx1', 'ctx2', 'q1'], 1), null);
});

test('D4 空条目或空行 → null', () => {
  assert.equal(pickQuestionAtScroll([], ['a1'], 0), null);
  assert.equal(pickQuestionAtScroll([{ key: 'q1', text: '一' }], [], 0), null);
});

test('D5 firstVisible 越界钳制到末行', () => {
  const entries = [{ key: 'q2', text: '二' }];
  assert.equal(pickQuestionAtScroll(entries, ['q1x', 'q2'], 99), 'q2');
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
