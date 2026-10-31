import type { AccountBalanceSnapshot, BalanceProvider, BalanceSuccess } from '../types';
/**
 * 账号余额快照 → 成功结果（纯函数，便于测试直接喂真实结构）。
 *
 * 失败口径：没有可用的充值钱包（未登录 / 查询失败 / 空数组）→ 抛错，由调用方落成 `fetch-error`；
 * 金额非法同理 —— **绝不伪造 0 余额**。
 *
 * 多币种：账号可能同时持有 CNY / USD 钱包，**每个币种各出一条**（`data.wallets`），
 * 选哪个显示交给展示层（它才知道气泡宽度、要不要显示为 0 的币种）。
 */
export declare function parseAccountBalance(snapshot: AccountBalanceSnapshot | null | undefined, provider: string): BalanceSuccess;
export declare const deepseekAccount: BalanceProvider;
