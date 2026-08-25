/**
 * V3 验证冒烟测试：验证 lib/client.js 是 DSH 要求的
 * `window.__ModuleLoader__.load({ id, factory })` lazy-CJS 模块格式，
 * 且 factory 返回的 module.exports 带可调用的 apply（注入 slots stub）。
 *
 * 布局提供者架构（方案 C）：apply 注册 2 个槽位 —— root（DevFrame 五列框架，
 * 官方 ui-layout 禁用后由本插件接替）与 conversation.input.left（@文件 按钮）；
 * 并提供 ctx.layout 服务（reflect.provide）+ ThemePresenter（DOM stub）。
 *
 * 运行：node tests/integration/client-bundle-format.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const code = readFileSync(join(root, 'lib', 'client.js'), 'utf8');

// ── DOM stub（ThemePresenter 需要 document/body/getComputedStyle） ──
const styleStub = () => ({
  colorScheme: '',
  setProperty() {},
  removeProperty() {},
});
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({
    name: '',
    content: '',
    isConnected: false,
    dataset: {},
    textContent: '',
    remove() {
      this.isConnected = false;
    },
  }),
  documentElement: { style: styleStub() },
  body: { setAttribute() {}, removeAttribute() {}, style: styleStub() },
  head: {
    append(el) {
      el.isConnected = true;
    },
    appendChild(el) {
      el.isConnected = true;
    },
  },
};
globalThis.getComputedStyle = () => ({ backgroundColor: 'rgb(0,0,0)' });

let captured = null;
globalThis.window = {
  localStorage: { getItem: () => null, setItem() {} },
  __ModuleLoader__: {
    load(def) {
      captured = def;
    },
  },
};

new Function(code)();

if (!captured) throw new Error('FAIL: __ModuleLoader__.load 未被调用');
console.log('[1] load called, id =', captured.id);

const requireStub = (id) => ({ __stub: id });
const mod = captured.factory(requireStub);
console.log('[2] factory returned, exports keys =', Object.keys(mod));

if (typeof mod.apply !== 'function') throw new Error('FAIL: exports.apply 不是函数');
if (!Array.isArray(mod.inject) || !mod.inject.includes('slots')) {
  throw new Error(`FAIL: exports.inject 应包含 'slots'，实际 ${JSON.stringify(mod.inject)}`);
}
console.log('[2.5] exports.inject =', JSON.stringify(mod.inject));

// ctx stub：inject 立即执行注册；effect 立即执行并收集 disposer
const registered = [];
const provided = [];
const disposers = [];
const ctxStub = {
  slots: {
    inject(name, register) {
      console.log(`[3] slots.inject(${name})`);
      register();
      return () => {};
    },
    register(options, component) {
      registered.push(options.name);
      console.log(`[3] slots.register(${JSON.stringify(options.name)}) component=${typeof component}`);
      return () => {};
    },
  },
  reflect: {
    provide(name, service) {
      provided.push(name);
      console.log(`[3] reflect.provide(${name}) service=${typeof service}`);
      return () => {};
    },
  },
  theme: {
    getTheme: () => ({ active: { colorScheme: 'dark', tokens: { '--ds-bg': '#000' } } }),
  },
  on: (event) => {
    console.log(`[3] ctx.on(${event})`);
    return () => {};
  },
  effect: (fn, label) => {
    console.log(`[3] ctx.effect(${label ?? ''})`);
    disposers.push(fn());
  },
};
mod.apply(ctxStub);

if (registered.length !== 2) {
  throw new Error(`FAIL: 期望注册 2 个 slot（root + conversation.input.left），实际 ${registered.length}: ${registered.join(',')}`);
}
if (!registered.includes('root') || !registered.includes('conversation.input.left')) {
  throw new Error(`FAIL: 槽位应为 root / conversation.input.left，实际 ${registered.join(',')}`);
}
console.log(`[4] apply() 注册 ${registered.length} 个槽位（${registered.join(' + ')}）✅`);

if (!provided.includes('layout')) {
  throw new Error(`FAIL: 应提供 ctx.layout 服务（官方条目依赖），实际 ${provided.join(',')}`);
}
console.log('[5] ctx.layout 服务已提供（DevLayoutController）✅');

// ── C5 终端面板断言：host 路由注册 + client 面板组件打包进 bundle ──
const hostCode = readFileSync(join(root, 'lib', 'index.js'), 'utf8');
// bundle 中保留 `${TERM}/xxx` 模板字符串（TERM = API_PREFIX + '/terminal'）
const termRoutes = ['${TERM}/shells', '${TERM}/create', '${TERM}/input', '${TERM}/resize', '${TERM}/read', '${TERM}/kill'];
for (const route of termRoutes) {
  if (!hostCode.includes(route)) {
    throw new Error(`FAIL: host bundle 缺少终端路由 ${route}`);
  }
}
console.log('[6] host 终端路由 6 条已注册（shells/create/input/resize/read/kill）✅');
if (!hostCode.includes('node-pty')) {
  throw new Error('FAIL: host bundle 应外部引用 node-pty（external，运行时解析）');
}
console.log('[7] node-pty 外部引用存在（未被打包，运行时由宿主 node_modules 解析）✅');

if (!code.includes('dskDevTermPanel') || !code.includes('dskDevTermView')) {
  throw new Error('FAIL: client bundle 缺少终端面板组件（dskDevTermPanel/dskDevTermView）');
}
if (!code.includes('xterm')) {
  throw new Error('FAIL: client bundle 应打包 @xterm/xterm（client 半不能依赖宿主提供 npm 包）');
}
console.log('[8] client 终端面板 + xterm 已打包进 bundle ✅');

// ── C6 monaco 编辑器内核断言：内核/主题/字体打进 bundle，旧叠层退役 ──
if (!code.includes('dsk-dark')) {
  throw new Error('FAIL: client bundle 缺少 dsk-dark 主题（editorHost 未打包）');
}
if (!code.includes('data:font/ttf;base64')) {
  throw new Error('FAIL: client bundle 缺少 codicon 字体 base64 内联（monaco-css-inject 插件失效）');
}
if (!code.includes('dskDevMonacoWrap')) {
  throw new Error('FAIL: client bundle 缺少 monaco 编辑区容器（MonacoEditorArea 未打包）');
}
if (code.includes('dskDevEditBackdrop')) {
  throw new Error('FAIL: 旧「透明 textarea 叠 shiki 层」编辑器仍在 bundle 中（应已退役）');
}
console.log('[9] monaco 内核 + dsk-dark 主题 + codicon 字体已打包，旧叠层编辑器退役 ✅');

console.log('SMOKE PASS');
