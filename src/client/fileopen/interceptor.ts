/**
 * 聊天内打开文件 · openPath 拦截器（client 半，纯逻辑模块）。
 *
 * installOpenPathInterceptor 以实例方法 shadow 方式包装 `workspaces.openPath`：
 * 决策命中（文件 + 工作区内）→ DSH 窗口打开；否则回落原方法（系统打开）。
 * 全 DSH 仅 conversation 聊天文件打开调用 openPath，影响面单一。
 *
 * - 防重复包装：模块级 WeakSet 记录已包装实例（重复安装返回 noop restore）；
 * - restore：恢复原方法并移除记录（插件卸载/重载不留残留）。
 * 依赖全部注入（statPath/openInDsh/currentCwd），单测可替换。
 */

import { decideOpenPath, type OpenPathDecision } from './decide';

/** openPath 服务最小面（workspaces 的 openPath 方法）。 */
export interface OpenPathService {
  openPath(path: string): Promise<void>;
}

/** 拦截器依赖（index.ts 组装真实实现，单测注入 fake）。 */
export interface OpenPathInterceptorDeps {
  /** host stat 路由调用：成功返回 { type }，失败返回 undefined */
  statPath: (path: string) => Promise<{ type?: unknown } | undefined>;
  /** DSH 窗口打开：文件树面板打开 tab + 树中定位 */
  openInDsh: (path: string) => Promise<void>;
  /** 当前会话工作区（undefined = 无法判定） */
  currentCwd: () => string | undefined;
}

/** 拦截器句柄：restore 恢复原方法。 */
export interface OpenPathInterceptor {
  restore(): void;
}

/** 已包装实例记录（防重复安装）。 */
const installed = new WeakSet<object>();

/**
 * 安装 openPath 拦截器（幂等；重复安装返回 noop restore）。
 * @param workspaces - ctx.workspaces 服务实例
 * @param deps - 依赖注入
 * @returns restore 句柄
 */
export function installOpenPathInterceptor(workspaces: OpenPathService, deps: OpenPathInterceptorDeps): OpenPathInterceptor {
  if (installed.has(workspaces)) {
    return { restore() {} };
  }
  const original = workspaces.openPath.bind(workspaces);
  const wrapped = async (path: string): Promise<void> => {
    const info = await deps.statPath(path).catch(() => undefined);
    const decision: OpenPathDecision = decideOpenPath(info, path, deps.currentCwd());
    if (decision === 'dsh') {
      await deps.openInDsh(path).catch(() => {});
      return;
    }
    return original(path);
  };
  workspaces.openPath = wrapped;
  installed.add(workspaces);
  return {
    restore() {
      if (!installed.has(workspaces)) return;
      workspaces.openPath = original;
      installed.delete(workspaces);
    },
  };
}
