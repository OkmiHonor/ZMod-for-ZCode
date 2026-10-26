/**
 * usage-stats — pure logic, zero deps, node-testable.
 *
 * Kept free of any DOM/@zmod-sdk references so `node --test` can drive it
 * directly; the runtime half (telemetry ingestion, popover rendering) lives
 * in index.js.
 */

/**
 * 元/百万 tokens：[谷期(off-peak), 峰期(peak)]。
 *
 * 现行官方 USD 计价（api-docs.deepseek.com，2026-10）按 1 USD = 7 CNY 折算，
 * 估算值仅供参考。峰谷窗口沿用 DeepSeek 官方定价页定义（北京时间）：
 * 峰 = 周一至周五 9:00–12:00 与 14:00–18:00，谷 = 其余时段半价。
 * 局限：法定节假日不判断——节假日仍按峰期口径估算，可能与官方实际计费有出入。
 */
export const PRICING = {
  // deepseek-flash: hit $0.006/$0.003 · miss $0.30/$0.15 · out $1.20/$0.60 (×7)
  flash: { hit: [0.02, 0.04], miss: [1.05, 2.1], out: [4.2, 8.4] },
  // deepseek-v4-pro: hit $0.044/$0.022 · miss $1.32/$0.66 · out $3.96/$1.98 (×7)
  v4pro: { hit: [0.15, 0.31], miss: [4.6, 9.2], out: [13.9, 27.7] },
  // deepseek-chat 旧价（2025 价目表，保留用于旧模型名兜底）
  v3legacy: { hit: [0.5, 1], miss: [2, 4], out: [8, 16] },
  // deepseek-reasoner 旧价（2025 价目表，保留用于旧模型名兜底）
  r1legacy: { hit: [1, 2], miss: [4, 8], out: [16, 32] }
};

/**
 * DeepSeek 峰谷判断：入参 date 缺省为当前时间。
 * 北京时区换算（UTC+8）、周一至周五、9–12 与 14–18 点为峰。
 */
export function isPeakHour(date) {
  try {
    const now = date || new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const bj = new Date(utc + 3600000 * 8);
    const day = bj.getDay();
    if (day === 0 || day === 6) return false;
    const hour = bj.getHours();
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  } catch {
    return false;
  }
}

/**
 * 模型 → 价目表。仅 DeepSeek 系模型计价（model 名含 "deepseek"，大小写不敏感），
 * 其他模型（GLM/qwen 等）返回 null —— 套用 DeepSeek 价目表毫无意义。
 */
export function costTable(model) {
  const m = String(model || '').toLowerCase();
  if (!m.includes('deepseek')) return null;
  if (/v4.?pro/.test(m)) return PRICING.v4pro;
  if (/flash/.test(m)) return PRICING.flash;
  if (/reasoner/.test(m) || /(^|[^a-z0-9])r1([^a-z0-9]|$)/.test(m)) return PRICING.r1legacy;
  if (/chat|v3/.test(m)) return PRICING.v3legacy;
  // 其余 deepseek 变体默认按 flash 价
  return PRICING.flash;
}

/**
 * 单次请求费用估算（元）。非 DeepSeek 系（costTable 为 null）返回 0。
 */
export function calculateCost(model, cachedTokens, missTokens, outputTokens, date) {
  const table = costTable(model);
  if (!table) return 0;
  const tier = isPeakHour(date) ? 1 : 0;
  return (
    (cachedTokens / 1e6) * table.hit[tier] +
    (missTokens / 1e6) * table.miss[tier] +
    (outputTokens / 1e6) * table.out[tier]
  );
}

/**
 * 会话感知的状态选择（v1 token-monitor v3.5 语义，修复跨会话串数据）：
 * 活跃会话有分桶（byTalk[activeTalkId]）时优先用桶；全局 lastTurn 仅在
 * 归属可确认（talkId 为 null 的旧存档 / 与活跃会话一致 / 无活跃会话）时回退，
 * 全局 session 累加器禁止用于「本会话」展示 —— 那正是串数据 bug 的来源。
 *
 * 返回 { lt, sess }：lt = 本轮数据，sess = 本会话分桶（可为 null）。
 */
export function pickScoped(state) {
  const activeTalkId = state.activeTalkId;
  const bucket = activeTalkId != null ? (state.byTalk || {})[activeTalkId] : null;

  let lt = (bucket && bucket.lastTurn) || null;
  if (!lt) {
    const g = state.lastTurn;
    if (
      g &&
      (activeTalkId == null ||
        g.talkId == null ||
        String(g.talkId) === String(activeTalkId))
    ) {
      lt = g;
    }
  }

  const sess = bucket && (bucket.turns || 0) > 0 ? bucket : null;
  return { lt, sess };
}
