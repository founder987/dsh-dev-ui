/**
 * host 半：终端 PTY 会话服务（C5 v2）。
 * shell 白名单硬编码（powershell/pwsh/cmd/Git Bash），cwd 经 ctx.fs resolve+stat 校验、
 * processPath 转换为子进程可用路径；输出经有界缓冲 + 长轮询 read 提供给 client。
 * PTY 工厂依赖注入：生产传 node-pty.spawn，测试传 fake（见 tests/unit/terminal.test.mjs）。
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type {
  TermCreateArgs,
  TermCreateResult,
  TermReadResult,
  TermShellInfo,
} from '../shared/rpc';

/** 终端服务错误：code 用 TERM_* UPPER_SNAKE（路由层映射 HTTP 状态码） */
export class TermError extends Error {
  public readonly code: string;

  public constructor(message: string, code: string) {
    super(message);
    this.name = 'TermError';
    this.code = code;
  }
}

/** PTY 句柄抽象（与 node-pty IPty 的所需子集结构兼容） */
export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (info: { exitCode: number }) => void): void;
}

/** PTY 工厂签名（生产 = node-pty.spawn，测试 = fake） */
export type PtyFactory = (
  file: string,
  args: string[],
  options: { cwd: string; cols: number; rows: number; env: Record<string, string> },
) => PtyHandle;

/** shell 白名单项：candidates 按优先级排列，取第一个存在的路径 */
export interface ShellSpec {
  id: string;
  title: string;
  candidates: string[];
}

/**
 * shell 白名单（仅 Windows 常见安装路径；wt 是终端模拟器应用，无法嵌入，故不在列）。
 * 安全约束：client 只能传 id，可执行路径由本表硬编码解析，不接受任意路径。
 */
export const SHELL_SPECS: ShellSpec[] = [
  {
    id: 'powershell',
    title: 'PowerShell',
    candidates: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
  },
  {
    id: 'pwsh',
    title: 'PowerShell 7',
    candidates: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
  },
  {
    id: 'cmd',
    title: '命令提示符',
    candidates: ['C:\\Windows\\System32\\cmd.exe'],
  },
  {
    id: 'bash',
    title: 'Git Bash',
    candidates: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'],
  },
];

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MIN_DIMENSION = 2;
const MAX_DIMENSION = 500;
const DEFAULT_MAX_BUFFER_CHARS = 512 * 1024;
const DEFAULT_MAX_SESSIONS = 16;
const DEFAULT_READ_HOLD_MS = 15000;

/** 尺寸钳制（防御 client 传入异常值） */
function clampDimension(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, n));
}

/** 输出缓冲块：seq 单调递增，作为长轮询 cursor */
interface BufferChunk {
  seq: number;
  data: string;
}

/** 会话内部状态 */
interface Session {
  id: string;
  shellId: string;
  title: string;
  pty: PtyHandle;
  chunks: BufferChunk[];
  nextSeq: number;
  /** 已丢弃的最大 seq（用于 dropped 标记） */
  trimmedUpTo: number;
  bufferedChars: number;
  exited: boolean;
  exitCode?: number;
  waiters: Set<() => void>;
}

/** 服务依赖（全部可注入，测试用 fake） */
export interface TerminalServiceDeps {
  fs: FileSystem;
  ptyFactory: PtyFactory;
  /** 文件存在性探测（默认 existsSync） */
  exists?: (path: string) => boolean;
  /** 输出缓冲字符上限（默认 512KB，超出丢弃最旧） */
  maxBufferChars?: number;
  /** 并发会话上限（默认 16） */
  maxSessions?: number;
}

/** 终端 PTY 会话服务：create/input/resize/read(长轮询)/kill */
export class TerminalService {
  private readonly fs: FileSystem;
  private readonly ptyFactory: PtyFactory;
  private readonly exists: (path: string) => boolean;
  private readonly maxBufferChars: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, Session>();

  public constructor(deps: TerminalServiceDeps) {
    this.fs = deps.fs;
    this.ptyFactory = deps.ptyFactory;
    this.exists = deps.exists ?? existsSync;
    this.maxBufferChars = deps.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
    this.maxSessions = deps.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /** 解析 shell 的可执行路径：取第一个存在的候选；无 → undefined */
  private resolveExecutable(spec: ShellSpec): string | undefined {
    return spec.candidates.find((candidate) => this.exists(candidate));
  }

  /** 可用 shell 列表（available=false 表示未安装，client 侧禁用该项） */
  public listShells(): TermShellInfo[] {
    return SHELL_SPECS.map((spec) => ({
      id: spec.id,
      title: spec.title,
      available: this.resolveExecutable(spec) !== undefined,
    }));
  }

  /** 创建会话：白名单校验 → cwd 校验 → spawn → 会话登记 */
  public async create(args: TermCreateArgs): Promise<TermCreateResult> {
    const spec = SHELL_SPECS.find((item) => item.id === args.shell);
    if (spec === undefined) {
      throw new TermError(`unknown shell: ${String(args.shell)}`, 'TERM_SHELL_UNKNOWN');
    }
    const executable = this.resolveExecutable(spec);
    if (executable === undefined) {
      throw new TermError(`shell not installed: ${spec.title}`, 'TERM_SHELL_UNAVAILABLE');
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new TermError(`too many sessions (max ${this.maxSessions})`, 'TERM_TOO_MANY_SESSIONS');
    }
    if (typeof args.cwd !== 'string' || args.cwd.length === 0) {
      throw new TermError('missing cwd', 'TERM_CWD_INVALID');
    }
    const target = await this.fs.resolve(args.cwd);
    const info = await this.fs.stat(target);
    if (info === undefined || info.type !== 'directory') {
      throw new TermError(`cwd is not an existing directory: ${args.cwd}`, 'TERM_CWD_INVALID');
    }
    const cols = clampDimension(args.cols, DEFAULT_COLS);
    const rows = clampDimension(args.rows, DEFAULT_ROWS);
    const pty = this.ptyFactory(executable, [], {
      cwd: this.fs.processPath(target),
      cols,
      rows,
      env: process.env as Record<string, string>,
    });
    const session: Session = {
      id: `term-${randomUUID()}`,
      shellId: spec.id,
      title: spec.title,
      pty,
      chunks: [],
      nextSeq: 0,
      trimmedUpTo: 0,
      bufferedChars: 0,
      exited: false,
      waiters: new Set(),
    };
    pty.onData((data) => this.pushData(session, data));
    pty.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode;
      this.notify(session);
    });
    this.sessions.set(session.id, session);
    return { id: session.id, title: session.title, cursor: 0 };
  }

  /** 取会话，不存在 → TERM_SESSION_NOT_FOUND */
  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new TermError(`session not found: ${id}`, 'TERM_SESSION_NOT_FOUND');
    }
    return session;
  }

  /** 键盘输入写入 PTY */
  public input(id: string, data: string): void {
    const session = this.requireSession(id);
    if (typeof data !== 'string' || data.length === 0) return;
    try {
      session.pty.write(data);
    } catch {
      // PTY 已死但 exit 事件未到时 write 会抛错，标记退出即可
      session.exited = true;
      this.notify(session);
    }
  }

  /** 调整终端尺寸（钳制后转发 PTY） */
  public resize(id: string, cols: number, rows: number): void {
    const session = this.requireSession(id);
    session.pty.resize(clampDimension(cols, DEFAULT_COLS), clampDimension(rows, DEFAULT_ROWS));
  }

  /**
   * 长轮询读取：有 cursor 之后的新数据立即返回；否则 hold 至数据到达/进程退出/超时。
   * holdMs 默认 15s（探针结论：桌面端 fetch 经 IPC 桥接，长轮询为已验证通道）。
   */
  public async read(id: string, after: number, holdMs: number = DEFAULT_READ_HOLD_MS): Promise<TermReadResult> {
    const session = this.requireSession(id);
    const deadline = Date.now() + holdMs;
    for (;;) {
      const fresh = session.chunks.filter((chunk) => chunk.seq > after);
      const last = fresh[fresh.length - 1];
      if (last !== undefined) {
        return {
          data: fresh.map((chunk) => chunk.data).join(''),
          cursor: last.seq,
          exited: session.exited,
          dropped: session.trimmedUpTo > after,
        };
      }
      if (session.exited || !this.sessions.has(id)) {
        return { data: '', cursor: after, exited: true, dropped: session.trimmedUpTo > after };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return { data: '', cursor: after, exited: false, dropped: false };
      }
      await this.waitForChange(session, remaining);
    }
  }

  /** 销毁会话：kill PTY、唤醒挂起 read（exited=true）、移出会话表 */
  public kill(id: string): void {
    const session = this.requireSession(id);
    try {
      session.pty.kill();
    } catch {
      // 已死会话 kill 抛错可忽略
    }
    session.exited = true;
    this.sessions.delete(id);
    this.notify(session);
  }

  /** 追加输出到有界缓冲，超出上限丢弃最旧块，并唤醒挂起 read */
  private pushData(session: Session, data: string): void {
    session.nextSeq += 1;
    session.chunks.push({ seq: session.nextSeq, data });
    session.bufferedChars += data.length;
    while (session.bufferedChars > this.maxBufferChars && session.chunks.length > 1) {
      const dropped = session.chunks.shift();
      if (dropped === undefined) break;
      session.bufferedChars -= dropped.data.length;
      session.trimmedUpTo = dropped.seq;
    }
    this.notify(session);
  }

  /** 等待会话变化（新数据/退出/销毁），最长 ms 毫秒 */
  private waitForChange(session: Session, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.waiters.delete(done);
        resolve();
      }, ms);
      const done = (): void => {
        clearTimeout(timer);
        session.waiters.delete(done);
        resolve();
      };
      session.waiters.add(done);
    });
  }

  /** 唤醒全部挂起 read */
  private notify(session: Session): void {
    const waiters = [...session.waiters];
    session.waiters.clear();
    for (const done of waiters) done();
  }
}
