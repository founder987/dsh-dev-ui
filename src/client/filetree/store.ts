/**
 * client 半：文件树面板共享状态（模块级 store + subscribe，
 * client 半不能 import 状态库，用 useSyncExternalStore 桥接）。
 * 状态：面板开关、@文件 引用待选（pendingRef）、composer 引用注入回调。
 */

type Listener = () => void;

let open = false;
let pendingRef = false;
let insertRefFn: ((ref: FileReference) => void) | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 兼容别名（原 subscribePanel） */
export const subscribePanel = subscribeStore;

/* ── 面板开关 ── */
export function isPanelOpen(): boolean {
  return open;
}

export function setPanelOpen(value: boolean): void {
  if (open === value) return;
  open = value;
  notify();
}

/* ── @文件 引用：待选模式 ── */
/** 是否处于"选文件用于对话引用"模式（由 composer @文件 按钮触发） */
export function isPendingRef(): boolean {
  return pendingRef;
}

export function setPendingRef(value: boolean): void {
  if (pendingRef === value) return;
  pendingRef = value;
  notify();
}

/* ── 树中定位：内容列请求在文件列表中展示/滚动到该文件 ── */
interface RevealRequest {
  path: string;
  /** 递增序号：同一文件重复定位也要触发（uSES 快照引用变化） */
  seq: number;
}

let reveal: RevealRequest | null = null;

/** 当前定位请求（内容列→树列） */
export function getReveal(): RevealRequest | null {
  return reveal;
}

/** 请求在树中定位文件（同时会打开树列） */
export function setReveal(path: string): void {
  reveal = { path, seq: (reveal?.seq ?? 0) + 1 };
  notify();
}

/* ── composer 引用注入回调（FileRefButton 注册，面板调用）── */
/** 引用载荷：文件 + 可选片段（片段级引用时携带选中文本） */
export interface FileReference {
  path: string;
  name: string;
  snippet?: string;
}

export function setInsertRefFn(fn: ((ref: FileReference) => void) | null): void {
  insertRefFn = fn;
}

/** composer 引用注入是否可用（FileRefButton 已注册） */
export function isInsertRefAvailable(): boolean {
  return insertRefFn !== null;
}

/**
 * 面板"引用此文件/发送片段"动作：把引用交给 composer 注入。
 * @returns 是否调用成功（false = composer 注入未就绪）
 */
export function callInsertRef(ref: FileReference): boolean {
  if (insertRefFn === null) return false;
  insertRefFn(ref);
  return true;
}
