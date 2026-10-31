import type { BalanceProvider, PluginProvider } from './types';
/** 内置服务商：编译期登记，顺序即优先级。 */
export declare const BUILTIN_PROVIDERS: BalanceProvider[];
/**
 * 注册一个第三方服务商。
 *
 * @param def - 服务商定义；`id` 必须与 agentDefaultModel 报告的 id 一致。
 * @returns 注销函数；同一 id 被重新注册后，旧注销函数不会误删新的那份。
 * @throws {TypeError} 定义不是对象、`id` 为空或 `fetch` 不是函数时。
 * @throws {Error} `id` 与内置冲突，或已被其他第三方注册时。
 */
export declare function registerBalanceProvider(def: PluginProvider): () => void;
/**
 * 现在到底有哪些 id（排障：为什么当前服务商显示「不支持」）。
 *
 * @returns `builtin` 为内置 id，`external` 为第三方已注册 id（每次调用返回新数组）。
 */
export declare function listBalanceProviders(): {
    builtin: string[];
    external: string[];
};
/** provider id → 定义：先内置，再第三方；都没有 = 不支持。 */
export declare function matchBalanceProvider(provider: string): BalanceProvider | PluginProvider | undefined;
