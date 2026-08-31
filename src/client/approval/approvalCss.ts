/**
 * client 半：审批面板样式（模块级 CSS 常量 + 一次性注入，参照 DevFrame 模式；
 * 视觉对齐官方 ApprovalPanel——dsw 设计令牌 + 亮暗色 fallback）。
 */

const APPROVAL_CSS = `
.dshDevApprovalRoot{padding:8px calc(var(--dsh-composer-side-clearance,16px) + 16px) 12px;flex-direction:column;align-items:center;display:flex}
.dshDevApprovalCard{width:100%;max-width:var(--dsh-chat-content-width,720px);border:1px solid var(--dsw-alias-state-warn-secondary,#f0c36d);background:var(--dsw-specific-input-major,#fff);box-shadow:var(--dsw-shadow-lv2,0 2px 8px rgba(0,0,0,.08));border-radius:20px;overflow:hidden;position:relative}
.dshDevApprovalStrip{background:var(--dsw-alias-state-warn-tertiary,#fdf3e0);color:var(--dsw-alias-state-warn-primary,#b8761f);align-items:center;gap:8px;padding:10px 16px;font-size:13px;line-height:18px;display:flex}
.dshDevApprovalDot{background:var(--dsw-alias-state-warn-primary,#b8761f);border-radius:50%;width:8px;height:8px;flex:none}
.dshDevApprovalBody{box-sizing:border-box;max-height:var(--dsh-composer-text-max-height,160px);flex-direction:column;gap:6px;padding:12px 16px 0;display:flex;overflow-y:auto}
.dshDevApprovalHeadline{color:var(--dsw-alias-label-primary,#262626);font-size:15px;font-weight:500;line-height:24px;word-break:break-word}
.dshDevApprovalCommand{color:var(--dsw-alias-label-tertiary,#8c8c8c);font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);word-break:break-all;font-size:13px;line-height:20px}
.dshDevApprovalActionRow{justify-content:flex-end;gap:8px;padding:14px 16px;display:flex;position:relative;flex-wrap:wrap}
.dshDevApprovalActionRow button{font-size:13px;line-height:20px;padding:5px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#d9d9d9);background:transparent;color:var(--dsw-alias-label-primary,#262626);display:inline-flex;align-items:center;gap:6px}
.dshDevApprovalActionRow button:disabled{opacity:.5;cursor:default}
.dshDevApprovalActionRow button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#6c8cff);outline-offset:1px}
.dshDevApprovalReject:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,#fff1f0);color:var(--dsw-alias-state-error-primary,#cf1322);border-color:transparent}
.dshDevApprovalAllow{background:var(--dsw-alias-state-business-primary,#6c8cff)!important;border-color:var(--dsw-alias-state-business-primary,#6c8cff)!important;color:#fff!important}
.dshDevApprovalAllow:hover:not(:disabled){background:var(--dsw-alias-state-business-primary-hover,#5b7bef)!important}
.dshDevApprovalAlways{position:relative;display:inline-flex}
.dshDevApprovalAlwaysBtn{white-space:nowrap}
.dshDevApprovalCandidates{position:absolute;bottom:calc(100% + 6px);right:0;z-index:30;min-width:300px;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,#d9d9d9);border-radius:12px;box-shadow:var(--dsw-shadow-lv2,0 4px 16px rgba(0,0,0,.12));padding:6px;display:flex;flex-direction:column;gap:2px}
.dshDevApprovalCandidate{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;padding:6px 10px;border-radius:8px;border:none;background:transparent;cursor:pointer}
.dshDevApprovalCandidate:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dshDevApprovalCandidate[data-exact] .dshDevApprovalCandidateLabel{color:var(--dsw-alias-label-primary,#262626)}
.dshDevApprovalCandidate:not([data-exact]) .dshDevApprovalCandidateLabel{color:var(--dsw-alias-state-warn-primary,#b8761f)}
.dshDevApprovalCandidateLabel{font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;line-height:18px;word-break:break-all}
.dshDevApprovalCandidateTag{color:var(--dsw-alias-state-error-primary,#cf1322);font-size:11px;line-height:16px}
.dshDevWhitelistMask{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.4)}
.dshDevWhitelistCard{width:100%;max-width:460px;background:var(--dsw-alias-bg-layer-2,#1e1f24);border:1px solid var(--dsw-alias-border-l2,#333);border-radius:12px;box-shadow:var(--dsw-shadow-lv2,0 4px 16px rgba(0,0,0,.3));display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary,#e8e8ec)}
.dshDevWhitelistHeader{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;font-size:13px;font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l1,#333)}
.dshDevWhitelistClose{border:none;background:transparent;color:var(--dsw-alias-label-tertiary,#8b8d95);font-size:15px;cursor:pointer;width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center}
.dshDevWhitelistClose:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dshDevWhitelistBody{display:flex;flex-direction:column;gap:4px;padding:10px 14px;max-height:280px;overflow-y:auto}
.dshDevWhitelistEmpty{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-tertiary,#8b8d95);padding:8px 0}
.dshDevWhitelistRow{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:8px}
.dshDevWhitelistRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dshDevWhitelistRowCmd{flex:1;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace);font-size:12px;line-height:18px;word-break:break-all;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshDevWhitelistRowTag{flex:none;font-size:11px;line-height:16px;padding:1px 6px;border-radius:6px;background:rgba(108,140,255,.14);color:var(--dsw-alias-state-business-primary,#6c8cff)}
.dshDevWhitelistRowTag[data-broad]{background:var(--dsw-alias-state-warn-tertiary,#3a3326);color:var(--dsw-alias-state-warn-primary,#f0c36d)}
.dshDevWhitelistRowDel{flex:none;border:none;background:transparent;color:var(--dsw-alias-state-error-primary,#ff6b6b);font-size:12px;cursor:pointer;padding:2px 4px;border-radius:4px}
.dshDevWhitelistRowDel:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(214,97,97,.15))}
.dshDevWhitelistAdd{display:flex;flex-direction:column;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,#333)}
.dshDevWhitelistInput{box-sizing:border-box;width:100%;background:var(--dsw-specific-input-major,#26272e);border:1px solid var(--dsw-alias-border-l1,#3a3b44);color:var(--dsw-alias-label-primary,#e8e8ec);border-radius:8px;padding:6px 10px;font-size:12px;font-family:var(--ds-font-family-code,ui-monospace,Consolas,monospace)}
.dshDevWhitelistInput:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#6c8cff)}
.dshDevWhitelistGran{display:flex;align-items:center;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary,#c9c9d1);flex-wrap:wrap}
.dshDevWhitelistGran label{display:inline-flex;align-items:center;gap:4px;cursor:pointer}
.dshDevWhitelistGranActive{color:var(--dsw-alias-state-business-primary,#6c8cff)}
.dshDevWhitelistGranNum{width:52px;background:var(--dsw-specific-input-major,#26272e);border:1px solid var(--dsw-alias-border-l1,#3a3b44);color:var(--dsw-alias-label-primary,#e8e8ec);border-radius:6px;padding:2px 4px;font-size:12px}
.dshDevWhitelistError{font-size:12px;color:var(--dsw-alias-state-error-primary,#ff6b6b)}
.dshDevWhitelistActions{display:flex;justify-content:space-between;align-items:center}
.dshDevWhitelistActions button{font-size:12px;line-height:18px;padding:4px 12px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#3a3b44);background:transparent;color:var(--dsw-alias-label-primary,#e8e8ec)}
.dshDevWhitelistActions button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dshDevWhitelistActions button:disabled{opacity:.4;cursor:default}
.dshDevWhitelistActions .dshDevWhitelistPrimary{background:#6c8cff;border-color:#6c8cff;color:#fff}
.dshDevWhitelistActions .dshDevWhitelistPrimary:hover:not(:disabled){background:#5b7bef}
`;
const APPROVAL_CSS_TAG_ID = 'dsh-develop-ui/Approval.css';
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${APPROVAL_CSS_TAG_ID}"]`) === null) {
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-develop-ui';
  tag.dataset.pluginCss = APPROVAL_CSS_TAG_ID;
  tag.textContent = APPROVAL_CSS;
  document.head.appendChild(tag);
}
