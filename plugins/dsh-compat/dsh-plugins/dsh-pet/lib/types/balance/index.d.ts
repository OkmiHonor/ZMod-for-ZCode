import type { AccountBalanceSnapshot, BalanceResult } from './types';
export { BUILTIN_PROVIDERS, listBalanceProviders, matchBalanceProvider, registerBalanceProvider } from './registry';
/** 已登记的内置服务商（保持旧导出名：测试与既有调用方不受影响） */
export declare const BALANCE_PROVIDERS: import("./types").BalanceProvider[];
/**
 * 按当前服务商查询余额。
 * @param provider agentDefaultModel.currentSelection().provider
 * @param resolveKey 凭证解析：ref 名 → key（由调用方注入 ctx.credentials.resolve）
 * @param resolveAccount 账号余额查询（由调用方注入 ctx.deepseekAccount.getBalance）；
 *   只被 `deepseek-account` 用到。缺省时该路由报 `credential-missing`（账号服务不在场）
 * @returns 结构化结果：成功 / 不支持 / 缺凭证 / 抓取失败（失败带 message，绝不返回伪造数字）
 */
export declare function queryBalance(provider: string, resolveKey: (ref: string) => Promise<string | undefined>, resolveAccount?: () => Promise<AccountBalanceSnapshot | null | undefined>): Promise<BalanceResult>;
export { parseAccountBalance } from './providers/deepseek-account';
export { parseCommandCode } from './providers/commandcode';
export type { AccountBalanceSnapshot, BalanceFetchContext, BalanceProvider, BalanceResult, BalanceShape, BalanceSuccess, CredentialSpec, MoneyBalance, PluginFetchContext, PluginProvider, PointsBalance, PricingTier, WindowsUsage, } from './types';
