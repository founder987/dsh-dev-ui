/**
 * client 半：终端面板状态（C5 v2 + C9 工作区隔离）——镜像 fileStore 多标签模型。
 * C9：tabs/activeId/creating/createError 按工作区（cwd）分组
 * （workspaces: Record<cwd, TermWorkspaceState>）；panelOpen/height/lastShell/shells
 * 保持全局（面板开合与高度记忆为布局偏好，对齐 treeOpen/editorOpen 语义；shell
 * 探测结果为机器级能力）。切换工作区只换投影：不 kill 远端会话、不停 read 循环
 * （PTY 保留，0 高/隐藏挂载语义扩展）；目标工作区无会话 → 空态，不自动创建
 * （自动创建仅限 setPanelOpen(true, cwd) 按钮路径）。
 * ✕ 关闭右邻居激活；右键/⋯菜单四动作以锚点 tab 为准；最后 tab 关闭 → 面板自动
 * 隐藏 + 空工作区条目回收；终端无 dirty 概念，不做关闭确认。
 * xterm 实例由 TermPanel 持有；本 store 经 onTermData 订阅把 host 长轮询输出推给画布
 * （通道决策见 docs/开发记录/C5-0-终端探针.md）。
 */
import type { TermCreateResult, TermReadResult, TermShellInfo } from '../../shared/rpc';

type Listener = () => void;

const API = '/api/dsh-develop-ui/terminal';

/** 面板高度记忆（默认 260px，拖拽范围 120–480） */
const TERM_HEIGHT_KEY = 'dsh-develop-ui.termHeight';
/** 上次选择的 shell（下次新建默认项） */
const LAST_SHELL_KEY = 'dsh-develop-ui.terminalShell';
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 480;
/** 长轮询失败后的退避重试间隔 */
const READ_RETRY_MS = 1000;

/** 终端标签（id = host 会话 id；exited 进程退出后保留展示「已退出」） */
export interface TermTab {
  id: string;
  title: string;
  shellId: string;
  exited: boolean;
}

/** 单工作区终端状态（tabs 顺序即 tab 条顺序；同 cwd 不同会话共享终端） */
export interface TermWorkspaceState {
  tabs: TermTab[];
  activeId: string | null;
  creating: boolean;
  /** 创建失败错误（shell 弹层重开后顶部红字展示） */
  createError: string | null;
}

interface TermState {
  /** 按工作区（cwd）分组的终端状态；tabs 空且无进行态/错误时条目回收 */
  workspaces: Record<string, TermWorkspaceState>;
  panelOpen: boolean;
  height: number;
  /** 可用 shell 探测结果（机器级能力，全局；空数组 = 尚未加载） */
  shells: TermShellInfo[];
  /** 上次选择的 shell（全局，下次新建默认项） */
  lastShell: string;
}

/** 无条目工作区的共享空态（引用稳定，避免 uSES 投影抖动） */
const EMPTY_WORKSPACE: TermWorkspaceState = {
  tabs: [],
  activeId: null,
  creating: false,
  createError: null,
};

function readHeight(): number {
  try {
    const raw = window.localStorage.getItem(TERM_HEIGHT_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(value)) return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, value));
  } catch {
    // localStorage 不可用时用默认值
  }
  return DEFAULT_HEIGHT;
}

function readLastShell(): string {
  try {
    return window.localStorage.getItem(LAST_SHELL_KEY) ?? 'cmd';
  } catch {
    return 'cmd';
  }
}

const initialState: TermState = {
  workspaces: {},
  panelOpen: false,
  height: readHeight(),
  shells: [],
  lastShell: readLastShell(),
};

let state = initialState;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** 订阅终端面板状态（useSyncExternalStore 契约） */
export function subscribeTerm(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 当前状态快照（不可变引用，patch 时整体更换；组件按 cwd 投影 workspaces） */
export function getTermState(): TermState {
  return state;
}

function patch(next: Partial<TermState>): void {
  state = { ...state, ...next };
  notify();
}

/** 取某工作区视图（无条目返回共享空态常量，引用稳定） */
export function getTermWorkspace(cwd: string | undefined): TermWorkspaceState {
  if (cwd === undefined || cwd.length === 0) return EMPTY_WORKSPACE;
  return state.workspaces[cwd] ?? EMPTY_WORKSPACE;
}

/** 更新单工作区状态；tabs 空且无进行态/错误时回收条目（保持 workspaces 精简） */
function patchWorkspace(cwd: string, next: Partial<TermWorkspaceState>): void {
  const merged = { ...getTermWorkspace(cwd), ...next };
  const workspaces = { ...state.workspaces };
  if (merged.tabs.length === 0 && !merged.creating && merged.createError === null) {
    delete workspaces[cwd];
  } else {
    workspaces[cwd] = merged;
  }
  patch({ workspaces });
}

/* ── 输出数据订阅（TermPanel 的 xterm 实例经此接收 host 输出；按会话 id 全局） ── */

const dataListeners = new Map<string, Set<(data: string) => void>>();

/** 订阅会话输出；返回取消函数 */
export function onTermData(id: string, listener: (data: string) => void): () => void {
  let set = dataListeners.get(id);
  if (set === undefined) {
    set = new Set();
    dataListeners.set(id, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) dataListeners.delete(id);
  };
}

function emitData(id: string, data: string): void {
  for (const listener of dataListeners.get(id) ?? []) listener(data);
}

/* ── 长轮询读取循环（按会话 id 全局；切工作区不停循环） ── */

const readLoops = new Map<string, { aborted: boolean }>();

function stopReadLoop(id: string): void {
  const loop = readLoops.get(id);
  if (loop !== undefined) loop.aborted = true;
}

/** 标记会话已退出（tab 保留展示「已退出」；按 id 定位所属工作区） */
function markExited(id: string): void {
  for (const [cwd, workspace] of Object.entries(state.workspaces)) {
    const tab = workspace.tabs.find((item) => item.id === id);
    if (tab === undefined) continue;
    if (tab.exited) return;
    patchWorkspace(cwd, {
      tabs: workspace.tabs.map((item) => (item.id === id ? { ...item, exited: true } : item)),
    });
    return;
  }
}

/**
 * 长轮询循环：read?id&after=cursor → 推给订阅者 → cursor 推进；
 * exited 或会话消失（kill 后 NOT_FOUND）时退出；网络错误退避重试。
 */
function startReadLoop(id: string): void {
  const control = { aborted: false };
  readLoops.set(id, control);
  let cursor = 0;
  void (async () => {
    while (!control.aborted) {
      try {
        const res = await fetch(`${API}/read?id=${encodeURIComponent(id)}&after=${cursor}`);
        const data = (await res.json()) as TermReadResult & { code?: string };
        if (!res.ok) {
          // 会话已销毁（kill/服务端重启）→ 标记退出并结束循环
          markExited(id);
          break;
        }
        if (data.dropped === true) {
          emitData(id, '\r\n\x1b[33m[输出过快，部分历史已丢弃]\x1b[0m\r\n');
        }
        if (data.data.length > 0) emitData(id, data.data);
        cursor = data.cursor;
        if (data.exited) {
          markExited(id);
          break;
        }
      } catch {
        if (control.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
      }
    }
    readLoops.delete(id);
  })();
}

/* ── HTTP 助手 ── */

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function errText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/* ── shell 探测与新建 ── */

/** 拉取可用 shell 列表（幂等；面板打开时调用；机器级能力，全局共享） */
export async function ensureShells(): Promise<void> {
  if (state.shells.length > 0) return;
  try {
    const res = await fetch(`${API}/shells`);
    const data = (await res.json()) as { shells?: TermShellInfo[] };
    if (res.ok && Array.isArray(data.shells)) {
      patch({ shells: data.shells });
    }
  } catch {
    // 探测失败保持空列表，shell 弹层项全部禁用
  }
}

/** 默认 shell：上次选择可用 → 上次；否则 cmd；否则第一个可用项 */
export function defaultShell(): string | undefined {
  const available = state.shells.filter((shell) => shell.available);
  if (available.some((shell) => shell.id === state.lastShell)) return state.lastShell;
  if (available.some((shell) => shell.id === 'cmd')) return 'cmd';
  return available[0]?.id;
}

/** shell 序号计数（标题 PowerShell 1、cmd 2 的序号源，单调递增不复用） */
const shellCounters = new Map<string, number>();

/** 新建终端会话（归属 cwd 工作区）：成功 → 追加 tab 并激活 + 启动读取循环；失败 → 该工作区 createError（弹层重开展示） */
export async function createTerm(shellId: string, cwd: string): Promise<void> {
  if (getTermWorkspace(cwd).creating) return;
  patchWorkspace(cwd, { creating: true, createError: null });
  try {
    const result = (await postJson('/create', { shell: shellId, cwd })) as TermCreateResult;
    const seq = (shellCounters.get(shellId) ?? 0) + 1;
    shellCounters.set(shellId, seq);
    const tab: TermTab = { id: result.id, title: `${result.title} ${seq}`, shellId, exited: false };
    try {
      window.localStorage.setItem(LAST_SHELL_KEY, shellId);
    } catch {
      // localStorage 不可用时忽略
    }
    patchWorkspace(cwd, {
      tabs: [...getTermWorkspace(cwd).tabs, tab],
      activeId: result.id,
      creating: false,
    });
    patch({ panelOpen: true, lastShell: shellId });
    startReadLoop(result.id);
  } catch (cause) {
    patchWorkspace(cwd, { creating: false, createError: errText(cause) });
  }
}

/* ── 面板显隐（全局） ── */

/**
 * 设置面板显隐（全局共享）；打开时确保 shell 探测完成，且当前工作区无 tab 且
 * cwd 有效时自动创建首个终端（上次 shell 或 cmd；仅按钮路径触发——切换工作区
 * 不经由此函数，故不会自动 spawn shell）。
 */
export function setPanelOpen(open: boolean, cwd?: string): void {
  if (open === state.panelOpen) return;
  patch({ panelOpen: open });
  if (cwd !== undefined && getTermWorkspace(cwd).createError !== null) {
    patchWorkspace(cwd, { createError: null });
  }
  if (!open) return;
  void ensureShells().then(() => {
    if (cwd === undefined || cwd.length === 0) return;
    if (getTermWorkspace(cwd).tabs.length > 0) return;
    const shell = defaultShell();
    if (shell === undefined) {
      patchWorkspace(cwd, { createError: '未检测到可用的终端 shell' });
      return;
    }
    void createTerm(shell, cwd);
  });
}

/** 底部栏终端按钮：切换面板显隐 */
export function togglePanel(cwd?: string): void {
  setPanelOpen(!state.panelOpen, cwd);
}

/* ── 高度拖拽 + 记忆（全局布局偏好） ── */

/** 设置面板高度（钳制 120–480 + localStorage 记忆） */
export function setHeight(px: number): void {
  const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(px)));
  if (height === state.height) return;
  patch({ height });
  try {
    window.localStorage.setItem(TERM_HEIGHT_KEY, String(height));
  } catch {
    // localStorage 不可用时忽略
  }
}

/* ── 输入与尺寸（按会话 id 全局） ── */

/** 键盘输入（xterm onData → host；fire-and-forget） */
export function sendInput(id: string, data: string): void {
  if (data.length === 0) return;
  postJson('/input', { id, data }).catch(() => {
    // 会话已死时静默丢弃（read 循环会标记 exited）
  });
}

/** 尺寸同步（xterm fit 后调用；fire-and-forget） */
export function sendResize(id: string, cols: number, rows: number): void {
  postJson('/resize', { id, cols, rows }).catch(() => {
    // 同上
  });
}

/* ── 关闭（镜像 fileStore closePaths 语义；无 dirty 确认；仅作用于 cwd 工作区） ── */

function killRemote(id: string): void {
  stopReadLoop(id);
  postJson('/kill', { id }).catch(() => {
    // 已销毁会话重复 kill 可忽略
  });
}

/** 关闭一批会话：kill 远端 + 停止读取循环 + 右邻居激活；全部关闭 → 面板自动隐藏 + 工作区条目回收 */
function closeIds(cwd: string, ids: string[]): void {
  const workspace = getTermWorkspace(cwd);
  const set = new Set(ids);
  const nextTabs = workspace.tabs.filter((tab) => !set.has(tab.id));
  if (nextTabs.length === workspace.tabs.length) return;
  for (const id of ids) killRemote(id);
  if (nextTabs.length === 0) {
    patchWorkspace(cwd, { tabs: [], activeId: null });
    patch({ panelOpen: false });
    return;
  }
  let nextActive = workspace.activeId;
  if (nextActive !== null && set.has(nextActive)) {
    const removedIdx = workspace.tabs.map((tab, i) => (set.has(tab.id) ? i : -1)).filter((i) => i >= 0);
    const rightmost = Math.max(...removedIdx);
    nextActive =
      workspace.tabs.slice(rightmost + 1).find((tab) => !set.has(tab.id))?.id ??
      nextTabs[Math.min(removedIdx[0] ?? 0, nextTabs.length - 1)]?.id ??
      null;
  }
  patchWorkspace(cwd, { tabs: nextTabs, activeId: nextActive });
}

/** 关闭单个会话；关闭活动 tab 时激活右侧邻居（无则左侧）；最后一个关闭 → 面板隐藏 */
export function closeTerm(cwd: string, id: string): void {
  closeIds(cwd, [id]);
}

/** 全部关闭（面板自动隐藏；仅当前工作区，其他工作区会话保留） */
export function closeAllTerms(cwd: string): void {
  closeIds(cwd, getTermWorkspace(cwd).tabs.map((tab) => tab.id));
}

/** 关闭锚点左侧所有会话（保留锚点及其右侧） */
export function closeTermsLeft(cwd: string, id: string): void {
  const tabs = getTermWorkspace(cwd).tabs;
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index <= 0) return;
  closeIds(cwd, tabs.slice(0, index).map((tab) => tab.id));
}

/** 关闭锚点右侧所有会话（保留锚点及其左侧） */
export function closeTermsRight(cwd: string, id: string): void {
  const tabs = getTermWorkspace(cwd).tabs;
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1 || index === tabs.length - 1) return;
  closeIds(cwd, tabs.slice(index + 1).map((tab) => tab.id));
}

/** 激活会话 tab（cwd 工作区内） */
export function activateTerm(cwd: string, id: string): void {
  const workspace = getTermWorkspace(cwd);
  if (workspace.activeId === id || !workspace.tabs.some((tab) => tab.id === id)) return;
  patchWorkspace(cwd, { activeId: id });
}
