/**
 * client 半：monaco 编辑器适配层（C6，替换「透明 textarea 叠 shiki 层」自制编辑器）。
 * - 动态 import monaco：2.6MB 内核首次打开文件时才初始化，不拖慢插件启动；
 * - 单 editor 实例 + 每 tab 一个 model（setModel 切换，保留各 tab undo 栈与视图状态）；
 * - 语言服务 worker 未验证可用：MonacoEnvironment dummy stub，相关特性静默退化，
 *   编辑 / monarch 高亮 / 查找替换 / 多光标 / 括号匹配均在主线程。
 * 选型结论与打包清单见 docs/开发记录/C6-0-编辑器内核探针.md。
 */
import type * as monacoNs from 'monaco-editor';

/** monaco 命名空间类型（editor.api 与顶层包同形） */
export type Monaco = typeof monacoNs;

let monacoPromise: Promise<Monaco> | null = null;

/**
 * 语言服务 worker dummy stub：monaco 内核按需 new Worker，webview 中 blob worker
 * 未验证 → 返回空 worker 让语言服务类特性静默失败（不抛错中断编辑器）。
 */
function installWorkerStub(): void {
  const w = self as unknown as { MonacoEnvironment?: monacoNs.Environment };
  if (w.MonacoEnvironment !== undefined) return;
  w.MonacoEnvironment = {
    getWorker: () => new Worker(URL.createObjectURL(new Blob([''], { type: 'text/javascript' }))),
  };
}

/** dsk-dark：vs-dark 基底 + 现有编辑器底色 #0d1117（对齐 shiki github-dark 与 xterm 主题） */
function defineTheme(monaco: Monaco): void {
  monaco.editor.defineTheme('dsk-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0d1117',
      'editor.lineHighlightBackground': '#161b22',
      'editorLineNumber.foreground': '#6e7681',
      'editorLineNumber.activeForeground': '#c9d1d9',
    },
  });
}

/**
 * 加载 monaco 内核（缓存 Promise，仅首次真正加载）。
 * 打包清单对齐探针：editor.api + codicon 字体样式 + 18 语言 monarch +
 * 查找替换 / 多光标 / 括号匹配 contrib。JSON 无 monarch（worker 版），plaintext 兜底。
 */
export function loadMonaco(): Promise<Monaco> {
  if (monacoPromise === null) {
    monacoPromise = (async () => {
      installWorkerStub();
      const monaco = await import('monaco-editor/esm/vs/editor/editor.api');
      // codicon 字体样式（查找/折叠等 widget 图标；editor.api 不会自动拉入）
      await import('monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css');
      await import('monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css');
      await Promise.all([
        import('monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'),
        import('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'),
        import('monaco-editor/esm/vs/basic-languages/css/css.contribution'),
        import('monaco-editor/esm/vs/basic-languages/html/html.contribution'),
        import('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'),
        import('monaco-editor/esm/vs/basic-languages/python/python.contribution'),
        import('monaco-editor/esm/vs/basic-languages/java/java.contribution'),
        import('monaco-editor/esm/vs/basic-languages/go/go.contribution'),
        import('monaco-editor/esm/vs/basic-languages/rust/rust.contribution'),
        import('monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution'),
        import('monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution'),
        import('monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'),
        import('monaco-editor/esm/vs/basic-languages/xml/xml.contribution'),
        import('monaco-editor/esm/vs/basic-languages/sql/sql.contribution'),
        import('monaco-editor/esm/vs/basic-languages/shell/shell.contribution'),
        import('monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution'),
        import('monaco-editor/esm/vs/basic-languages/ini/ini.contribution'),
        import('monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution'),
        import('monaco-editor/esm/vs/editor/contrib/find/browser/findController.js'),
        import('monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js'),
        import('monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js'),
      ]);
      defineTheme(monaco);
      return monaco;
    })();
  }
  return monacoPromise;
}

/** 扩展名 → monaco 语言 id（未覆盖的扩展名 plaintext 兜底） */
export function languageOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (/^dockerfile$/i.test(name)) return 'dockerfile';
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const table: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    css: 'css',
    html: 'html',
    htm: 'html',
    md: 'markdown',
    py: 'python',
    java: 'java',
    go: 'go',
    rs: 'rust',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    h: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    ps1: 'powershell',
    ini: 'ini',
  };
  return table[ext] ?? 'plaintext';
}

/** 编辑器事件回调（宿主组件桥接到 fileStore） */
export interface EditorCallbacks {
  /** 用户编辑导致的内容变化（外部 setContent 不触发） */
  onChange(content: string): void;
  /** 选区变化（'' = 无选区） */
  onSelectionChange(snippet: string): void;
  /** Ctrl+S（monaco 命令绑定；与 window keydown 双通道，saveFile 有 saving 重入防护） */
  onSaveShortcut(): void;
}

/** 编辑器句柄：宿主组件的 imperative 桥 */
export interface EditorHandle {
  /**
   * 切换到某路径的 model（不存在则以 content 创建）；保留各 tab undo 栈与视图状态。
   * @param openPaths 当前打开的路径集合，用于回收已关闭 tab 的 model
   */
  setFile(path: string, content: string, openPaths: readonly string[]): void;
  /** 外部内容变更（reload/版本回退）：不触发 onChange 回写（echo 防护） */
  setContent(content: string): void;
  focus(): void;
  dispose(): void;
}

/** 在容器中创建 monaco 编辑器实例（dsk-dark 主题，对齐现有编辑区度量） */
export function createEditor(
  monaco: Monaco,
  container: HTMLElement,
  callbacks: EditorCallbacks,
): EditorHandle {
  const editor = monaco.editor.create(container, {
    theme: 'dsk-dark',
    automaticLayout: true,
    fontSize: 13,
    fontFamily: 'var(--ds-font-family-code, ui-monospace, Consolas, monospace)',
    lineHeight: 22,
    tabSize: 4,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: 'all',
    padding: { top: 8 },
    fixedOverflowWidgets: true,
  });
  const models = new Map<string, monacoNs.editor.ITextModel>();
  const viewStates = new Map<string, monacoNs.editor.ICodeEditorViewState | null>();
  let applyingExternal = false;

  const subs = [
    editor.onDidChangeModelContent(() => {
      if (applyingExternal) return;
      const model = editor.getModel();
      if (model !== null) callbacks.onChange(model.getValue());
    }),
    editor.onDidChangeCursorSelection(() => {
      const model = editor.getModel();
      const selection = editor.getSelection();
      if (model === null || selection === null || selection.isEmpty()) {
        callbacks.onSelectionChange('');
        return;
      }
      callbacks.onSelectionChange(model.getValueInRange(selection));
    }),
  ];
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => callbacks.onSaveShortcut());

  return {
    setFile(path, content, openPaths) {
      // 回收已关闭 tab 的 model 与视图状态
      for (const [p, model] of models) {
        if (!openPaths.includes(p)) {
          model.dispose();
          models.delete(p);
          viewStates.delete(p);
        }
      }
      const current = editor.getModel();
      if (current !== null && models.get(path) !== current) {
        for (const [p, model] of models) {
          if (model === current) {
            viewStates.set(p, editor.saveViewState());
            break;
          }
        }
      }
      let model = models.get(path);
      if (model === undefined) {
        model = monaco.editor.createModel(content, languageOf(path));
        models.set(path, model);
      }
      if (editor.getModel() !== model) {
        editor.setModel(model);
        const viewState = viewStates.get(path);
        if (viewState != null) editor.restoreViewState(viewState);
      }
    },
    setContent(content) {
      const model = editor.getModel();
      if (model === null || model.getValue() === content) return;
      applyingExternal = true;
      try {
        model.setValue(content);
      } finally {
        applyingExternal = false;
      }
    },
    focus() {
      editor.focus();
    },
    dispose() {
      for (const sub of subs) sub.dispose();
      for (const model of models.values()) model.dispose();
      models.clear();
      viewStates.clear();
      editor.dispose();
    },
  };
}
