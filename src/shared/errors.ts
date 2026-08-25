/**
 * 双半共享的业务错误码与常量（纯类型/常量，禁止运行时逻辑）
 * host 半抛错用 `{ code, message }`（UPPER_SNAKE 错误码），client 半分支处理。
 * 见 specs/开发规范.md 第 5/6 节。
 */

/** 业务错误码（与 @deepseek-ai/dsh-fs 的 FsErrorCode 对齐的常用子集 + 自定义码） */
export const ErrorCode = {
  FS_NOT_FOUND: 'FS_NOT_FOUND',
  FS_NOT_DIRECTORY: 'FS_NOT_DIRECTORY',
  FS_NOT_REGULAR_FILE: 'FS_NOT_REGULAR_FILE',
  FS_STALE_VERSION: 'FS_STALE_VERSION',
  FS_TOO_LARGE: 'FS_TOO_LARGE',
  FS_PERMISSION_DENIED: 'FS_PERMISSION_DENIED',
  FS_SANDBOX_DENIED: 'FS_SANDBOX_DENIED',
  FS_ABORTED: 'FS_ABORTED',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 读取上限：超过该字节数的文件拒绝读取（见开发规范第 6 节） */
export const MAX_FILE_SIZE_BYTES = 1024 * 1024;

/** 图片读取上限（预览用） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 文件列表默认忽略的目录名 */
export const HIDDEN_DIR_NAMES: readonly string[] = ['.git', 'node_modules', '.dsh'];

/** 文件列表默认忽略的文件名（系统垃圾文件） */
export const HIDDEN_FILE_NAMES: readonly string[] = ['.DS_Store'];
