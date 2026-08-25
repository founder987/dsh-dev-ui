/**
 * host 半：markdown 渲染（纯函数）。
 * markdown-it（default preset 含表格/删除线）+ markdown-it-task-lists（任务列表）。
 * renderMarkdownToHtml 供单元测试直接验证。
 */
import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';

/** 纯函数：markdown → HTML（html 转义关闭、链接自动识别、换行保留） */
export function renderMarkdownToHtml(source: string): string {
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true }).use(taskLists);
  return md.render(source);
}
