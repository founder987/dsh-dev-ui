/**
 * host 半：代码高亮（shiki v4）。
 * createHighlighter 异步初始化（懒加载单例），codeToHtml 渲染带内联样式的 HTML。
 * detectLanguage 从文件扩展名推断 shiki lang（未知 → text）。
 */
import { createHighlighter, type Highlighter } from 'shiki';

/** 扩展名 → shiki lang 映射 */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  mdx: 'markdown',
  css: 'css',
  html: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
};

/** 从文件路径/名称推断 shiki lang */
export function detectLanguage(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'text';
  const ext = filename.slice(dot + 1).toLowerCase();
  return LANG_BY_EXT[ext] ?? 'text';
}

let highlighterPromise: Promise<Highlighter> | null = null;

/** 懒加载单例 highlighter（shiki v4 异步初始化） */
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: ['github-dark'],
    langs: [
      'typescript', 'tsx', 'javascript', 'jsx', 'json', 'markdown', 'css',
      'html', 'yaml', 'bash', 'python', 'rust', 'go', 'java', 'text',
    ],
  });
  return highlighterPromise;
}

/** 渲染代码为高亮 HTML（shiki github-dark 主题，内联样式） */
export async function highlightCode(source: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter();
  return highlighter.codeToHtml(source, { lang, theme: 'github-dark' });
}

/** 按文件名推断 lang 并渲染 */
export async function highlightFile(source: string, filename: string): Promise<string> {
  return highlightCode(source, detectLanguage(filename));
}
