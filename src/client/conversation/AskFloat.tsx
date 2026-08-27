/**
 * client 半：R9 当前提问浮层（C7-1，v2 滚动跟随）。
 * 渲染在 DevFrame 聊天列内顶部（absolute，随列宽自适应），展示**可视区第一行所属
 * 的用户提问**：监听聊天列捕获阶段 scroll（scroll 不冒泡，捕获可及后代滚动），
 * 以浮层底边为可视区上沿，二分找第一可见聊天行（[data-chat-flow-key]，key 与会话
 * 节点一致），该行或其上方最近的提问行即为所求；第一行在所有提问之前 → 显示第一条
 * 提问；无行信息（初始/底部跟随）→ 显示最新提问。内容超 2 行默认折叠（line-clamp）
 * 并给出「展开/收起」；展示文本变化即复位折叠；无提问不渲染。数据源为 askFeed 单例
 * （官方 sessions 管线，缺失时快照恒空 → 浮层自然隐藏）。样式在 DevFrame FRAME_CSS
 * （.dskDevAskFloat*）。
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { askFeed, pickQuestionAtScroll } from './askFeed';

export function AskFloat(): React.JSX.Element | null {
  const snap = useSyncExternalStore(askFeed.subscribe, askFeed.getSnapshot);
  const entries = snap.entries;
  const latest = snap.questions[snap.questions.length - 1];
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  // null=无滚动信息（跟随最新）；{key:null}=可视区在所有提问之前（跟随第一条）
  const [scrollPick, setScrollPick] = useState<{ key: string | null } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  const textByKey = useMemo(() => new Map(entries.map((e) => [e.key, e.text])), [entries]);

  // 滚动跟随：捕获阶段监听列内 scroll + entries 变化时重算
  useEffect(() => {
    const col = rootRef.current?.parentElement;
    if (col === null || col === undefined) return;
    let raf = 0;
    const recompute = (): void => {
      const rows = col.querySelectorAll('[data-chat-flow-key]');
      if (rows.length === 0) {
        setScrollPick(null);
        return;
      }
      // 浮层覆盖滚动区顶部：以其底边为可视区上沿
      const viewportTop = rootRef.current?.getBoundingClientRect().bottom ?? 0;
      const arr = Array.from(rows);
      let lo = 0;
      let hi = arr.length - 1;
      let first = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const bottom = arr[mid]?.getBoundingClientRect().bottom ?? 0;
        if (bottom > viewportTop + 1) {
          first = mid;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      if (first === -1) {
        setScrollPick(null);
        return;
      }
      const rowKeys = arr.map((r) => r.getAttribute('data-chat-flow-key') ?? '');
      setScrollPick({ key: pickQuestionAtScroll(entries, rowKeys, first) });
    };
    const onScroll = (): void => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        recompute();
      });
    };
    recompute();
    col.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      col.removeEventListener('scroll', onScroll, { capture: true });
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [entries]);

  // 展示文本：滚动定位优先，key 不在当前条目表（切会话瞬间）回退最新
  const displayed =
    scrollPick === null
      ? latest
      : scrollPick.key === null
        ? entries[0]?.text ?? latest
        : textByKey.get(scrollPick.key) ?? latest;

  // 展示文本变化 → 复位折叠，并在折叠态下测量是否超 2 行（超出才显示「展开」）
  useEffect(() => {
    setExpanded(false);
    const el = textRef.current;
    if (el === null) return;
    const raf = requestAnimationFrame(() => {
      setOverflowing(el.scrollHeight > el.clientHeight + 1);
    });
    return () => cancelAnimationFrame(raf);
  }, [displayed]);

  if (displayed === undefined) return null;

  return (
    <div ref={rootRef} className="dskDevAskFloat">
      <span className="dskDevAskLabel">当前提问</span>
      <span ref={textRef} className="dskDevAskText" data-clamped={expanded ? undefined : ''}>
        {displayed}
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
