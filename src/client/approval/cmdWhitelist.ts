/**
 * 命令白名单 store（client 半，纯逻辑模块）。
 *
 * 分层：
 * - 纯函数层：normalizeTokens / matchCommand / buildCandidates / load / save
 *   （不触碰任何平台 API，node 与浏览器均可直接 import 测试）；
 * - store 层：createWhitelistStore 返回轻量订阅 store（参照 fileStore/termStore
 *   的 getSnapshot/subscribe 模式），持久化依赖注入的 storage——浏览器传
 *   localStorage，单测传 fake storage。
 *
 * 匹配语义（技术方案 §3.3）：统一前缀 token 匹配，粒度由 tokenCount 决定——
 * 目标命令 normalize 后前 N 个 token 与条目逐 token 相等即命中；
 * token 边界对齐（`mvn` 不命中 `mvnx`，`mvn clean package` 不命中
 * `mvn clean install`）。exact 条目（整行精确）额外要求目标 token 数与条目
 * 相同（不命中带多余参数的命令变体）。大小写敏感（Windows cmd 内建命令
 * 不区分大小写的问题 MVP 不处理，见需求文档）。
 */

export const WHITELIST_STORAGE_KEY = 'dsh-develop-ui.cmdWhitelist';

/** 一条白名单规则：tokens 恒等于规范化后前 tokenCount 个 token。 */
export interface WhitelistEntry {
  /** randomUUID */
  id: string;
  /** normalize 后保留的前 N 个 token（N = tokenCount） */
  tokens: string[];
  /** 粒度：1 = 命令名；2..总数-1 = 子命令前缀；= 全部 = 整行精确（配 exact） */
  tokenCount: number;
  /** 整行精确：目标 token 数必须与 tokenCount 相同（不命中带多余参数的命令） */
  exact: boolean;
  /** 创建时间戳（ms） */
  createdAt: number;
}

/** 最小存储面：浏览器 localStorage 与单测 fake storage 的共同接口。 */
export interface WhitelistStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 「永远允许」粒度候选：token 数 + 对应前缀文本 + 是否整行精确。 */
export interface WhitelistCandidate {
  tokenCount: number;
  /** 前 tokenCount 个 token 的文本（空格连接） */
  label: string;
  /** 整行精确（tokenCount = 全部 token）：目标命令多一个 token 即不命中 */
  exact: boolean;
}

/** 命令规范化：trim + 空白折叠为单空格 → 按空白切 token。 */
export function normalizeTokens(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * 前缀 token 匹配：目标 token 序列前 entry.tokenCount 个与条目逐 token 相等。
 * 整行精确（exact）条目额外要求目标 token 总数与条目相同。
 * @param entry - 白名单条目
 * @param targetTokens - 目标命令 normalizeTokens 的结果
 * @returns 是否命中
 */
export function matchCommand(entry: WhitelistEntry, targetTokens: string[]): boolean {
  if (entry.tokenCount <= 0 || targetTokens.length < entry.tokenCount) return false;
  if (entry.exact && targetTokens.length !== entry.tokenCount) return false;
  for (let i = 0; i < entry.tokenCount; i += 1) {
    if (entry.tokens[i] !== targetTokens[i]) return false;
  }
  return true;
}

/**
 * 按 token 数生成全部粒度候选（1..N）；末档（整行）标记 exact。
 * @param tokens - 命令 normalizeTokens 的结果
 * @returns 候选列表（空命令返回空数组）
 */
export function buildCandidates(tokens: string[]): WhitelistCandidate[] {
  const candidates: WhitelistCandidate[] = [];
  for (let n = 1; n <= tokens.length; n += 1) {
    candidates.push({ tokenCount: n, label: tokens.slice(0, n).join(' '), exact: n === tokens.length });
  }
  return candidates;
}

/** 结构校验：坏数据（含 tokenCount 与 tokens 长度不一致）一律判非条目。 */
function isWhitelistEntry(value: unknown): value is WhitelistEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    Array.isArray(record.tokens) &&
    (record.tokens as unknown[]).every((token) => typeof token === 'string') &&
    typeof record.tokenCount === 'number' &&
    Number.isInteger(record.tokenCount) &&
    record.tokenCount > 0 &&
    (record.tokens as unknown[]).length === record.tokenCount &&
    typeof record.exact === 'boolean' &&
    typeof record.createdAt === 'number'
  );
}

/**
 * 从存储读取白名单；结构非法 / JSON 损坏时回退空表。
 * @param storage - 存储面（localStorage 或 fake）
 * @returns 白名单条目数组（坏数据被过滤）
 */
export function loadWhitelist(storage: WhitelistStorage): WhitelistEntry[] {
  const raw = storage.getItem(WHITELIST_STORAGE_KEY);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWhitelistEntry);
  } catch {
    return [];
  }
}

/** 持久化整表。 */
export function saveWhitelist(storage: WhitelistStorage, entries: WhitelistEntry[]): void {
  storage.setItem(WHITELIST_STORAGE_KEY, JSON.stringify(entries));
}

/** 轻量订阅 store 的公开面（同实例供审批面板与管理浮层共用）。 */
export interface WhitelistStore {
  /** 当前条目快照（调用方不得修改） */
  getEntries(): readonly WhitelistEntry[];
  /** 订阅变更；返回退订函数 */
  subscribe(listener: () => void): () => void;
  /**
   * 新增条目并持久化。
   * @param tokens - 命令 normalizeTokens 结果（需非空）
   * @param tokenCount - 粒度（1..tokens.length）
   * @param exact - 整行精确（目标 token 数必须与 tokenCount 相同）
   * @returns 新增条目
   */
  addEntry(tokens: string[], tokenCount: number, exact: boolean): WhitelistEntry;
  /** 按 id 删除并持久化。 */
  removeEntry(id: string): void;
  /** 清空全部并持久化。 */
  clearAll(): void;
  /** 目标 token 序列是否命中任一条目。 */
  matches(targetTokens: string[]): boolean;
}

/**
 * 创建白名单 store。
 * @param storage - 存储面（localStorage 或 fake）
 * @param now - 时间戳源（可注入，单测用）
 * @returns WhitelistStore
 */
export function createWhitelistStore(storage: WhitelistStorage, now: () => number = Date.now): WhitelistStore {
  let entries: WhitelistEntry[] = loadWhitelist(storage);
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function persist(): void {
    saveWhitelist(storage, entries);
  }

  return {
    getEntries: () => entries,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    addEntry: (tokens, tokenCount, exact) => {
      if (tokens.length === 0 || tokenCount <= 0 || tokenCount > tokens.length) {
        throw new Error(`invalid whitelist entry: tokens=${tokens.length} tokenCount=${tokenCount}`);
      }
      const entry: WhitelistEntry = {
        id: globalThis.crypto.randomUUID(),
        tokens: tokens.slice(0, tokenCount),
        tokenCount,
        exact,
        createdAt: now(),
      };
      entries = [...entries, entry];
      persist();
      notify();
      return entry;
    },
    removeEntry: (id) => {
      if (!entries.some((entry) => entry.id === id)) return;
      entries = entries.filter((entry) => entry.id !== id);
      persist();
      notify();
    },
    clearAll: () => {
      if (entries.length === 0) return;
      entries = [];
      persist();
      notify();
    },
    matches: (targetTokens) => entries.some((entry) => matchCommand(entry, targetTokens)),
  };
}
