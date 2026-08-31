/**
 * 审批命令提取与应答封装（client 半，纯逻辑模块）。
 *
 * - commandOf：官方 `skeleton/ApprovalPanel` 等价实现（官方未从包入口导出，
 *   语义照抄 client.js——bash 族 tool 的 argsRaw JSON 中含 command 字段）。
 * - rootToolCall / commandForApproval：按 approval.callId 经会话 snapshot
 *   查配对 running tool call（照抄官方 conversationContextKey 查 tool-call 节点）。
 * - answerApproval：PendingApproval.answer 的等价编码（照抄 client.js：
 *   wait.respond({ ok: true, value: { sessionId, approvalId, outcome } })）。
 */
import type { ChatConversationViewNode, ConversationSnapshot, PendingWait, RunningToolCall } from '@deepseek-ai/dsh-client-runtime/client';

/**
 * 会话上下文 key 构造（官方 `conversationContextKey(kind, id)` 等价实现：
 * `${kind.length}:${kind}${id}`，见 runtime client.js；官方函数未随包导出，
 * 且 runtime client 为 __ModuleLoader__ 包装产物无法在 node 单测中 import，
 * 故自实现——格式稳定，用于 snapshot.chat.nodes.get 的 key）。
 * @param kind - 节点种类（如 'tool-call'）
 * @param id - 节点身份
 * @returns 节点 key
 */
export function contextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`;
}

/**
 * 从配对 tool call 提取 shell 命令；取不到返回 undefined（调用方隐藏命令行）。
 * @param call - 配对 running tool call（可能未就绪）
 * @returns bash 族 tool 的 args.command；args 非 JSON / 无 command 字段 → undefined
 */
export function commandOf(call: RunningToolCall | undefined): string | undefined {
  if (call === undefined) return undefined;
  try {
    const args: unknown = JSON.parse(call.argsRaw);
    const command = (args as { command?: unknown }).command;
    return typeof command === 'string' ? command : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 查 root tool call（官方 rootToolCall 等价）：snapshot 的 chat 节点库中按
 * conversationContextKey 定位 tool-call 节点并取其 data.root。
 * @param snapshot - 会话快照
 * @param rootCallId - root call 身份
 * @returns 运行中的 root call（节点缺失/类型不符 → undefined）
 */
export function rootToolCall(snapshot: ConversationSnapshot, rootCallId: string): RunningToolCall | undefined {
  const node = snapshot.chat.nodes.get(contextKey('tool-call', rootCallId));
  if (node === undefined || node.kind !== 'tool-call') return undefined;
  const root = (node.data as { root?: unknown }).root;
  return typeof root === 'object' && root !== null ? (root as RunningToolCall) : undefined;
}

/**
 * 组合提取：approval 的 callId → root call（仅运行中的 call，无 kind 字段）
 * → commandOf。selector 与面板共用此函数判定「shell 命令类」。
 * @param snapshot - 会话快照（selector 场景传 props.session，可能 undefined）
 * @param callId - approval 配对的 callId（可能 undefined）
 * @returns shell 命令文本；无法判定 → undefined
 */
export function commandForApproval(snapshot: ConversationSnapshot | undefined, callId: string | undefined): string | undefined {
  if (snapshot === undefined || callId === undefined) return undefined;
  const root = rootToolCall(snapshot, callId);
  if (root === undefined || root.callId !== callId || 'kind' in root) return undefined;
  return commandOf(root);
}

/**
 * 应答 pending approval（官方 PendingApproval.answer 等价编码）。
 * @param wait - approval carrier（runtime PendingWait）
 * @param outcome - 客户端仅有的两种结局
 * @returns 应答被 host 拒绝时抛错
 */
export async function answerApproval(wait: PendingWait<'approval'>, outcome: 'allowed-once' | 'rejected'): Promise<void> {
  const receipt = await wait.respond({
    ok: true,
    value: {
      sessionId: wait.sessionId,
      approvalId: wait.payload.approvalId,
      outcome,
    },
  });
  if (!receipt.accepted) throw new Error(`approval response rejected: ${String(receipt.reason ?? 'unknown')}`);
}

/** 导出类型复用（避免组件侧重复声明 node/data 形状）。 */
export type { ChatConversationViewNode };
