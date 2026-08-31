/**
 * esbuild 双入口构建脚本（见 specs/开发规范.md 第 8 节）
 * - host 半：lib/index.js，依赖外部化（@deepseek-ai/* + npm 依赖）
 * - client 半：lib/client.js，仅闭包符号（react external），禁打包 npm 依赖
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const shared = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

// host 半：外部化运行时依赖，由 npm 安装的 node_modules 解析。
// 多入口：index.js（插件入口）+ markdown/fs-service/highlight/terminal.js（独立模块，供单元测试 import）
await build({
  ...shared,
  platform: 'node',
  entryPoints: {
    index: 'src/host/index.ts',
    markdown: 'src/host/markdown.ts',
    'fs-service': 'src/host/fs-service.ts',
    highlight: 'src/host/highlight.ts',
    terminal: 'src/host/terminal.ts',
  },
  outdir: 'lib',
  entryNames: '[name]',
  external: ['@deepseek-ai/*', 'markdown-it', 'markdown-it-task-lists', 'shiki', 'node-pty'],
});

// client 半：react 与 DSH 注入服务为 external（宿主模块表提供），
// 并包装为 DSH 要求的 __ModuleLoader__ lazy-CJS 模块格式
// （见 specs/开发规范.md 第 4 节与 docs/开发记录/M0-技术验证.md）
const clientBanner = `window.__ModuleLoader__.load({
  id: "dsh-develop-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`;
const clientFooter = `
    return module.exports;
  }
});
`;
// monaco css → 运行时 style 注入（保持单文件 bundle）；url(...) 字体/图片内联为 data URI。
// 仅拦 monaco 路径；xterm.css 仍走 .css: text 由 TermPanel 手动注入（去重键不同）。
// 探针验证见 docs/开发记录/C6-0-编辑器内核探针.md
const CSS_MIME = {
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const monacoCssInjectPlugin = {
  name: 'monaco-css-inject',
  setup(b) {
    b.onLoad({ filter: /monaco-editor[\\/].*\.css$/ }, async (args) => {
      const dir = dirname(args.path);
      const css = readFileSync(args.path, 'utf8').replace(
        /url\((['"]?)([^'":)]+)\1\)/g,
        (match, quote, ref) => {
          const ext = '.' + String(ref).split('.').pop();
          const mime = CSS_MIME[ext];
          if (mime === undefined) return match;
          try {
            const buf = readFileSync(join(dir, ref));
            return `url(data:${mime};base64,${buf.toString('base64')})`;
          } catch {
            return match;
          }
        },
      );
      const fileName = args.path.split(/[\\/]/).pop();
      return {
        contents: [
          `const css=${JSON.stringify(css)};`,
          `if (typeof document !== 'undefined') {`,
          `  const key = 'dsh-develop-ui/monaco:${fileName}';`,
          `  if (document.querySelector('style[data-plugin-css="' + key + '"]') === null) {`,
          `    const tag = document.createElement('style');`,
          `    tag.dataset.pluginCss = key;`,
          `    tag.textContent = css;`,
          `    document.head.appendChild(tag);`,
          `  }`,
          `}`,
          `export default css;`,
        ].join('\n'),
        loader: 'js',
      };
    });
  },
};

await build({
  ...shared,
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  minify: true, // monaco 内核未压缩约 10MB；压缩后全量 bundle ≈ 3MB
  loader: { '.css': 'text' }, // xterm.css 以文本内联注入（保持单文件 bundle，见 TermPanel）
  plugins: [monacoCssInjectPlugin],
  external: ['@deepseek-ai/*', 'react'],
  banner: { js: clientBanner },
  footer: { js: clientFooter },
});

// client 半纯逻辑模块：独立产物供单元测试 import（无 __ModuleLoader__ 包装，
// 不引用 react；@deepseek-ai/* 外部化，运行时由 node_modules 解析）
await build({
  ...shared,
  platform: 'browser',
  entryPoints: {
    'approval/cmd-whitelist': 'src/client/approval/cmdWhitelist.ts',
    'approval/extract': 'src/client/approval/extract.ts',
    'fileopen/decide': 'src/client/fileopen/decide.ts',
    'fileopen/interceptor': 'src/client/fileopen/interceptor.ts',
  },
  outdir: 'lib',
  outbase: 'src/client',
  entryNames: '[dir]/[name]',
  external: ['@deepseek-ai/*', 'react'],
});

console.log('[build] lib/index.js + lib/client.js 构建完成');
