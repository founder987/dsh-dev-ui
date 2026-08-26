/**
 * client 半：文件内容共享状态（模块级 store + subscribe，与 store.ts 同模式；
 * client 半不能 import 状态库，用 useSyncExternalStore 桥接）。
 * 方案 C 布局：树列与内容列分处对话两侧，文件状态从面板组件提升至此共享。
 * 多标签模型（变更 C1）：tabs 有序路径列表 + activePath + 每标签状态 byPath；
 * 支持逐个关闭、全部关闭、关闭左侧/右侧所有。
 * 数据经 fetch 调 host 路由 /api/dsh-develop-ui/*（参照 market 模式）。
 */

type Listener = () => void;

const API = '/api/dsh-develop-ui';

/** 图片扩展名（预览用） */
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;

export type FileViewMode = 'source' | 'preview' | 'highlight' | 'image';

/** 单个标签（文件）的状态 */
export interface TabState {
  content: string;
  /** 保存版本守卫（write-text expectedVersion） */
  version: string;
  dirty: boolean;
  isMd: boolean;
  isCode: boolean;
  mdHtml: string;
  codeHtml: string;
  viewMode: FileViewMode;
  saving: boolean;
  /** 保存失败（版本冲突/权限）→ 提供"重新加载"恢复 */
  saveFailed: boolean;
  /** 图片预览 dataUrl（host read-image） */
  imageSrc: string;
  /** 片段级引用：编辑器选中文本 */
  selectedSnippet: string;
}

export interface FileState {
  /** 打开的文件路径（标签顺序） */
  tabs: string[];
  /** 活动标签路径（'' = 无标签） */
  activePath: string;
  /** 每标签状态（按路径） */
  byPath: Record<string, TabState>;
  /** 内容列可见（最小化 = false；列 0 宽保挂载，状态保留） */
  editorOpen: boolean;
  /** 树/内容共享错误条（加载失败、保存失败等） */
  error: string;
  /** 保存授权提示（未信任目录首次被沙箱拒绝；path = 待保存文件） */
  sandboxPrompt: { path: string; dir: string } | null;
  /** 已信任目录的授权重试中（等待会话权限放开） */
  sandboxRetry: { dir: string } | null;
  /** 关闭确认（涉及 dirty 标签时拦截）：paths = 待关闭，dirtyPaths = 其中未保存的 */
  pendingClose: { paths: string[]; dirtyPaths: string[] } | null;
}

function emptyTab(): TabState {
  return {
    content: '',
    version: '',
    dirty: false,
    isMd: false,
    isCode: false,
    mdHtml: '',
    codeHtml: '',
    viewMode: 'source',
    saving: false,
    saveFailed: false,
    imageSrc: '',
    selectedSnippet: '',
  };
}

const initialState: FileState = {
  tabs: [],
  activePath: '',
  byPath: {},
  editorOpen: false,
  error: '',
  sandboxPrompt: null,
  sandboxRetry: null,
  pendingClose: null,
};

let state: FileState = initialState;
const listeners = new Set<Listener>();

/** 受信任文件夹（localStorage 持久化；信任本身不绕过沙箱，仍需会话权限放开） */
const TRUSTED_KEY = 'dsh-develop-ui.trustedDirs';
const RETRY_DELAY_MS = 1500;
const RETRY_MAX_ROUNDS = 40; // 40 * 1.5s ≈ 60s
let trustedDirs: string[] = [];
try {
  const raw = window.localStorage.getItem(TRUSTED_KEY);
  if (raw !== null) trustedDirs = JSON.parse(raw) as string[];
} catch {
  trustedDirs = [];
}
function persistTrusted(): void {
  try {
    window.localStorage.setItem(TRUSTED_KEY, JSON.stringify(trustedDirs));
  } catch {
    // localStorage 不可用时忽略（信任仅本页有效）
  }
}

/** 父目录（'' = 无父目录） */
function parentOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i <= 0 ? '' : path.slice(0, i);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeFile(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** uSES getSnapshot：仅 patch 时换新引用，订阅安全 */
export function getFileState(): FileState {
  return state;
}

function patch(partial: Partial<FileState>): void {
  state = { ...state, ...partial };
  notify();
}

/** patch 单个标签状态（标签不存在则忽略） */
function patchTab(path: string, partial: Partial<TabState>): void {
  const tab = state.byPath[path];
  if (tab === undefined) return;
  state = { ...state, byPath: { ...state.byPath, [path]: { ...tab, ...partial } } };
  notify();
}

export function errText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function setError(error: string): void {
  if (state.error === error) return;
  patch({ error });
}

/** 编辑器输入：更新活动标签内容并标脏（清空片段选区） */
export function setContent(content: string): void {
  const path = state.activePath;
  if (path === '') return;
  patchTab(path, { content, dirty: true, selectedSnippet: '' });
}

export function setViewMode(viewMode: FileViewMode): void {
  const path = state.activePath;
  if (path === '' || state.byPath[path] === undefined) return;
  if ((state.byPath[path] as TabState).viewMode === viewMode) return;
  patchTab(path, { viewMode });
}

export function setSelectedSnippet(selectedSnippet: string): void {
  const path = state.activePath;
  if (path === '' || state.byPath[path] === undefined) return;
  if ((state.byPath[path] as TabState).selectedSnippet === selectedSnippet) return;
  patchTab(path, { selectedSnippet });
}

/** 更新活动标签代码高亮 HTML（实时高亮防抖后写入） */
export function setCodeHtml(codeHtml: string): void {
  const path = state.activePath;
  if (path === '' || state.byPath[path] === undefined) return;
  if ((state.byPath[path] as TabState).codeHtml === codeHtml) return;
  patchTab(path, { codeHtml });
}

/** 内容列最小化/展开（列 0 宽保挂载，文件状态保留，点击文件可恢复） */
export function setEditorOpen(editorOpen: boolean): void {
  if (state.editorOpen === editorOpen) return;
  patch({ editorOpen });
}

/** 切换活动标签（保留各自状态）；授权流程随之取消（重试只作用于原活动标签） */
export function activateTab(path: string): void {
  if (state.byPath[path] === undefined || state.activePath === path) return;
  cancelSandboxApproval();
  patch({ activePath: path });
}

/** 直接移除一批标签（无 dirty 检查；内部用）。关闭活动标签时激活最右被关者的右邻居（无则左侧） */
function closePaths(paths: string[]): void {
  const set = new Set(paths);
  const nextTabs = state.tabs.filter((p) => !set.has(p));
  if (nextTabs.length === state.tabs.length) return;
  cancelSandboxApproval();
  if (nextTabs.length === 0) {
    patch({ tabs: [], activePath: '', byPath: {}, editorOpen: false, pendingClose: null });
    return;
  }
  let nextActive = state.activePath;
  if (set.has(state.activePath)) {
    const removedIdx = state.tabs.map((p, i) => (set.has(p) ? i : -1)).filter((i) => i >= 0);
    const rightmost = Math.max(...removedIdx);
    nextActive =
      state.tabs.slice(rightmost + 1).find((p) => !set.has(p)) ??
      (nextTabs[Math.min(removedIdx[0] ?? 0, nextTabs.length - 1)] as string);
  }
  const byPath: Record<string, TabState> = { ...state.byPath };
  for (const p of paths) delete byPath[p];
  patch({ tabs: nextTabs, activePath: nextActive, byPath, pendingClose: null });
}

/** 请求关闭一批标签：含未保存（dirty）标签时拦截并弹确认（pendingClose），否则直接关闭 */
export function requestCloseTabs(paths: string[]): void {
  const existing = paths.filter((p) => state.tabs.includes(p));
  if (existing.length === 0) return;
  const dirtyPaths = existing.filter((p) => state.byPath[p]?.dirty === true);
  if (dirtyPaths.length === 0) {
    closePaths(existing);
    return;
  }
  patch({ pendingClose: { paths: existing, dirtyPaths } });
}

/** 取消关闭确认 */
export function cancelPendingClose(): void {
  if (state.pendingClose === null) return;
  patch({ pendingClose: null });
}

/** 确认关闭：save = 先逐个保存 dirty 标签（保存失败的标签保留）；discard = 丢弃修改直接关闭 */
export async function confirmPendingClose(mode: 'save' | 'discard'): Promise<void> {
  const pc = state.pendingClose;
  if (pc === null) return;
  if (mode === 'save') {
    for (const p of pc.dirtyPaths) {
      if (state.byPath[p] === undefined) continue;
      activateTab(p);
      await saveFile();
    }
  }
  const closable = pc.paths.filter((p) => {
    const tab = state.byPath[p];
    if (tab === undefined) return false;
    return mode === 'discard' || tab.dirty !== true;
  });
  patch({ pendingClose: null });
  closePaths(closable);
  if (mode === 'save' && closable.length < pc.paths.length) {
    setError('部分文件保存失败，对应标签已保留未关闭');
  }
}

/** 关闭单个标签（dirty 拦截确认）；关闭活动标签时激活右侧邻居（无则左侧）；最后一个关闭 → 内容列隐藏 */
export function closeTab(path: string): void {
  requestCloseTabs([path]);
}

/** 全部关闭（内容列隐藏；含 dirty 时拦截确认） */
export function closeAllTabs(): void {
  requestCloseTabs(state.tabs);
}

/** 关闭 path 左侧所有标签（保留 path 及其右侧；含 dirty 时拦截确认） */
export function closeTabsLeft(path: string): void {
  const index = state.tabs.indexOf(path);
  if (index <= 0) return;
  requestCloseTabs(state.tabs.slice(0, index));
}

/** 关闭 path 右侧所有标签（保留 path 及其左侧；含 dirty 时拦截确认） */
export function closeTabsRight(path: string): void {
  const index = state.tabs.indexOf(path);
  if (index === -1 || index === state.tabs.length - 1) return;
  requestCloseTabs(state.tabs.slice(index + 1));
}

/** 渲染活动标签的 md 预览（按路径参数化） */
export async function refreshMarkdown(path: string, source: string): Promise<void> {
  try {
    const res = await fetch(`${API}/md/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    patchTab(path, { mdHtml: data.html ?? '' });
  } catch (cause) {
    patchTab(path, { mdHtml: `<p style="color:#e66">渲染失败：${errText(cause)}</p>` });
  }
}

/** 渲染代码标签的 shiki 高亮（按路径参数化） */
async function highlightTab(path: string, source: string): Promise<void> {
  try {
    const res = await fetch(`${API}/highlight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, filename: path }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
    patchTab(path, { codeHtml: d.html ?? '' });
  } catch (cause) {
    patchTab(path, { codeHtml: `<pre style="color:#e66">高亮失败：${errText(cause)}</pre>` });
  }
}

/** 打开文件：已有标签 → 激活恢复（保留未保存编辑）；否则读取并追加标签 */
export async function openFile(path: string): Promise<void> {
  if (state.byPath[path] !== undefined) {
    cancelSandboxApproval();
    patch({ activePath: path, editorOpen: true });
    return;
  }
  if (IMAGE_EXT_PATTERN.test(path)) {
    try {
      const res = await fetch(`${API}/fs/read-image?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const tab: TabState = { ...emptyTab(), viewMode: 'image', imageSrc: data.dataUrl as string };
      patch({ tabs: [...state.tabs, path], activePath: path, editorOpen: true, byPath: { ...state.byPath, [path]: tab } });
    } catch (cause) {
      setError(errText(cause));
    }
    return;
  }
  try {
    const res = await fetch(`${API}/fs/read-text?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    const markdown = /\.md$/i.test(path);
    // 代码文件（非 md/非二进制）走 shiki 高亮；文本类扩展名才尝试
    const codeLike =
      !markdown && /\.(ts|tsx|js|jsx|mjs|cjs|json|css|html|yml|yaml|sh|py|rs|go|java)$/i.test(path);
    const tab: TabState = {
      ...emptyTab(),
      content: data.content,
      version: data.version,
      isMd: markdown,
      isCode: codeLike,
    };
    patch({ tabs: [...state.tabs, path], activePath: path, editorOpen: true, byPath: { ...state.byPath, [path]: tab } });
    if (markdown) {
      void refreshMarkdown(path, data.content);
    } else if (codeLike) {
      void highlightTab(path, data.content);
    }
  } catch (cause) {
    setError(errText(cause));
  }
}

/**
 * 保存活动标签（版本守卫）；成功后刷新 md 预览 / 代码高亮。
 * @returns 结果信号：'saved' / 'sandbox-denied' / 'failed'（授权重试循环用）
 */
export async function saveFile(): Promise<'saved' | 'sandbox-denied' | 'failed'> {
  const path = state.activePath;
  const tab = state.byPath[path];
  if (path === '' || tab === undefined || tab.saving) return 'failed';
  patchTab(path, { saving: true });
  try {
    // 文件夹白名单：用户已信任的目录随请求携带 sandboxRoot，host 将其作为本次
    // 调用的 workspace-write 根（dsh-fs-sandbox 单次策略），目标在其下即放行——
    // 无需会话切「完全访问」。旧运行时忽略该参则回退 /permission 重试流。
    const dir = parentOf(path);
    const sandboxRoot = trustedDirs.includes(dir) ? dir : undefined;
    const res = await fetch(`${API}/fs/write-text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content: tab.content, expectedVersion: tab.version, ...(sandboxRoot !== undefined ? { sandboxRoot } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) {
      const cause = new Error(data.error ?? `HTTP ${res.status}`) as Error & { code?: string };
      cause.code = typeof data.code === 'string' ? data.code : undefined;
      throw cause;
    }
    patchTab(path, { version: data.version, dirty: false, saveFailed: false });
    setError('');
    if (tab.isMd) {
      void refreshMarkdown(path, tab.content);
    } else if (tab.isCode) {
      void highlightTab(path, tab.content);
    }
    return 'saved';
  } catch (cause) {
    patchTab(path, { saveFailed: true });
    const code = (cause as { code?: unknown })?.code;
    if (code === 'FS_SANDBOX_DENIED') {
      const dir = parentOf(path);
      if (trustedDirs.includes(dir)) {
        // 已信任但会话权限未放开：进入授权重试状态
        startRetry(dir);
        setError(
          '保存被沙箱拒绝：已信任该文件夹，但当前会话权限尚未放开（workspace-write）。请在会话输入框执行 /permission 切换为「完全访问」，插件将自动重试保存。',
        );
      } else {
        patch({ sandboxPrompt: { path, dir } });
        setError('保存被沙箱拒绝：该文件夹不在当前会话可写工作区内。可「信任此文件夹并授权保存」。');
      }
      return 'sandbox-denied';
    }
    setError(`保存失败：${errText(cause)}`);
    return 'failed';
  } finally {
    patchTab(path, { saving: false });
  }
}

/* ── 沙箱授权（信任文件夹 → 会话权限放开 → 自动重试保存） ── */
let retryActive = false;

function stopRetry(): void {
  if (!retryActive) return;
  retryActive = false;
  patch({ sandboxRetry: null });
}

function startRetry(dir: string): void {
  if (retryActive) return;
  retryActive = true;
  patch({ sandboxPrompt: null, sandboxRetry: { dir } });
  void (async () => {
    for (let round = 0; round < RETRY_MAX_ROUNDS; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      if (!retryActive) return;
      const outcome = await saveFile();
      if (outcome !== 'sandbox-denied') {
        // 保存成功或出现其它错误（版本冲突等）→ 停止重试，错误提示由 saveFile 呈现
        stopRetry();
        return;
      }
    }
    retryActive = false;
    patch({ sandboxRetry: null });
    setError('会话权限尚未放开，已停止自动重试：请切换权限后手动保存。');
  })();
}

/** 信任文件夹并进入授权保存流程（信任持久化；放行仍需会话权限切换为完全访问） */
export function trustDir(dir: string): void {
  if (!trustedDirs.includes(dir)) {
    trustedDirs.push(dir);
    persistTrusted();
  }
  startRetry(dir);
}

/** 取消授权流程（关闭提示 / 停止自动重试） */
export function cancelSandboxApproval(): void {
  stopRetry();
  patch({ sandboxPrompt: null });
}

/** 强制从磁盘重读（标签保留）：用于保存冲突/失败后的"重新加载"恢复 */
export async function reloadFile(path: string): Promise<void> {
  if (state.byPath[path] === undefined) {
    void openFile(path);
    return;
  }
  try {
    const res = await fetch(`${API}/fs/read-text?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    const markdown = /\.md$/i.test(path);
    const codeLike =
      !markdown && /\.(ts|tsx|js|jsx|mjs|cjs|json|css|html|yml|yaml|sh|py|rs|go|java)$/i.test(path);
    const prev = state.byPath[path] as TabState;
    const tab: TabState = {
      ...emptyTab(),
      content: data.content,
      version: data.version,
      isMd: markdown,
      isCode: codeLike,
      viewMode: prev.viewMode === 'image' ? 'source' : prev.viewMode,
    };
    patch({ byPath: { ...state.byPath, [path]: tab }, activePath: path, editorOpen: true });
    setError('');
    if (markdown) {
      void refreshMarkdown(path, data.content);
    } else if (codeLike) {
      void highlightTab(path, data.content);
    }
  } catch (cause) {
    setError(errText(cause));
  }
}
