/**
 * client 半：命令白名单单例 store（审批面板与管理浮层共用实例）。
 * 持久化于浏览器 localStorage；非浏览器环境（单测）不加载此模块。
 */
import { createWhitelistStore } from './cmdWhitelist';

/** 全局单例：白名单增删查、订阅、前缀匹配。 */
export const whitelistStore = createWhitelistStore(globalThis.localStorage);
