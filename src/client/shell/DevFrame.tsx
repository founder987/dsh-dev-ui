/**
 * client 半：方案 C 落地版 —— 布局提供者接管（官方 ui-layout 在 profile 层禁用）。
 * 布局（参考 demo）：sidebar(官方会话) | 文件树 | conversation(官方对话) | 文件内容 | details(官方工具详情)。
 *
 * 与官方契约的对应（@deepseek-ai/dsh-client-ui-layout rc.7 源码）：
 * - 同名子槽声明（sidebar/conversation/details/shell.overlay）随 root 注册，
 *   官方 occupant 渲染在本框架的列里 → 工作区/对话/工具详情功能全保留；
 * - ctx.layout 服务由 index.ts 提供（LayoutController 等价面），root 条目
 *   inject 钩子把 bound actions 接线进 attachPanels，官方插件（ui-sidebar/
 *   ui-conversation）的面板切换调用不受影响；
 * - 主题 token 呈现由 index.ts 接替（ThemePresenter 等价物）；
 * - details 列 0 宽保持挂载（tool details 状态不丢）；sidebar 折叠为 56px rail；
 *   1024px 断点自动折叠 + narrowExpanded 覆盖；让渡链保 center >= 640。
 * - 主题由 ui-layout 的 ThemePresenter 负责（其 apply 照常运行，不随 root shadow 失效）。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { defineStore } from '@deepseek-ai/dsh-client-runtime/client';
import { IconCodeOutline16, IconFolderClose16, IconFolderOpen16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { isPanelOpen, setPanelOpen, subscribePanel } from '../filetree/store';
import { getFileState, subscribeFile } from '../filetree/fileStore';
import { WorkbenchEditor, WorkbenchTree } from '../filetree/Workbench';
import { TermPanel } from '../terminal/TermPanel';
import { getTermState, subscribeTerm, togglePanel as toggleTermPanel } from '../terminal/termStore';

/** 上次工作区路径（与 WorkbenchTree 同源：session cwd → recentWorkspace → localStorage 回退） */
const ROOT_PATH_KEY = 'dsk-develop-ui.rootPath';

/* ── 列宽契约（sidebar/details 对齐官方 columns.ts；tree/editor 为本插件列） ── */
const CENTER_MIN = 640;
const SIDEBAR_MIN = 264;
const SIDEBAR_MAX = 420;
const SIDEBAR_DEFAULT = 280;
const SIDEBAR_COLLAPSED = 56;
const SIDEBAR_AUTO_COLLAPSE = 1024;
const DETAILS_MIN = 300;
const DETAILS_MAX = 520;
const DETAILS_DEFAULT = 360;
const TREE_MIN = 240;
const TREE_MAX = 480;
const TREE_DEFAULT = 360;
const EDITOR_MIN = 480;
const EDITOR_MAX = 1200;

const TREE_WIDTH_KEY = 'dsk-develop-ui.treeWidth';
const EDITOR_WIDTH_KEY = 'dsk-develop-ui.editorWidth';

function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, px));
}

/** 读取持久化列宽（越界钳制；缺省/非法回退） */
function readWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return clampWidth(value, min, max);
  } catch {
    return fallback;
  }
}

/* ── 布局 store（官方动作集 + 树/内容列宽；index.ts 注册时接线 ctx.layout） ── */
export interface DevLayoutState {
  sidebar: number;
  details: number;
  narrow: boolean;
  narrowExpanded: boolean;
  tree: number;
  editor: number;
}

export function createDevLayoutStore(): unknown {
  return defineStore({
    init: (): DevLayoutState => ({
      sidebar: SIDEBAR_DEFAULT,
      details: 0,
      narrow: false,
      narrowExpanded: false,
      tree: readWidth(TREE_WIDTH_KEY, TREE_DEFAULT, TREE_MIN, TREE_MAX),
      editor: readWidth(
        EDITOR_WIDTH_KEY,
        clampWidth(Math.round(window.innerWidth * 0.36), EDITOR_MIN, EDITOR_MAX),
        EDITOR_MIN,
        EDITOR_MAX,
      ),
    }),
    actions: {
      setSidebar: (d: DevLayoutState, px: number) => {
        d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX);
      },
      setDetails: (d: DevLayoutState, px: number) => {
        d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX);
      },
      toggleSidebar: (d: DevLayoutState) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded;
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0;
      },
      setNarrow: (d: DevLayoutState, narrow: boolean) => {
        if (d.narrow === narrow) return;
        d.narrow = narrow;
        d.narrowExpanded = false;
      },
      openDetails: (d: DevLayoutState) => {
        if (d.details === 0) d.details = DETAILS_DEFAULT;
      },
      closeDetails: (d: DevLayoutState) => {
        d.details = 0;
      },
      setTree: (d: DevLayoutState, px: number) => {
        d.tree = clampWidth(px, TREE_MIN, TREE_MAX);
      },
      setEditor: (d: DevLayoutState, px: number) => {
        d.editor = clampWidth(px, EDITOR_MIN, EDITOR_MAX);
      },
    },
  });
}

/* ── 五列让渡求解：先压 details（至 min → 派生关闭），再压 editor/tree 至 min，center 兜底 ── */
interface DevColumns {
  sidebar: number;
  tree: number;
  center: number;
  editor: number;
  details: number;
}

function computeDevColumns(
  viewport: number,
  sidebar: number,
  tree: number,
  editor: number,
  details: number,
): DevColumns {
  let d = details;
  let e = editor;
  let t = tree;
  const room = (): number => viewport - sidebar - t - e - d;
  if (room() < CENTER_MIN && d > 0) {
    d = Math.max(DETAILS_MIN, d - (CENTER_MIN - room()));
    if (room() < CENTER_MIN) d = 0;
  }
  if (room() < CENTER_MIN && e > 0) {
    e = Math.max(EDITOR_MIN, e - (CENTER_MIN - room()));
  }
  if (room() < CENTER_MIN && t > 0) {
    t = Math.max(TREE_MIN, t - (CENTER_MIN - room()));
  }
  return { sidebar, tree: t, center: room(), editor: e, details: d };
}

/* ── 框架样式（官方 AppFrame.module.css 规则的自有副本 + 树/内容列 + 树行态） ── */
const FRAME_CSS = `
.dskDevFrame{background:var(--dsw-alias-bg-base);height:100%;display:grid;grid-template-rows:minmax(0,1fr) auto auto;position:relative;overflow:hidden;transition:grid-template-columns var(--ds-transition-duration-slow,.2s) var(--ds-ease-in-out,ease)}
.dskDevFrame[data-dragging]{transition:none}
@media (prefers-reduced-motion:reduce){.dskDevFrame{transition:none}}
.dskDevSidebarCol{grid-row:1/-1;background:var(--dsw-specific-sidebar-fill);border-right:1px solid var(--dsw-alias-border-l1);min-width:0;overflow:hidden}
.dskDevTreeCol{background:var(--dsw-specific-sidebar-fill,#1e1f24);border-right:1px solid var(--dsw-alias-border-l1,#333);min-width:0;overflow:hidden;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#e8e8ec)}
.dskDevFrame[data-tree-collapsed] .dskDevTreeCol{border-right:none}
.dskDevCenterCol{display:flex;flex-direction:column;min-width:0;overflow:hidden}
.dskDevEditorCol{position:relative;background:var(--dsw-specific-sidebar-fill,#1e1f24);border-right:1px solid var(--dsw-alias-border-l1,#333);min-width:0;overflow:hidden;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#e8e8ec)}
.dskDevFrame[data-editor-collapsed] .dskDevEditorCol{border-right:none}
.dskDevDetailsCol{border-left:1px solid var(--dsw-alias-border-l2);min-width:0;overflow:hidden}
.dskDevFrame[data-details-collapsed] .dskDevDetailsCol{border-left:none}
.dskDevOverlayLayer{z-index:20;pointer-events:none;position:absolute;inset:0}
.dskDevOverlayLayer>*{pointer-events:auto}
.dskDevBottomBar{grid-row:3;grid-column:2/-1;display:flex;align-items:center;gap:4px;padding:2px 8px;height:32px;box-sizing:border-box;background:var(--dsw-specific-sidebar-fill,#1e1f24);border-top:1px solid var(--dsw-alias-border-l1,#333);color:var(--dsw-alias-label-primary,#e8e8ec);flex:none;min-width:0;overflow:hidden}
.dskDevBottomBarAction{display:inline-flex;align-items:center;justify-content:center;width:28px;height:26px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#c9c9d1);cursor:pointer;flex:none}
.dskDevBottomBarAction:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dskDevBottomBarAction[data-active=true]{color:var(--dsw-alias-label-primary,#e8e8ec)}
.dskDevHandle{cursor:col-resize;z-index:2;touch-action:none;width:8px;margin-left:-4px;position:absolute;top:0;bottom:0;transition:left var(--ds-transition-duration-slow,.2s) var(--ds-ease-in-out,ease)}
.dskDevFrame[data-dragging] .dskDevHandle{transition:none}
@media (prefers-reduced-motion:reduce){.dskDevHandle{transition:none}}
.dskDevHandle:after{content:"";box-sizing:border-box;background:var(--dsw-alias-button-floating-fill);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);opacity:0;width:12px;height:32px;transition:opacity var(--ds-transition-duration-slow,.2s) var(--ds-ease-in-out,ease),background var(--ds-transition-duration-slow,.2s) var(--ds-ease-in-out,ease);border-radius:10px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}
.dskDevHandle:hover:after,.dskDevHandle[data-dragging=true]:after{opacity:1;background:var(--dsw-alias-button-floating-hover);border-color:var(--dsw-alias-border-l3)}
.dskDevRow{margin:0 4px;border-radius:4px}
.dskDevRow:hover{background:var(--dsw-alias-bg-hover,rgba(255,255,255,.06))}
.dskDevRow[data-active=true]{background:rgba(108,140,255,.14)}
.dskDevRow[data-active=true]:hover{background:rgba(108,140,255,.22)}
@keyframes dskDevFlash{0%{background:rgba(108,140,255,.45)}100%{background:rgba(108,140,255,.14)}}
.dskDevRow[data-flash=true]{animation:dskDevFlash 1.2s var(--ds-ease-in-out,ease) both}
.dskDevPathInput{box-sizing:border-box;background:var(--dsw-specific-input-major,#26272e);border:1px solid var(--dsw-alias-border-l1,#3a3b44);color:var(--dsw-alias-label-primary,#e8e8ec);border-radius:4px}
.dskDevPathInput::placeholder{color:var(--dsw-alias-label-caption,#8b8d95)}
.dskDevPathInput:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#6c8cff)}
.dskDevMonacoWrap{flex:1;min-height:0;overflow:hidden;background:#0d1117}
.dskDevMonacoError{flex:1;display:flex;align-items:center;justify-content:center;color:#e6a23c;font-size:12px;padding:16px;background:#0d1117}
.dskDevTabBar{display:flex;align-items:center;gap:2px;padding:4px 6px 0;background:var(--dsw-specific-sidebar-fill,#1e1f24);border-bottom:1px solid var(--dsw-alias-border-l1,#333);flex:none}
.dskDevTabs{display:flex;align-items:center;gap:2px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:thin;align-self:stretch}
.dskDevTab{display:inline-flex;align-items:center;gap:6px;max-width:180px;padding:3px 6px 3px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8d95);border:1px solid transparent;border-radius:6px 6px 0 0;cursor:pointer;white-space:nowrap;flex:none}
.dskDevTab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dskDevTab[data-active=true]{background:var(--dsw-alias-bg-base,#0d1117);color:var(--dsw-alias-label-primary,#e8e8ec);border-color:var(--dsw-alias-border-l1,#333);border-bottom-color:transparent}
.dskDevTabName{overflow:hidden;text-overflow:ellipsis}
.dskDevTabDirty{width:7px;height:7px;border-radius:50%;background:#e6a23c;flex:none}
.dskDevTabClose{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:none;border-radius:4px;background:transparent;color:inherit;cursor:pointer;font-size:11px;flex:none}
.dskDevTabClose:hover{background:rgba(214,97,97,.25);color:#e66}
.dskDevTabMenuWrap{position:relative;flex:none;margin-left:auto;align-self:center}
.dskDevTabMenu{width:24px;height:22px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b8d95);cursor:pointer;font-size:13px}
.dskDevTabMenu:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#e8e8ec)}
.dskDevTabMenuPopup{position:absolute;right:0;top:26px;z-index:30;min-width:130px;background:var(--dsw-alias-bg-layer-2,#1e1f24);border:1px solid var(--dsw-alias-border-l2,#333);border-radius:8px;box-shadow:var(--dsw-shadow-lv2);padding:4px;display:flex;flex-direction:column}
.dskDevTabMenuPopup button{border:none;background:transparent;color:var(--dsw-alias-label-primary,#e8e8ec);text-align:left;padding:6px 10px;font-size:12px;border-radius:6px;cursor:pointer}
.dskDevTabMenuPopup button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dskDevTabMenuPopup button:disabled{opacity:.4;cursor:default}
.dskDevCtxMenu{position:fixed;z-index:60;min-width:150px;background:var(--dsw-alias-bg-layer-2,#1e1f24);border:1px solid var(--dsw-alias-border-l2,#333);border-radius:8px;box-shadow:var(--dsw-shadow-lv2);padding:4px;display:flex;flex-direction:column}
.dskDevCtxMenu button{border:none;background:transparent;color:var(--dsw-alias-label-primary,#e8e8ec);text-align:left;padding:6px 10px;font-size:12px;border-radius:6px;cursor:pointer}
.dskDevCtxMenu button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dskDevCtxMenu button:disabled{opacity:.4;cursor:default}
.dskDevTermPanel{grid-row:2;grid-column:2/-1;position:relative;display:flex;flex-direction:column;background:var(--dsw-specific-sidebar-fill,#1e1f24);border-top:1px solid var(--dsw-alias-border-l1,#333);min-width:0;overflow:hidden}
.dskDevTermPanel:not([data-open]){border-top:none}
.dskDevTermHandle{position:absolute;top:-3px;left:0;right:0;height:7px;cursor:row-resize;z-index:5;touch-action:none}
.dskDevTermHandle:after{content:"";position:absolute;top:2px;left:50%;transform:translateX(-50%);width:48px;height:4px;border-radius:2px;background:var(--dsw-alias-border-l2,#333);opacity:0;transition:opacity var(--ds-transition-duration-slow,.2s) var(--ds-ease-in-out,ease)}
.dskDevTermHandle:hover:after{opacity:1}
.dskDevTermBody{flex:1;min-height:0;position:relative;background:#0d1117}
.dskDevTermView{position:absolute;inset:0;display:none;padding:2px 0 2px 6px;box-sizing:border-box}
.dskDevTermView[data-active=true]{display:block}
.dskDevTermEmpty{height:100%;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8d95)}
.dskDevTermHint{padding:6px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8b8d95)}
.dskDevTermError{padding:6px 10px;font-size:12px;color:#e66}
.dskDevTabExited{font-size:10px;color:var(--dsw-alias-label-caption,#8b8d95);flex:none}
.dskDevSandboxPrompt{position:absolute;inset:0;z-index:25;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.4)}
.dskDevSandboxPromptCard{max-width:420px;background:var(--dsw-alias-bg-layer-2,#1e1f24);border:1px solid var(--dsw-alias-border-l2,#333);border-radius:12px;box-shadow:var(--dsw-shadow-lv2);padding:16px;display:flex;flex-direction:column;gap:10px}
.dskDevSandboxPromptTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#e8e8ec)}
.dskDevSandboxPromptBody{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#c9c9d1)}
.dskDevSandboxPromptBody code{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:11px;background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));padding:1px 4px;border-radius:4px}
.dskDevSandboxPromptActions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dskDevSandboxPromptActions button{font-size:12px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3b44);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e8e8ec);cursor:pointer}
.dskDevSandboxPromptActions button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dskDevSandboxPromptActions .dskDevSandboxPromptPrimary{background:#6c8cff;border-color:#6c8cff;color:#fff}
.dskDevSandboxPromptActions .dskDevSandboxPromptPrimary:hover{background:#5b7bef}
`;
const FRAME_CSS_TAG_ID = 'dsk-develop-ui/DevFrame.css';
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${FRAME_CSS_TAG_ID}"]`) === null) {
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsk-develop-ui';
  tag.dataset.pluginCss = FRAME_CSS_TAG_ID;
  tag.textContent = FRAME_CSS;
  document.head.appendChild(tag);
}

/** 列宽拖拽手柄：pointer capture + rAF 节流（对齐官方 DragHandle 交互） */
function FrameDragHandle(props: {
  side: string;
  left: number;
  onStart: () => void;
  onDrag: (dx: number) => void;
  onEnd: () => void;
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | null>(null);
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd });
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd };

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = e.clientX;
    latest.current = e.clientX;
    callbacks.current.onStart();
    setDragging(true);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    latest.current = e.clientX;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      callbacks.current.onDrag(latest.current - origin.current);
    });
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    callbacks.current.onDrag(latest.current - origin.current);
    setDragging(false);
    callbacks.current.onEnd();
  }, []);

  return (
    <div
      className="dskDevHandle"
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

interface SessionListStateLike {
  current?: string;
  byId?: Record<string, { blank?: boolean; cwd?: string }>;
}

/** root 入口四份框架 props 面的最小契约（框架保证提供；此处结构化声明） */
interface DevFrameProps {
  useStore: <T>(selector: (state: DevLayoutState) => T) => T;
  useSessions: <T>(selector: (state: SessionListStateLike) => T) => T;
  useWorkspaces: <T>(selector: (state: unknown) => T) => T;
  actions: {
    setSidebar: (px: number) => void;
    setDetails: (px: number) => void;
    toggleSidebar: () => void;
    setNarrow: (narrow: boolean) => void;
    openDetails: () => void;
    closeDetails: () => void;
    setTree: (px: number) => void;
    setEditor: (px: number) => void;
  };
  renderSlot: (key: string, owner: Record<string, unknown>) => React.ReactNode;
}

/** 五列开发框架（root 槽 occupant；官方 sidebar/conversation/details 照常渲染） */
export function DevFrame({ useStore, useSessions, useWorkspaces, actions, renderSlot }: DevFrameProps): React.JSX.Element {
  const panels = useStore((s) => s);
  // details 列会话门禁（复制官方）：无会话或非 blank=false 会话时 details 关闭
  const detailsSession = useSessions((s) => {
    const current = s.current;
    return current !== undefined && s.byId?.[current]?.blank === false ? current : undefined;
  });
  const frameRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const lastSession = useRef(detailsSession);
  useLayoutEffect(() => {
    if (detailsSession === undefined) return;
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) actions.closeDetails();
    lastSession.current = detailsSession;
  }, [actions, detailsSession]);
  useEffect(() => {
    const el = frameRef.current;
    if (el === null) return;
    let raf: number | null = null;
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null;
        const width = el.getBoundingClientRect().width;
        if (width > 0) setViewport(width);
      });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE;
  useEffect(() => {
    actions.setNarrow(narrow);
  }, [actions, narrow]);

  // 树列开关（FileTreeButton / @文件 按钮驱动）；内容列随打开的文件出现，二者独立最小化
  const treeOpen = useSyncExternalStore(subscribePanel, isPanelOpen);
  const fileState = useSyncExternalStore(subscribeFile, getFileState);
  const editorOpen = fileState.editorOpen && fileState.tabs.length > 0;
  // 终端面板（C5 v2）：显隐开关 + cwd（当前 session cwd → 最近工作区 → localStorage 回退）
  const termState = useSyncExternalStore(subscribeTerm, getTermState);
  const workspaces = useWorkspaces((s) => s) as
    | { items?: Array<{ workspaceId: string; path?: string }>; recentWorkspaceId?: string }
    | undefined;
  const sessionsState = useSessions((s) => s);
  const recentPath = workspaces?.items?.find((w) => w.workspaceId === workspaces.recentWorkspaceId)?.path;
  const sessionCwd = sessionsState.current !== undefined ? sessionsState.byId?.[sessionsState.current]?.cwd : undefined;
  const termCwd =
    sessionCwd ??
    recentPath ??
    ((): string | undefined => {
      try {
        return window.localStorage.getItem(ROOT_PATH_KEY) ?? undefined;
      } catch {
        return undefined;
      }
    })();

  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0;
  const cols = computeDevColumns(
    viewport,
    sidebarCollapsed ? SIDEBAR_COLLAPSED : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar,
    treeOpen ? panels.tree : 0,
    editorOpen ? panels.editor : 0,
    detailsSession === undefined ? 0 : panels.details,
  );
  const colsRef = useRef(cols);
  colsRef.current = cols;
  const sidebarBase = useRef(0);
  const treeBase = useRef(0);
  const editorBase = useRef(0);
  const detailsBase = useRef(0);
  const [dragging, setDragging] = useState(false);
  const onDragEnd = useCallback(() => setDragging(false), []);

  // 树/内容列宽持久化
  useEffect(() => {
    try {
      window.localStorage.setItem(TREE_WIDTH_KEY, String(panels.tree));
    } catch {
      // localStorage 不可用时忽略
    }
  }, [panels.tree]);
  useEffect(() => {
    try {
      window.localStorage.setItem(EDITOR_WIDTH_KEY, String(panels.editor));
    } catch {
      // localStorage 不可用时忽略
    }
  }, [panels.editor]);

  return (
    <div
      ref={frameRef}
      className="dskDevFrame"
      style={{
        // 需求：工作区 → 文件夹列表 → 文件内容 → 聊天区（对话最右，details 随工具调用在右缘展开）
        gridTemplateColumns: `${cols.sidebar}px ${cols.tree}px ${cols.editor}px minmax(0, 1fr) ${cols.details}px`,
      }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-tree-collapsed={cols.tree === 0 || undefined}
      data-editor-collapsed={cols.editor === 0 || undefined}
      data-dragging={dragging || undefined}
    >
      <div className="dskDevSidebarCol">
        {renderSlot('sidebar', { collapsed: sidebarCollapsed, width: cols.sidebar })}
      </div>
      {/* 树列 0 宽保持挂载：目录展开状态在关闭后保留（对齐官方 details 列语义） */}
      <div className="dskDevTreeCol">
        <WorkbenchTree useWorkspaces={useWorkspaces} useSessions={useSessions} />
      </div>
      {/* 内容列 0 宽保挂载：标签状态（含未保存编辑）在最小化后保留，点击文件恢复 */}
      <div className="dskDevEditorCol">
        {fileState.tabs.length > 0 && <WorkbenchEditor useSessions={useSessions} />}
      </div>
      <div className="dskDevCenterCol">{renderSlot('conversation', {})}</div>
      <div className="dskDevDetailsCol">{renderSlot('details', {})}</div>
      {/* 终端面板（C5 v2）：grid-row 2 + grid-column 2/-1（sidebar 列独占全高）；0 高保挂载保会话 */}
      <TermPanel cwd={termCwd} />
      <div className="dskDevOverlayLayer" data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* 底部通用菜单栏（全宽第二 grid 行）：文件列表开关 + 预留通用操作区 */}
      <div className="dskDevBottomBar">
        <button
          type="button"
          className="dskDevBottomBarAction"
          data-active={treeOpen || undefined}
          aria-label="文件列表"
          aria-pressed={treeOpen}
          title="文件列表（文件树）"
          onClick={() => setPanelOpen(!treeOpen)}
        >
          {treeOpen ? <IconFolderOpen16 size={16} /> : <IconFolderClose16 size={16} />}
        </button>
        {/* 终端面板开关（C5 v2）：data-active 对齐 📁；无专用终端图标，用代码图标 */}
        <button
          type="button"
          className="dskDevBottomBarAction"
          data-active={termState.panelOpen || undefined}
          aria-label="终端"
          aria-pressed={termState.panelOpen}
          title="终端"
          onClick={() => toggleTermPanel(termCwd)}
        >
          <IconCodeOutline16 size={16} />
        </button>
      </div>
      {!sidebarCollapsed && (
        <FrameDragHandle
          side="sidebar"
          left={cols.sidebar}
          onStart={() => {
            sidebarBase.current = colsRef.current.sidebar;
            setDragging(true);
          }}
          onDrag={(dx) => actions.setSidebar(sidebarBase.current + dx)}
          onEnd={onDragEnd}
        />
      )}
      {cols.tree > 0 && (
        <FrameDragHandle
          side="tree"
          left={cols.sidebar + cols.tree}
          onStart={() => {
            treeBase.current = colsRef.current.tree;
            setDragging(true);
          }}
          onDrag={(dx) => actions.setTree(treeBase.current + dx)}
          onEnd={onDragEnd}
        />
      )}
      {cols.editor > 0 && (
        <FrameDragHandle
          side="editor"
          left={cols.sidebar + cols.tree + cols.editor}
          onStart={() => {
            editorBase.current = colsRef.current.editor;
            setDragging(true);
          }}
          onDrag={(dx) => actions.setEditor(editorBase.current + dx)}
          onEnd={onDragEnd}
        />
      )}
      {cols.details > 0 && (
        <FrameDragHandle
          side="details"
          left={viewport - cols.details}
          onStart={() => {
            detailsBase.current = colsRef.current.details;
            setDragging(true);
          }}
          onDrag={(dx) => actions.setDetails(detailsBase.current - dx)}
          onEnd={onDragEnd}
        />
      )}
    </div>
  );
}
