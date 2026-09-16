/**
 * client 半：文件系统打开调用（C12）。
 *
 * systemOpen 经 host 路由 `POST /api/dsh-develop-ui/system/open` 执行系统打开
 * （explorer / rundll32）。**不经过 `workspaces.openPath`**——其已被「聊天内
 * 打开文件」拦截器包装为 DSH 打开，本调用需系统语义，走 host 路由天然隔离。
 * 返回结构化结果：失败时不抛错，调用方可在菜单内展示错误（用户可见）。
 */

/** 系统打开动作（与 host system-open.ts 同枚举）。 */
export type SystemOpenAction = 'reveal' | 'open' | 'choose-app';

/** 调用结果：ok=false 时 error 为可展示的错误描述；ok=true 时 command 为 host 实际执行命令。 */
export interface SystemOpenResult {
  ok: boolean;
  error?: string;
  command?: string;
}

const API = '/api/dsh-develop-ui';

/**
 * 请求系统打开。
 * @param path - 绝对路径（文件树面板行路径）
 * @param action - reveal（资源管理器定位）/ open（默认应用）/ choose-app（打开方式）
 * @returns { ok, error?, command? }——失败含可展示错误，成功含实际执行命令；不抛错
 */
export async function systemOpen(path: string, action: SystemOpenAction): Promise<SystemOpenResult> {
  try {
    const res = await fetch(`${API}/system/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, action }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[dsh-develop-ui] system open ${action} failed: HTTP ${res.status} ${body}`);
      return { ok: false, error: `HTTP ${res.status} ${body.trim().slice(0, 200)}` };
    }
    const data: unknown = await res.json().catch(() => undefined);
    const command = (data as { command?: unknown } | undefined)?.command;
    return { ok: true, command: typeof command === 'string' ? command : undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[dsh-develop-ui] system open request failed', error);
    return { ok: false, error: message };
  }
}
