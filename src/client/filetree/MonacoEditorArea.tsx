/**
 * client 半：文件内容编辑区（C6 —— monaco 内核，替换「透明 textarea 叠 shiki 层」）。
 * 薄组件：loadMonaco → createEditor；props 变化桥接 EditorHandle（echo 防护在 handle 内）；
 * 事件回调桥接 fileStore（onChange→setContent / 选区→selectedSnippet / Ctrl+S→saveFile）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createEditor, loadMonaco, type EditorHandle } from './editorHost';

interface MonacoEditorAreaProps {
  /** 活动文件路径（model 切换键） */
  path: string;
  /** store 内容（外部变更经 echo 防护同步进 model） */
  content: string;
  /** 当前打开的全部路径（回收已关闭 tab 的 model） */
  openPaths: readonly string[];
  onChange(content: string): void;
  onSelection(snippet: string): void;
  onSaveShortcut(): void;
}

/** monaco 编辑区（填满内容列剩余高度；内核未加载时容器占位） */
export function MonacoEditorArea(props: MonacoEditorAreaProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  // 回调经 ref 转发：editor 实例只创建一次，回调永远指向最新 props
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    let disposed = false;
    let handle: EditorHandle | null = null;
    loadMonaco()
      .then((monaco) => {
        if (disposed) return;
        handle = createEditor(monaco, container, {
          onChange: (content) => propsRef.current.onChange(content),
          onSelectionChange: (snippet) => propsRef.current.onSelection(snippet),
          onSaveShortcut: () => propsRef.current.onSaveShortcut(),
        });
        handleRef.current = handle;
        setReady(true);
      })
      .catch((cause: unknown) => {
        if (!disposed) setLoadError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      handle?.dispose();
      handleRef.current = null;
    };
  }, []);

  // 活动 tab / 内容 / 打开集合变化 → 桥接 handle
  useEffect(() => {
    if (!ready) return;
    handleRef.current?.setFile(props.path, props.content, props.openPaths);
    handleRef.current?.setContent(props.content);
  }, [ready, props.path, props.content, props.openPaths]);

  if (loadError !== '') {
    return <div className="dskDevMonacoError">编辑器内核加载失败：{loadError}</div>;
  }
  return <div ref={containerRef} className="dskDevMonacoWrap" />;
}
