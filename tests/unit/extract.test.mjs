/**
 * 审批命令提取与应答单元测试（W2-1）：commandOf、rootToolCall、commandForApproval、answerApproval。
 * 运行：node tests/unit/extract.test.mjs（需先 pnpm build 产出 lib/approval/extract.js）
 */
import { commandOf, rootToolCall, commandForApproval, answerApproval, contextKey } from '../../lib/approval/extract.js';
import assert from 'node:assert/strict';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✅ ${name}`);
}

/** running tool call fixture */
function runningCall(callId, argsRaw, extra = {}) {
  return { callId, name: 'Bash', argsRaw, turn: 1, step: 1, time: 0, callView: null, subCalls: [], ...extra };
}

console.log('--- contextKey ---');
{
  assert.equal(contextKey('tool-call', 'abc'), '9:tool-callabc');
  assert.equal(contextKey('tool-call', ''), '9:tool-call');
  ok('K1 key 构造与官方格式一致');
}

console.log('--- commandOf ---');
{
  assert.equal(commandOf(runningCall('c1', JSON.stringify({ command: 'mvn clean package -D maven.test.skip=true' }))), 'mvn clean package -D maven.test.skip=true');
  assert.equal(commandOf(runningCall('c2', JSON.stringify({ command: 'git status' }))), 'git status');
  assert.equal(commandOf(runningCall('c3', JSON.stringify({ path: 'a.txt', content: 'x' }))), undefined, '无 command 字段 → undefined');
  assert.equal(commandOf(runningCall('c4', 'not-json{')), undefined, 'args 非 JSON → undefined');
  assert.equal(commandOf(undefined), undefined);
  assert.equal(commandOf(runningCall('c5', JSON.stringify({ command: 42 }))), undefined, 'command 非 string → undefined');
  ok('E1 commandOf 提取语义');
}

console.log('--- rootToolCall / commandForApproval ---');
{
  // fake snapshot：chat.nodes.get 按 key 匹配 tool-call 节点
  const nodeFor = (call) => ({ kind: 'tool-call', data: { root: call } });
  const snapshot = {
    chat: {
      nodes: {
        get: (key) => {
          if (key.includes('tool-call')) {
            if (key.includes('call-running')) return nodeFor(runningCall('call-running', JSON.stringify({ command: 'npm install' })));
            if (key.includes('call-result')) return { kind: 'tool-result', data: { root: {} } };
            if (key.includes('call-missing')) return undefined;
          }
          return undefined;
        },
      },
    },
  };

  const root = rootToolCall(snapshot, 'call-running');
  assert.ok(root !== undefined);
  assert.equal(root.callId, 'call-running');

  assert.equal(commandForApproval(snapshot, 'call-running'), 'npm install');
  assert.equal(commandForApproval(snapshot, undefined), undefined, '无 callId → undefined');
  assert.equal(commandForApproval(undefined, 'call-running'), undefined, '无 snapshot → undefined');
  assert.equal(commandForApproval(snapshot, 'call-result'), undefined, '已结算（有 kind）→ undefined');
  assert.equal(commandForApproval(snapshot, 'call-missing'), undefined, '节点缺失 → undefined');
  assert.equal(commandForApproval(snapshot, 'call-unknown'), undefined, '非 tool-call key → undefined');
  ok('E2 rootToolCall + commandForApproval');
}

console.log('--- answerApproval 编码 ---');
{
  let received = null;
  const wait = {
    sessionId: 'sess-1',
    payload: { approvalId: 'approval-1' },
    respond: async (result) => {
      received = result;
      return { accepted: true, reason: undefined };
    },
  };
  await answerApproval(wait, 'allowed-once');
  assert.deepEqual(received, {
    ok: true,
    value: { sessionId: 'sess-1', approvalId: 'approval-1', outcome: 'allowed-once' },
  });
  ok('A1 allowed-once 编码');

  await answerApproval(wait, 'rejected');
  assert.equal(received.value.outcome, 'rejected');
  ok('A2 rejected 编码');

  const rejectingWait = {
    sessionId: 's',
    payload: { approvalId: 'a' },
    respond: async () => ({ accepted: false, reason: 'stale' }),
  };
  await assert.rejects(() => answerApproval(rejectingWait, 'allowed-once'), /approval response rejected: stale/);
  ok('A3 host 拒绝时抛错');
}

console.log(`\n全部通过：${passed} 项断言`);
