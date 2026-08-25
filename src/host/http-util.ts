/**
 * host 半：HTTP 工具函数（webServer 路由用）。
 * 参照 dsh-community-market 的 host/routes.js 模式（sendJson/readJson/本机校验）。
 */

/** 发送 JSON 响应（Node res） */
export function sendJson(
  res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (b: string) => void },
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(body);
}

/** 读取 JSON 请求体 */
export function readJson(req: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'));
        (req as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * 本机请求校验：请求必须来自 DSH web 服务自身端口（防跨站调用）。
 * 参照 market 的 requestAllowed 语义（HTTP 时代仍保留 host 校验）。
 */
export function isLocalRequest(req: { headers: Record<string, string | string[] | undefined> }, expectedPort: number): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.length === 0) return false;
  const port = Number(host.split(':').pop());
  return Number.isFinite(port) && port === expectedPort;
}
