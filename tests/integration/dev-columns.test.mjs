/**
 * DevFrame 五列让渡求解纯函数测试（变更 C8）。
 * 覆盖：chat 展开（CENTER_MIN 让渡链回归）与 chat 收起（editor 弹性吸收 + details/tree 让渡兜底）。
 * esbuild 内存打包 src/client/shell/devColumns.ts（CJS，无外部依赖）。
 *
 * 运行：node tests/integration/dev-columns.test.mjs
 */
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundled = buildSync({
  entryPoints: [join(root, 'src', 'client', 'shell', 'devColumns.ts')],
  bundle: true,
  format: 'cjs',
  write: false,
  platform: 'neutral',
});
const mod = { exports: {} };
new Function('module', 'exports', bundled.outputFiles[0].text)(mod, mod.exports);
const { computeDevColumns } = mod.exports;

/* ── 微型断言框架 ── */
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (cause) {
    failed += 1;
    failures.push({ name, cause });
    console.log(`  ❌ ${name}: ${cause.message}`);
  }
}
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg ?? 'eq'}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/* 列宽契约（与 DevFrame.tsx 对齐）：CENTER_MIN 640 / DETAILS_MIN 300 / EDITOR_MIN 480 / TREE_MIN 240 */

/* ── A. chat 展开：让渡链回归（details → editor → tree，center 兜底） ── */
test('A1 空间充足：五列原样，center 吃剩余', () => {
  const cols = computeDevColumns(2200, 280, 360, 432, 360, true);
  eq(cols, { sidebar: 280, tree: 360, center: 768, editor: 432, details: 360 });
});

test('A2 空间不足先压 details（至 0 仍不够则关闭）', () => {
  const cols = computeDevColumns(1800, 280, 360, 432, 360, true);
  eq(cols, { sidebar: 280, tree: 360, center: 728, editor: 432, details: 0 });
});

test('A3 details 关闭后压 editor 至下限、再压 tree，center 兜底', () => {
  const cols = computeDevColumns(1600, 280, 360, 432, 360, true);
  // details→0 后 deficit=112；editor 432 已低于下限 480 → 归位 480（deficit 涨到 160）；
  // tree 吸收 160 → 200 低于 TREE_MIN 240 → 钳到 240；center 得剩余 600（下限让渡链穷尽后兜底）
  eq(cols, { sidebar: 280, tree: 240, center: 600, editor: 480, details: 0 });
});

/* ── B. chat 收起：center 0 宽，editor 弹性吸收全部剩余 ── */
test('B1 空间充足：editor = viewport - sidebar - tree - details，center=0', () => {
  const cols = computeDevColumns(2200, 280, 360, 432, 360, false);
  eq(cols, { sidebar: 280, tree: 360, center: 0, editor: 1200, details: 360 });
});

test('B2 空间不足先压 details 再给 editor（editor 保下限 480）', () => {
  const cols = computeDevColumns(1200, 280, 360, 432, 360, false);
  eq(cols, { sidebar: 280, tree: 360, center: 0, editor: 560, details: 0 });
});

test('B3 再不足压 tree 至下限，editor 达 480', () => {
  const cols = computeDevColumns(1000, 280, 360, 432, 360, false);
  eq(cols, { sidebar: 280, tree: 240, center: 0, editor: 480, details: 0 });
});

test('B4 极端窄屏：tree 已至下限，editor 兜底压缩（可低于 480）', () => {
  const cols = computeDevColumns(700, 280, 240, 432, 0, false);
  eq(cols, { sidebar: 280, tree: 240, center: 0, editor: 180, details: 0 });
});

test('B5 details 已关且空间充足：editor 独占剩余', () => {
  const cols = computeDevColumns(1600, 280, 360, 432, 0, false);
  eq(cols, { sidebar: 280, tree: 360, center: 0, editor: 960, details: 0 });
});

/* ── 运行 ── */
console.log('--- devColumns 让渡求解测试（变更 C8） ---');
console.log(`\n结果：${passed}/${passed + failed} 通过`);
if (failed > 0) {
  for (const f of failures) console.error(`\n[FAIL] ${f.name}\n`, f.cause);
  process.exit(1);
}
