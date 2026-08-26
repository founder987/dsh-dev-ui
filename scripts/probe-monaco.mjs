/**
 * C6-0 探针：monaco-editor ESM 打包进 client 单文件 bundle 的可行性验证。
 * 验证项：① esbuild 可打包（css 注入插件 + ttf dataurl）；② 体积；③ 无外链资源；
 * ④ basic-languages monarch 高亮（主线程，无 worker）。
 * 运行：node scripts/probe-monaco.mjs
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 探针产物输出到 lib 之外（lib 整体进 npm 包，探针产物不应发布）
const probeDir = join(root, '.probe');
mkdirSync(probeDir, { recursive: true });

// 探针入口：仅 standalone editor + 常用语言 monarch 高亮（不含语言服务，无 worker）
writeFileSync(
  join(probeDir, 'entry.js'),
  `import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
   import 'monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles.js';
   import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution';
   import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
   import 'monaco-editor/esm/vs/basic-languages/css/css.contribution';
   import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
   import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
   import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
   import 'monaco-editor/esm/vs/basic-languages/java/java.contribution';
   import 'monaco-editor/esm/vs/basic-languages/go/go.contribution';
   import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution';
   import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution';
   import 'monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution';
   import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
   import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
   import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
   import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
   import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution';
   import 'monaco-editor/esm/vs/basic-languages/ini/ini.contribution';
   import 'monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution';
   import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
   import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js';
   import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
   console.log('monaco loaded:', typeof monaco.editor.create);
  `,
);

/** css → 运行时 style 注入插件（保持单文件 bundle）；url(...) 资源（字体等）内联为 data URI */
const MIME = { '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const cssInjectPlugin = {
  name: 'css-inject',
  setup(b) {
    b.onLoad({ filter: /\.css$/ }, async (args) => {
      const dir = dirname(args.path);
      const css = readFileSync(args.path, 'utf8').replace(
        /url\((['"]?)([^'":)]+)\1\)/g,
        (match, quote, ref) => {
          const ext = '.' + String(ref).split('.').pop();
          const mime = MIME[ext];
          if (!mime) return match;
          try {
            const buf = readFileSync(join(dir, ref));
            return `url(data:${mime};base64,${buf.toString('base64')})`;
          } catch {
            return match;
          }
        },
      );
      return {
        contents: `const css=${JSON.stringify(css)};
          if (typeof document !== 'undefined') {
            const tag = document.createElement('style');
            tag.dataset.pluginCss = ${JSON.stringify(args.path.split(/[\\/]/).pop())};
            tag.textContent = css;
            document.head.appendChild(tag);
          }
          export default css;`,
        loader: 'js',
      };
    });
  },
};

await build({
  entryPoints: [join(probeDir, 'entry.js')],
  outfile: join(probeDir, 'monaco-probe.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  minify: true,
  logLevel: 'warning',
  plugins: [cssInjectPlugin],
  loader: { '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
});

const code = readFileSync(join(probeDir, 'monaco-probe.js'), 'utf8');
const kb = Math.round(code.length / 1024);
console.log(`[1] 打包成功，体积 ${kb} KB（minified）`);

const externalUrls = [...new Set(code.match(/https?:\/\/[^"'\s)]+/g) ?? [])].filter(
  (u) => !u.includes('w3.org') && !u.includes('microsoft.com') && !u.includes('github.com'),
);
console.log(`[2] 外链资源（排除注释/文档 URL）：${externalUrls.length === 0 ? '无 ✅' : externalUrls.join(', ')}`);

console.log(`[3] codicon 字体：${code.includes('data:font') ? '已 base64 内联 ✅' : '未内联 ❌'}`);
console.log(`[4] monarch 高亮：${code.includes('monarch') || code.includes('tokenizer') ? '包含 ✅' : '未知'}`);
console.log(`[5] worker 依赖：${code.includes('getWorker') ? '含 getWorker 引用（需 MonacoEnvironment stub 或主线程退化）' : '无 ✅'}`);
