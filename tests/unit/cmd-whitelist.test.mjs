/**
 * 命令白名单 store 单元测试（W1）：normalize/match 前缀语义、粒度候选、持久化与坏数据回退。
 * 运行：node tests/unit/cmd-whitelist.test.mjs（需先 pnpm build 产出 lib/approval/cmd-whitelist.js）
 */
import {
  WHITELIST_STORAGE_KEY,
  normalizeTokens,
  matchCommand,
  buildCandidates,
  loadWhitelist,
  createWhitelistStore,
} from '../../lib/approval/cmd-whitelist.js';
import assert from 'node:assert/strict';

/** fake storage：内存 Map 实现 WhitelistStorage */
function makeStorage(seed) {
  const map = new Map();
  if (seed !== undefined) map.set(WHITELIST_STORAGE_KEY, seed);
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
    dump() {
      return map.get(WHITELIST_STORAGE_KEY);
    },
  };
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✅ ${name}`);
}

console.log('--- normalizeTokens ---');
{
  assert.deepEqual(normalizeTokens('  mvn   clean  package '), ['mvn', 'clean', 'package']);
  assert.deepEqual(normalizeTokens('npm install --save-dev'), ['npm', 'install', '--save-dev']);
  assert.deepEqual(normalizeTokens('   '), []);
  assert.deepEqual(normalizeTokens(''), []);
  ok('N1 trim + 空白折叠 + 空命令');
}

console.log('--- matchCommand 前缀语义 ---');
{
  const sub = { id: 'a', tokens: ['mvn', 'clean', 'package'], tokenCount: 3, createdAt: 1, exact: false };
  const name = { id: 'b', tokens: ['mvn'], tokenCount: 1, createdAt: 1, exact: false };
  const exact = {
    id: 'c',
    tokens: ['mvn', 'clean', 'package', '-D', 'maven.test.skip=true'],
    tokenCount: 5,
    createdAt: 1,
    exact: true,
  };
  assert.equal(matchCommand(sub, normalizeTokens('mvn clean package -D maven.test.skip=true')), true);
  assert.equal(matchCommand(sub, normalizeTokens('mvn clean package deploy')), true);
  assert.equal(matchCommand(sub, normalizeTokens('mvn clean install')), false, '子命令前缀不应命中 mvn clean install');
  assert.equal(matchCommand(name, normalizeTokens('mvn -v')), true);
  assert.equal(matchCommand(name, normalizeTokens('mvnx foo')), false, '命令名不应命中 mvnx（token 边界）');
  assert.equal(matchCommand(name, normalizeTokens('MVN -v')), false, '大小写敏感');
  assert.equal(matchCommand(name, normalizeTokens('')), false, '空命令不命中');
  assert.equal(matchCommand(exact, normalizeTokens('mvn clean package -D maven.test.skip=true')), true);
  assert.equal(matchCommand(exact, normalizeTokens('mvn clean package -D maven.test.skip=true extra')), false, '整行精确不应命中多参数');
  assert.equal(matchCommand(sub, normalizeTokens('mvn clean')), false, '目标比前缀短不命中');
  const prefixAll = { id: 'd', tokens: ['git', 'status'], tokenCount: 2, createdAt: 1, exact: false };
  assert.equal(matchCommand(prefixAll, normalizeTokens('git status --short')), true, '非 exact 全 token 条目可命中超集');
  ok('M1 前缀 token 匹配 + 边界 + 大小写');
}

console.log('--- buildCandidates 粒度候选 ---');
{
  const tokens = normalizeTokens('mvn clean package -D maven.test.skip=true');
  const candidates = buildCandidates(tokens);
  assert.equal(candidates.length, 5, '应有 5 个候选（1..N）');
  assert.deepEqual(candidates[0], { tokenCount: 1, label: 'mvn', exact: false });
  assert.deepEqual(candidates[2], { tokenCount: 3, label: 'mvn clean package', exact: false });
  assert.deepEqual(candidates[4], { tokenCount: 5, label: 'mvn clean package -D maven.test.skip=true', exact: true });
  assert.deepEqual(buildCandidates([]), []);
  ok('C1 候选生成（命令名/子命令前缀/整行）');
}

console.log('--- store 增删查 + 持久化 ---');
{
  const storage = makeStorage();
  const store = createWhitelistStore(storage, () => 1000);
  assert.deepEqual(store.getEntries(), []);
  const sub = store.addEntry(normalizeTokens('mvn clean package'), 3, false);
  assert.equal(sub.tokenCount, 3);
  assert.deepEqual(sub.tokens, ['mvn', 'clean', 'package']);
  assert.equal(store.matches(normalizeTokens('mvn clean package -D x')), true);
  assert.equal(store.matches(normalizeTokens('git status')), false);

  // 持久化：同一 storage 新建 store 仍读到
  const store2 = createWhitelistStore(storage);
  assert.equal(store2.getEntries().length, 1);
  assert.equal(store2.getEntries()[0].id, sub.id);

  // 删除 + 清空
  store2.removeEntry(sub.id);
  assert.deepEqual(store2.getEntries(), []);
  store.addEntry(normalizeTokens('npm install'), 2, false);
  store.addEntry(normalizeTokens('git status'), 2, false);
  store.clearAll();
  assert.deepEqual(store.getEntries(), []);
  assert.deepEqual(createWhitelistStore(storage).getEntries(), []);
  ok('S1 增删查 + 跨实例持久化');

  // 非法参数
  assert.throws(() => store.addEntry([], 1, false), /invalid whitelist/);
  assert.throws(() => store.addEntry(['mvn'], 2, false), /invalid whitelist/);
  ok('S2 非法参数拦截');

  // 订阅通知
  let notified = 0;
  const off = store.subscribe(() => {
    notified += 1;
  });
  store.addEntry(normalizeTokens('pnpm build'), 2, false);
  store.removeEntry(store.getEntries()[0].id);
  off();
  store.clearAll();
  assert.equal(notified, 2, '订阅只应在退订前收到通知');
  ok('S3 订阅通知');
}

console.log('--- 坏数据回退 ---');
{
  const storage = makeStorage('not-json');
  assert.deepEqual(loadWhitelist(storage), []);
  ok('L1 JSON 损坏回退空表');

  const mixed = JSON.stringify([
    { id: 'good', tokens: ['npm'], tokenCount: 1, createdAt: 1, exact: false },
    { id: 'bad-tokencount', tokens: ['npm', 'run'], tokenCount: 5, createdAt: 1, exact: false },
    { id: 'bad-tokens', tokens: ['npm', 42], tokenCount: 2, createdAt: 1, exact: false },
    { id: 'bad-exact', tokens: ['npm'], tokenCount: 1, createdAt: 1 },
    { id: 'bad-id', tokens: ['npm'], tokenCount: 1, exact: false },
    'string-entry',
    null,
  ]);
  const storage2 = makeStorage(mixed);
  const entries = loadWhitelist(storage2);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'good');
  const store = createWhitelistStore(storage2);
  assert.equal(store.getEntries().length, 1, '坏数据被过滤');
  assert.equal(store.matches(normalizeTokens('npm install')), true);
  ok('L2 坏条目过滤 + 好条目保留');
}

console.log(`\n全部通过：${passed} 项断言`);
