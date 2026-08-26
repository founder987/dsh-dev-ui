/**
 * client 半：聊天区增强数据管线（C7，无 React 依赖，可独立打包测试）。
 *
 *  - extractUserQuestions：会话快照 chat.nodes → 用户提问队列（升序、连续去重）。
 *    节点形状见 C7-0 探针：{ kind, visibility, data: { kind, seq, content } }，
 *    kind ∈ 'user' | 'steering'；全部访问做 typeof 守卫，结构漂移降级为空数组。
 *  - createAskFeed：ctx.sessions（SessionRuntime）→ list.current → manager.sessions
 *    → Session.subscribe/getSnapshot 的订阅链；快照引用稳定（useSyncExternalStore
 *    契约）；任一环节缺失静默降级为空队列 + 一次性诊断。
 *  - recallMove：↑↓ 历史回显纯状态机（暂存草稿/遍历/恢复/越界），DOM 与 composer
 *    交互在 HistoryRecall.tsx，此处保持纯净可测。
 */

/** askFeed 对外快照（引用稳定：内容不变时返回同一对象）。 */
export interface AskFeedSnapshot {
  /** 当前会话 id（无选定为 undefined） */
  sessionId?: string;
  /** 当前会话用户提问队列（时间升序、连续去重） */
  questions: string[];
}

const EMPTY_FEED: AskFeedSnapshot = { questions: [] };

interface ChatNodeLike {
  kind?: unknown;
  visibility?: unknown;
  data?: unknown;
}

/**
 * 从会话快照 chat 提取用户提问队列。
 * @param chat 会话快照的 chat 字段（未知形状，逐项守卫）
 * @returns 用户提问文本数组（seq 升序、连续重复去一）；结构不符时返回 []
 */
export function extractUserQuestions(chat: unknown): string[] {
  if (chat === null || typeof chat !== 'object') return [];
  const nodes = (chat as { nodes?: unknown }).nodes;
  if (!(nodes instanceof Map)) return [];
  const picked: Array<{ seq: number; content: string }> = [];
  for (const node of nodes.values()) {
    const n = node as ChatNodeLike;
    if (n.kind !== 'user' && n.kind !== 'steering') continue;
    if (n.visibility !== undefined && n.visibility !== 'visible') continue;
    const data = n.data as { seq?: unknown; content?: unknown } | null | undefined;
    if (data === null || typeof data !== 'object') continue;
    if (typeof data.content !== 'string' || data.content.trim().length === 0) continue;
    picked.push({ seq: typeof data.seq === 'number' ? data.seq : 0, content: data.content });
  }
  picked.sort((a, b) => a.seq - b.seq);
  const out: string[] = [];
  for (const p of picked) {
    if (out[out.length - 1] !== p.content) out.push(p.content);
  }
  return out;
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

  const publish = (sessionId: string | undefined, questions: string[]): void => {
    const sameQuestions =
      questions.length === snapshot.questions.length &&
      questions.every((q, i) => q === snapshot.questions[i]);
    if (snapshot.sessionId === sessionId && sameQuestions) return;
    snapshot =
      sessionId === undefined && questions.length === 0 ? EMPTY_FEED : { sessionId, questions };
    for (const fn of listeners) fn();
  };

  const readSession = (sessionId: string | undefined): void => {
    if (sessionId === undefined || currentSession === undefined) {
      publish(sessionId, []);
      return;
    }
    const snap = currentSession.getSnapshot() as { chat?: unknown } | null | undefined;
    publish(sessionId, extractUserQuestions(snap?.chat));
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
