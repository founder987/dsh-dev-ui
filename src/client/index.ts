/**
 * dsh-develop-ui client 半入口（__ModuleLoader__ lazy-CJS bundle）。
 *
 * 布局提供者架构（方案 C 落地版）：官方 `ui-layout` 条目在 profile 层
 * `cordis.patch.yml` 中被禁用（`- id: ui-layout, disabled: true`），本插件
 * 接替其布局提供者角色：
 *  - 提供 `ctx.layout` 服务（LayoutController 等价面：toggleSidebar /
 *    openDetails / closeDetails），官方 ui-sidebar / ui-conversation 的
 *    面板切换调用不受影响；
 *  - 提供主题呈现（ThemePresenter 等价：body 暗色属性 + 主题 token），
 *    主题服务本身（ctx.theme）仍由官方 ui-theme 提供；
 *  - 注册 root 槽五列框架 DevFrame：sidebar(官方) | 文件树 | conversation(官方)
 *    | 文件内容 | details(官方)，同名子槽声明 + shell.overlay 照旧，官方
 *    sidebar/conversation/details 条目原位渲染，功能全保留。
 *
 * 另注册：
 *  - conversation.input.left：composer "@文件" 按钮（list 槽，additive）
 *  - conversation.input.left：C7 ↑↓ 历史回显（list 槽，additive，0 宽锚点组件）
 *  - C7 R9 当前提问浮层随 DevFrame 聊天列渲染（AskFloat）；数据源 askFeed 绑定
 *    ctx.sessions（exports.inject 含 'sessions'，服务缺失时降级为空）
 *
 * 数据经 fetch 调 host 路由 /api/dsh-develop-ui/*。
 * 变更 C3：文件列表开关按钮不再注册 sidebar.footer.action，改由 DevFrame
 * 底部通用菜单栏直接渲染（见 DevFrame.tsx dskDevBottomBar）。
 */
import { DevFrame, createDevLayoutStore, type DevLayoutActions, type DevLayoutSeat } from './shell/DevFrame';
import { ThemePresenter } from './shell/theme';
import { FileRefButton } from './conversation/FileRefButton';
import { HistoryRecall } from './conversation/HistoryRecall';
import { askFeed, type SessionsLike } from './conversation/askFeed';
import { WhitelistEntry, selectShellApproval } from './approval/WhitelistEntry';
import { installOpenPathInterceptor } from './fileopen/interceptor';
import { setPanelOpen, setReveal } from './filetree/store';
import { openFile } from './filetree/fileStore';

type ThemeSnapshot = {
  active: {
    colorScheme: string;
    tokens: Record<string, string>;
  };
};

type ClientCtx = {
  slots: {
    inject: (name: string, register: () => unknown) => () => void;
    register: (options: unknown, component: unknown) => () => void;
    /** 提供 root 级钩子（官方 ui-layout 同款：panelInfo 供 usePanelInfo 消费） */
    provideRoot: (options: {
      hooks: Record<string, { getSnapshot: () => unknown; subscribe: (listener: () => void) => () => void }>;
    }) => () => void;
    /** 订阅某槽条目变化（main 面板集合保留判定用） */
    subscribe: (name: string, listener: () => void) => () => void;
    /** 某槽当前条目（keyed 槽的 key 在 options.key） */
    entries: (name: string) => Array<{ options: { key?: string } }>;
  };
  /** cordis 内置：向 ctx 提供服务（插件间通过 inject 声明消费） */
  reflect: {
    provide: (name: string, service: unknown) => () => void;
  };
  /** 官方 ui-theme 提供的主题服务（本插件只读消费） */
  theme: {
    getTheme: () => ThemeSnapshot;
  };
  /** 官方 runtime 提供的会话运行时（C7 提问浮层/历史回显数据源；缺失时降级） */
  sessions?: SessionsLike;
  /** 官方 workspace controller 提供的工作区服务（聊天内打开文件拦截 openPath 用） */
  workspaces: {
    openPath: (path: string) => Promise<void>;
  };
  on: (event: string, handler: (snapshot: ThemeSnapshot) => void) => () => void;
  effect: (disposer: () => void, label?: string) => void;
};

/** client 半 host 路由前缀（与 src/host/index.ts 的 API_PREFIX 同源） */
const API_PREFIX = '/api/dsh-develop-ui';

/**
 * 跨插件面板动作面（复制官方 0.1.5-rc.2 LayoutController 契约：官方条目 ctx.layout 调用照常）。
 * 面板选择还带官方同款的 main 面板存在性校验与导航取消信号。
 */
class DevLayoutController {
  private panels: DevLayoutActions;
  private hasMainPanel: (id: string) => boolean;
  private navigation = new AbortController();

  constructor(panels: DevLayoutActions, hasMainPanel: (id: string) => boolean) {
    this.panels = panels;
    this.hasMainPanel = hasMainPanel;
  }

  /** 选择全局面板或回到会话面板（null） */
  selectPanel(panelId: string | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`);
    }
    this.navigation.abort();
    this.panels.selectPanel(panelId);
  }

  /** 开始一次导航：返回本次导航的取消信号（上一次导航随之取消） */
  beginNavigation(): AbortSignal {
    this.navigation.abort();
    this.navigation = new AbortController();
    return this.navigation.signal;
  }

  /** 布局提供者卸载时取消未完成的导航 */
  dispose(): void {
    this.navigation.abort();
  }

  toggleSidebar(): void {
    this.panels.toggleSidebar();
  }

  /** 右侧栏 occupant 上报呈现态：轨道 / 全屏 */
  openRightbar(track: boolean, fullscreen: boolean): void {
    this.panels.openRightbar(track, fullscreen);
  }

  /** 右侧栏 occupant 上报隐藏：无轨道、无拖拽手柄 */
  closeRightbar(): void {
    this.panels.closeRightbar();
  }
}

/**
 * client 半声明的 ctx 服务注入（bundle 静态包协议：exports.inject，参照官方
 * dsh-client-ui-workspace 的 `inject: ["slots", ...]`）。apply 访问 ctx.slots /
 * ctx.theme / ctx.on 必须先在此声明，否则报 "cannot get property ... without inject"。
 * 注意：`layout` 由本插件提供，不在此注入。
 */
export const inject = ['slots', 'theme', 'sessions', 'workspaces'];

export function apply(ctx: ClientCtx): void {
  console.log('[dsh-develop-ui] client half loaded (layout provider)');

  // 布局提供者装配：ctx.layout 服务 + root 五列框架，随本 fiber 生命周期释放
  //（镜像官方 ui-layout 的 effect 包裹模式：store 实例由本插件创建并交给注册席位）。
  ctx.effect(() => {
    // 1) store 实例（官方同款：handle.create() 单例在注册席位与 ctx.layout 间共享）
    const handle = createDevLayoutStore() as DevLayoutSeat & {
      spec: unknown;
      create: () => {
        actions: DevLayoutActions;
        getSnapshot: () => { panelInfo: { activePanelId: string | null } };
        subscribe: (listener: () => void) => () => void;
      };
    };
    const instance = handle.create();

    // 2) ctx.layout（官方 LayoutController 等价面；main 面板存在性取自 main 槽条目）
    const layout = new DevLayoutController(instance.actions, (id) =>
      ctx.slots.entries('main').some((entry) => entry.options.key === id),
    );

    // 3) panelInfo 钩子（官方 ui-layout 同款）：框架据此向 occupant 发 usePanelInfo，
    //    本框架用它选 main 槽 entryKey。
    const disposePanelInfo = ctx.slots.provideRoot({
      hooks: {
        panelInfo: {
          getSnapshot: () => instance.getSnapshot().panelInfo,
          subscribe: (listener) => instance.subscribe(listener),
        },
      },
    });

    // 4) 提供 ctx.layout 服务（官方 ui-layout 已禁用，缺了这个官方条目调用会抛错）
    const disposeService = ctx.reflect.provide('layout', layout);

    // 5) root 槽五列框架（子声明对齐官方 0.1.5-rc.2 AppFrame）
    const disposeRegistration = ctx.slots.register(
      {
        name: 'root',
        children: {
          sidebar: { kind: 'single', scope: 'root' },
          main: { kind: 'keyed', scope: 'root' },
          rightbar: { kind: 'single', scope: 'root' },
          'shell.overlay': { kind: 'list', scope: 'root' },
        },
        store: { ...handle, create: () => instance },
      },
      DevFrame,
    );

    // 6) main 槽条目保留判定（官方同款）：面板卸载后清空悬空的 activePanelId
    const retainMainPanels = (): void => {
      instance.actions.retainMainPanels(
        ctx.slots
          .entries('main')
          .flatMap((entry) => (typeof entry.options.key === 'string' ? [entry.options.key] : [])),
      );
    };
    const disposePanels = ctx.slots.subscribe('main', retainMainPanels);
    retainMainPanels();

    return () => {
      disposePanels();
      disposeRegistration();
      disposeService();
      disposePanelInfo();
      layout.dispose();
    };
  }, 'dsh-develop-ui: layout service + root registration');

  // 主题呈现（官方 ui-layout 的 ThemePresenter 等价物）
  ctx.effect(() => {
    const presenter = new ThemePresenter();
    presenter.apply(ctx.theme.getTheme());
    const off = ctx.on('theme/change', (snapshot) => presenter.apply(snapshot));
    return () => {
      off();
      presenter.dispose();
    };
  }, 'dsh-develop-ui: theme presenter');

  // 侧栏底部按钮已随 C3 移除：文件列表开关在 DevFrame 底部通用菜单栏（避免与
  // 插件市场按钮同列争位）；此处仅保留 composer "@文件" 按钮（additive）。

  // composer "@文件" 按钮（list 槽：additive，@文件 引用入口）
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      { name: 'conversation.input.left', id: 'dsh-develop-ui.file-ref' },
      FileRefButton,
    ),
  );

  // C7 聊天区增强：提问数据源绑定（R9 浮层 + R10 回显共用管线；服务缺失降级为空）
  askFeed.bindSessions(ctx.sessions);

  // R10 composer ↑↓ 历史回显（list 槽：additive，null 渲染组件挂 keydown）
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      { name: 'conversation.input.left', id: 'dsh-develop-ui.history-recall' },
      HistoryRecall,
    ),
  );

  // 聊天内打开文件：包装 workspaces.openPath（唯一调用者即聊天文件打开）——
  // 工作区内文件 → DSH 窗口打开（文件树面板 + 树中定位）；目录/工作区外/失败 → 回落系统。
  ctx.effect(() => {
    if (typeof ctx.workspaces?.openPath !== 'function') {
      console.warn('[dsh-develop-ui] workspaces service unavailable, openPath interceptor skipped');
      return () => {};
    }
    const interceptor = installOpenPathInterceptor(ctx.workspaces, {
      statPath: async (path) => {
        const res = await fetch(`${API_PREFIX}/fs/stat?path=${encodeURIComponent(path)}`);
        const data: unknown = await res.json();
        return res.ok ? (data as { type?: unknown }) : undefined;
      },
      openInDsh: async (path) => {
        setPanelOpen(true);
        await openFile(path);
        setReveal(path);
      },
      currentCwd: () => {
        const list = ctx.sessions?.list?.getSnapshot() as
          | { current?: unknown; byId?: Record<string, { cwd?: unknown }> }
          | undefined;
        const current = list?.current;
        if (typeof current !== 'string') return undefined;
        const cwd = list?.byId?.[current]?.cwd;
        return typeof cwd === 'string' ? cwd : undefined;
      },
    });
    return () => interceptor.restore();
  }, 'dsh-develop-ui: openPath interceptor');

  // 命令白名单：conversation.composer chain 条目（shell 命令审批三键 + 白名单自动放行）。
  // priority 默认 0，先于官方 ApprovalPanel（priority 1）评估：selector 命中
  // shell 命令类 approval → 本条目接管；非 shell 类 → selector 返回 null → 官方面板。
  ctx.slots.inject('conversation.composer', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer',
        id: 'dsh-develop-ui.cmd-whitelist',
        select: selectShellApproval,
      },
      WhitelistEntry,
    ),
  );
}
