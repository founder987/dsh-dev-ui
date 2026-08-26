/**
 * client 半：R10 composer ↑↓ 历史回显（C7-2）。
 * conversation.input.left 槽注册的 0 宽保挂载组件：以隐藏 span 为锚定位本实例
 * 所属 composer（[data-composer-seat]），在 document 冒泡阶段拦其 textarea 的
 * ArrowUp/ArrowDown——该时点官方 React onKeyDown（root 容器委托）已执行完毕，
 * 官方输入触发器弹层（/命令、@提及）消费过的按键 defaultPrevented=true 直接放行；
 * 未消费再按交互条件接管：
 *   ↑：草稿为空或光标在首行 → 回显上一条（首次回显暂存当前草稿）
 *   ↓：回显中 → 前进；越过最新 → 恢复暂存草稿并退出回显
 * 历史队列 = askFeed 当前会话用户提问（与 R9 同管线）；新提问到达（含发送成功）
 * 回显态自动复位。写入经 inputActions.setDraft（FileRefButton 已验证契约），
 * 光标 rAF 后置末尾（尽力而为）。setDraft 缺失时不挂监听（静默降级）。
 * 多实例（主会话 + 已寻址 subagent 各自 InputBar）经锚点 seat 归属判断隔离。
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { askFeed, recallMove, RECALL_IDLE, type RecallState } from './askFeed';

interface HistoryRecallProps {
  /** conversation.input 槽注入的输入动作（InputBar 契约的子集） */
  inputActions?: {
    setDraft?: (text: string) => void;
  };
  /** 会话输入状态选择器（读当前草稿，selector 需引用稳定） */
  useInput?: (selector: (state: unknown) => unknown) => unknown;
}

export function HistoryRecall(props: HistoryRecallProps): React.JSX.Element | null {
  const { inputActions, useInput } = props;
  const setDraft = inputActions?.setDraft;

  // 稳定 selector：uSES 契约（对齐 FileRefButton）
  const selectDraft = useCallback(
    (s: unknown) => (s as { draft?: string } | null | undefined)?.draft,
    [],
  );
  const draft = (useInput?.(selectDraft) as string | undefined) ?? '';
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const recallRef = useRef<RecallState>(RECALL_IDLE);
  const anchorRef = useRef<HTMLSpanElement>(null);

  // 新提问到达（发送成功 / 切会话）→ 回显态复位
  useEffect(
    () =>
      askFeed.subscribe(() => {
        recallRef.current = RECALL_IDLE;
      }),
    [],
  );

  useEffect(() => {
    if (typeof setDraft !== 'function') return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (e.defaultPrevented) return; // 官方弹层（/命令、@提及）已消费 → 放行
      const target = e.target;
      if (!(target instanceof HTMLTextAreaElement)) return;
      // 多实例隔离：只处理本组件锚点所属 composer 内的按键
      const seat = anchorRef.current?.closest('[data-composer-seat]');
      if (seat === null || seat === undefined || !seat.contains(target)) return;
      const current = recallRef.current;
      if (!current.active) {
        const d = draftRef.current;
        const caretFirstLine = !target.value.slice(0, target.selectionStart).includes('\n');
        if (d !== '' && !caretFirstLine) return; // 光标不在首行 → 放行默认光标移动
      }
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      const questions = askFeed.getSnapshot().questions;
      const r = recallMove(current, dir, questions, draftRef.current);
      if (r.draft === null) return;
      e.preventDefault();
      recallRef.current = r.state;
      setDraft(r.draft);
      // 光标置末尾（setDraft 后 textarea 值由官方受控更新，rAF 尽力而为）
      requestAnimationFrame(() => {
        try {
          target.selectionStart = target.selectionEnd = target.value.length;
        } catch {
          /* textarea 已卸载等场景忽略 */
        }
      });
    };
    // document 冒泡：晚于官方 React root 委托 handler，defaultPrevented 避让生效
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [setDraft]);

  // 0 宽保挂载：span 不占位，仅作 composer 归属锚点
  return <span ref={anchorRef} style={{ display: 'none' }} aria-hidden="true" />;
}
