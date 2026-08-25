/**
 * 文件树面板 · 状态流转测试用例（S1–S10，见 交互设计.md 第 6 节）
 * 变更 C5：终端入口状态机与 T1–T8 用例（见 交互设计.md 3.1 节）
 * 运行：npx tsx tests/... 或按状态机逐条人工验证（原型 prototype/index.html 可操作演示）
 */

export type PanelState =
  | 'collapsed' // 面板收起
  | 'expanded-empty' // 展开未加载
  | 'loading-dir' // 目录加载中
  | 'dir-loaded' // 目录加载成功
  | 'load-error' // 加载失败
  | 'loading-file' // 文件加载中
  | 'content-ready' // 内容就绪
  | 'editing' // 编辑中（dirty）
  | 'saving' // 保存中
  | 'save-error'; // 保存失败

export interface Transition {
  from: PanelState[];
  event: string;
  to: PanelState;
  guard?: string;
}

/** 状态机转移表 */
export const TRANSITIONS: Transition[] = [
  { from: ['collapsed'], event: 'toggle', to: 'expanded-empty' },
  { from: ['expanded-empty', 'dir-loaded', 'content-ready', 'editing', 'load-error', 'save-error'], event: 'toggle', to: 'collapsed' },
  { from: ['expanded-empty', 'dir-loaded', 'load-error'], event: 'load-path', to: 'loading-dir', guard: 'path 非空' },
  { from: ['loading-dir'], event: 'resolve-ok', to: 'dir-loaded', guard: 'listDir 成功' },
  { from: ['loading-dir'], event: 'resolve-fail', to: 'load-error', guard: '路径无效/权限拒绝' },
  { from: ['dir-loaded', 'load-error'], event: 'open-file', to: 'loading-file' },
  { from: ['loading-file'], event: 'read-ok', to: 'content-ready', guard: 'readText 成功且 ≤1MB' },
  { from: ['loading-file'], event: 'read-fail', to: 'load-error', guard: '文件过大/不存在/IO 错误' },
  { from: ['content-ready'], event: 'edit', to: 'editing', guard: '内容变化' },
  { from: ['editing'], event: 'save', to: 'saving', guard: 'Ctrl+S 且 dirty' },
  { from: ['editing', 'save-error'], event: 'edit', to: 'editing' },
  { from: ['saving'], event: 'save-ok', to: 'content-ready', guard: '版本匹配，写盘成功' },
  { from: ['saving'], event: 'save-fail', to: 'save-error', guard: '版本冲突/权限拒绝' },
  { from: ['content-ready', 'editing', 'save-error'], event: 'switch-file', to: 'loading-file' },
];

/** 断言一次转移合法 */
export function canTransition(state: PanelState, event: string): boolean {
  return TRANSITIONS.some((t) => t.from.includes(state) && t.event === event);
}

/* ---------- 终端面板（变更 C5 v2：内嵌底部面板 + 多 tab）---------- */

export type TerminalState =
  | 'panel-hidden' // 面板隐藏（0 高保挂载，会话保留）
  | 'panel-open' // 面板展开（≥1 个终端 tab）
  | 'creating'; // + 新建中（shell 弹层 → host 创建会话）

export const TERMINAL_TRANSITIONS: Array<{ from: TerminalState[]; event: string; to: TerminalState; guard?: string }> = [
  { from: ['panel-hidden'], event: 'toggle-panel', to: 'panel-open', guard: '底部栏终端按钮；无会话则创建首个 tab（上次 shell 或 PowerShell，cwd=工作区）' },
  { from: ['panel-open'], event: 'toggle-panel', to: 'panel-hidden', guard: '终端按钮 / 面板✕；0 高保挂载，会话与 tab 保留' },
  { from: ['panel-open'], event: 'new-terminal', to: 'creating', guard: '+ 按钮开 shell 弹层并选择' },
  { from: ['creating'], event: 'create-ok', to: 'panel-open', guard: '新增 tab 并激活；记忆 lastShell' },
  { from: ['creating'], event: 'create-fail', to: 'panel-open', guard: '弹层重开 + 顶部红字错误行；lastShell 不变更；已有 tab 不受影响' },
  { from: ['panel-open'], event: 'close-tab', to: 'panel-open', guard: '✕ / 右键菜单；kill 会话；右邻居激活（无则左侧）；剩余 ≥1' },
  { from: ['panel-open'], event: 'close-tab', to: 'panel-hidden', guard: '最后一个 tab 关闭 → 面板自动隐藏' },
];

export function canTerminalTransition(state: TerminalState, event: string): boolean {
  return TERMINAL_TRANSITIONS.some((t) => t.from.includes(state) && t.event === event);
}

export const TERMINAL_CASES: Array<{ id: string; steps: Array<[TerminalState, string, TerminalState]> }> = [
  { id: 'T1-首次打开创建首个tab', steps: [['panel-hidden', 'toggle-panel', 'panel-open']] },
  {
    id: 'T2-新建终端成功',
    steps: [
      ['panel-open', 'new-terminal', 'creating'],
      ['creating', 'create-ok', 'panel-open'],
    ],
  },
  {
    id: 'T9-创建失败弹层错误行',
    steps: [
      ['panel-open', 'new-terminal', 'creating'],
      ['creating', 'create-fail', 'panel-open'],
    ],
  },
  { id: 'T4-关闭tab右邻居激活', steps: [['panel-open', 'close-tab', 'panel-open']] },
  {
    id: 'T6-全部关闭面板隐藏',
    steps: [
      ['panel-open', 'close-tab', 'panel-open'],
      ['panel-open', 'close-tab', 'panel-hidden'],
    ],
  },
  {
    id: 'T7-隐藏再开会话保留',
    steps: [
      ['panel-open', 'toggle-panel', 'panel-hidden'],
      ['panel-hidden', 'toggle-panel', 'panel-open'],
    ],
  },
];

export function runTerminal(): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const c of TERMINAL_CASES) {
    let ok = true;
    for (const [from, event] of c.steps) {
      if (!canTerminalTransition(from, event)) {
        ok = false;
        console.error(`FAIL ${c.id}: ${from} --${event}--> 不允许`);
        break;
      }
    }
    if (ok) { passed += 1; console.log(`PASS ${c.id}`); } else { failed += 1; }
  }
  return { passed, failed };
}

/* ---------- 测试用例 ---------- */

export const CASES: Array<{ id: string; steps: Array<[PanelState, string, PanelState]> }> = [
  {
    id: 'S1-面板开关',
    steps: [
      ['collapsed', 'toggle', 'expanded-empty'],
      ['expanded-empty', 'toggle', 'collapsed'],
      ['collapsed', 'toggle', 'expanded-empty'],
    ],
  },
  {
    id: 'S2-路径加载成功',
    steps: [
      ['expanded-empty', 'load-path', 'loading-dir'],
      ['loading-dir', 'resolve-ok', 'dir-loaded'],
    ],
  },
  {
    id: 'S3-路径无效',
    steps: [
      ['expanded-empty', 'load-path', 'loading-dir'],
      ['loading-dir', 'resolve-fail', 'load-error'],
    ],
  },
  {
    id: 'S5-S7-打开md-编辑-保存成功',
    steps: [
      ['dir-loaded', 'open-file', 'loading-file'],
      ['loading-file', 'read-ok', 'content-ready'],
      ['content-ready', 'edit', 'editing'],
      ['editing', 'save', 'saving'],
      ['saving', 'save-ok', 'content-ready'],
    ],
  },
  {
    id: 'S8-版本冲突',
    steps: [
      ['editing', 'save', 'saving'],
      ['saving', 'save-fail', 'save-error'],
      ['save-error', 'edit', 'editing'],
    ],
  },
  {
    id: 'S9-大文件拦截',
    steps: [
      ['loading-file', 'read-fail', 'load-error'],
    ],
  },
];

export function run(): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const c of CASES) {
    let ok = true;
    for (const [from, event, to] of c.steps) {
      if (!canTransition(from, event)) {
        ok = false;
        console.error(`FAIL ${c.id}: ${from} --${event}--> 不允许`);
        break;
      }
    }
    if (ok) {
      passed += 1;
      console.log(`PASS ${c.id}`);
    } else {
      failed += 1;
    }
  }
  const term = runTerminal();
  passed += term.passed;
  failed += term.failed;
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  return { passed, failed };
}
