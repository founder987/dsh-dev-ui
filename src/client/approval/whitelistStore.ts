/**
 * client 半：命令白名单单例 store（审批面板与管理浮层共用实例）。
 * 持久化于浏览器 localStorage；无 localStorage 环境（SMOKE/SSR）回退内存存储。
 */
import { createWhitelistStore, type WhitelistStorage } from './cmdWhitelist';

/** 存储面：优先 localStorage，缺失时内存回退（会话级，不持久化）。 */
const storage: WhitelistStorage = (() => {
  try {
    if (typeof globalThis.localStorage !== 'undefined') return globalThis.localStorage;
  } catch {
    // 访问被拒绝（隐私模式）时忽略，走内存回退
  }
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
})();

/** 全局单例：白名单增删查、订阅、前缀匹配。 */
export const whitelistStore = createWhitelistStore(storage);
