/**
 * 双半共享的 RPC 契约（纯类型，禁止运行时逻辑）
 * host 半注册 @Remote 服务（typert），client 半经 ctx.remote.<ns>.<method> 调用。
 * 出入参必须 JSON 可序列化（见 specs/开发规范.md 第 5 节）。
 */

/** RPC 错误形状：code 用 UPPER_SNAKE 错误码 */
export interface RpcError {
  code: string;
  message: string;
}

/** 文件系统条目（listDir 返回项） */
export interface FsEntry {
  name: string;
  isDir: boolean;
}

/** listDir 入参/出参 */
export interface FsListDirArgs {
  path: string;
}
export interface FsListDirResult {
  entries: FsEntry[];
}

/** stat 入参/出参 */
export interface FsStatArgs {
  path: string;
}
export interface FsStatResult {
  version: string;
  type: string;
  size: number;
}

/** readText 入参/出参 */
export interface FsReadTextArgs {
  path: string;
}
export interface FsReadTextResult {
  content: string;
  /** 版本守卫：写回时须原样带回 */
  version: string;
}

/** writeText 入参（expectedVersion 为版本守卫，见 specs/开发规范.md 第 6 节） */
export interface FsWriteTextArgs {
  path: string;
  content: string;
  expectedVersion: string;
}
export interface FsWriteTextResult {
  version: string;
}

/** 图片读取出参（dataUrl 供 <img src> 直接使用） */
export interface FsReadImageResult {
  dataUrl: string;
  mime: string;
}

/** markdown 渲染入参/出参（host 半渲染，client 半 dangerouslySetInnerHTML） */
export interface MarkdownRenderArgs {
  source: string;
}
export interface MarkdownRenderResult {
  html: string;
}

/** 可用 shell 信息（/terminal/shells 返回项；available=false 表示未安装，项禁用） */
export interface TermShellInfo {
  id: string;
  title: string;
  available: boolean;
}

/** 创建终端会话入参/出参（cwd 须为已存在目录，cols/rows 缺省 80x24，服务端钳制 2..500） */
export interface TermCreateArgs {
  shell: string;
  cwd: string;
  cols?: number;
  rows?: number;
}
export interface TermCreateResult {
  id: string;
  title: string;
  cursor: number;
}

/** 终端键盘输入入参（data 为原始按键序列） */
export interface TermInputArgs {
  id: string;
  data: string;
}

/** 终端尺寸调整入参 */
export interface TermResizeArgs {
  id: string;
  cols: number;
  rows: number;
}

/**
 * 长轮询读取出参：data 为 cursor 之后的新输出（已拼接）；
 * cursor 单调递增，下次请求原样带回；dropped=true 表示缓冲溢出、中间有输出丢失。
 */
export interface TermReadResult {
  data: string;
  cursor: number;
  exited: boolean;
  dropped: boolean;
}

/** 销毁会话入参 */
export interface TermKillArgs {
  id: string;
}
