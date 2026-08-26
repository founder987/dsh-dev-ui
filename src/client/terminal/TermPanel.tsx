/**
 * client 半：终端面板组件（C5 v2 + C9 工作区隔离）。
 * 布局：DevFrame 底部行（grid-row 2，grid-column 2/-1；sidebar 列独占全高）；
 * 0 高保挂载（隐藏保会话，对齐列最小化语义）；顶部行手柄拖拽调高（120–480 + 记忆）。
 * C9：store 全量 state 按 props.cwd 投影当前工作区视图（tabs/activeId/creating/
 * createError）；cwd 变化自动切换展示，其他工作区 PTY 会话与 read 循环全保留；
 * 目标工作区无会话 → 空态（cwd 有效可 + 新建，不自动创建）。
 * tab 交互完全镜像文件内容 Tab：悬停 ✕ 右邻居激活、右键/⋯菜单四动作（锚点语义，
 * 复用 C4 .dskDevCtxMenu）、最后 tab 关闭面板自动隐藏、无 dirty 确认。
 * xterm 画布每 tab 一个实例（display:none 保活）；输入 onData → /input；
 * 输出经 termStore.onTermData（host 长轮询）写入。
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import xtermCss from '@xterm/xterm/css/xterm.css';
import {
  activateTerm,
  closeAllTerms,
  closeTerm,
  closeTermsLeft,
  closeTermsRight,
  createTerm,
  ensureShells,
  getTermState,
  getTermWorkspace,
  onTermData,
  sendInput,
  sendResize,
  setHeight,
  subscribeTerm,
  type TermTab,
} from './termStore';

/* xterm 画布必备 CSS（行高测量依赖）；打包为文本内联注入，保持 client 单文件 bundle */
const XTERM_CSS_TAG_ID = 'dsh-develop-ui/xterm.css';
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${XTERM_CSS_TAG_ID}"]`) === null) {
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-develop-ui';
  tag.dataset.pluginCss = XTERM_CSS_TAG_ID;
  tag.textContent = xtermCss;
  document.head.appendChild(tag);
}

/** 单个终端画布：xterm 实例随 tab.id 创建/销毁，隐藏时 display:none 保活 */
function TermView(props: { tab: TermTab; active: boolean; height: number }): React.JSX.Element {
  const { tab, active } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  // 右键复制/粘贴菜单（复用 dskDevCtxMenu；复制依赖 xterm 选区）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  // 实例生命周期（按 tab.id）：创建 → 接输出订阅 / 输入转发 → 初次 fit + 尺寸上报
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'var(--ds-font-family-code, ui-monospace, Consolas, monospace)',
      theme: { background: '#0d1117' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    const offOutput = onTermData(tab.id, (data) => term.write(data));
    const inputSub = term.onData((data) => sendInput(tab.id, data));
    const selSub = term.onSelectionChange(() => setHasSelection(term.getSelection().length > 0));
    return () => {
      offOutput();
      inputSub.dispose();
      selSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [tab.id]);

  // 尺寸同步：容器可见且尺寸变化时 fit + 上报（ResizeObserver 覆盖列宽/面板高变化）
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const sync = (): void => {
      const term = termRef.current;
      const fit = fitRef.current;
      if (term === null || fit === null) return;
      if (!activeRef.current || container.clientWidth === 0 || container.clientHeight === 0) return;
      try {
        fit.fit();
        sendResize(tab.id, term.cols, term.rows);
      } catch {
        // 隐藏瞬间尺寸退化时 fit 可能抛错，下次可见时再同步
      }
    };
    const observer = new ResizeObserver(() => sync());
    observer.observe(container);
    // 激活/面板高度变化 → 等 DOM 恢复可见后同步并聚焦
    const raf = requestAnimationFrame(() => {
      sync();
      if (activeRef.current) termRef.current?.focus();
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [tab.id, active, props.height]);

  // 右键菜单：点外部 / Esc 关闭（与 tab 右键菜单同模式）
  useEffect(() => {
    if (ctxMenu === null) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.dskDevCtxMenu') === null) setCtxMenu(null);
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

  /** 复制当前选区到剪贴板 */
  const copySelection = useCallback(() => {
    const selection = termRef.current?.getSelection() ?? '';
    setCtxMenu(null);
    if (selection.length > 0) {
      navigator.clipboard.writeText(selection).catch(() => {
        // 剪贴板权限被拒时静默失败
      });
    }
  }, []);

  /** 粘贴剪贴板文本到终端（多行文本逐行送入，与键盘输入同语义） */
  const pasteClipboard = useCallback(() => {
    setCtxMenu(null);
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text.length > 0) sendInput(tab.id, text);
        termRef.current?.focus();
      })
      .catch(() => {
        // 剪贴板权限被拒时静默失败
      });
  }, [tab.id]);

  return (
    <>
      <div
        ref={containerRef}
        className="dskDevTermView"
        data-active={active || undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          // 边界防溢出：菜单估计尺寸 150×90
          setCtxMenu({
            x: Math.min(e.clientX, window.innerWidth - 150),
            y: Math.min(e.clientY, window.innerHeight - 90),
          });
        }}
      />
      {ctxMenu !== null && (
        <div className="dskDevCtxMenu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button type="button" disabled={!hasSelection} onClick={copySelection}>
            复制
          </button>
          <button type="button" onClick={pasteClipboard}>
            粘贴
          </button>
        </div>
      )}
    </>
  );
}

/** 面板高度拖拽手柄（顶部行手柄；pointer capture，与 FrameDragHandle 同模式） */
function TermHeightHandle(): React.JSX.Element {
  const origin = useRef(0);
  const base = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = e.clientY;
    latest.current = e.clientY;
    base.current = getTermState().height;
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    latest.current = e.clientY;
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      // 向上拖（clientY 减小）→ 高度增加
      setHeight(base.current + (origin.current - latest.current));
    });
  }, []);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    setHeight(base.current + (origin.current - latest.current));
  }, []);

  return (
    <div
      className="dskDevTermHandle"
      aria-label="拖拽调整终端面板高度"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

/** 终端面板本体（cwd = 当前工作区路径，由 DevFrame 计算传入；C9：按 cwd 投影工作区视图，
 *  切换工作区只换展示——其他工作区的 PTY 会话与 read 循环全保留） */
export function TermPanel(props: { cwd?: string }): React.JSX.Element {
  const state = useSyncExternalStore(subscribeTerm, getTermState);
  const { panelOpen, height, shells, lastShell } = state;
  const cwd = props.cwd;
  const workspace = cwd === undefined || cwd.length === 0 ? undefined : state.workspaces[cwd];
  const tabs = workspace?.tabs ?? [];
  const activeId = workspace?.activeId ?? null;
  const creating = workspace?.creating ?? false;
  const createError = workspace?.createError ?? null;

  // shell 选择弹层（+ 按钮；向上弹出，复用 dskDevCtxMenu fixed 定位）
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPos, setPickerPos] = useState<{ left: number; bottom: number }>({ left: 0, bottom: 0 });
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.dskDevCtxMenu') === null && target?.closest('.dskDevTermPlus') === null) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  // tab 关闭菜单（右键以被点 tab 为锚；⋯以活动 tab 为锚；向上弹出防底部裁剪）
  const [closeMenu, setCloseMenu] = useState<{ id: string; left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (closeMenu === null) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('.dskDevCtxMenu') === null) setCloseMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCloseMenu(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [closeMenu]);

  /** 打开 shell 弹层（先确保探测完成） */
  const openPicker = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    void ensureShells();
    const rect = e.currentTarget.getBoundingClientRect();
    // 向上弹出：bottom 锚在按钮上缘；左缘防溢出（菜单估计宽 180）
    setPickerPos({ left: Math.min(rect.left, window.innerWidth - 180), bottom: window.innerHeight - rect.top + 4 });
    setPickerOpen((v) => !v);
  }, []);

  /** 选中 shell 创建：失败时弹层保持展开并展示错误行（交互设计 T8） */
  const pickShell = useCallback(
    (shellId: string) => {
      if (cwd === undefined || cwd.length === 0) return;
      void createTerm(shellId, cwd).then(() => {
        if (getTermWorkspace(cwd).createError === null) setPickerOpen(false);
      });
    },
    [cwd],
  );

  /** 打开关闭菜单（右键 = 被点 tab；⋯ = 活动 tab），向上弹出 */
  const openCloseMenu = useCallback((id: string, x: number, y: number) => {
    setPickerOpen(false);
    // 菜单估计尺寸 170×150；左缘防溢出，向上弹出锚在点击点上缘
    setCloseMenu({ id, left: Math.min(x, window.innerWidth - 170), bottom: window.innerHeight - y + 4 });
  }, []);

  const anchorIndex = closeMenu !== null ? tabs.findIndex((tab) => tab.id === closeMenu.id) : -1;

  return (
    <div
      className="dskDevTermPanel"
      style={{ height: panelOpen ? height : 0 }}
      data-open={panelOpen || undefined}
      aria-hidden={!panelOpen}
    >
      {panelOpen && <TermHeightHandle />}
      {/* tab 条：镜像文件内容 Tab 条（dskDevTabBar/dskDevTabs/dskDevTab） */}
      <div className="dskDevTabBar">
        <div className="dskDevTabs">
          {tabs.map((tab) => {
            const active = tab.id === activeId;
            return (
              <div
                key={tab.id}
                className="dskDevTab"
                data-active={active || undefined}
                title={tab.exited ? `${tab.title}（已退出）` : tab.title}
                onClick={() => {
                  if (cwd !== undefined) activateTerm(cwd, tab.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openCloseMenu(tab.id, e.clientX, e.clientY);
                }}
              >
                <span className="dskDevTabName">{tab.title}</span>
                {tab.exited && <span className="dskDevTabExited">已退出</span>}
                <button
                  type="button"
                  className="dskDevTabClose"
                  aria-label={`关闭 ${tab.title}`}
                  title="关闭"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (cwd !== undefined) closeTerm(cwd, tab.id);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="dskDevTabMenu dskDevTermPlus"
          aria-label="新建终端"
          title="新建终端"
          disabled={creating}
          onClick={openPicker}
        >
          +
        </button>
        <div className="dskDevTabMenuWrap">
          <button
            type="button"
            className="dskDevTabMenu"
            aria-label="标签操作"
            title="标签操作"
            disabled={activeId === null}
            onClick={(e) => {
              if (activeId === null) return;
              const rect = e.currentTarget.getBoundingClientRect();
              openCloseMenu(activeId, rect.right, rect.top);
            }}
          >
            ⋯
          </button>
        </div>
      </div>

      {/* 画布区：无 tab 时空态提示；有 tab 时逐 tab 保活渲染 */}
      <div className="dskDevTermBody">
        {tabs.length === 0 ? (
          <div className="dskDevTermEmpty">
            {cwd === undefined || cwd.length === 0 ? '未设置工作区，无法创建终端' : '点击 + 新建终端'}
          </div>
        ) : (
          tabs.map((tab) => (
            <TermView key={tab.id} tab={tab} active={tab.id === activeId} height={height} />
          ))
        )}
      </div>

      {/* shell 选择弹层（向上弹出；未设工作区提示行 + 未安装禁用 + 上次 ✓ + 失败错误行） */}
      {pickerOpen && (
        <div className="dskDevCtxMenu" style={{ left: pickerPos.left, top: 'auto', bottom: pickerPos.bottom }}>
          {(cwd === undefined || cwd.length === 0) && <div className="dskDevTermHint">未设置工作区，无法创建终端</div>}
          {createError !== null && <div className="dskDevTermError">{createError}</div>}
          {shells.length === 0 && <div className="dskDevTermHint">正在检测可用 shell…</div>}
          {shells.map((shell) => (
            <button
              key={shell.id}
              type="button"
              disabled={!shell.available || cwd === undefined || cwd.length === 0 || creating}
              onClick={() => pickShell(shell.id)}
            >
              {shell.id === lastShell ? '✓ ' : '　'}
              {shell.title}
              {!shell.available && '（未安装）'}
            </button>
          ))}
        </div>
      )}

      {/* tab 关闭菜单（锚点语义：右键 = 被点 tab，⋯ = 活动 tab；向上弹出；仅作用于当前工作区） */}
      {closeMenu !== null && cwd !== undefined && (
        <div className="dskDevCtxMenu" style={{ left: closeMenu.left, top: 'auto', bottom: closeMenu.bottom }}>
          <button
            type="button"
            onClick={() => {
              closeTerm(cwd, closeMenu.id);
              setCloseMenu(null);
            }}
          >
            关闭当前
          </button>
          <button
            type="button"
            onClick={() => {
              closeAllTerms(cwd);
              setCloseMenu(null);
            }}
          >
            关闭全部
          </button>
          <button
            type="button"
            disabled={anchorIndex <= 0}
            onClick={() => {
              closeTermsLeft(cwd, closeMenu.id);
              setCloseMenu(null);
            }}
          >
            关闭左侧全部
          </button>
          <button
            type="button"
            disabled={anchorIndex === -1 || anchorIndex === tabs.length - 1}
            onClick={() => {
              closeTermsRight(cwd, closeMenu.id);
              setCloseMenu(null);
            }}
          >
            关闭右侧全部
          </button>
        </div>
      )}
    </div>
  );
}
