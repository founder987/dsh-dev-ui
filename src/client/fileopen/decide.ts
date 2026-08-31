/**
 * 聊天内打开文件 · 决策纯函数（client 半，纯逻辑模块）。
 *
 * decideOpenPath 判定一次 openPath(path) 调用应走 DSH 窗口打开还是回落系统：
 * - stat 失败 / 非文件（目录等）/ 工作区外 / 无 cwd → 'system'（保守回落）；
 * - 文件且在当前会话工作区内 → 'dsh'。
 * 路径比较前规范化：反斜杠转正斜杠、去尾斜杠（Windows 下 resolveWorkspacePath
 * 产出的是绝对路径，可能带 \\ 分隔符）。
 */

/** 打开方式决策结果。 */
export type OpenPathDecision = 'dsh' | 'system';

/** host stat 路由返回的最小面（type: 'file' | 'directory' | ...）。 */
export interface StatInfoLike {
  type?: unknown;
}

/**
 * 路径规范化（比较用）：反斜杠→正斜杠、去掉尾部斜杠。
 * @param path - 绝对路径
 * @returns 规范化路径
 */
export function normalizePathForCompare(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

/**
 * 路径是否在当前工作区内（规范化后相等或位于其下）。
 * @param path - 绝对路径
 * @param cwd - 当前会话工作区（undefined = 无法判定）
 * @returns 是否工作区内
 */
export function isInsideWorkspace(path: string, cwd: string | undefined): boolean {
  if (cwd === undefined) return false;
  const normalized = normalizePathForCompare(path);
  const root = normalizePathForCompare(cwd);
  if (root.length === 0) return false;
  return normalized === root || normalized.startsWith(root + '/');
}

/**
 * 决策：该路径应走 DSH 打开还是回落系统。
 * @param info - host stat 结果（undefined = stat 失败/不可达）
 * @param path - 绝对路径
 * @param cwd - 当前会话工作区（undefined = 无法判定，回落系统）
 * @returns 'dsh'（文件 + 工作区内）或 'system'
 */
export function decideOpenPath(info: StatInfoLike | undefined, path: string, cwd: string | undefined): OpenPathDecision {
  if (info === undefined || info.type !== 'file') return 'system';
  if (!isInsideWorkspace(path, cwd)) return 'system';
  return 'dsh';
}
