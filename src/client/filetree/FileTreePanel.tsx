/**
 * client 半：文件树面板（shell.overlay list 槽，左右停靠双列）。
 * 布局（参考 demo）：左列文件树 | 中间宿主对话（透明穿透）| 右列文件内容。
 * 功能：路径输入加载目录树 → 点击文件夹展开 → 点击文件查看内容 →
 * md 源码/预览切换 → 代码高亮 → textarea 编辑 + dirty + Ctrl+S 保存（版本守卫）；
 * @文件 引用模式：composer 按钮触发，选文件后点"引用"注入对话。
 * 数据经 fetch 调 host 路由 /api/dsk-develop-ui/*（参照 market 模式）。
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  callInsertRef,
  isPanelOpen,
  isPendingRef,
  setPanelOpen,
  setPendingRef,
  subscribePanel,
} from './store';

const API = '/api/dsk-develop-ui';

/** 上次工作区路径（localStorage 记忆，MVP 替代自动检测） */
const ROOT_PATH_KEY = 'dsk-develop-ui.rootPath';

/** 图片扩展名（预览用） */
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;

interface TreeNode {
  name: string;
  isDir: boolean;
}

function joinPath(dir: string, name: string): string {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + name;
  return `${dir}/${name}`;
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

function errText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** 目录树行（文件夹可展开，懒加载子目录） */
function DirRow({
  path,
  name,
  depth,
  expandedDirs,
  onToggle,
  onOpenFile,
}: {
  path: string;
  name: string;
  depth: number;
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
                expandedDirs={expandedDirs}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
              />
            ) : (
              <div
                key={child.name}
                role="button"
                tabIndex={0}
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

/** overlay 槽 standardProps 的子集（useWorkspaces/useSessions 用于自动检测当前工作区） */
interface PanelProps {
  useWorkspaces?: (selector: (state: unknown) => unknown) => unknown;
  useSessions?: (selector: (state: unknown) => unknown) => unknown;
}

/** 文件树面板本体 */
function FileTreePanelImpl(props: PanelProps): React.JSX.Element | null {
  const open = useSyncExternalStore(subscribePanel, isPanelOpen);
  const pendingRef = useSyncExternalStore(subscribePanel, isPendingRef);
  // 最近工作区路径（自动检测回退）：overlay 槽注入 useWorkspaces → recentWorkspaceId.path
  const workspaces = props.useWorkspaces?.((s: unknown) => s) as
    | { items?: Array<{ workspaceId: string; path?: string }>; recentWorkspaceId?: string }
    | undefined;
  const recentPath = workspaces?.items?.find((w) => w.workspaceId === workspaces.recentWorkspaceId)?.path;
  // 当前活动工作区路径（最准确）：当前 session 的 cwd（session summary 携带，见 dsh-client-runtime workspaces 服务）
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
  const [error, setError] = useState('');

  // 文件内容视图
  const [filePath, setFilePath] = useState('');
  const [content, setContent] = useState('');
  const [version, setVersion] = useState('');
  const [dirty, setDirty] = useState(false);
  const [isMd, setIsMd] = useState(false);
  const [isCode, setIsCode] = useState(false);
  const [mdHtml, setMdHtml] = useState('');
  const [codeHtml, setCodeHtml] = useState('');
  const [viewMode, setViewMode] = useState<'source' | 'preview' | 'highlight' | 'image'>('source');
  const [saving, setSaving] = useState(false);
  // 保存失败（版本冲突/权限）→ 提供"重新加载"恢复
  const [saveFailed, setSaveFailed] = useState(false);
  // 图片预览（P1）
  const [imageSrc, setImageSrc] = useState('');
  // 片段级引用：编辑器选中文本（P1）
  const [selectedSnippet, setSelectedSnippet] = useState('');
  /** 读取 textarea 选区（用 DOM 当前值，避免 state 滞后；鼠标/键盘选择均触发） */
  const updateSelection = useCallback((el: HTMLTextAreaElement) => {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === end) {
      setSelectedSnippet('');
      return;
    }
    setSelectedSnippet(el.value.slice(start, end));
  }, []);
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

  // 打开面板时默认展示当前工作区（用户切换工作区后点击 📂/@文件 即加载该工作区）；
  // 无当前 session cwd 时回退最近工作区路径
  useEffect(() => {
    if (!open) return;
    const target = workspaceRoot ?? recentPath;
    if (!target) return;
    setRootPath(target);
    void loadDir(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceRoot, recentPath]);

  const refreshMarkdown = useCallback(async (source: string) => {
    try {
      const res = await fetch(`${API}/md/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMdHtml(data.html ?? '');
    } catch (cause) {
      setMdHtml(`<p style="color:#e66">渲染失败：${errText(cause)}</p>`);
    }
  }, []);

  const openFile = useCallback(
    async (path: string) => {
      // 图片文件：走图片预览（read-image → dataUrl），不读文本
      if (IMAGE_EXT_PATTERN.test(path)) {
        try {
          const res = await fetch(`${API}/fs/read-image?path=${encodeURIComponent(path)}`);
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
          setFilePath(path);
          setContent('');
          setDirty(false);
          setIsMd(false);
          setIsCode(false);
          setViewMode('image');
          setImageSrc(data.dataUrl as string);
          setError('');
        } catch (cause) {
          setError(errText(cause));
        }
        return;
      }
      try {
        const res = await fetch(`${API}/fs/read-text?path=${encodeURIComponent(path)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        setFilePath(path);
        setContent(data.content);
        setVersion(data.version);
        setDirty(false);
        setViewMode('source');
        const markdown = /\.md$/i.test(path);
        setIsMd(markdown);
        // 代码文件（非 md/非二进制）走 shiki 高亮；文本类扩展名才尝试
        const codeLike = !markdown && /\.(ts|tsx|js|jsx|mjs|cjs|json|css|html|yml|yaml|sh|py|rs|go|java)$/i.test(path);
        setIsCode(codeLike);
        if (markdown) {
          void refreshMarkdown(data.content);
        } else if (codeLike) {
          void (async () => {
            try {
              const res = await fetch(`${API}/highlight`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ source: data.content, filename: path }),
              });
              const d = await res.json();
              if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
              setCodeHtml(d.html ?? '');
            } catch (cause) {
              setCodeHtml(`<pre style="color:#e66">高亮失败：${errText(cause)}</pre>`);
            }
          })();
        }
        setError('');
      } catch (cause) {
        setError(errText(cause));
      }
    },
    [refreshMarkdown],
  );

  const saveFile = useCallback(async () => {
    if (!filePath || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/fs/write-text`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: filePath, content, expectedVersion: version }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setVersion(data.version);
      setDirty(false);
      if (isMd) {
        void refreshMarkdown(content);
      } else if (isCode && filePath) {
        const res2 = await fetch(`${API}/highlight`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: content, filename: filePath }),
        });
        const d2 = await res2.json();
        if (res2.ok) setCodeHtml(d2.html ?? '');
      }
      setError('');
      setSaveFailed(false);
    } catch (cause) {
      setError(`保存失败：${errText(cause)}`);
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  }, [filePath, content, version, isMd, isCode, saving, refreshMarkdown]);

  // Ctrl+S 保存
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (filePath.length > 0 && dirty) void saveFile();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveFile, filePath, dirty]);

  if (!open) return null;

  // 布局参考 demo：会话侧栏(宿主) | 文件树(左列) | 对话(宿主中列) | 文件内容(右列)。
  // overlay 槽无法推动宿主列，外层用全宽透明容器（pointerEvents: none 穿透到对话），
  // 左右两列各自 pointerEvents: auto 停靠两侧，中间对话保持可见可交互。
  return (
    <div
      style={{
        position: 'fixed',
        left: 56,
        top: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        pointerEvents: 'none',
        zIndex: 30,
      }}
    >
      {/* 左列：文件树 */}
      <div
        style={{
          width: 360,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--dsw-specific-sidebar-fill, #1e1f24)',
          borderRight: '1px solid var(--dsw-alias-border-l1, #333)',
          boxShadow: '4px 0 16px rgba(0,0,0,.3)',
          pointerEvents: 'auto',
        }}
      >
        {/* 头部：路径输入 + 加载 + 关闭 */}
        <div style={{ display: 'flex', gap: 6, padding: 8, borderBottom: '1px solid var(--dsw-alias-border-l1, #333)' }}>
          <input
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && rootPath.trim()) void loadDir(rootPath.trim());
            }}
            placeholder="工作区路径，如 C:\work\project"
            style={{
              flex: 1,
              minWidth: 0,
              padding: '4px 8px',
              fontSize: 12,
              background: 'var(--dsw-alias-input-fill, #26272e)',
              border: '1px solid var(--dsw-alias-border-l1, #333)',
              color: 'inherit',
              borderRadius: 4,
            }}
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
          <button type="button" aria-label="关闭" onClick={() => setPanelOpen(false)} style={btnStyle}>
            ✕
          </button>
        </div>

        {/* 目录树 */}
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 0', minHeight: 0 }}>
          {error && (
            <div style={{ padding: 8, fontSize: 12, color: '#e66', whiteSpace: 'pre-wrap' }}>{error}</div>
          )}
          {currentPath && (
            <div style={{ padding: '3px 8px', fontSize: 11, opacity: 0.85, display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
              {breadcrumbParts(currentPath).map((part, index) => {
                const last = index === breadcrumbParts(currentPath).length - 1;
                return (
                  <React.Fragment key={part.path}>
                    {index > 0 && <span style={{ opacity: 0.45 }}>›</span>}
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
                        opacity: last ? 1 : 0.7,
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
      </div>

      {/* 中间：对话区留白（透明且事件穿透，宿主对话保持可见可点） */}
      <div style={{ flex: 1, minWidth: 0 }} />

      {/* 右列：文件内容（选中文件后展开；对话保持 DSH 原生中置） */}
      {filePath !== '' && (
        <div
          style={{
            width: 'clamp(480px, 36vw, 920px)',
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-specific-sidebar-fill, #1e1f24)',
            borderLeft: '1px solid var(--dsw-alias-border-l1, #333)',
            boxShadow: '-4px 0 16px rgba(0,0,0,.3)',
            pointerEvents: 'auto',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', fontSize: 11.5 }}>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>
              {filePath.split('/').pop()}
              {dirty && <span style={{ color: '#e6a23c', marginLeft: 4 }}>● 未保存</span>}
            </span>
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
                    if (mdHtml === '') void refreshMarkdown(content);
                  }}
                  style={{ ...btnStyle, opacity: viewMode === 'preview' ? 1 : 0.5 }}
                >
                  预览
                </button>
              </div>
            )}
            {isCode && !isMd && (
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
                  onClick={() => setViewMode('highlight')}
                  style={{ ...btnStyle, opacity: viewMode === 'highlight' ? 1 : 0.5 }}
                >
                  高亮
                </button>
              </div>
            )}
            {viewMode !== 'image' && (
              <button type="button" onClick={() => void saveFile()} disabled={!dirty || saving} style={{ ...btnStyle, opacity: !dirty || saving ? 0.5 : 1 }}>
                保存
              </button>
            )}
            {viewMode !== 'image' && selectedSnippet && filePath && (
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
                  setPanelOpen(false);
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
            {pendingRef && filePath && (
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
                  setPanelOpen(false);
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
            {saveFailed && filePath && (
              <button
                type="button"
                title="放弃当前编辑，从磁盘重新加载"
                onClick={() => {
                  setSaveFailed(false);
                  setError('');
                  void openFile(filePath);
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
              aria-label="关闭文件"
              title="关闭文件"
              onClick={() => {
                if (!dirty || window.confirm('当前文件有未保存的修改，确定关闭？')) setFilePath('');
              }}
              style={btnStyle}
            >
              ✕
            </button>
          </div>
          {viewMode === 'image' && imageSrc ? (
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
          ) : viewMode === 'highlight' && isCode ? (
            <div
              className="dskDevCodeHighlight"
              style={{ flex: 1, overflow: 'auto', padding: 8, fontSize: 12.5, lineHeight: 1.6 }}
              // 渲染结果来自 host 半 shiki（带内联样式），插件信任自身渲染
              dangerouslySetInnerHTML={{ __html: codeHtml }}
            />
          ) : (
            <textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
                setSelectedSnippet('');
              }}
              onSelect={(e) => updateSelection(e.target as HTMLTextAreaElement)}
              onMouseUp={(e) => updateSelection(e.target as HTMLTextAreaElement)}
              onKeyUp={(e) => updateSelection(e.target as HTMLTextAreaElement)}
              spellCheck={false}
              style={{
                flex: 1,
                width: '100%',
                resize: 'none',
                border: 'none',
                padding: 8,
                fontSize: 12.5,
                fontFamily: 'ui-monospace, Consolas, monospace',
                background: 'transparent',
                color: 'inherit',
                outline: 'none',
              }}
            />
          )}
        </div>
      )}
    </div>
  );
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

/** 导出组件（overlay 槽需要可挂载组件；props 来自槽 standardProps） */
export function FileTreePanel(props: PanelProps): React.JSX.Element | null {
  return <FileTreePanelImpl {...props} />;
}
