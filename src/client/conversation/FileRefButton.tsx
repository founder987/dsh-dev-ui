/**
 * client 半：composer "@文件" 按钮（conversation.input.left list 槽，additive）。
 * 点击进入"待选文件"模式并打开文件树面板；用户在面板选文件后点"引用"，
 * 经 inputActions.setDraft 把文件引用文本注入 composer 草稿（agent 可感知）。
 * 参照 InputBar 的 inputActions 契约（setDraft(text) 全量替换草稿）。
 * 稳定性：useInput selector 用 useCallback 固定引用（uSES 契约）；注册只依赖
 * setDraft 引用（不随 draft 反复注销）；setDraft 缺失时按钮显示不可用诊断。
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { setPanelOpen, setPendingRef, setInsertRefFn } from '../filetree/store';

interface FileRefButtonProps {
  /** conversation.input 槽注入的输入动作（InputBar 契约的子集） */
  inputActions?: {
    setDraft?: (text: string) => void;
  };
  /** 会话输入状态选择器（读当前草稿，selector 需引用稳定） */
  useInput?: (selector: (state: unknown) => unknown) => unknown;
}

export function FileRefButton(props: FileRefButtonProps): React.JSX.Element | null {
  const { inputActions, useInput } = props;
  const setDraft = inputActions?.setDraft;
  const available = typeof setDraft === 'function';

  // 稳定 selector：uSES（SnapshotSelectorHook）要求 selector 引用稳定
  const selectDraft = useCallback(
    (s: unknown) => (s as { draft?: string } | null | undefined)?.draft,
    [],
  );
  const draft = (useInput?.(selectDraft) as string | undefined) ?? '';
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // 注册 composer 引用注入回调（只依赖 setDraft 引用，避免随 draft 反复注销）
  useEffect(() => {
    if (typeof setDraft !== 'function') return;
    setInsertRefFn((ref) => {
      const base = draftRef.current.trim();
      const lines =
        ref.snippet !== undefined
          ? `片段：${ref.snippet}\n文件：${ref.name}（${ref.path}）`
          : `文件：${ref.name}（${ref.path}）`;
      setDraft(base.length > 0 ? `${base}\n${lines} ` : `${lines} `);
    });
    return () => setInsertRefFn(null);
  }, [setDraft]);

  return (
    <button
      type="button"
      aria-label="在对话中引用文件"
      title={available ? '@文件（在对话中引用工作区文件）' : '引用不可用：composer 输入未就绪'}
      onClick={() => {
        if (!available) return;
        setPendingRef(true);
        setPanelOpen(true);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 7px',
        fontSize: 12,
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: 4,
        cursor: available ? 'pointer' : 'not-allowed',
        color: 'inherit',
        opacity: available ? 0.85 : 0.4,
      }}
    >
      @文件
    </button>
  );
}
