/**
 * dsh-develop-ui host 半入口。
 * 经 ctx.webServer 注册 HTTP 路由（/api/dsh-develop-ui/*），client 半 fetch 调用
 * （参照 dsh-community-market 的第三方插件模式）。
 * 所有路由带本机端口校验（isLocalRequest），写操作为 POST + 版本守卫。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'; // 激活 ctx.webServer 类型注入
import { spawn as ptySpawn } from 'node-pty';
import * as fsOps from './fs-service';
import { renderMarkdownToHtml } from './markdown';
import { highlightCode, highlightFile } from './highlight';
import { TerminalService, type PtyFactory } from './terminal';
import { isLocalRequest, readJson, sendJson } from './http-util';

const API_PREFIX = '/api/dsh-develop-ui';

type Req = Parameters<Parameters<Context['webServer']['register']>[0]['handler']>[0];
type Res = Parameters<Parameters<Context['webServer']['register']>[0]['handler']>[1];

/** 提取查询参数（?path=...） */
function queryParam(req: Req, name: string): string | undefined {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get(name) ?? undefined;
}

/** 统一错误响应：{ error, code } */
function sendError(res: Res, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'internal';
  const status =
    code === 'FS_NOT_FOUND' || code === 'TERM_SESSION_NOT_FOUND'
      ? 404
      : code === 'FS_STALE_VERSION'
        ? 409
        : code === 'FS_TOO_LARGE'
          ? 413
          : 400;
  sendJson(res, status, { error: message, code });
}

export function apply(ctx: Context): void {
  console.log('[dsh-develop-ui] host half loaded');

  const webServer = ctx.webServer;
  const expectedPort = webServer.port;

  // 列目录：GET /api/dsh-develop-ui/fs/list-dir?path=<绝对路径>
  webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/fs/list-dir`,
    handler: async (req, res) => {
      if (!isLocalRequest(req, expectedPort)) {
        sendJson(res, 403, { error: 'request authority rejected' });
        return;
      }
      const path = queryParam(req, 'path');
      if (path === undefined || path.length === 0) {
        sendJson(res, 400, { error: 'missing path', code: 'invalid-request' });
        return;
      }
      try {
        sendJson(res, 200, { entries: await fsOps.listDir(ctx.fs, path) });
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  // 路径状态：GET /api/dsh-develop-ui/fs/stat?path=<绝对路径>（聊天内打开文件判定：文件/目录/工作区）
  webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/fs/stat`,
    handler: async (req, res) => {
      if (!isLocalRequest(req, expectedPort)) {
        sendJson(res, 403, { error: 'request authority rejected' });
        return;
      }
      const path = queryParam(req, 'path');
      if (path === undefined || path.length === 0) {
        sendJson(res, 400, { error: 'missing path', code: 'invalid-request' });
        return;
      }
      try {
        sendJson(res, 200, await fsOps.stat(ctx.fs, path));
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  // 读取文件：GET /api/dsh-develop-ui/fs/read-text?path=<绝对路径>
  webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/fs/read-text`,
    handler: async (req, res) => {
      if (!isLocalRequest(req, expectedPort)) {
        sendJson(res, 403, { error: 'request authority rejected' });
        return;
      }
      const path = queryParam(req, 'path');
      if (path === undefined || path.length === 0) {
        sendJson(res, 400, { error: 'missing path', code: 'invalid-request' });
        return;
      }
      try {
        sendJson(res, 200, await fsOps.readText(ctx.fs, path));
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  // 读取图片：GET /api/dsh-develop-ui/fs/read-image?path=<绝对路径>
  webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/fs/read-image`,
    handler: async (req, res) => {
      if (!isLocalRequest(req, expectedPort)) {
        sendJson(res, 403, { error: 'request authority rejected' });
        return;
      }
      const path = queryParam(req, 'path');
      if (path === undefined || path.length === 0) {
        sendJson(res, 400, { error: 'missing path', code: 'invalid-request' });
        return;
      }
      try {
        sendJson(res, 200, await fsOps.readImage(ctx.fs, path));
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  // 写入文件：POST /api/dsh-develop-ui/fs/write-text { path, content, expectedVersion }
  webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/fs/write-text`,
    handler: async (req, res) => {
      if (req.method !== 'POST' || !isLocalRequest(req, expectedPort)) {
        sendJson(res, 405, { error: 'write requires a local same-origin POST', code: 'method-not-allowed' });
        return;
      }
      try {
        const body = (await readJson(req)) as { path?: unknown; content?: unknown; expectedVersion?: unknown; sandboxRoot?: unknown };
        if (typeof body.path !== 'string' || typeof body.content !== 'string' || typeof body.expectedVersion !== 'string') {
          sendJson(res, 400, { error: 'invalid body: need path/content/expectedVersion', code: 'invalid-request' });
          return;
        }
        // sandboxRoot：文件夹白名单（用户信任的目录），作为本次调用的 workspace-write 根
        const sandboxRoot = typeof body.sandboxRoot === 'string' && body.sandboxRoot.length > 0 ? body.sandboxRoot : undefined;
        sendJson(res, 200, await fsOps.writeText(ctx.fs, body.path, body.content, body.expectedVersion, sandboxRoot));
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  // md 渲染：POST /api/dsh-develop-ui/md/render { source }
  webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/md/render`,
    handler: async (req, res) => {
      if (req.method !== 'POST' || !isLocalRequest(req, expectedPort)) {
        sendJson(res, 405, { error: 'render requires a local same-origin POST', code: 'method-not-allowed' });
        return;
      }
      try {
        const body = (await readJson(req)) as { source?: unknown };
        if (typeof body.source !== 'string') {
          sendJson(res, 400, { error: 'invalid body: need source', code: 'invalid-request' });
          return;
        }
        sendJson(res, 200, { html: renderMarkdownToHtml(body.source) });
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  // 代码高亮：POST /api/dsh-develop-ui/highlight { source, filename, lang? }
  // lang 可选（直接指定时优先）；缺省按 filename 扩展名推断
  webServer.register({
    kind: 'exact',
    path: `${API_PREFIX}/highlight`,
    handler: async (req, res) => {
      if (req.method !== 'POST' || !isLocalRequest(req, expectedPort)) {
        sendJson(res, 405, { error: 'highlight requires a local same-origin POST', code: 'method-not-allowed' });
        return;
      }
      try {
        const body = (await readJson(req)) as { source?: unknown; filename?: unknown; lang?: unknown };
        if (typeof body.source !== 'string' || typeof body.filename !== 'string') {
          sendJson(res, 400, { error: 'invalid body: need source/filename', code: 'invalid-request' });
          return;
        }
        const html =
          typeof body.lang === 'string' && body.lang.length > 0
            ? await highlightCode(body.source, body.lang)
            : await highlightFile(body.source, body.filename);
        sendJson(res, 200, { html });
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  // ── 终端（C5 v2）：node-pty 会话 + 长轮询输出通道，见 docs/开发记录/C5-0-终端探针.md ──
  const termService = new TerminalService({
    fs: ctx.fs,
    ptyFactory: ((file, args, options) =>
      ptySpawn(file, args, { ...options, name: 'xterm-256color', useConpty: true })) as PtyFactory,
  });
  const TERM = `${API_PREFIX}/terminal`;

  // 可用 shell 探测：GET /terminal/shells
  webServer.register({
    kind: 'exact',
    path: `${TERM}/shells`,
    handler: async (req, res) => {
      if (!isLocalRequest(req, expectedPort)) {
        sendJson(res, 403, { error: 'request authority rejected' });
        return;
      }
      sendJson(res, 200, { shells: termService.listShells() });
    },
  });

  // 创建会话：POST /terminal/create { shell, cwd, cols?, rows? }
  webServer.register({
    kind: 'exact',
    path: `${TERM}/create`,
    handler: async (req, res) => {
      if (req.method !== 'POST' || !isLocalRequest(req, expectedPort)) {
        sendJson(res, 405, { error: 'create requires a local same-origin POST', code: 'method-not-allowed' });
        return;
      }
      try {
        const body = (await readJson(req)) as { shell?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown };
        if (typeof body.shell !== 'string' || typeof body.cwd !== 'string') {
          sendJson(res, 400, { error: 'invalid body: need shell/cwd', code: 'TERM_INVALID_REQUEST' });
          return;
        }
        const cols = typeof body.cols === 'number' ? body.cols : undefined;
        const rows = typeof body.rows === 'number' ? body.rows : undefined;
        sendJson(res, 200, await termService.create({ shell: body.shell, cwd: body.cwd, cols, rows }));
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  // 键盘输入：POST /terminal/input { id, data }
  webServer.register({
    kind: 'exact',
    path: `${TERM}/input`,
    handler: async (req, res) => {
      if (req.method !== 'POST' || !isLocalRequest(req, expectedPort)) {
        sendJson(res, 405, { error: 'input requires a local same-origin POST', code: 'method-not-allowed' });
        return;
      }
      try {
        const body = (await readJson(req)) as { id?: unknown; data?: unknown };
        if (typeof body.id !== 'string' || typeof body.data !== 'string') {
          sendJson(res, 400, { error: 'invalid body: need id/data', code: 'TERM_INVALID_REQUEST' });
          return;
        }
        termService.input(body.id, body.data);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  // 尺寸调整：POST /terminal/resize { id, cols, rows }
  webServer.register({
    kind: 'exact',
    path: `${TERM}/resize`,
    handler: async (req, res) => {
      if (req.method !== 'POST' || !isLocalRequest(req, expectedPort)) {
        sendJson(res, 405, { error: 'resize requires a local same-origin POST', code: 'method-not-allowed' });
        return;
      }
      try {
        const body = (await readJson(req)) as { id?: unknown; cols?: unknown; rows?: unknown };
        if (typeof body.id !== 'string' || typeof body.cols !== 'number' || typeof body.rows !== 'number') {
          sendJson(res, 400, { error: 'invalid body: need id/cols/rows', code: 'TERM_INVALID_REQUEST' });
          return;
        }
        termService.resize(body.id, body.cols, body.rows);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  // 长轮询输出：GET /terminal/read?id=<会话>&after=<cursor>（hold ≤15s，见 C5-0 探针）
  webServer.register({
    kind: 'exact',
    path: `${TERM}/read`,
    handler: async (req, res) => {
      if (!isLocalRequest(req, expectedPort)) {
        sendJson(res, 403, { error: 'request authority rejected' });
        return;
      }
      const id = queryParam(req, 'id');
      const afterRaw = queryParam(req, 'after');
      const after = afterRaw === undefined ? Number.NaN : Number(afterRaw);
      if (id === undefined || id.length === 0 || !Number.isFinite(after) || after < 0) {
        sendJson(res, 400, { error: 'missing id/after', code: 'TERM_INVALID_REQUEST' });
        return;
      }
      try {
        sendJson(res, 200, await termService.read(id, Math.floor(after)));
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  // 销毁会话：POST /terminal/kill { id }
  webServer.register({
    kind: 'exact',
    path: `${TERM}/kill`,
    handler: async (req, res) => {
      if (req.method !== 'POST' || !isLocalRequest(req, expectedPort)) {
        sendJson(res, 405, { error: 'kill requires a local same-origin POST', code: 'method-not-allowed' });
        return;
      }
      try {
        const body = (await readJson(req)) as { id?: unknown };
        if (typeof body.id !== 'string') {
          sendJson(res, 400, { error: 'invalid body: need id', code: 'TERM_INVALID_REQUEST' });
          return;
        }
        termService.kill(body.id);
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendError(res, error);
      }
    },
  });

  console.log(`[dsh-develop-ui] routes mounted at ${API_PREFIX}/*`);
}
