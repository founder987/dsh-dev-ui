/**
 * host 半：系统打开命令解析与派生进程启动（C12 文件系统打开）。
 *
 * - resolveSystemOpenCommand：按路径类型与动作映射为 Windows 系统命令
 *   （explorer / rundll32），非法组合返回 null；MVP 仅支持 Windows
 *   （DSH Desktop 目标平台；macOS/Linux 留后续）。
 * - spawnDetached：无 shell 派生进程（路径作独立参数防注入），detached +
 *   unref 不阻塞 host；'spawn' 事件确认启动成功，'error' 事件失败。
 */

import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 系统打开动作。 */
export type SystemOpenAction = 'reveal' | 'open' | 'choose-app';

/** 解析结果：可执行文件 + 参数（无 shell）。 */
export interface SystemOpenCommand {
  file: string;
  args: string[];
}

/** 派生结果（诊断用）。 */
export interface SpawnOutcome {
  ok: boolean;
  detail: string;
}

/** 诊断日志（无需控制台，用户可回传）：os.tmpdir()/dsh-develop-ui-system-open.log */
export function logSystemOpen(entry: string): void {
  try {
    appendFileSync(join(tmpdir(), 'dsh-develop-ui-system-open.log'), `${new Date().toISOString()} ${entry}\n`);
  } catch {
    // 日志写入失败不影响主流程
  }
}

/**
 * 动作 → 系统命令映射（Windows 语义）。
 * - reveal：在资源管理器打开/定位——文件 `explorer /select,<path>`（选中），目录 `explorer <path>`；
 * - open：系统默认应用打开——`explorer <path>`（文件=默认应用，无默认应用时 Windows 弹「选择应用」；目录=资源管理器）；
 * - choose-app：强制打开方式对话框——`rundll32 shell32.dll,OpenAs_RunDLL <path>`（仅文件）。
 * @param type - 路径类型（host stat 结果）
 * @param action - 用户动作
 * @param path - 绝对路径
 * @returns 派生命令；非法组合（如 choose-app 作用于目录）或非 Windows → null
 */
export function resolveSystemOpenCommand(
  type: 'file' | 'directory',
  action: SystemOpenAction,
  path: string,
): SystemOpenCommand | null {
  if (process.platform !== 'win32') return null;
  if (action === 'reveal' && type === 'file') {
    return { file: 'explorer.exe', args: [`/select,${path}`] };
  }
  if (action === 'reveal' || action === 'open') {
    return { file: 'explorer.exe', args: [path] };
  }
  if (action === 'choose-app' && type === 'file') {
    return { file: 'rundll32.exe', args: ['shell32.dll,OpenAs_RunDLL', path] };
  }
  return null;
}

/**
 * 无 shell 派生进程（立即返回结果；启动失败记录日志）。
 * explorer/rundll32 为 GUI 启动器，spawn 调用即返回；不等待 'spawn' 事件
 * （该事件仅 Node 15+ 提供，旧运行时永不触发会挂起路由）。
 * @param file - 可执行文件
 * @param args - 独立参数（不拼接命令字符串，防注入）
 * @returns 派生结果（error 事件 = ok:false + 错误详情；否则 ok:true + pid）
 */
export function spawnDetached(file: string, args: string[]): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (error) => {
      const code = 'code' in error ? String((error as { code?: unknown }).code) : 'error';
      const detail = `${code}: ${String(error.message ?? error)}`;
      console.warn(`[dsh-develop-ui] system open spawn failed: ${file} ${detail}`);
      resolve({ ok: false, detail });
    });
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true, detail: `pid=${String(child.pid)}` });
    });
    // 兜底：旧 Node（无 'spawn' 事件）直接视为启动成功
    setTimeout(() => {
      resolve({ ok: true, detail: 'pid=unknown (no spawn event)' });
    }, 500).unref?.();
  });
}
