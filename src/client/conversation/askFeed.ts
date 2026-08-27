/**
 * client 半：聊天区增强数据管线（C7，无 React 依赖，可独立打包测试）。
 *
 *  - extractUserQuestions：会话快照 chat.nodes → 用户提问队列（升序、连续去重）。
 *    节点形状见 C7-0 探针：{ kind, visibility, data: { kind, seq, content } }，
 *    kind ∈ 'user' | 'steering'；全部访问做 typeof 守卫，结构漂移降级为空数组。
 *    注意两处运行期与类型层的差异（2026-08-26 真机实证）：
 *      1. chat.nodes 不是原生 Map——ui-conversation 的 ChatSnapshotBuilder 用
 *         MutableChatNodeStore（普通 class，仅 get/values/replace/upsert），故按
 *         values 方法鸭式判定而非 instanceof Map；
 *      2. data.content 不是 string——运行期为 ContentBlock[]（[{type:'text',text}]），
 *         需拼接 text 块（contentToText）。
 *  - createAskFeed：ctx.sessions（SessionRuntime）→ list.current → manager.sessions
 *    → Session.subscribe/getSnapshot 的订阅链；快照引用稳定（useSyncExternalStore
 *    契约）；任一环节缺失静默降级为空队列 + 一次性诊断。
 *  - recallMove：↑↓ 历史回显纯状态机（暂存草稿/遍历/恢复/越界），DOM 与 composer
 *    交互在 HistoryRecall.tsx，此处保持纯净可测。
 */

/** 提问条目：浮层滚动定位需要节点 key（DOM data-chat-flow-key 与之一致）。 */
export interface AskEntry {
  /** 会话节点 key（聊天行 DOM 的 data-chat-flow-key） */
  key: string;
  /** 提问纯文本（contentToText 拼接结果） */
  text: string;
}

/** askFeed 对外快照（引用稳定：内容不变时返回同一对象）。 */
export interface AskFeedSnapshot {
  /** 当前会话 id（无选定为 undefined） */
  sessionId?: string;
  /** 当前会话用户提问队列（时间升序、连续去重）——↑↓ 回显用 */
  questions: string[];
  /** 当前会话提问条目（seq 升序、不去重、含节点 key）——浮层滚动定位用 */
  entries: AskEntry[];
}

const EMPTY_FEED: AskFeedSnapshot = { questions: [], entries: [] };

interface ChatNodeLike {
  key?: unknown;
  kind?: unknown;
  visibility?: unknown;
  data?: unknown;
}

/**
 * user/steering 节点 data.content → 纯文本。
 * 运行期为 ContentBlock[]（[{type:'text', text}]，可含 image 等非文本块）；
 * 字符串形态保留兼容。无文本内容返回 null（该节点不计入提问队列）。
 */
function contentToText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim().length > 0 ? content : null;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    const joined = parts.join('\n');
    return joined.trim().length > 0 ? joined : null;
  }
  return null;
}

/**
 * 从会话快照 chat 提取用户提问条目（含节点 key，供浮层按滚动位置定位）。
 * @param chat 会话快照的 chat 字段（未知形状，逐项守卫）
 * @returns 提问条目数组（seq 升序、不去重）；结构不符时返回 []
 */
export function extractUserQuestionEntries(chat: unknown): AskEntry[] {
  if (chat === null || typeof chat !== 'object') return [];
  const nodes = (chat as { nodes?: unknown }).nodes;
  // 鸭式判定：原生 Map 与 MutableChatNodeStore 都有 values()；其余形状降级
  const valuesOf = (nodes as { values?: unknown } | null | undefined)?.values;
  if (typeof valuesOf !== 'function') return [];
  let iterable: Iterable<unknown>;
  try {
    iterable = (valuesOf as () => Iterable<unknown>).call(nodes);
  } catch {
    return [];
  }
  const picked: Array<{ seq: number; entry: AskEntry }> = [];
  for (const node of iterable) {
    const n = node as ChatNodeLike;
    if (n.kind !== 'user' && n.kind !== 'steering') continue;
    if (n.visibility !== undefined && n.visibility !== 'visible') continue;
    const data = n.data as { seq?: unknown; content?: unknown } | null | undefined;
    if (data === null || typeof data !== 'object') continue;
    const text = contentToText(data.content);
    if (text === null) continue;
    picked.push({
      seq: typeof data.seq === 'number' ? data.seq : 0,
      entry: { key: typeof n.key === 'string' ? n.key : '', text },
    });
  }
  picked.sort((a, b) => a.seq - b.seq);
  return picked.map((p) => p.entry);
}

/**
 * 从会话快照 chat 提取用户提问队列（↑↓ 回显用）。
 * @param chat 会话快照的 chat 字段（未知形状，逐项守卫）
 * @returns 用户提问文本数组（seq 升序、连续重复去一）；结构不符时返回 []
 */
export function extractUserQuestions(chat: unknown): string[] {
  const entries = extractUserQuestionEntries(chat);
  const out: string[] = [];
  for (const e of entries) {
    if (out[out.length - 1] !== e.text) out.push(e.text);
  }
  return out;
}

/**
 * 滚动定位纯函数：第一可见行所属提问的 key。
 * 聊天行 DOM 带 data-chat-flow-key（与节点 key 一致），按 DOM 顺序（=seq 序）。
 * @param entries 当前会话提问条目（升序）
 * @param rowKeys 滚动区内全部聊天行的 key（DOM 顺序）
 * @param firstVisible 第一可见行在 rowKeys 中的下标
 * @returns 第一可见行或其上方最近提问行的 key；上方无提问行返回 null（调用方回退）
 */
export function pickQuestionAtScroll(
  entries: readonly AskEntry[],
  rowKeys: readonly string[],
  firstVisible: number,
): string | null {
  if (entries.length === 0 || rowKeys.length === 0) return null;
  const keys = new Set(entries.map((e) => e.key));
  let hit: string | null = null;
  const end = Math.min(firstVisible, rowKeys.length - 1);
  for (let i = 0; i <= end; i++) {
    const k = rowKeys[i];
    if (k !== undefined && keys.has(k)) hit = k;
  }
  return hit;
}

interface StoreLike {
  subscribe: (fn: () => void) => () => void;
  getSnapshot: () => unknown;
}

/** SessionRuntime 最小面（官方服务，全部可选以便降级） */
export interface SessionsLike {
  list?: StoreLike;
  manager?: { sessions?: Map<string, StoreLike> };
}

export interface AskFeed {
  /** 绑定 ctx.sessions 服务（apply 时调用一次；重复调用先解绑旧链） */
  bindSessions: (sessions: SessionsLike | undefined) => void;
  /** useSyncExternalStore 订阅 */
  subscribe: (fn: () => void) => () => void;
  /** 当前快照（引用稳定） */
  getSnapshot: () => AskFeedSnapshot;
}

/**
 * 创建聊天区提问订阅管线。
 * @returns AskFeed 实例；未绑定或服务缺失时快照恒为 EMPTY_FEED
 */
export function createAskFeed(): AskFeed {
  const listeners = new Set<() => void>();
  let snapshot: AskFeedSnapshot = EMPTY_FEED;
  let disposeList: (() => void) | undefined;
  let disposeSession: (() => void) | undefined;
  let currentSession: StoreLike | undefined;
  let diagnosed = false;

  const diagnose = (msg: string): void => {
    if (diagnosed) return;
    diagnosed = true;
    console.warn(`[dsh-develop-ui] ask-feed unavailable: ${msg}`);
  };

  const publish = (sessionId: string | undefined, entries: AskEntry[]): void => {
    const sameEntries =
      entries.length === snapshot.entries.length &&
      entries.every((e, i) => e.key === snapshot.entries[i]?.key && e.text === snapshot.entries[i]?.text);
    if (snapshot.sessionId === sessionId && sameEntries) return;
    const questions: string[] = [];
    for (const e of entries) {
      if (questions[questions.length - 1] !== e.text) questions.push(e.text);
    }
    snapshot =
      sessionId === undefined && entries.length === 0 ? EMPTY_FEED : { sessionId, questions, entries };
    for (const fn of listeners) fn();
  };

  const readSession = (sessionId: string | undefined): void => {
    if (sessionId === undefined || currentSession === undefined) {
      publish(sessionId, []);
      return;
    }
    const snap = currentSession.getSnapshot() as { chat?: unknown } | null | undefined;
    publish(sessionId, extractUserQuestionEntries(snap?.chat));
  };

  const followCurrent = (sessions: SessionsLike): void => {
    const id = (sessions.list?.getSnapshot() as { current?: unknown } | undefined)
      ?.current;
    const sessionId = typeof id === 'string' ? id : undefined;
    disposeSession?.();
    disposeSession = undefined;
    currentSession = sessionId !== undefined ? sessions.manager?.sessions?.get(sessionId) : undefined;
    if (sessionId !== undefined && currentSession === undefined) {
      // current 指向尚未物化的会话（重连窗口期）：空队列但不诊断
      publish(sessionId, []);
      return;
    }
    if (currentSession !== undefined) {
      disposeSession = currentSession.subscribe(() => readSession(sessionId));
    }
    readSession(sessionId);
  };

  return {
    bindSessions(sessions) {
      disposeList?.();
      disposeSession?.();
      disposeList = undefined;
      disposeSession = undefined;
      currentSession = undefined;
      snapshot = EMPTY_FEED;
      if (sessions === undefined || sessions.list === undefined) {
        diagnose('ctx.sessions missing or list store absent');
        return;
      }
      if (sessions.manager?.sessions === undefined) diagnose('sessions.manager.sessions absent');
      disposeList = sessions.list.subscribe(() => followCurrent(sessions));
      followCurrent(sessions);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot() {
      return snapshot;
    },
  };
}

/* ---------- ↑↓ 历史回显状态机 ---------- */

/** 回显状态：active=回显中；index 指向历史队列；stash 为进入回显前暂存的草稿。 */
export interface RecallState {
  active: boolean;
  index: number;
  stash: string;
}

export const RECALL_IDLE: RecallState = { active: false, index: -1, stash: '' };

/** 模块级单例：apply 时 bindSessions；AskFloat（R9）与 HistoryRecall（R10）共用。 */
export const askFeed: AskFeed = createAskFeed();

export interface RecallResult {
  state: RecallState;
  /** 需写入 composer 的草稿；null = 不接管（放行官方默认行为） */
  draft: string | null;
}

/**
 * ↑↓ 回显转移（纯函数）。
 * @param state 当前回显状态
 * @param dir -1=↑（更早）/ 1=↓（更新）
 * @param questions 历史提问队列（升序）
 * @param draft 当前 composer 草稿（首次回显时暂存）
 * @returns 新状态与应写入的草稿；draft=null 表示本次按键不接管
 */
export function recallMove(
  state: RecallState,
  dir: -1 | 1,
  questions: readonly string[],
  draft: string,
): RecallResult {
  if (questions.length === 0) return { state, draft: null };
  if (!state.active) {
    if (dir !== -1) return { state, draft: null };
    const index = questions.length - 1;
    return { state: { active: true, index, stash: draft }, draft: questions[index] ?? null };
  }
  const next = state.index + dir;
  if (next < 0) return { state: { ...state, index: 0 }, draft: questions[0] ?? null };
  if (next >= questions.length) {
    return { state: RECALL_IDLE, draft: state.stash };
  }
  return { state: { ...state, index: next }, draft: questions[next] ?? null };
}
