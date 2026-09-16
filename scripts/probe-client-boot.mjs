/**
 * client 半启动探针：无头 Chrome + CDP，在导航前挂上调试会话，收集渲染进程
 * 控制台/异常日志并回读页面 DOM 探针值。
 *
 * 用途：验证本插件 client 半在**真宿主模块表**里能激活（2026-09-16 启动事故：
 * require 了模块表没有的包 → factory 物化失败 → ctx.layout 缺失 → 官方 UI 条目全部
 * pending → 桌面渲染进程启动失败；详见 docs/开发记录/DSH-2.0.10-启动失败修复.md）。
 *
 * 前置：已用隔离 DSH_HOME 起好 web 宿主（DSH Desktop 自带 CLI 的 --profile desktop），
 * 并拿到它打印的带 token 的 URL：
 *
 *   $env:ELECTRON_RUN_AS_NODE=1; $env:DSH_HOME=<隔离目录>
 *   & 'D:\apps\DSH Desktop\DSH Desktop.exe' --expose-internals `
 *     'D:\apps\DSH Desktop\resources\app\lib\desktop-cli.js' --profile desktop --port 3099 --no-open
 *
 * 用法：node scripts/probe-client-boot.mjs <带 token 的 URL> [等待毫秒数，默认 15000]
 *
 * 期望输出：
 *   [console.log] [dsh-develop-ui] client half loaded (layout provider)
 *   无 [exception] / 无 SlotAssemblyError；probe.devFrame === true，bodyText 为官方 UI 文案。
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const [url, waitMsArg] = process.argv.slice(2);
const waitMs = Number(waitMsArg ?? 15000);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const profileDir = mkdtempSync(join(tmpdir(), 'dsh-cdp-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${String(PORT)}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPageTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page !== undefined) return page;
    } catch {
      // Chrome is not up yet.
    }
    await sleep(250);
  }
  throw new Error('CDP page target never appeared');
}

/** Minimal RFC6455 client: enough for CDP request/response plus events. */
function connectWebSocket(wsUrl) {
  const parsed = new URL(wsUrl);
  const key = randomBytes(16).toString('base64');
  const socket = net.connect(Number(parsed.port), parsed.hostname);
  let buffer = Buffer.alloc(0);
  let handshakeDone = false;
  let fragments = [];
  let onMessage = () => {};
  let onOpen = () => {};

  const sendFrame = (payload, opcode = 0x1) => {
    const data = Buffer.from(payload);
    const mask = randomBytes(4);
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(data.length), 2);
    }
    const masked = Buffer.from(data);
    for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
    socket.write(Buffer.concat([header, mask, masked]));
  };

  const parse = () => {
    while (true) {
      if (!handshakeDone) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        buffer = buffer.subarray(end + 4);
        handshakeDone = true;
        onOpen();
        continue;
      }
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        length = Number(buffer.readBigUInt64BE(offset));
        offset += 8;
      }
      let maskKey;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      let payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4];
      }
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x9) {
        sendFrame(payload, 0xa);
        continue;
      }
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      if (opcode === 0x0) {
        fragments.push(payload);
        if (!fin) continue;
        payload = Buffer.concat(fragments);
        fragments = [];
      } else if (!fin) {
        fragments = [payload];
        continue;
      }
      onMessage(payload.toString('utf8'));
    }
  };

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    parse();
  });
  socket.on('error', (error) => console.error('ws error:', error.message));

  socket.write(
    [
      `GET ${parsed.pathname} HTTP/1.1`,
      `Host: ${parsed.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'),
  );

  return {
    send: (text) => sendFrame(text),
    setOnMessage: (handler) => {
      onMessage = handler;
    },
    setOnOpen: (handler) => {
      onOpen = handler;
    },
    close: () => socket.end(),
  };
}

const target = await waitForPageTarget();
const ws = connectWebSocket(target.webSocketDebuggerUrl);

const events = [];
const pending = new Map();
let nextId = 1;

const describe = (arg) =>
  arg.value !== undefined ? String(arg.value) : (arg.description ?? arg.preview?.description ?? arg.type);

ws.setOnMessage((text) => {
  const message = JSON.parse(text);
  if (message.id !== undefined) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled') {
    events.push(`[console.${message.params.type}] ${(message.params.args ?? []).map(describe).join(' ')}`);
  } else if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    events.push(`[exception] ${details.exception?.description ?? details.text}`);
  } else if (message.method === 'Log.entryAdded') {
    events.push(`[log.${message.params.entry.level}] ${message.params.entry.text}`);
  }
});

const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve) => ws.setOnOpen(resolve));
await send('Runtime.enable', {});
await send('Log.enable', {});
await send('Page.enable', {});
await send('Page.navigate', { url });

await sleep(waitMs);

const probeExpression = `JSON.stringify({
  url: location.href,
  devFrame: document.querySelector('.dskDevFrame') !== null,
  sidebarColChildren: document.querySelector('.dskDevSidebarCol')?.childElementCount ?? -1,
  centerColChildren: document.querySelector('.dskDevCenterCol')?.childElementCount ?? -1,
  rightbarColChildren: document.querySelector('.dskDevRightbarCol')?.childElementCount ?? -1,
  dragHandles: document.querySelectorAll('.dskDevHandle').length,
  bottomBarButtons: document.querySelectorAll('.dskDevBottomBarAction').length,
  bodyText: (document.body.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 400)
})`;

const probe = await send('Runtime.evaluate', { expression: probeExpression, returnByValue: true });

console.log('=== events ===');
for (const event of events) console.log(event);
console.log('=== probe ===');
console.log(probe?.result?.value ?? JSON.stringify(probe));

ws.close();
chrome.kill();
await sleep(300);
process.exit(0);
