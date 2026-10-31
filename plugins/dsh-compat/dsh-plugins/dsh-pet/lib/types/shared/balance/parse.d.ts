import type { BalanceState } from './types';
/**
 * host 的余额原始响应（`BalanceResult`，经 `/state` 的 `sections.balance` 叶子送达）→ 客户端视图。
 *
 * 形状非法 / shape 不认识 → **null**（消费端跳过这一拍）——注意这里**不抛**：它跑在 1s 轮询里，
 * 抛异常会把整拍打断（其余叶子也跟着不渲染）。取数失败（HTTP/网络）不在这里发生：取数在 host，
 * 失败会以 `ok:false` 写进 S，由这里正常映射成"不可用"状态。
 */
export declare function toBalanceState(raw: unknown): BalanceState | null;
