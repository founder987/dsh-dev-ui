/**
 * client 半：五列让渡求解纯函数（变更 C8 从 DevFrame.tsx 抽出，便于单测）。
 *
 * chat 展开（chatOpen=true）：先压 details（至 min → 派生关闭），再压 editor/tree
 * 至各自下限，center 兜底 CENTER_MIN；
 * chat 收起（chatOpen=false）：center 0 宽保挂载，editor 弹性吸收全部剩余
 * （渲染宽 = viewport − sidebar − tree − details，下限 EDITOR_MIN；不足时先压
 * details → 0，再压 tree 至 TREE_MIN，最后 editor 兜底可低于 EDITOR_MIN）。
 * editor 已关闭（输入 0）时不做弹性吸收，余量留给 grid 的 1fr center 轨
 * （内容列最小化优先，中间留空）。
 *
 * 注：`details` 入参自 2026-09-16 起是官方 rightbar 的**轨道宽**
 * （track=0 时 occupant 自锚右缘悬浮，见 DevFrame 的 solveRightbarNormal）。
 */

/** 列宽契约（sidebar 对齐官方 columns.ts；树/内容/中心约束见 devColumns.ts） */
export const CENTER_MIN = 640;
export const DETAILS_MIN = 300;
export const DETAILS_MAX = 520;
export const DETAILS_DEFAULT = 360;
export const TREE_MIN = 240;
export const TREE_MAX = 480;
export const TREE_DEFAULT = 360;
export const EDITOR_MIN = 480;
export const EDITOR_MAX = 1200;

/** 五列渲染宽（px；center 为逻辑宽，grid 中由 minmax(0,1fr) 轨实现） */
export interface DevColumns {
  sidebar: number;
  tree: number;
  center: number;
  editor: number;
  details: number;
}

/**
 * 求解五列渲染宽。
 * @param viewport 框架可用总宽
 * @param sidebar 侧栏宽（折叠时传 56 rail 宽）
 * @param tree 树列宽（最小化传 0）
 * @param editor 内容列宽（最小化传 0；chat 收起时为弹性吸收的基准输入）
 * @param details 详情列宽（无会话传 0）
 * @param chatOpen 聊天区是否展开（false = center 0 宽保挂载，editor 弹性吸收）
 * @returns 各列渲染宽
 */
export function computeDevColumns(
  viewport: number,
  sidebar: number,
  tree: number,
  editor: number,
  details: number,
  chatOpen: boolean,
): DevColumns {
  if (!chatOpen) {
    if (editor <= 0) return { sidebar, tree, center: 0, editor: 0, details };
    let d = details;
    let t = tree;
    const editorFor = (): number => viewport - sidebar - t - d;
    if (editorFor() < EDITOR_MIN && d > 0) {
      d = Math.max(DETAILS_MIN, d - (EDITOR_MIN - editorFor()));
      if (editorFor() < EDITOR_MIN) d = 0;
    }
    if (editorFor() < EDITOR_MIN && t > 0) {
      t = Math.max(TREE_MIN, t - (EDITOR_MIN - editorFor()));
    }
    return { sidebar, tree: t, center: 0, editor: editorFor(), details: d };
  }
  let d = details;
  let e = editor;
  let t = tree;
  const room = (): number => viewport - sidebar - t - e - d;
  if (room() < CENTER_MIN && d > 0) {
    d = Math.max(DETAILS_MIN, d - (CENTER_MIN - room()));
    if (room() < CENTER_MIN) d = 0;
  }
  if (room() < CENTER_MIN && e > 0) {
    e = Math.max(EDITOR_MIN, e - (CENTER_MIN - room()));
  }
  if (room() < CENTER_MIN && t > 0) {
    t = Math.max(TREE_MIN, t - (CENTER_MIN - room()));
  }
  return { sidebar, tree: t, center: room(), editor: e, details: d };
}
