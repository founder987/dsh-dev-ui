/**
 * dsk-develop-ui client 半入口（__ModuleLoader__ lazy-CJS bundle）。
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
 *
 * 数据经 fetch 调 host 路由 /api/dsk-develop-ui/*。
 * 变更 C3：文件列表开关按钮不再注册 sidebar.footer.action，改由 DevFrame
 * 底部通用菜单栏直接渲染（见 DevFrame.tsx dskDevBottomBar）。
 */
import { DevFrame, createDevLayoutStore } from './shell/DevFrame';
import { ThemePresenter } from './shell/theme';
import { FileRefButton } from './conversation/FileRefButton';

type ThemeSnapshot = {
  active: {
    colorScheme: string;
    tokens: Record<string, string>;
  };
};

type ClientCtx = {
  slots: {
    inject: (name: string, register: () => unknown) => () => void;
    register: (options: unknown, component: unknown) => unknown;
  };
  /** cordis 内置：向 ctx 提供服务（插件间通过 inject 声明消费） */
  reflect: {
    provide: (name: string, service: unknown) => () => void;
  };
  /** 官方 ui-theme 提供的主题服务（本插件只读消费） */
  theme: {
    getTheme: () => ThemeSnapshot;
  };
  on: (event: string, handler: (snapshot: ThemeSnapshot) => void) => () => void;
  effect: (disposer: () => void, label?: string) => void;
};

/** 跨插件面板动作面（复制官方 LayoutController 契约，官方条目照常调用）。 */
class DevLayoutController {
  private panels: unknown;
  /** 采纳 root 条目 store 的 bound actions（root 条目 inject 钩子接线）。 */
  attachPanels(actions: unknown): void {
    this.panels = actions;
  }
  toggleSidebar(): void {
    this.require().toggleSidebar();
  }
  openDetails(): void {
    this.require().openDetails();
  }
  closeDetails(): void {
    this.require().closeDetails();
  }
  private require(): { toggleSidebar: () => void; openDetails: () => void; closeDetails: () => void } {
    if (this.panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)');
    return this.panels as { toggleSidebar: () => void; openDetails: () => void; closeDetails: () => void };
  }
}

/**
 * client 半声明的 ctx 服务注入（bundle 静态包协议：exports.inject，参照官方
 * dsh-client-ui-workspace 的 `inject: ["slots", ...]`）。apply 访问 ctx.slots /
 * ctx.theme / ctx.on 必须先在此声明，否则报 "cannot get property ... without inject"。
 * 注意：`layout` 由本插件提供，不在此注入。
 */
export const inject = ['slots', 'theme'];

export function apply(ctx: ClientCtx): void {
  console.log('[dsk-develop-ui] client half loaded (layout provider)');

  // 布局提供者装配：ctx.layout 服务 + root 五列框架，随本 fiber 生命周期释放
  //（镜像官方 ui-layout 的 effect 包裹模式）。
  ctx.effect(() => {
    // 1) 提供 ctx.layout（官方 ui-layout 已禁用，缺了这个官方条目调用会抛错）
    const layout = new DevLayoutController();
    const disposeService = ctx.reflect.provide('layout', layout);

    // 2) root 槽五列框架（官方 ui-layout 禁用后，子槽声明无冲突）
    const disposeRegistration = ctx.slots.inject('root', () =>
      ctx.slots.register(
        {
          name: 'root',
          id: 'dsk-develop-ui.root',
          children: {
            sidebar: { kind: 'single', scope: 'root' },
            conversation: { kind: 'single', scope: 'session-maybe' },
            details: { kind: 'single', scope: 'session' },
            'shell.overlay': { kind: 'list', scope: 'root' },
          },
          store: createDevLayoutStore,
          inject: (actions: unknown) => {
            // 官方插件经 ctx.layout 触发的面板切换（侧栏/详情）落到本框架 store
            layout.attachPanels(actions);
            return {};
          },
        },
        DevFrame,
      ),
    );

    return () => {
      disposeRegistration();
      disposeService();
    };
  }, 'dsk-develop-ui: layout service + root registration');

  // 主题呈现（官方 ui-layout 的 ThemePresenter 等价物）
  ctx.effect(() => {
    const presenter = new ThemePresenter();
    presenter.apply(ctx.theme.getTheme());
    const off = ctx.on('theme/change', (snapshot) => presenter.apply(snapshot));
    return () => {
      off();
      presenter.dispose();
    };
  }, 'dsk-develop-ui: theme presenter');

  // 侧栏底部按钮已随 C3 移除：文件列表开关在 DevFrame 底部通用菜单栏（避免与
  // 插件市场按钮同列争位）；此处仅保留 composer "@文件" 按钮（additive）。

  // composer "@文件" 按钮（list 槽：additive，@文件 引用入口）
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      { name: 'conversation.input.left', id: 'dsk-develop-ui.file-ref' },
      FileRefButton,
    ),
  );
}
