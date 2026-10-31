/** 进度条配色档位：<70 正常 / 70–90 预警 / ≥90 危急 */
export type QuotaTone = 'ok' | 'warn' | 'crit';
export declare const QUOTA_WARN_PERCENT = 70;
export declare const QUOTA_CRIT_PERCENT = 90;
export declare function quotaTone(percent: number): QuotaTone;
