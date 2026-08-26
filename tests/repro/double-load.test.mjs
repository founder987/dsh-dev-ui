/**
 * host 半加载回归：模拟 dsh boot 加载 lib/index.js，
 * 验证 apply 执行一次且不再有 "service has been registered" 冲突
 * （2026-08-21 修复：cordis Service 构造自动 provide 导致双重注册）。
 * 运行：node tests/repro/double-load.test.mjs
 */
import { boot } from '@deepseek-ai/dsh-app-boot';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const configPath = join(dir, 'empty-cordis.yml');
writeFileSync(configPath, '[]\n');

const libIndex = fileURLToPath(new URL('../../lib/index.js', import.meta.url));
const patches = [{ insert: [{ id: 'dsh-develop-ui', name: pathToFileURL(libIndex).href }] }];

console.log('[repro] boot with 1 insert row（host 半现在依赖 ctx.webServer，prepare 注入 stub）');
try {
  const ctx = await boot('repro', configPath, patches, (hostCtx) => {
    hostCtx.provide('webServer', {
      port: 1234,
      register: () => ({ dispose: () => {} }),
    });
  });
  console.log('[repro] boot OK（apply 执行一次，无 service 冲突）✅');
  await ctx.fiber?.dispose?.();
} catch (error) {
  console.error('[repro] BOOT FAIL:', error.message);
  console.error(error.stack?.split('\n').slice(0, 12).join('\n') ?? '');
  process.exit(1);
}
