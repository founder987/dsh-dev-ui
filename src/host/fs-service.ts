/**
 * host 半：文件系统操作（纯函数，基于 ctx.fs / @deepseek-ai/dsh-fs）。
 * 由 webServer 路由调用；所有操作自动继承 DSH 沙箱策略（开发规范第 6 节）。
 * 路径边界：resolve 规范化 + 大文件拦截 + 版本守卫写入。
 */
import { FsError, type FileSystem } from '@deepseek-ai/dsh-fs';
import { HIDDEN_DIR_NAMES, HIDDEN_FILE_NAMES, MAX_FILE_SIZE_BYTES, MAX_IMAGE_BYTES } from '../shared/errors';
import type {
  FsEntry,
  FsReadImageResult,
  FsStatResult,
  FsReadTextResult,
  FsWriteTextResult,
} from '../shared/rpc';

/**
 * 列出目录条目：过滤隐藏目录（.git/node_modules/.dsh）与垃圾文件（.DS_Store），
 * 保留用户可见的隐藏文件（.gitignore 等）；目录优先排序由 client 侧处理。
 */
export async function listDir(fs: FileSystem, path: string): Promise<FsEntry[]> {
  const target = await fs.resolve(path);
  const entries = await fs.listDir(target);
  return entries
    .filter((entry) => {
      if (entry.type === 'directory') return !HIDDEN_DIR_NAMES.includes(entry.name);
      return !HIDDEN_FILE_NAMES.includes(entry.name);
    })
    .map((entry) => ({
      name: entry.name,
      isDir: entry.type === 'directory',
    }));
}

/** stat：版本（写回守卫）、类型、大小 */
export async function stat(fs: FileSystem, path: string): Promise<FsStatResult> {
  const target = await fs.resolve(path);
  const info = await fs.stat(target);
  if (info === undefined) {
    throw new FsError(`file not found: ${path}`, 'FS_NOT_FOUND');
  }
  return { version: info.version, type: info.type, size: info.size ?? 0 };
}

/** 读取文本：先 stat 拦截超限文件（>1MB），返回内容与版本 */
export async function readText(fs: FileSystem, path: string): Promise<FsReadTextResult> {
  const target = await fs.resolve(path);
  const info = await fs.stat(target);
  if (info === undefined) {
    throw new FsError(`file not found: ${path}`, 'FS_NOT_FOUND');
  }
  if ((info.size ?? 0) > MAX_FILE_SIZE_BYTES) {
    throw new FsError(
      `file too large (${info.size ?? 0} bytes > ${MAX_FILE_SIZE_BYTES}); use an external editor`,
      'FS_TOO_LARGE',
    );
  }
  const content = await fs.readText(target);
  return { content, version: info.version };
}

/** 单次调用的沙箱执行策略（dsh-fs-sandbox SandboxedFileSystem.writeText 第 5 参）。 */
interface SandboxExecutionPolicyLike {
  mode: 'workspace-write';
  workspaceRoot: string;
}

/** rc.7 公开类型未暴露第 5 参；运行时 SandboxedFileSystem 支持（rc.5 起），旧运行时忽略该参后按会话策略拒绝。 */
type WriteWithPolicy = (
  target: unknown,
  content: string,
  expected: unknown,
  signal?: unknown,
  sandboxPolicy?: SandboxExecutionPolicyLike,
) => Promise<FsWriteTextResult>;

/**
 * 写入文本：版本守卫（replaceIfVersion），版本不匹配抛 FS_STALE_VERSION。
 * sandboxRoot（可选）：本次调用的 workspace-write 根（文件夹白名单）——目标在其下即放行，
 * 无需会话切「完全访问」；由 client 仅在用户已信任的目录上传递。
 */
export async function writeText(
  fs: FileSystem,
  path: string,
  content: string,
  expectedVersion: string,
  sandboxRoot?: string,
): Promise<FsWriteTextResult> {
  const target = await fs.resolve(path);
  const policy =
    typeof sandboxRoot === 'string' && sandboxRoot.length > 0
      ? { mode: 'workspace-write' as const, workspaceRoot: sandboxRoot }
      : undefined;
  const outcome = await (fs.writeText as WriteWithPolicy).call(
    fs,
    target,
    content,
    { kind: 'replaceIfVersion', version: expectedVersion as never },
    undefined,
    policy,
  );
  return { version: outcome.version };
}

/** 扩展名 → MIME（图片预览用） */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** 从文件路径推断图片 MIME（非图片返回 undefined） */
export function imageMimeOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  return MIME_BY_EXT[path.slice(dot + 1).toLowerCase()];
}

/**
 * 读取图片为 dataUrl（预览用）：readBytes 受 MAX_IMAGE_BYTES 限制（FS_TOO_LARGE）。
 */
export async function readImage(fs: FileSystem, path: string): Promise<FsReadImageResult> {
  const mime = imageMimeOf(path);
  if (mime === undefined) {
    throw new FsError(`not an image: ${path}`, 'FS_NOT_REGULAR_FILE');
  }
  const target = await fs.resolve(path);
  const bytes = await fs.readBytes(target, undefined, MAX_IMAGE_BYTES);
  const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  return { dataUrl, mime };
}
