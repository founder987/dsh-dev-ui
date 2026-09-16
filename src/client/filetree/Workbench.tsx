/**
 * client 半：文件工作台（方案 C —— 树列 + 内容列，由 DevFrame 排入五列框架）。
 * WorkbenchTree：路径输入加载目录树 → 文件夹展开 → 点击文件经 fileStore 共享；
 * WorkbenchEditor：md 源码/预览切换 → monaco 编辑器（C6）+ dirty + Ctrl+S 保存（版本守卫）；
 * @文件 引用模式：composer 按钮触发，选文件后点"引用"注入对话。
 * 文件状态见 fileStore.ts；面板开关/@文件 待选见 store.ts。
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  callInsertRef,
  getReveal,
  isPanelOpen,
  isPendingRef,
  setPanelOpen,
  setPendingRef,
  setReveal,
  subscribePanel,
} from './store';
import {
  activateTab,
  cancelPendingClose,
  cancelSandboxApproval,
  closeAllTabs,
  closeTab,
  closeTabsLeft,
  closeTabsRight,
  confirmPendingClose,
  errText,
  getFileState,
  openFile,
  refreshMarkdown,
  reloadFile,
  saveFile,
  setContent,
  setEditorOpen,
  setError,
  setSelectedSnippet,
  setViewMode,
  subscribeFile,
  trustDir,
} from './fileStore';
import { MonacoEditorArea } from './MonacoEditorArea';
import { systemOpen, type SystemOpenAction } from '../fileopen/systemOpen';

const API = '/api/dsh-develop-ui';

/** 上次工作区路径（localStorage 记忆，MVP 替代自动检测） */
const ROOT_PATH_KEY = 'dsh-develop-ui.rootPath';

interface TreeNode {
  name: string;
  isDir: boolean;
}

function joinPath(dir: string, name: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + name;
  return `${dir}/${name}`;
}

/** 选中态路径规范化：分隔符统一为正斜杠后比较（树路径与聊天打开路径格式可能不同）。 */
function normalizeActivePath(path: string): string {
  return path.replaceAll('\\', '/');
}

/** 父目录（'' = 无父目录，定位跳过） */
function parentOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i <= 0 ? '' : path.slice(0, i);
}

/** dir 是否为 path 的祖先（含相等） */
function isAncestor(dir: string, path: string): boolean {
  if (dir === path) return true;
  const prefix = dir.endsWith('/') || dir.endsWith('\\') ? dir : `${dir}/`;
  return path.startsWith(prefix);
}

/** 路径 → 面包屑段（每段含可点击的前缀路径） */
function breadcrumbParts(path: string): Array<{ label: string; path: string }> {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const crumbs: Array<{ label: string; path: string }> = [];
  let acc = '';
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as string;
    acc = i === 0 ? part : `${acc}/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

const btnStyle: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: 12,
  background: 'var(--dsw-alias-button-floating-fill, #2a2b33)',
  border: '1px solid var(--dsw-alias-border-l1, #3a3b44)',
  color: 'inherit',
  borderRadius: 4,
  cursor: 'pointer',
};

/** 目录树行（文件夹可展开，懒加载子目录） */
function DirRow({
  path,
  name,
  depth,
  activePath,
  expandedDirs,
  onToggle,
  onOpenFile,
}: {
  path: string;
  name: string;
  depth: number;
  activePath: string;
  expandedDirs: ReadonlyMap<string, TreeNode[] | 'loading'>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}): React.JSX.Element {
  const children = expandedDirs.get(path);
  const expanded = children !== undefined;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="dskDevRow"
        data-active={expanded || undefined}
        data-path={path}
        data-dir="true"
        onClick={() => onToggle(path)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onToggle(path);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          paddingLeft: 8 + depth * 14,
          fontSize: 12.5,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <span style={{ width: 14, textAlign: 'center', flexShrink: 0, opacity: 0.7 }}>
          {expanded ? '▾' : '▸'}
        </span>
        <span style={{ flexShrink: 0 }}>📁</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
      </div>
      {expanded &&
        (children === 'loading' ? (
          <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 12, opacity: 0.6 }}>加载中…</div>
        ) : (
          children.map((child) =>
            child.isDir ? (
              <DirRow
                key={child.name}
                path={joinPath(path, child.name)}
                name={child.name}
                depth={depth + 1}
                activePath={activePath}
                expandedDirs={expandedDirs}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
              />
            ) : (
              <div
                key={child.name}
                role="button"
                tabIndex={0}
                className="dskDevRow"
                data-active={joinPath(path, child.name) === activePath || undefined}
                data-name={child.name}
                onClick={() => onOpenFile(joinPath(path, child.name))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onOpenFile(joinPath(path, child.name));
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 8px',
                  paddingLeft: 8 + (depth + 1) * 14,
                  fontSize: 12.5,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                <span style={{ width: 14, flexShrink: 0 }} />
                <span style={{ flexShrink: 0 }}>📄</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{child.name}</span>
              </div>
            ),
          )
        ))}
    </>
  );
}

/** 框架全局标准钩子面（GlobalStandardProps 的子集，由 DevFrame 透传） */
export interface WorkbenchHooks {
  useWorkspaces?: <T>(selector: (state: unknown) => T) => T;
  useSessions?: <T>(selector: (state: unknown) => T) => T;
}

/** 树列本体（填满 DevFrame 树列轨道） */
export function WorkbenchTree(props: WorkbenchHooks): React.JSX.Element {
  const open = useSyncExternalStore(subscribePanel, isPanelOpen);
  const fileState = useSyncExternalStore(subscribeFile, getFileState);
  const reveal = useSyncExternalStore(subscribePanel, getReveal);
  // 最近工作区路径（自动检测回退）：recentWorkspaceId.path
  const workspaces = props.useWorkspaces?.((s: unknown) => s) as
    | { items?: Array<{ workspaceId: string; path?: string }>; recentWorkspaceId?: string }
    | undefined;
  const recentPath = workspaces?.items?.find((w) => w.workspaceId === workspaces.recentWorkspaceId)?.path;
  // 当前活动工作区路径（最准确）：当前 session 的 cwd
  const sessions = props.useSessions?.((s: unknown) => s) as
    | { current?: string; byId?: Record<string, { cwd?: string }> }
    | undefined;
  const workspaceRoot = sessions?.current ? sessions.byId?.[sessions.current]?.cwd : undefined;
  const [rootPath, setRootPath] = useState(() => {
    try {
      return window.localStorage.getItem(ROOT_PATH_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<TreeNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<ReadonlyMap<string, TreeNode[] | 'loading'>>(new Map());

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/fs/list-dir?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const list = (data.entries as TreeNode[]).sort(
        (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
      );
      setEntries(list);
      setCurrentPath(path);
      try {
        window.localStorage.setItem(ROOT_PATH_KEY, path);
      } catch {
        // localStorage 不可用时忽略（面板仍可用）
      }
      setError('');
    } catch (cause) {
      setError(errText(cause));
      setEntries(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // 面板打开（列挂载）时默认展示当前工作区（用户切换工作区后点击 📂/@文件 即加载该工作区）；
  // 无当前 session cwd 时回退最近工作区路径
  useEffect(() => {
    if (!open) return;
    const target = workspaceRoot ?? recentPath;
    if (!target) return;
    setRootPath(target);
    void loadDir(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceRoot, recentPath]);

  // 树中定位：内容列请求 → 打开树列，在树层级中逐级展开父目录，滚动+选中该文件行。
  // 锚点根：当前树根若是文件祖先则原地展开；否则用工作区根；兜底用文件父目录。
  const [flashName, setFlashName] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reveal) return;
    setPanelOpen(true);
    const path = reveal.path;
    const seq = reveal.seq;
    const anchor =
      currentPath !== '' && isAncestor(currentPath, path)
        ? currentPath
        : workspaceRoot && isAncestor(workspaceRoot, path)
          ? workspaceRoot
          : parentOf(path);
    if (anchor === '') return;
    setRootPath(anchor);
    setFlashName(path.split(/[\\/]/).pop() ?? path);
    void (async () => {
      // 1) 锚点根列表（不动用户目录切换语义：树根为文件祖先时原地展开）
      await loadDir(anchor);
      if (getReveal()?.seq !== seq) return;
      // 2) 逐级展开父目录（懒加载复用 expandedDirs，文件行随最后一级展开出现）
      const rel = path.slice(anchor.length).replace(/^[/\\]+/, '');
      const dirSegments = rel.split(/[\\/]/).filter(Boolean).slice(0, -1);
      for (let i = 0; i < dirSegments.length; i += 1) {
        if (getReveal()?.seq !== seq) return;
        const dirPath = joinPath(anchor, dirSegments.slice(0, i + 1).join('/'));
        try {
          const res = await fetch(`${API}/fs/list-dir?path=${encodeURIComponent(dirPath)}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
          const list = (data.entries as TreeNode[]).sort(
            (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
          );
          setExpandedDirs((prev) => {
            const next = new Map(prev);
            next.set(dirPath, list);
            return next;
          });
        } catch {
          break; // 某级展开失败即停（文件行可能已可见）
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq]);
  // 定位后：滚动到该文件行（data-name 精确匹配；最后一级目录展开后行才出现）
  useEffect(() => {
    if (flashName === '' || entries === null || !scrollRef.current) return;
    const rows = Array.from(scrollRef.current.querySelectorAll('.dskDevRow'));
    const row = rows.find((el) => (el as HTMLElement).dataset.name === flashName);
    if (row instanceof HTMLElement) row.scrollIntoView({ block: 'nearest' });
  }, [flashName, entries, expandedDirs]);
  // 闪烁高亮 1.4s 后熄灭
  useEffect(() => {
    if (flashName === '') return;
    const timer = window.setTimeout(() => setFlashName(''), 1400);
    return () => window.clearTimeout(timer);
  }, [flashName]);

  // 树行右键菜单（C12 文件系统打开）：fixed 锚点 + 点外/Esc 关闭；失败红字 / 成功灰字命令反馈
  const [rowMenu, setRowMenu] = useState<{
    path: string;
    x: number;
    y: number;
    isDir: boolean;
    error?: string;
    feedback?: string;
  } | null>(null);
  useEffect(() => {
    if (rowMenu === null) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.dskDevCtxMenu') == null) setRowMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRowMenu(null);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [rowMenu]);

  // 行右键（原生 contextmenu 监听，不依赖 React 合成事件）：从行 dataset 读路径与类型
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const onContext = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      const row = target?.closest('.dskDevRow') as HTMLElement | null;
      if (row === null) return;
      const path = row.dataset.path;
      if (path === undefined || path.length === 0) return;
      event.preventDefault();
      openRowMenuAt(path, row.dataset.dir === 'true', event.clientX, event.clientY);
    };
    el.addEventListener('contextmenu', onContext);
    return () => el.removeEventListener('contextmenu', onContext);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 行右键锚点（边界防溢出：菜单估计 170×120）
  const openRowMenuAt = (path: string, isDir: boolean, clientX: number, clientY: number): void => {
    setRowMenu({
      path,
      x: Math.min(clientX, window.innerWidth - 170),
      y: Math.min(clientY, window.innerHeight - 120),
      isDir,
    });
  };

  // 菜单项点击：失败保留菜单红字错误；成功保留菜单灰字显示实际执行命令（用户可见，无需控制台）
  const runSystemOpen = (path: string, action: SystemOpenAction): void => {
    void systemOpen(path, action).then((result) => {
      setRowMenu((prev) => {
        if (prev === null) return prev;
        if (result.ok) {
          return { ...prev, feedback: `已执行：${result.command ?? action}`, error: undefined };
        }
        return { ...prev, error: result.error ?? '系统打开失败', feedback: undefined };
      });
    });
  };

  return (
    <>
      {/* 头部：路径输入 + 加载 + 关闭 */}
      <div style={{ display: 'flex', gap: 6, padding: 8, borderBottom: '1px solid var(--dsw-alias-border-l1, #333)' }}>
        <input
          value={rootPath}
          onChange={(e) => setRootPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && rootPath.trim()) void loadDir(rootPath.trim());
          }}
          placeholder="工作区路径，如 C:\work\project"
          className="dskDevPathInput"
          style={{ flex: 1, minWidth: 0, padding: '4px 8px', fontSize: 12 }}
        />
        <button
          type="button"
          onClick={() => rootPath.trim() && void loadDir(rootPath.trim())}
          style={btnStyle}
        >
          加载
        </button>
        <button
          type="button"
          aria-label="刷新当前工作区"
          title="刷新（重新加载当前工作区）"
          onClick={() => {
            const target = workspaceRoot ?? currentPath;
            if (target) void loadDir(target);
          }}
          style={btnStyle}
        >
          ⟳
        </button>
        <button type="button" aria-label="最小化文件列表" title="最小化文件列表（点击侧栏 📁 恢复）" onClick={() => setPanelOpen(false)} style={btnStyle}>
          ✕
        </button>
      </div>

      {/* 目录树 */}
      <div ref={scrollRef} style={{ flex: 1, overflow: 'auto', padding: '4px 0', minHeight: 0 }}>
        {fileState.error !== '' && (
          <div style={{ padding: 8, fontSize: 12, color: '#e66', whiteSpace: 'pre-wrap' }}>{fileState.error}</div>
        )}
        {currentPath && (
          <div style={{ padding: '3px 8px', fontSize: 11, display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
            {breadcrumbParts(currentPath).map((part, index) => {
              const last = index === breadcrumbParts(currentPath).length - 1;
              return (
                <React.Fragment key={part.path}>
                  {index > 0 && <span style={{ color: 'var(--dsw-alias-label-tertiary, #8b8d95)' }}>›</span>}
                  <button
                    type="button"
                    onClick={() => void loadDir(part.path)}
                    style={{
                      ...btnStyle,
                      padding: '0 4px',
                      fontSize: 11,
                      background: 'transparent',
                      border: 'none',
                      fontWeight: last ? 600 : 400,
                      color: last
                        ? 'var(--dsw-alias-label-primary, #e8e8ec)'
                        : 'var(--dsw-alias-label-tertiary, #8b8d95)',
                    }}
                  >
                    {part.label}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        )}
        {loading ? (
          <div style={{ padding: 16, fontSize: 12, opacity: 0.6, textAlign: 'center' }}>加载中…</div>
        ) : entries === null ? (
          <div style={{ padding: 16, fontSize: 12, opacity: 0.6, textAlign: 'center' }}>
            输入工作区路径后点击"加载"
          </div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, opacity: 0.6, textAlign: 'center' }}>空目录</div>
        ) : (
          entries.map((entry) =>
            entry.isDir ? (
              <DirRow
                key={entry.name}
                path={joinPath(currentPath, entry.name)}
                name={entry.name}
                depth={0}
                activePath={fileState.activePath}
                expandedDirs={expandedDirs}
                onToggle={(path) => {
                  setExpandedDirs((prev) => {
                    const next = new Map(prev);
                    const state = next.get(path);
                    if (state === undefined) {
                      next.set(path, 'loading');
                      void (async () => {
                        try {
                          const res = await fetch(`${API}/fs/list-dir?path=${encodeURIComponent(path)}`);
                          const data = await res.json();
                          if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
                          const list = (data.entries as TreeNode[]).sort(
                            (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name),
                          );
                          setExpandedDirs((prev2) => {
                            const next2 = new Map(prev2);
                            next2.set(path, list);
                            return next2;
                          });
                        } catch (cause) {
                          setExpandedDirs((prev2) => {
                            const next2 = new Map(prev2);
                            next2.delete(path);
                            return next2;
                          });
                          setError(errText(cause));
                        }
                      })();
                    } else if (state !== 'loading') {
                      next.delete(path);
                    }
                    return next;
                  });
                }}
                onOpenFile={(path) => void openFile(path)}
              />
            ) : (
              <div
                key={entry.name}
                role="button"
                tabIndex={0}
                className="dskDevRow"
                data-active={
                  normalizeActivePath(joinPath(currentPath, entry.name)) === normalizeActivePath(fileState.activePath) || undefined
                }
                data-name={entry.name}
                data-path={joinPath(currentPath, entry.name)}
                data-dir="false"
                data-flash={entry.name === flashName || undefined}
                onClick={() => void openFile(joinPath(currentPath, entry.name))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') void openFile(joinPath(currentPath, entry.name));
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '3px 8px',
                  paddingLeft: 22,
                  fontSize: 12.5,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                <span style={{ flexShrink: 0 }}>📄</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.name}</span>
              </div>
            ),
          )
        )}
      </div>
      {/* 树行右键菜单（C12）：portal 到 body 脱离列容器；失败时保留菜单并显示红字错误 */}
      {rowMenu !== null &&
        createPortal(
          <div className="dskDevCtxMenu" style={{ left: rowMenu.x, top: rowMenu.y }}>
            <button
              type="button"
              onClick={() => runSystemOpen(rowMenu.path, 'reveal')}
            >
              在资源管理器打开
            </button>
            {!rowMenu.isDir && (
              <>
                <button
                  type="button"
                  onClick={() => runSystemOpen(rowMenu.path, 'open')}
                >
                  系统默认应用打开
                </button>
                <button
                  type="button"
                  onClick={() => runSystemOpen(rowMenu.path, 'choose-app')}
                >
                  打开方式
                </button>
              </>
            )}
            {rowMenu.error !== undefined && (
              <div className="dskDevCtxMenuError">{rowMenu.error}</div>
            )}
            {rowMenu.feedback !== undefined && (
              <div className="dskDevCtxMenuFeedback">{rowMenu.feedback}</div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/** 内容列本体（填满 DevFrame 内容列轨道；仅在 tabs.length > 0 时挂载） */
export function WorkbenchEditor(props: WorkbenchHooks): React.JSX.Element {
  const fileState = useSyncExternalStore(subscribeFile, getFileState);
  const pendingRef = useSyncExternalStore(subscribePanel, isPendingRef);
  const { tabs, activePath: filePath, byPath, sandboxPrompt, sandboxRetry, pendingClose } = fileState;
  const tab = filePath !== '' ? byPath[filePath] : undefined;
  // 会话工作区（沙箱 workspace-write 只允许写这里）：工作区外文件预警
  const sessions = props.useSessions?.((s: unknown) => s) as
    | { current?: string; byId?: Record<string, { cwd?: string }> }
    | undefined;
  const sessionCwd = sessions?.current ? sessions.byId?.[sessions.current]?.cwd : undefined;
  const outsideWorkspace =
    filePath !== '' && sessionCwd !== undefined && !isAncestor(sessionCwd, filePath);
  // 标签菜单（⋯）：关闭左侧/右侧/全部
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [menuOpen]);

  // 标签右键菜单（C4）：以被右键标签为锚的四个关闭动作
  const [ctxMenu, setCtxMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (ctxMenu === null) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.dskDevCtxMenu') == null) setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  if (tab === undefined) return <></>;
  const { content, dirty, isMd, mdHtml, viewMode, saving, saveFailed, imageSrc, selectedSnippet } = tab;
  const activeIndex = tabs.indexOf(filePath);

  // md 预览容器（代码块高亮用）
  const mdPreviewRef = useRef<HTMLDivElement>(null);

  // md 预览代码块高亮：渲染后对 pre>code 逐个调 host /highlight 替换
  useEffect(() => {
    if (viewMode !== 'preview' || !isMd || mdHtml === '') return;
    const container = mdPreviewRef.current;
    if (!container) return;
    const blocks = Array.from(container.querySelectorAll('pre code'));
    for (const block of blocks) {
      const el = block as HTMLElement;
      const langMatch = (el.className ?? '').match(/language-([\w-]+)/);
      const lang = langMatch?.[1] ?? 'text';
      const source = el.textContent ?? '';
      if (source.trim() === '') continue;
      void (async () => {
        try {
          const res = await fetch(`${API}/highlight`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source, filename: `code.${lang}`, lang }),
          });
          const data = await res.json();
          if (res.ok && typeof data.html === 'string' && data.html.length > 0) {
            const pre = el.closest('pre');
            if (pre) pre.outerHTML = data.html;
          }
        } catch {
          // 高亮失败保留原样
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, isMd, mdHtml]);

  // Ctrl+S 保存（window 通道；monaco 内按键经 addCommand 另一通道，saveFile 有 saving 重入防护）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        const s = getFileState();
        const t = s.activePath !== '' ? s.byPath[s.activePath] : undefined;
        if (t !== undefined && t.dirty) void saveFile();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {/* 标签条：多文件同时打开，逐个 ✕ / ⋯ 批量关闭（dirty 标签关闭前弹确认） */
      /* dskDevTabs 独立滚动容器：tab bar 本体 overflow:visible，否则 ⋯ 弹层被 overflow-x:auto 裁剪 */}
      <div className="dskDevTabBar">
        <div className="dskDevTabs">
          {tabs.map((path) => {
            const t = byPath[path];
            const active = path === filePath;
            const name = path.split(/[\\/]/).pop() ?? path;
            return (
              <div
                key={path}
                className="dskDevTab"
                data-active={active || undefined}
                title={path}
                onClick={() => activateTab(path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenuOpen(false);
                  // 边界防溢出：菜单估计尺寸 160×140
                  setCtxMenu({
                    path,
                    x: Math.min(e.clientX, window.innerWidth - 160),
                    y: Math.min(e.clientY, window.innerHeight - 140),
                  });
                }}
              >
                {t?.dirty === true && <span className="dskDevTabDirty" />}
                <span className="dskDevTabName">{name}</span>
                <button
                  type="button"
                  className="dskDevTabClose"
                  aria-label={`关闭 ${name}`}
                  title="关闭"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(path);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <div className="dskDevTabMenuWrap" ref={menuRef}>
          <button
            type="button"
            className="dskDevTabMenu"
            aria-label="标签操作"
            title="标签操作"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="dskDevTabMenuPopup">
              <button
                type="button"
                disabled={activeIndex <= 0}
                onClick={() => {
                  closeTabsLeft(filePath);
                  setMenuOpen(false);
                }}
              >
                关闭左侧所有
              </button>
              <button
                type="button"
                disabled={activeIndex === -1 || activeIndex === tabs.length - 1}
                onClick={() => {
                  closeTabsRight(filePath);
                  setMenuOpen(false);
                }}
              >
                关闭右侧所有
              </button>
              <button
                type="button"
                onClick={() => {
                  closeAllTabs();
                  setMenuOpen(false);
                }}
              >
                全部关闭
              </button>
            </div>
          )}
        </div>
      </div>

      {/* tab 右键菜单（fixed 定位脱离列裁剪；以被右键标签为锚） */}
      {ctxMenu !== null && (
        <div className="dskDevCtxMenu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button
            type="button"
            onClick={() => {
              closeTab(ctxMenu.path);
              setCtxMenu(null);
            }}
          >
            关闭当前
          </button>
          <button
            type="button"
            onClick={() => {
              closeAllTabs();
              setCtxMenu(null);
            }}
          >
            关闭全部
          </button>
          <button
            type="button"
            disabled={tabs.indexOf(ctxMenu.path) <= 0}
            onClick={() => {
              closeTabsLeft(ctxMenu.path);
              setCtxMenu(null);
            }}
          >
            关闭左侧全部
          </button>
          <button
            type="button"
            disabled={tabs.indexOf(ctxMenu.path) === -1 || tabs.indexOf(ctxMenu.path) === tabs.length - 1}
            onClick={() => {
              closeTabsRight(ctxMenu.path);
              setCtxMenu(null);
            }}
          >
            关闭右侧全部
          </button>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 11.5 }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>
          {filePath.split('/').pop()}
          {dirty && <span style={{ color: '#e6a23c', marginLeft: 4 }}>● 未保存</span>}
        </span>
        {outsideWorkspace && (
          <span
            title="该文件不在当前会话工作区内：可查看/编辑，但保存会被沙箱（workspace-write）拒绝，请切换到对应工作区的会话后保存"
            style={{ color: '#e6a23c', fontSize: 11, flexShrink: 0, whiteSpace: 'nowrap' }}
          >
            ⚠ 工作区外
          </span>
        )}
        {isMd && (
          <div style={{ display: 'flex', gap: 2 }}>
            <button
              type="button"
              onClick={() => setViewMode('source')}
              style={{ ...btnStyle, opacity: viewMode === 'source' ? 1 : 0.5 }}
            >
              源码
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode('preview');
                if (mdHtml === '') void refreshMarkdown(filePath, content);
              }}
              style={{ ...btnStyle, opacity: viewMode === 'preview' ? 1 : 0.5 }}
            >
              预览
            </button>
          </div>
        )}
        {viewMode !== 'image' && (
          <button
            type="button"
            onClick={() => void saveFile()}
            disabled={!dirty || saving}
            style={{ ...btnStyle, opacity: !dirty || saving ? 0.5 : 1 }}
          >
            保存
          </button>
        )}
        {viewMode !== 'image' && selectedSnippet !== '' && filePath !== '' && (
          <button
            type="button"
            title="把选中片段发送给 agent"
            onClick={() => {
              const name = filePath.split(/[\\/]/).pop() ?? filePath;
              const ok = callInsertRef({ path: filePath, name, snippet: selectedSnippet });
              if (!ok) {
                setError('引用未注入：composer 未就绪（请确认对话输入框的 @文件 按钮可用后重试）');
                return;
              }
              setSelectedSnippet('');
            }}
            style={{
              ...btnStyle,
              borderColor: '#6c8cff',
              color: '#6c8cff',
            }}
          >
            发送片段给 agent
          </button>
        )}
        {pendingRef && filePath !== '' && (
          <button
            type="button"
            onClick={() => {
              const name = filePath.split(/[\\/]/).pop() ?? filePath;
              const ok = callInsertRef({ path: filePath, name });
              if (!ok) {
                setError('引用未注入：composer 未就绪（请确认对话输入框的 @文件 按钮可用后重试）');
                return;
              }
              setPendingRef(false);
            }}
            style={{
              ...btnStyle,
              borderColor: '#6c8cff',
              color: '#6c8cff',
            }}
          >
            引用此文件
          </button>
        )}
        {saveFailed && filePath !== '' && (
          <button
            type="button"
            title="放弃当前编辑，从磁盘重新加载"
            onClick={() => {
              setError('');
              void reloadFile(filePath);
            }}
            style={{
              ...btnStyle,
              borderColor: '#e6a23c',
              color: '#e6a23c',
            }}
          >
            重新加载
          </button>
        )}
        <button
          type="button"
          aria-label="最小化内容列"
          title="最小化内容列（点击文件恢复）"
          onClick={() => setEditorOpen(false)}
          style={btnStyle}
        >
          ✕
        </button>
        {filePath !== '' && (
          <button
            type="button"
            aria-label="在文件列表中定位"
            title="在文件列表中定位该文件"
            onClick={() => {
              setPanelOpen(true);
              setReveal(filePath);
            }}
            style={btnStyle}
          >
            定位
          </button>
        )}
      </div>
      {viewMode === 'image' && imageSrc !== '' ? (
        <div style={{ flex: 1, overflow: 'auto', padding: 8, display: 'flex', alignItems: 'flex-start', justifyContent: 'center' }}>
          {/* 图片来自 host read-image（沙箱内文件字节），本插件直接展示 */}
          <img src={imageSrc} alt={filePath.split(/[\\/]/).pop() ?? 'preview'} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 4 }} />
        </div>
      ) : viewMode === 'preview' && isMd ? (
        <div
          ref={mdPreviewRef}
          className="dskDevMdPreview"
          style={{ flex: 1, overflow: 'auto', padding: '8px 12px', fontSize: 13, lineHeight: 1.6 }}
          // 渲染结果来自 host 半 markdown-it（html 转义关闭），插件信任自身渲染
          dangerouslySetInnerHTML={{ __html: mdHtml }}
        />
      ) : (
        // 文本类文件（含 md 源码）：monaco 编辑器内核（C6）
        <MonacoEditorArea
          path={filePath}
          content={content}
          openPaths={tabs}
          onChange={(v) => setContent(v)}
          onSelection={(snippet) => setSelectedSnippet(snippet)}
          onSaveShortcut={() => {
            const s = getFileState();
            const t = s.activePath !== '' ? s.byPath[s.activePath] : undefined;
            if (t !== undefined && t.dirty && !t.saving) void saveFile();
          }}
        />
      )}
      {/* 关闭确认：待关闭批次中含未保存（dirty）标签时拦截 */}
      {pendingClose !== null && (
        <div className="dskDevSandboxPrompt">
          <div className="dskDevSandboxPromptCard">
            <div className="dskDevSandboxPromptTitle">未保存的修改</div>
            <div className="dskDevSandboxPromptBody">
              {pendingClose.dirtyPaths.length} 个文件有未保存修改：
              {pendingClose.dirtyPaths
                .map((p) => p.split(/[\\/]/).pop() ?? p)
                .join('、')}
              。关闭前是否保存？
            </div>
            <div className="dskDevSandboxPromptActions">
              <button
                type="button"
                className="dskDevSandboxPromptPrimary"
                onClick={() => void confirmPendingClose('save')}
              >
                保存并关闭
              </button>
              <button type="button" onClick={() => void confirmPendingClose('discard')}>
                不保存
              </button>
              <button type="button" onClick={() => cancelPendingClose()}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 保存授权面板：未信任目录首次被拒 → 信任授权；已信任 → 等待会话权限放开自动重试 */}
      {(sandboxPrompt !== null || sandboxRetry !== null) && (
        <div className="dskDevSandboxPrompt">
          <div className="dskDevSandboxPromptCard">
            {sandboxPrompt !== null ? (
              <>
                <div className="dskDevSandboxPromptTitle">保存需要授权</div>
                <div className="dskDevSandboxPromptBody">
                  文件夹 <code>{sandboxPrompt.dir}</code> 不在当前会话工作区内，DSH 沙箱（workspace-write）默认拒绝写入。
                  信任后插件将以「文件夹白名单」方式保存（仅放行该目录，无需切换「完全访问」）。
                  未保存内容保留在编辑区。
                </div>
                <div className="dskDevSandboxPromptActions">
                  <button
                    type="button"
                    className="dskDevSandboxPromptPrimary"
                    onClick={() => trustDir(sandboxPrompt.dir)}
                  >
                    信任此文件夹并授权保存
                  </button>
                  <button type="button" onClick={() => cancelSandboxApproval()}>
                    取消
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="dskDevSandboxPromptTitle">已信任，正在重试保存</div>
                <div className="dskDevSandboxPromptBody">
                  插件正以「文件夹白名单」方式重试保存（通常立即成功）。若持续失败（旧版运行时），
                  请在会话输入框执行 <code>/permission</code> 选择「完全访问」，插件会自动重试（约 60 秒内，可随时停止）。
                </div>
                <div className="dskDevSandboxPromptActions">
                  <button type="button" onClick={() => cancelSandboxApproval()}>
                    停止重试
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}


