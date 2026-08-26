/**
 * client 半：R9 当前提问浮层（C7-1）。
 * 渲染在 DevFrame 聊天列内顶部（absolute，随列宽自适应），展示当前会话最近一条
 * 用户提问；内容超 2 行时默认折叠（line-clamp）并给出「展开/收起」；新提问到达
 * 即更新并复位折叠；无提问不渲染。数据源为 askFeed 单例（官方 sessions 管线，
 * 缺失时快照恒空 → 浮层自然隐藏）。样式在 DevFrame FRAME_CSS（.dskDevAskFloat*）。
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { askFeed } from './askFeed';

export function AskFloat(): React.JSX.Element | null {
  const snap = useSyncExternalStore(askFeed.subscribe, askFeed.getSnapshot);
  const latest = snap.questions[snap.questions.length - 1];
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);

  // 新提问到达 → 复位折叠，并在折叠态下测量是否超 2 行（超出才显示「展开」）
  useEffect(() => {
    setExpanded(false);
    const el = textRef.current;
    if (el === null) return;
    const raf = requestAnimationFrame(() => {
      setOverflowing(el.scrollHeight > el.clientHeight + 1);
    });
    return () => cancelAnimationFrame(raf);
  }, [latest]);

  if (latest === undefined) return null;

  return (
    <div className="dskDevAskFloat">
      <span className="dskDevAskLabel">最近提问</span>
      <span ref={textRef} className="dskDevAskText" data-clamped={expanded ? undefined : ''}>
        {latest}
      </span>
      {overflowing && (
        <button
          type="button"
          className="dskDevAskToggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  );
}
