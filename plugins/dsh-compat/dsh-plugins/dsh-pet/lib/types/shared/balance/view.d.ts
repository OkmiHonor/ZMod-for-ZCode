import type { BalanceBubbleRow, BalanceState } from './types';
/**
 * 把 BalanceState 渲染成气泡行数据（纯函数，不碰 DOM/React）：
 * - windows：两行 —— 「X额度已用 N%」+ 重置倒计时
 * - money：一行 —— 「余额（峰/谷）¥x.xx」（峰红/谷绿由 role:'tier' 表达）；
 *   服务商没给档位装饰时退化成「余额 ¥x.xx」，不替它编一个峰谷
 * - points：一行 —— 「余额 800 积分」（单位由数据带出，绝不套货币符号）
 * - 无效：显式展示不可用原因（见 unavailableRows），绝不伪造数字
 */
export declare function balanceBubbleView(state: BalanceState): BalanceBubbleRow[];
/**
 * 展开态行数据（点余额气泡后显示）：只有 windows 有三窗口读数可展开，每个存在窗口一行。
 *
 * money / points 形态没有"窗口"这个概念（只有账户余额 / 积分），也没有额外的 handler.detail，
 * 于是回落到收起态视图 —— 展开前后内容一致，不会出现"点了一下却什么都没变"的空交互。
 */
export declare function balanceDetailView(state: BalanceState): BalanceBubbleRow[];
