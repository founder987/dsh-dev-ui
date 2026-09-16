/**
 * V3 验证冒烟测试：验证 lib/client.js 是 DSH 要求的
 * `window.__ModuleLoader__.load({ id, factory })` lazy-CJS 模块格式，
 * 且 factory 返回的 module.exports 带可调用的 apply（注入 slots stub）。
 *
 * 布局提供者架构（方案 C）：apply 注册 3 个槽位 —— root（DevFrame 五列框架，
 * 官方 ui-layout 禁用后由本插件接替）与 conversation.input.left ×2（@文件 按钮 +
 * C7 ↑↓ 历史回显 null 组件）；并提供 ctx.layout 服务（reflect.provide，
 * 0.1.5-rc.2 官方 LayoutController 等价面：selectPanel/beginNavigation/toggleSidebar/
 * openRightbar/closeRightbar）+ panelInfo 钩子（slots.provideRoot）+
 * ThemePresenter（DOM stub）。C7：exports.inject 增 'sessions'（提问数据源）。
 * C10：浮层复制按钮（dskDevAskCopy + 「已复制」反馈文案）。
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

// 模块表 stub：只有 @deepseek-ai/dsh-client-store 需要真实现（apply 内建 store 实例）
const storeStub = {
  defineStore(spec) {
    const actions = {};
    const state = spec.init();
    for (const key of Object.keys(spec.actions)) {
      actions[key] = (...params) => spec.actions[key](state, ...params);
    }
    const listeners = new Set();
    return {
      spec,
      create: () => ({
        actions,
        getSnapshot: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        store: { update: (mutator) => mutator(state) },
        clearPersisted: () => {},
      }),
    };
  },
};
const requireStub = (id) => (id === '@deepseek-ai/dsh-client-store' ? storeStub : { __stub: id });
const mod = captured.factory(requireStub);
console.log('[2] factory returned, exports keys =', Object.keys(mod));

if (typeof mod.apply !== 'function') throw new Error('FAIL: exports.apply 不是函数');
if (!Array.isArray(mod.inject) || !mod.inject.includes('slots')) {
  throw new Error(`FAIL: exports.inject 应包含 'slots'，实际 ${JSON.stringify(mod.inject)}`);
}
console.log('[2.5] exports.inject =', JSON.stringify(mod.inject));

// ctx stub：inject 立即执行注册；effect 立即执行并收集 disposer
const registered = [];
const registrationOptions = new Map();
const provided = [];
const providedServices = new Map();
const providedRootHooks = [];
const disposers = [];
const rootPanels = [
  { options: { key: 'conversation' } },
  { options: { key: 'plugin-inventory' } },
];
const ctxStub = {
  slots: {
    inject(name, register) {
      console.log(`[3] slots.inject(${name})`);
      register();
      return () => {};
    },
    register(options, component) {
      registered.push(options.name);
      registrationOptions.set(options.name, options);
      console.log(`[3] slots.register(${JSON.stringify(options.name)}) component=${typeof component}`);
      return () => {};
    },
    provideRoot(options) {
      providedRootHooks.push(...Object.keys(options.hooks));
      console.log(`[3] slots.provideRoot(hooks: ${Object.keys(options.hooks).join(',')})`);
      return () => {};
    },
    subscribe(name, listener) {
      console.log(`[3] slots.subscribe(${name})`);
      listener();
      return () => {};
    },
    entries(name) {
      return name === 'main' ? rootPanels : [];
    },
  },
  reflect: {
    provide(name, service) {
      provided.push(name);
      providedServices.set(name, service);
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

if (registered.length !== 4) {
  throw new Error(`FAIL: 期望注册 4 个 slot（root + conversation.input.left ×2 + conversation.composer），实际 ${registered.length}: ${registered.join(',')}`);
}
if (!registered.includes('root') || registered.filter((n) => n === 'conversation.input.left').length !== 2) {
  throw new Error(`FAIL: 槽位应为 root / conversation.input.left ×2 / conversation.composer，实际 ${registered.join(',')}`);
}
console.log('[3] 槽位注册：root + conversation.input.left ×2 + conversation.composer（命令白名单）✅');
console.log(`[4] apply() 注册 ${registered.length} 个槽位（${registered.join(' + ')}）✅`);

if (!provided.includes('layout')) {
  throw new Error(`FAIL: 应提供 ctx.layout 服务（官方条目依赖），实际 ${provided.join(',')}`);
}
console.log('[5] ctx.layout 服务已提供（DevLayoutController）✅');

// ── 0.1.5-rc.2 布局接管契约断言：root 子槽 = sidebar/main/rightbar/shell.overlay，
//    main 为 keyed；panelInfo 钩子提供；ctx.layout 暴露官方 0.1.5-rc.2 动作面。
//    （2026-09-16 修复：旧 sidebar/conversation/details 子槽在 0.1.5-rc.2 下使官方
//    ui-conversation/ui-sidebar-right/… 全部 pending，渲染进程启动失败）──
const rootOptions = registrationOptions.get('root');
if (rootOptions === undefined) throw new Error('FAIL: root 槽未注册');
const childNames = Object.keys(rootOptions.children ?? {}).sort();
const expectedChildren = ['main', 'rightbar', 'shell.overlay', 'sidebar'];
if (childNames.join(',') !== expectedChildren.join(',')) {
  throw new Error(
    `FAIL: root 子槽应为 ${expectedChildren.join('/')}（官方 0.1.5-rc.2 AppFrame 契约），实际 ${childNames.join('/')}`,
  );
}
if (rootOptions.children.main.kind !== 'keyed' || rootOptions.children.main.scope !== 'root') {
  throw new Error(`FAIL: main 子槽应为 keyed/root，实际 ${JSON.stringify(rootOptions.children.main)}`);
}
if (rootOptions.children.rightbar.kind !== 'single') {
  throw new Error(`FAIL: rightbar 子槽应为 single，实际 ${JSON.stringify(rootOptions.children.rightbar)}`);
}
if (typeof rootOptions.store?.create !== 'function') {
  throw new Error('FAIL: root 注册应带 store 席位（handle + 固定实例）');
}
if (!providedRootHooks.includes('panelInfo')) {
  throw new Error(`FAIL: 应经 slots.provideRoot 提供 panelInfo 钩子，实际 ${providedRootHooks.join(',')}`);
}
const layoutServiceInterface = ['selectPanel', 'beginNavigation', 'dispose', 'toggleSidebar', 'openRightbar', 'closeRightbar'];
const layoutService = providedServices.get('layout');
for (const method of layoutServiceInterface) {
  if (typeof layoutService?.[method] !== 'function') {
    throw new Error(`FAIL: ctx.layout 缺 ${method}()（官方 0.1.5-rc.2 LayoutController 契约）`);
  }
}
console.log(`[5.3] ctx.layout 接口齐备（${layoutServiceInterface.join('/')}）✅`);
console.log(`[5.1] root 子槽 = ${childNames.join('/')}（main keyed/root）✅`);
console.log('[5.2] panelInfo 钩子已提供（usePanelInfo 消费面）✅');

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

// ── C7 聊天区增强断言：inject 增 sessions、浮层样式与回显组件进 bundle、无 sessions 降级不炸 ──
if (!mod.inject.includes('sessions')) {
  throw new Error(`FAIL: exports.inject 应包含 'sessions'（C7 提问数据源），实际 ${JSON.stringify(mod.inject)}`);
}
if (!code.includes('dskDevAskFloat')) {
  throw new Error('FAIL: client bundle 缺少 R9 当前提问浮层样式（AskFloat 未打包）');
}
if (!code.includes('dsh-develop-ui.history-recall')) {
  throw new Error('FAIL: client bundle 缺少 R10 历史回显注册（HistoryRecall 未打包）');
}
// apply(ctxStub) 未提供 sessions 服务：askFeed 应静默降级（上面 apply 未抛错即通过）
console.log('[10] C7：inject 含 sessions + AskFloat/HistoryRecall 已打包，无 sessions 服务时降级不炸 ✅');

// ── C8 三区最小化断言：底部栏 4 按钮（📁文件列表/📝文件内容/💬聊天区/>_终端）+ 聊天区弹性让渡进 bundle ──
// esbuild 将非 ASCII 字符串转义为 \uXXXX（大写 hex），断言前做同形转换
const esc = (s) => [...s].map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : c)).join('');
for (const label of ['文件列表', '文件内容', '聊天区', '终端']) {
  if (!code.includes(esc(label))) {
    throw new Error(`FAIL: client bundle 缺少底部栏按钮「${label}」（C8 三区最小化还原文关）`);
  }
}
if (!code.includes('toggleChat')) {
  throw new Error('FAIL: client bundle 缺少 toggleChat action（DevLayoutStore 聊天区最小化未打包）');
}
console.log('[11] C8：底部栏 4 按钮（文件列表/文件内容/聊天区/终端）+ toggleChat 已打包 ✅');

// ── C10 提问浮层复制断言：复制按钮样式类 + 「已复制」反馈文案进 bundle ──
if (!code.includes('dskDevAskCopy')) {
  throw new Error('FAIL: client bundle 缺少提问浮层复制按钮样式（C10 AskFloat 复制未打包）');
}
if (!code.includes(esc('已复制'))) {
  throw new Error('FAIL: client bundle 缺少复制成功反馈文案「已复制」（C10 AskFloat 复制未打包）');
}
console.log('[12] C10：提问浮层复制按钮 + 已复制反馈已打包 ✅');

// ── C12 文件系统打开断言：host system/open 路由 + client 树行右键菜单进 bundle ──
if (!hostCode.includes('/system/open')) {
  throw new Error('FAIL: host bundle 缺少 system/open 路由（C12 系统打开未注册）');
}
if (!hostCode.includes('resolveSystemOpenCommand')) {
  throw new Error('FAIL: host bundle 缺少 resolveSystemOpenCommand（C12 动作映射未打包）');
}
console.log('[13] C12：host system/open 路由 + 动作映射已注册 ✅');
for (const label of ['在资源管理器打开', '系统默认应用打开', '打开方式']) {
  if (!code.includes(esc(label))) {
    throw new Error(`FAIL: client bundle 缺少树行右键菜单文案「${label}」（C12 未打包）`);
  }
}
if (!code.includes('/system/open')) {
  throw new Error('FAIL: client bundle 缺少 systemOpen fetch 路径 /system/open（C12 未打包）');
}
console.log('[14] C12：树行右键菜单（资源管理器/默认应用/打开方式）已打包 ✅');

// ── 客户端外部模块面断言（2026-09-16 启动失败根因防线）──
// 模块表只回答平台 seed 名与 __DSH_BOOT__ 图内包名；出现表外的 require 时整个 client 半
// 物化失败（apply 不执行）→ ctx.layout 缺失 → 官方布局消费方全部 pending →
// 桌面渲染进程启动失败。新增外部依赖时必须同步此白名单（见 specs/开发规范.md §4.4）。
const seedModules = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);
const graphModules = new Set(
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dsh.client.inject ?? [],
);
const requires = new Set([...code.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]));
const offenders = [...requires].filter(
  (id) => !seedModules.has(id) && !graphModules.has(id.replace(/\/client$/, '')),
);
if (offenders.length > 0) {
  throw new Error(`FAIL: client bundle require 了宿主模块表未提供的模块：${offenders.join(', ')}`);
}
console.log(
  `[15] client 外部模块面 = ${[...requires].sort().join(' + ')}（全部命中平台 seed / 图内包）✅`,
);

console.log('SMOKE PASS');
