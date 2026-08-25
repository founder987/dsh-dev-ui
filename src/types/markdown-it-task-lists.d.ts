/**
 * markdown-it-task-lists 无内置类型，补充最小声明。
 * 插件形态：markdown-it 插件函数（.use(plugin, options?)）。
 */
declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';

  interface TaskListsOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }

  const plugin: (md: MarkdownIt, options?: TaskListsOptions) => void;
  export default plugin;
}
