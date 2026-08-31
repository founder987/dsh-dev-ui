/**
 * client 半：conversation.composer chain 条目（id `dsh-develop-ui.cmd-whitelist`）。
 *
 * selector（selectShellApproval）：仅命中「shell 命令类 approval」——存在 pending
 * approval 且配对 running tool call 可提取 command（用 props.session 纯函数判定，
 * 遵守 ui-slots 的 ChainSelect 契约：decline 决策必须在 selector，组件内 render
 * null 不会回退到下一条目）。priority 0（默认）先于官方 ApprovalPanel（priority 1）
 * 评估：shell 类 → 本条目接管；非 shell 类 → selector 返回 null → 官方条目接管。
 *
 * 组件：命中白名单 → effect 自动代答 allowed-once 并渲染空（composer chain 为
 * overlay 模式，InputBar display:none 隐藏、DOM 存活；代答成功后 approval 从
 * pending 列表移除 → selector 自然落选 → InputBar 恢复）。代答失败 → 转手动面板，
 * 避免用户卡死。未命中白名单 → 渲染三键审批面板（ApprovalPanel）。
 */
import { useEffect, useMemo, useState } from 'react';
import type { ConversationSnapshot, PendingWait } from '@deepseek-ai/dsh-client-runtime/client';
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import { normalizeTokens } from './cmdWhitelist';
import { answerApproval, commandForApproval } from './extract';
import { whitelistStore } from './whitelistStore';
import { ApprovalPanel } from './ApprovalPanel';

/** 本条目组件 props：chain currency + selector 收窄的 matched + 框架标准 kit。 */
export interface WhitelistEntryProps extends ComposerChainProps {
  /** selector 返回值（shell 命令类 approval carrier） */
  matched: PendingWait<'approval'>;
  /** 会话快照选择器（框架标准 kit，官方 ApprovalPanel 同款用法） */
  useSession: <T>(selector: (snapshot: ConversationSnapshot) => T) => T;
  /** 会话词条（可选，缺失用默认文案） */
  t?: (key: string, params?: Record<string, unknown>) => string;
}

/**
 * chain 条目选择器：命中 shell 命令类 approval；其余交官方条目。
 * @param props - composer chain currency（owner props，纯函数只读它）
 * @returns approval carrier（接管）或 null（交下一条目）
 */
export function selectShellApproval(props: ComposerChainProps): PendingWait<'approval'> | null {
  const wait = props.interactions.find((interaction) => interaction.kind === 'approval');
  if (wait === undefined) return null;
  return commandForApproval(props.session, wait.payload.callId) !== undefined ? wait : null;
}

/**
 * chain 条目组件：白名单命中自动代答 + 隐藏；未命中渲染三键审批面板。
 * @param props - WhitelistEntryProps
 * @returns 空（自动放行中）或审批面板
 */
export function WhitelistEntry(props: WhitelistEntryProps): React.JSX.Element | null {
  const command = props.useSession((snapshot) => commandForApproval(snapshot, props.matched.payload.callId));
  const tokens = useMemo(() => (command === undefined ? [] : normalizeTokens(command)), [command]);
  const whitelisted = useMemo(() => tokens.length > 0 && whitelistStore.matches(tokens), [tokens]);
  const [autoFailed, setAutoFailed] = useState(false);

  // 白名单命中：自动代答；失败转手动面板（避免隐藏后卡死）
  useEffect(() => {
    if (!whitelisted || autoFailed) return;
    let cancelled = false;
    void answerApproval(props.matched, 'allowed-once').catch(() => {
      if (!cancelled) setAutoFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [whitelisted, autoFailed, props.matched]);

  if (tokens.length === 0) return null; // 防御：selector 已保证 shell 类
  if (whitelisted && !autoFailed) return null; // 自动放行中：隐藏（overlay 模式回落 InputBar）
  return <ApprovalPanel wait={props.matched} command={command ?? ''} tokens={tokens} t={props.t} />;
}
