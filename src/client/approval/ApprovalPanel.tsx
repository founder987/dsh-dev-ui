/**
 * client 半：三键审批面板（拒绝 / 允许一次 / 永远允许）。
 *
 * 视觉参照官方 ApprovalPanel（strip + body + actionRow，dsw 设计令牌）；
 * 追加第三键「永远允许 ▾」：展开按当前命令 tokens 生成的粒度候选
 * （命令名 / 子命令前缀 / 整行精确，见 cmdWhitelist.buildCandidates），
 * 选中一项 → 按该粒度写入白名单 + 应答 allowed-once。命令名/子命令前缀
 * 档以警示色标注「可匹配更多命令」。
 *
 * 按钮接线（W3-2）：拒绝/允许一次不入库；永远允许按所选粒度入库 + 应答；
 * 应答中防重复点击（answered 置位）；应答失败恢复按钮可用（仿官方）。
 */
import { useState } from 'react';
import type { PendingWait } from '@deepseek-ai/dsh-client-runtime/client';
import { buildCandidates, type WhitelistCandidate } from './cmdWhitelist';
import { answerApproval } from './extract';
import { whitelistStore } from './whitelistStore';
import './approvalCss';

/** 审批面板 props。 */
export interface ApprovalPanelProps {
  /** approval carrier */
  wait: PendingWait<'approval'>;
  /** 命令全文（等宽展示） */
  command: string;
  /** 命令 normalizeTokens 结果（粒度候选生成源） */
  tokens: string[];
  /** 会话词条（可选，缺失用默认文案） */
  t?: (key: string, params?: Record<string, unknown>) => string;
}

/** 中文文案（客户端硬编码；t 缺失时兜底） */
const TEXT: Record<string, string> = {
  'dshDev.approval.waiting': '等待审批',
  'dshDev.approval.escalation': '工具 {toolName} 请求执行命令',
  'dshDev.approval.allowAlways': '永远允许',
  'dshDev.approval.allowOnce': '允许一次',
  'dshDev.approval.reject': '拒绝',
  'dshDev.approval.warnBroad': '可匹配更多命令（含任意参数）',
};

/**
 * 三键审批面板。
 * @param props - ApprovalPanelProps
 * @returns 审批面板元素
 */
export function ApprovalPanel(props: ApprovalPanelProps): React.JSX.Element {
  const { wait, command, tokens, t } = props;
  const text = (key: string, params?: Record<string, unknown>): string => {
    const template = t?.(`approval.${key}`) ?? t?.(key) ?? TEXT[key] ?? key;
    if (params === undefined) return template;
    return Object.entries(params).reduce(
      (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
      template,
    );
  };
  const [answered, setAnswered] = useState(false);
  const [candidatesOpen, setCandidatesOpen] = useState(false);

  // 防重复点击：应答中锁定全部按钮；失败恢复
  const answer = (outcome: 'allowed-once' | 'rejected'): void => {
    setAnswered(true);
    void answerApproval(wait, outcome).catch(() => {
      setAnswered(false);
    });
  };

  const alwaysAllow = (candidate: WhitelistCandidate): void => {
    setAnswered(true);
    try {
      // 按所选粒度入库（永远允许 = 白名单写入 + 应答，线上无第三种结局）
      whitelistStore.addEntry(tokens, candidate.tokenCount, candidate.exact);
    } catch {
      setAnswered(false);
      return;
    }
    void answerApproval(wait, 'allowed-once').catch(() => {
      setAnswered(false);
    });
  };

  const candidates = buildCandidates(tokens);

  return (
    <div className="dshDevApprovalRoot">
      <div className="dshDevApprovalCard">
        <div className="dshDevApprovalStrip">
          <span className="dshDevApprovalDot" />
          {text('waiting')}
        </div>
        <div className="dshDevApprovalBody">
          <div className="dshDevApprovalHeadline">{text('escalation', { toolName: wait.payload.toolName })}</div>
          {command.length > 0 && <div className="dshDevApprovalCommand">{command}</div>}
        </div>
        <div className="dshDevApprovalActionRow">
          <button
            type="button"
            className="dshDevApprovalReject"
            disabled={answered}
            onClick={() => answer('rejected')}
          >
            {text('reject')}
          </button>
          <button
            type="button"
            className="dshDevApprovalAllow"
            disabled={answered}
            onClick={() => answer('allowed-once')}
          >
            {text('allowOnce')}
          </button>
          <span className="dshDevApprovalAlways">
            <button
              type="button"
              className="dshDevApprovalAlwaysBtn"
              disabled={answered}
              onClick={() => setCandidatesOpen((open) => !open)}
              aria-expanded={candidatesOpen}
            >
              {text('allowAlways')} ▾
            </button>
            {candidatesOpen && (
              <span className="dshDevApprovalCandidates">
                {candidates.map((candidate) => (
                  <button
                    key={candidate.tokenCount}
                    type="button"
                    className="dshDevApprovalCandidate"
                    data-exact={candidate.exact || undefined}
                    disabled={answered}
                    title={candidate.exact ? undefined : text('warnBroad')}
                    onClick={() => alwaysAllow(candidate)}
                  >
                    <span className="dshDevApprovalCandidateLabel">{candidate.label}</span>
                    {!candidate.exact && <span className="dshDevApprovalCandidateTag">{text('warnBroad')}</span>}
                  </button>
                ))}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
