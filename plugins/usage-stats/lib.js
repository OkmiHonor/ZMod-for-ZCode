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
// tiered: true = 峰谷双档表（hit/miss/out 各为 [谷, 峰]），calculateCost 走 isPeakHour 选档
export const PRICING = {
  // deepseek-flash: hit $0.006/$0.003 · miss $0.30/$0.15 · out $1.20/$0.60 (×7)
  flash: { tiered: true, hit: [0.02, 0.04], miss: [1.05, 2.1], out: [4.2, 8.4] },
  // deepseek-v4-pro: hit $0.044/$0.022 · miss $1.32/$0.66 · out $3.96/$1.98 (×7)
  v4pro: { tiered: true, hit: [0.15, 0.31], miss: [4.6, 9.2], out: [13.9, 27.7] },
  // deepseek-chat 旧价（2025 价目表，保留用于旧模型名兜底）
  v3legacy: { tiered: true, hit: [0.5, 1], miss: [2, 4], out: [8, 16] },
  // deepseek-reasoner 旧价（2025 价目表，保留用于旧模型名兜底）
  r1legacy: { tiered: true, hit: [1, 2], miss: [4, 8], out: [16, 32] }
};

/**
 * 百炼（阿里云 DashScope）RMB 价目表：元/百万 tokens，{ in, out }，无峰谷
 * （2026-10 官方价）。货币统一 ¥ —— 与 DeepSeek 系（USD×7 折算 RMB）口径一致。
 */
export const BAILIAN_PRICING = {
  dsv41flash: { in: 1, out: 4 },      // deepseek-v4.1-flash(-1017)
  dsv4pro: { in: 4.5, out: 13.5 },    // deepseek-v4-pro-0813（百炼快照）
  glm53: { in: 8, out: 28 },          // glm-5.3 / glm-5.2
  qwen38max: { in: 12, out: 36 },     // qwen3.8-max(-0902)
  qwen38flash: { in: 0.8, out: 2.7 }  // qwen3.8-flash
};

/**
 * 扩展主流模型参考价目表（元/百万 tokens，USD 定价按 1 USD ≈ 7.0 CNY 或 NewAPI 标准单价折算）：
 * 供开启「扩展主流模型与反代计价」或「按额度消耗 (cost)」模式时使用。
 * 支持 hit（缓存命中读取价）与 cw（缓存创建写入价，如 Claude 1.25x）。
 */
export const EXTENDED_PRICING = {
  // 智谱 GLM 系列
  glm53flash: { in: 0.5, hit: 0.1, out: 1.5 },
  glm51: { in: 5, hit: 1, out: 15 },
  glm47: { in: 4, hit: 0.8, out: 12 },
  glm45: { in: 0.8, hit: 0.16, out: 2 },
  // 阿里通义千问 Qwen 系列
  qwenMax: { in: 12, hit: 2.4, out: 36 },
  qwenPlus: { in: 0.8, hit: 0.16, out: 2 },
  qwenFlash: { in: 0.3, hit: 0.06, out: 0.9 },
  qwenCoder: { in: 1.5, hit: 0.3, out: 6 },
  // Kimi / Moonshot 系列
  kimiK2: { in: 4, hit: 1, out: 16 },
  // Anthropic Claude 系列 ($3/$15 Sonnet ≈ ¥21/¥105; $15/$75 Opus ≈ ¥105/¥525; $0.8/$4 Haiku ≈ ¥5.6/¥28)
  claudeOpus: { in: 105, hit: 10.5, cw: 131.25, out: 525, usdIn: 15, usdOut: 75 },
  claudeSonnet: { in: 21, hit: 2.1, cw: 26.25, out: 105, usdIn: 3, usdOut: 15 },
  claudeHaiku: { in: 5.6, hit: 0.56, cw: 7.0, out: 28, usdIn: 0.8, usdOut: 4 },
  // OpenAI GPT / o 系列 ($2.5/$10 GPT-4o/4.1 ≈ ¥17.5/¥70; $0.4/$1.6 mini ≈ ¥2.8/¥11.2; GPT-5/Pro)
  gptFlagship: { in: 17.5, hit: 4.375, out: 70, usdIn: 2.5, usdOut: 10 },
  gptMini: { in: 2.8, hit: 0.7, out: 11.2, usdIn: 0.4, usdOut: 1.6 },
  gptPro: { in: 70, hit: 17.5, out: 280, usdIn: 10, usdOut: 40 },
  // Google Gemini 系列 ($1.25/$10 Pro ≈ ¥8.75/¥70; $0.15/$0.60 Flash ≈ ¥1.05/¥4.2)
  geminiPro: { in: 8.75, hit: 2.18, out: 70, usdIn: 1.25, usdOut: 10 },
  geminiFlash: { in: 1.05, hit: 0.26, out: 4.2, usdIn: 0.15, usdOut: 0.6 },
  // MiniMax / 豆包 / 阶跃 / Grok
  minimaxM2: { in: 1, hit: 0.2, out: 8 },
  doubaoPro: { in: 0.8, hit: 0.16, out: 2 },
  stepFlagship: { in: 4, hit: 0.8, out: 12 },
  grokFlagship: { in: 21, hit: 5.25, out: 105, usdIn: 3, usdOut: 15 }
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
 * 订阅制模型判定（费用互斥铁律的网关侧延伸）：magpie 本地网关转发的 ZCode 订阅
 * 模型（model_id 带 zcode/ 前缀，如 zcode/GLM-5.3-Flash）走包月订阅，严禁套用
 * 百炼按量价——真实余量由数据源 magpie 适配器展示，这里只负责隐藏费用。
 */
export function isSubscriptionModel(model) {
  return /(^|\/)zcode\//i.test(String(model || ''));
}

/**
 * 订阅制供应商 ID 判定（SQLite model_usage.provider_id 或渠道标识）：
 * 例如 account:zai-start-plan、zai-coding-plan、kimi-code、minimax-token-plan、
 * bailian-coding-plan、volcengine-coding-plan、xiaomi-token-plan、step-plan、
 * magpie、antigravity 均为包月/买断制订阅，不应按百炼/官方按量单价计费。
 */
export function isSubscriptionProvider(providerId, model = '') {
  if (isSubscriptionModel(model)) return true;
  const p = String(providerId || '').trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith('account:')) return true;
  return /(coding-plan|token-plan|start-plan|m-plan|step-plan|kimi-code|magpie|antigravity|google-ai-pro)/i.test(p);
}

/**
 * 模型 → 价目表（默认严格模式，100% 保持历史单测契约）：
 * 0. zcode/ 前缀（magpie 网关订阅源）→ null 不计价；
 * 1. deepseek + v4.1 → 百炼 dsv41flash；
 * 2. deepseek + 0813 → 百炼 dsv4pro；
 * 3. 其余 deepseek → 官方 USD×7 峰谷价；
 * 4. 非 deepseek：qwen3.8 / glm-5.2|5.3（不含 flash）→ 百炼固定价；其余 → null。
 */
export function costTable(model, opts = null) {
  if (!opts?.forceCostForQuota && isSubscriptionModel(model)) return null;
  if (opts?.providerId && !opts?.forceCostForQuota && isSubscriptionProvider(opts.providerId, model)) {
    return null;
  }
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  if (m.includes('deepseek')) {
    if (/v4\.1/.test(m)) return BAILIAN_PRICING.dsv41flash;
    if (/0813/.test(m)) return BAILIAN_PRICING.dsv4pro;
    if (/v4.?pro/.test(m)) return PRICING.v4pro;
    if (/flash/.test(m)) return PRICING.flash;
    if (/reasoner/.test(m) || /(^|[^a-z0-9])r1([^a-z0-9]|$)/.test(m)) return PRICING.r1legacy;
    if (/chat|v3/.test(m)) return PRICING.v3legacy;
    // 其余 deepseek 变体默认按 flash 价
    return PRICING.flash;
  }
  if (/qwen3\.8-flash/.test(m)) return BAILIAN_PRICING.qwen38flash;
  if (/qwen3\.8-max/.test(m)) return BAILIAN_PRICING.qwen38max;
  if (/glm-5\.[23]-flash/.test(m)) {
    return opts?.extended ? EXTENDED_PRICING.glm53flash : null;
  }
  if (/glm-5\.[23]/.test(m)) return BAILIAN_PRICING.glm53;

  if (!opts?.extended) return null;

  // 扩展模型价目匹配（当 opts.extended === true 时启用）
  if (/glm-5\.1|glm-5\b/.test(m)) return EXTENDED_PRICING.glm51;
  if (/glm-4\.[67]|glm-4-plus/.test(m)) return EXTENDED_PRICING.glm47;
  if (/glm-4/.test(m)) return EXTENDED_PRICING.glm45;
  if (/qwen.*max/.test(m)) return EXTENDED_PRICING.qwenMax;
  if (/qwen.*coder/.test(m)) return EXTENDED_PRICING.qwenCoder;
  if (/qwen.*(flash|turbo)/.test(m)) return EXTENDED_PRICING.qwenFlash;
  if (/qwen/.test(m)) return EXTENDED_PRICING.qwenPlus;
  if (/kimi|moonshot/.test(m)) return EXTENDED_PRICING.kimiK2;
  if (/claude.*opus/.test(m)) return EXTENDED_PRICING.claudeOpus;
  if (/claude.*haiku/.test(m)) return EXTENDED_PRICING.claudeHaiku;
  if (/claude/.test(m)) return EXTENDED_PRICING.claudeSonnet;
  if (/gpt-5-pro|o1-pro|o3-pro/.test(m)) return EXTENDED_PRICING.gptPro;
  if (/gpt-.*(mini|nano)|o[134]-mini/.test(m)) return EXTENDED_PRICING.gptMini;
  if (/gpt-4|gpt-5|(^|\/)o[134]\b/.test(m)) return EXTENDED_PRICING.gptFlagship;
  if (/gemini.*flash/.test(m)) return EXTENDED_PRICING.geminiFlash;
  if (/gemini/.test(m)) return EXTENDED_PRICING.geminiPro;
  if (/minimax|abab/.test(m)) return EXTENDED_PRICING.minimaxM2;
  if (/doubao|seed/.test(m)) return EXTENDED_PRICING.doubaoPro;
  if (/step-/.test(m)) return EXTENDED_PRICING.stepFlagship;
  if (/grok/.test(m)) return EXTENDED_PRICING.grokFlagship;
  return null;
}

/**
 * 单次请求费用估算（元，或当 opts.currency === '$' 时折算美元）。
 * - tiered 表（DeepSeek 系）：按 isPeakHour 峰谷双档，缓存命中单独计价；
 * - 固定表（百炼系）：无峰谷，入价按全部输入 tokens 计；
 * - 扩展表（EXTENDED_PRICING）：支持 hit（缓存读取折扣）与 cw（缓存写入溢价）及渠道倍率 priceMultiplier。
 * 无价目表（costTable 为 null）返回 0。
 */
export function calculateCost(model, cachedTokens, missTokens, outputTokens, date, opts = null) {
  const table = costTable(model, opts);
  if (!table) return 0;
  const mult = Number.isFinite(Number(opts?.priceMultiplier)) && Number(opts.priceMultiplier) >= 0
    ? Number(opts.priceMultiplier)
    : 1;
  const cached = Math.max(0, Number(cachedTokens) || 0);
  const miss = Math.max(0, Number(missTokens) || 0);
  const out = Math.max(0, Number(outputTokens) || 0);
  const cacheWrite = Math.max(0, Number(opts?.cacheWriteTokens) || 0);
  const pureMiss = Math.max(0, miss - cacheWrite);

  let rmb = 0;
  if (table.tiered) {
    const tier = isPeakHour(date) ? 1 : 0;
    rmb =
      (cached / 1e6) * table.hit[tier] +
      (miss / 1e6) * table.miss[tier] +
      (out / 1e6) * table.out[tier];
  } else if (opts?.extended && (table.hit !== undefined || table.cw !== undefined)) {
    const hitRate = table.hit !== undefined ? table.hit : table.in;
    const cwRate = table.cw !== undefined ? table.cw : table.in;
    rmb =
      (cached / 1e6) * hitRate +
      (cacheWrite / 1e6) * cwRate +
      (pureMiss / 1e6) * table.in +
      (out / 1e6) * table.out;
  } else {
    rmb = ((cached + miss) / 1e6) * table.in + (out / 1e6) * table.out;
  }
  const scaled = rmb * mult;
  if (opts?.currency === '$') {
    return scaled / 7;
  }
  return scaled;
}

/**
 * 费用数字格式化（纯函数，不含 ¥ 前缀）：>=0.01 保留 3 位小数，<0.01 保留 4 位，
 * 避免极小费用被 toFixed(3) 显示成 ¥0.000。
 */
export function formatCost(n) {
  const v = Number(n) || 0;
  return v >= 0.01 ? v.toFixed(3) : v.toFixed(4);
}

/**
 * 订阅额度规则（按"模型请求数"计）：matcher 命中模型名后按 flash/pro 档与统计周期取请求次数。
 * 支持 5小时额度 (5h) 与 周额度 (weekly)，并保留日额度 (daily) 兼容：
 * - 5小时额度 (5h 滚动窗口)：Google AI Pro 约 Pro 50 次、Flash 150 次 / 5小时
 * - 周额度 (weekly 每周窗口)：Google AI Pro 约 Pro 500 次、Flash 1500 次 / 周
 * - 日额度 (daily 每日估算)：Google AI Pro 约 Pro 100 次、Flash 250 次 / 日
 * 实际配额以订阅商后台或 Antigravity 网关 (8045) 为准。
 *
 * 桶组归属（实测 ~/.antigravity_tools/accounts/<id>.json 的 quota_groups）：
 * Google 按"模型分组"限流而非逐模型限流——Argon 系模型拥有独立桶组（Pro 订阅仅周桶），
 * 其余 gemini（flash/pro）共享 "Gemini Models" 桶组的 5h + weekly 双桶；额度计数必须
 * 按桶组聚合，跨组请求（含非 gemini 模型）互不挤占，否则估算必然虚高。
 */
export const QUOTA_RULES = [
  {
    matcher: /gemini/i,
    name: 'Google AI Pro',
    windows: {
      '5h': { pro: 50, flash: 150, windowLabel: '5小时额度', label: 'Google AI Pro (5小时额度估算)' },
      'weekly': { pro: 500, flash: 1500, windowLabel: '周额度', label: 'Google AI Pro (周额度估算)' },
      'daily': { pro: 100, flash: 250, windowLabel: '日额度', label: 'Google AI Pro (日额度估算)' }
    }
  }
];

/**
 * 模型 → 订阅额度表。
 * 参数 window: '5h'（5小时额度，默认）| 'weekly'（周额度）| 'daily'（日额度）。
 * 命中返回 { limit, daily, window, windowLabel, label }（/flash/i → flash 档，其余 → pro 档），
 * 未命中任何规则返回 null。保留 daily 字段以保持老调用方与单测完全兼容。
 */
export function quotaTable(model, window = '5h') {
  const m = String(model || '');
  const winKey = window === 'weekly' ? 'weekly' : (window === 'daily' ? 'daily' : '5h');
  for (const rule of QUOTA_RULES) {
    if (!rule || !rule.matcher || !rule.matcher.test(m)) continue;
    const cfg = rule.windows?.[winKey] || rule.windows?.['5h'];
    if (!cfg) return null;
    const isFlash = /flash/i.test(m);
    const limit = isFlash ? cfg.flash : cfg.pro;
    return {
      limit,
      daily: limit,
      window: winKey,
      windowLabel: cfg.windowLabel,
      label: cfg.label
    };
  }
  return null;
}

/**
 * 模型 → 配额桶组（Antigravity 网关 quota_groups 实测口径）：
 * - gemini 系且非 argon → 'gemini'（与 "Gemini Models" 组对应，flash/pro 共享 5h+weekly 双桶）；
 * - gemini 系 argon（如 gemini-4-argon / gemini-4-argon-low）→ 'gemini-argon'（独立桶组，
 *   Pro 订阅只有周桶——名字里没有 flash 落 pro 档的旧逻辑无法表达这一分组）；
 * - 当 opts.allowAllGroups === true 时，claude / gpt / o1 / o3 / o4 系 → 'claude-gpt'
 *   （对应 Antigravity 的 "Claude and GPT models" 桶组）；
 * - 默认 1 参数调用下非 gemini → null（保持历史单测 100% 兼容）。
 */
export function quotaBucketGroup(model, opts = null) {
  const m = String(model || '');
  if (/gemini/i.test(m)) {
    return /argon/i.test(m) ? 'gemini-argon' : 'gemini';
  }
  if (opts?.allowAllGroups && /(claude|gpt|opus|sonnet|haiku|(^|\/|-)(o1|o3|o4)\b)/i.test(m)) {
    return 'claude-gpt';
  }
  return null;
}

/**
 * 统计周期 → 滚动窗口时长（ms）。周额度按"近 7 天滚动"近似（Google 实际为固定周
 * 重置点，本地无重置时刻信息时滚动窗口是最接近的估算口径）。
 */
export function quotaWindowMs(window = '5h') {
  if (window === 'weekly') return 7 * 24 * 3600000;
  if (window === 'daily') return 24 * 3600000;
  return 5 * 3600000;
}

/**
 * 解析单条自定义额度配置值：
 * - 数字或纯数字字符串（如 50 / "150"）→ { limit: 50, unit: 'requests' }
 * - 金额字符串（如 "$5" / "¥50" / "10usd" / "20cny"）→ { limit: 5, unit: 'cost', currency: '$' | '¥' }
 * - Token 字符串（如 "500w" / "500万" / "5m" / "5000k" / "5000000tok"）→ { limit: 5000000, unit: 'tokens' }
 * - 结构化对象（如 { limit: 10, unit: 'cost', currency: '$', multiplier: 1.5 }）
 */
export function parseCustomQuotaEntry(rawVal) {
  if (rawVal == null || typeof rawVal === 'boolean') return null;
  if (typeof rawVal === 'number') {
    return Number.isFinite(rawVal) && rawVal > 0 ? { limit: rawVal, unit: 'requests' } : null;
  }
  if (typeof rawVal === 'string') {
    const s = rawVal.trim();
    if (!s) return null;
    if (/^[+-]?\d+(?:\.\d+)?$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? { limit: n, unit: 'requests' } : null;
    }
    const curMatch = /^(?:([$¥￥])\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(usd|cny|rmb|刀|元|\$|¥|￥))$/i.exec(s);
    if (curMatch) {
      const n = Number(curMatch[2] || curMatch[3]);
      if (!Number.isFinite(n) || n <= 0) return null;
      const sym = String(curMatch[1] || curMatch[4] || '').toLowerCase();
      const currency = sym === '$' || sym === 'usd' || sym === '刀' ? '$' : '¥';
      return { limit: n, unit: 'cost', currency };
    }
    const tokMatch = /^(\d+(?:\.\d+)?)\s*(w|万|m|k|tok|tokens?)$/i.exec(s);
    if (tokMatch) {
      const base = Number(tokMatch[1]);
      if (!Number.isFinite(base) || base <= 0) return null;
      const u = tokMatch[2].toLowerCase();
      const mult = u === 'm' ? 1e6 : (u === 'w' || u === '万') ? 1e4 : u === 'k' ? 1e3 : 1;
      return { limit: Math.round(base * mult), unit: 'tokens' };
    }
    return null;
  }
  if (typeof rawVal === 'object' && !Array.isArray(rawVal)) {
    const n = Number(rawVal.limit ?? rawVal.value ?? rawVal.amount);
    if (!Number.isFinite(n) || n <= 0) return null;
    const uRaw = String(rawVal.unit || rawVal.mode || 'requests').toLowerCase();
    const unit = uRaw === 'cost' || uRaw === 'credit' || uRaw === 'usd' || uRaw === 'cny'
      ? 'cost'
      : uRaw === 'tokens' || uRaw === 'token'
        ? 'tokens'
        : 'requests';
    const currency = rawVal.currency === '$' || uRaw === 'usd' ? '$' : '¥';
    const multiplier = Number.isFinite(Number(rawVal.multiplier)) && Number(rawVal.multiplier) > 0
      ? Number(rawVal.multiplier)
      : undefined;
    return { limit: n, unit, currency, multiplier };
  }
  return null;
}

/**
 * 解析额度表：customQuota（JSON 字典，模型名 → 周期上限，支持数字次数、"$5"/"¥50" 金额、"500w" Token 或对象）
 * 命中时优先于内置；接受对象或 JSON 字符串形态，非法/缺失/非正数值一律回退内置表
 * （非法 JSON 不抛错）。自定义键支持精确匹配、忽略大小写、前缀通配（如 "claude*"）与全局通配（"*"）。
 */
export function resolveQuotaTable(model, customQuota, window = '5h', opts = null) {
  const m = String(model || '');
  const winKey = window === 'weekly' ? 'weekly' : (window === 'daily' ? 'daily' : '5h');
  const winLabel = winKey === 'weekly' ? '周额度' : (winKey === 'daily' ? '日额度' : '5小时额度');
  const builtin = quotaTable(m, window);

  let cq = customQuota;
  if (typeof cq === 'string') {
    try {
      cq = JSON.parse(cq);
    } catch {
      cq = null;
    }
  }
  if (cq && typeof cq === 'object' && !Array.isArray(cq) && m) {
    let hit = Object.prototype.hasOwnProperty.call(cq, m) ? cq[m] : undefined;
    const lower = m.toLowerCase();
    const baseLower = lower.includes('/') ? lower.split('/').pop() : lower;
    if (hit == null) {
      for (const k of Object.keys(cq)) {
        const kl = String(k).toLowerCase().trim();
        if (kl === lower || kl === baseLower) {
          hit = cq[k];
          break;
        }
      }
    }
    if (hit == null) {
      for (const k of Object.keys(cq)) {
        const kl = String(k).toLowerCase().trim();
        if (kl.endsWith('*') && kl.length > 1) {
          const prefix = kl.slice(0, -1);
          if (lower.startsWith(prefix) || baseLower.startsWith(prefix) || lower.includes(prefix)) {
            hit = cq[k];
            break;
          }
        }
      }
    }
    if (hit == null && Object.prototype.hasOwnProperty.call(cq, '*')) {
      hit = cq['*'];
    }
    const parsed = parseCustomQuotaEntry(hit);
    if (parsed) {
      const out = {
        limit: parsed.limit,
        daily: parsed.limit,
        window: winKey,
        windowLabel: winLabel,
        label: builtin ? builtin.label : `自定义${winLabel}`,
        custom: true
      };
      if (parsed.unit && parsed.unit !== 'requests') out.unit = parsed.unit;
      if (parsed.currency) out.currency = parsed.currency;
      if (parsed.multiplier !== undefined) out.multiplier = parsed.multiplier;
      return out;
    }
  }

  // 若用户在插件设置里配置了通用周期上限 (periodicQuotaLimit > 0)
  const fallbackLimit = Number(opts?.periodicQuotaLimit);
  if (m && Number.isFinite(fallbackLimit) && fallbackLimit > 0) {
    const mode = String(opts?.quotaMode || 'auto').toLowerCase();
    const unit = mode === 'cost' ? 'cost' : mode === 'tokens' ? 'tokens' : 'requests';
    const realLimit = unit === 'tokens' && fallbackLimit < 1e5 ? fallbackLimit * 1e4 : fallbackLimit;
    return {
      limit: realLimit,
      daily: realLimit,
      window: winKey,
      windowLabel: winLabel,
      label: `通用${winLabel}`,
      custom: true,
      unit,
      currency: opts?.currency || '¥'
    };
  }

  return builtin;
}

/**
 * 已发请求次数占订阅额度的百分比（0..∞，可超 100）。无可用额度表返回 0。
 */
export function calculateQuotaPercent(model, requests, customQuota, window = '5h') {
  const table = resolveQuotaTable(model, customQuota, window);
  if (!table || !(table.limit > 0)) return 0;
  return ((Number(requests) || 0) / table.limit) * 100;
}

/**
 * 滚动窗口内的"同桶组"请求计数（额度估算的计数口径，v1.4.2 起）：
 * - events = 会话分桶的 reqEvents（[{ m: 模型名, t: epoch ms }]，按时间升序）；
 * - 只统计与 quotaModel 同桶组（quotaBucketGroup 相同）的请求——Gemini Flash/Pro
 *   共享桶组互相挤占，Argon 独立桶组，非 gemini 请求永不计入；
 * - 只统计窗口内（t >= now - 窗口时长）的请求，真实还原 Google 的滚动 5h/周窗口，
 *   替代旧版"整段会话累计"口径（会话跨天时旧口径必然虚高）。
 */
export function countQuotaRequests(events, model, window = '5h', now = Date.now(), opts = null) {
  const group = quotaBucketGroup(model, opts);
  const mNorm = String(model || '').toLowerCase();
  if (!group && !(opts?.matchExactModel && mNorm)) return 0;
  const cutoff = (Number(now) || Date.now()) - quotaWindowMs(window);
  let n = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev) continue;
    const t = Number(ev.t) || 0;
    if (t < cutoff) continue;
    if (group) {
      if (quotaBucketGroup(ev.m, opts) === group) n++;
    } else if (String(ev.m || '').toLowerCase() === mNorm) {
      n++;
    }
  }
  return n;
}

/**
 * 多维滚动窗口额度消耗聚合（支持按次数 requests / 按金额额度 cost / 按 Token 总量 tokens）：
 * 输入 events 可为 usageEvents（含 in/out/hit/cw/cost）或 reqEvents（仅含 m/t）。
 */
export function computeWindowQuotaUsage(events, model, quotaRule, window = '5h', now = Date.now(), opts = {}) {
  if (!quotaRule || !(quotaRule.limit > 0)) return null;
  const unit = quotaRule.unit || (opts.quotaMode === 'cost' ? 'cost' : opts.quotaMode === 'tokens' ? 'tokens' : 'requests');
  const cutoff = (Number(now) || Date.now()) - quotaWindowMs(window);
  const group = quotaBucketGroup(model, { allowAllGroups: true });
  const mNorm = String(model || '').toLowerCase();
  const mBase = mNorm.includes('/') ? mNorm.split('/').pop() : mNorm;
  const matchAllModels = Boolean(opts.matchAllModels);

  let usedRequests = 0;
  let usedTokens = 0;
  let usedCost = 0;
  const mult = Number.isFinite(Number(quotaRule.multiplier ?? opts.priceMultiplier))
    ? Number(quotaRule.multiplier ?? opts.priceMultiplier)
    : 1;
  const currency = quotaRule.currency || opts.currency || '¥';

  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev) continue;
    const t = Number(ev.t ?? ev.startedAt) || 0;
    if (t < cutoff) continue;
    const evModel = String(ev.m ?? ev.modelId ?? ev.model ?? '');
    const evLower = evModel.toLowerCase();
    const evBase = evLower.includes('/') ? evLower.split('/').pop() : evLower;

    let matched = false;
    if (matchAllModels || unit === 'cost') {
      // 按金额/额度池消耗时（如反代网关同一 Key 跨模型扣减总额度），默认统计窗口内所有模型或同组模型
      matched = true;
    } else if (group) {
      matched = quotaBucketGroup(evModel, { allowAllGroups: true }) === group;
    } else if (mBase) {
      matched = evLower === mNorm || evBase === mBase;
    }
    if (!matched) continue;

    usedRequests++;
    const inp = Number(ev.in ?? ev.input) || 0;
    const out = Number(ev.out ?? ev.output) || 0;
    const hit = Math.min(inp, Math.max(0, Number(ev.hit ?? ev.cached) || 0));
    const cw = Math.max(0, Number(ev.cw ?? ev.cacheWrite) || 0);
    const miss = Math.max(0, inp - hit);
    usedTokens += inp + out;

    const c = calculateCost(evModel, hit, miss, out, t ? new Date(t) : undefined, {
      extended: true,
      forceCostForQuota: true,
      priceMultiplier: mult,
      currency,
      cacheWriteTokens: cw
    });
    usedCost += c;
  }

  const used = unit === 'cost' ? usedCost : unit === 'tokens' ? usedTokens : usedRequests;
  const pct = (used / quotaRule.limit) * 100;
  return {
    unit,
    currency,
    used,
    limit: quotaRule.limit,
    pct,
    usedRequests,
    usedTokens,
    usedCost
  };
}

/**
 * Antigravity 网关配额快照 → 当前模型所在桶组的真实余量。
 * snapshot 为主进程 usage.getAntigravityQuota 的返回（读
 * ~/.antigravity_tools/accounts/<id>.json 的 quota 段，网关未运行也可用文件快照）：
 * { ok, tier, lastUpdated, groups: [{ name, description, buckets: [{ window, frac, reset }] }] }
 * 分组名匹配大小写不敏感：目标 'gemini' → 名字/描述含 gemini 且不含 argon 的组；
 * 目标 'gemini-argon' → 含 argon 的组；当 opts.allowAllGroups === true 时，
 * 目标 'claude-gpt' → 含 claude 或 gpt 的组。命中返回
 * { group, tier, lastUpdated, buckets }，无匹配/数据非法返回 null。
 */
export function mapAntigravityQuota(snapshot, model, opts = null) {
  const group = quotaBucketGroup(model, opts);
  if (!group || !snapshot || typeof snapshot !== 'object') return null;
  const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const hay = `${String(g.name || '')} ${String(g.description || '')}`.toLowerCase();
    const isArgon = /argon/.test(hay);
    const isGemini = /gemini/.test(hay);
    const isClaudeGpt = /claude|gpt/.test(hay);
    const match =
      group === 'gemini-argon'
        ? isArgon
        : group === 'claude-gpt'
          ? isClaudeGpt
          : isGemini && !isArgon;
    if (!match) continue;
    const buckets = (Array.isArray(g.buckets) ? g.buckets : [])
      .filter((b) => b && typeof b === 'object' && Number.isFinite(Number(b.frac)))
      .map((b) => ({ window: String(b.window || ''), frac: Number(b.frac), reset: String(b.reset || '') }));
    if (buckets.length === 0) continue;
    return {
      group,
      tier: String(snapshot.tier || ''),
      lastUpdated: Number(snapshot.lastUpdated) || 0,
      buckets
    };
  }
  return null;
}

/**
 * 子串 containment 双向贴词边界：模型名互为前缀（GLM-5.3 vs GLM-5.3-Flash）
 * 时不得互相吸桶，只有整词命中（紧邻字符非字母数字/连字符/点）才放行。
 */
function fuzzyModelHit(short, long) {
  const i = long.indexOf(short);
  if (i < 0) return false;
  const before = i > 0 ? long[i - 1] : '';
  const after = i + short.length < long.length ? long[i + short.length] : '';
  const glued = (c) => /[a-z0-9.-]/.test(c);
  return !glued(before) && !glued(after);
}

/**
 * Magpie 网关/本地快照 → 当前模型的真实窗口余量。
 * 支持 zcode/GLM-5.3-Flash、GLM-5.3-Flash 等模型匹配（词边界防前缀互吸）。
 * 多账户同标签时按 window 收敛为一条：at 最新优先（并列取 frac 最小保守）；
 * 无 at（旧契约）直接取 frac 最小，宁可少报不虚报。不用 reset 判新鲜度——
 * 同窗口各账户 resetsAt 是同一日历时间，reset 相同不代表快照同新鲜。
 */
export function mapMagpieQuota(snapshot, model) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.ok) return null;
  const m = String(model || '').trim().toLowerCase();
  if (!m) return null;
  const mBase = m.includes('/') ? m.split('/').pop() : m;
  const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
  const byWindow = new Map();
  let matchedPlan = String(snapshot.plan || '');
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    if (g.plan && !matchedPlan) matchedPlan = String(g.plan);
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      if (!b || !Number.isFinite(Number(b.frac))) continue;
      const w = String(b.window || '');
      const wl = w.toLowerCase();
      const wBase = wl.includes('/') ? wl.split('/').pop() : wl;
      if (!(wl === m || wBase === mBase || (mBase.length >= 4 && (fuzzyModelHit(mBase, wBase) || fuzzyModelHit(wBase, mBase))))) {
        continue;
      }
      const atMs = Date.parse(String(b.at || ''));
      const cand = {
        window: w,
        frac: Number(b.frac),
        reset: String(b.reset || ''),
        atMs: Number.isFinite(atMs) ? atMs : null
      };
      if (b.display != null) cand.display = String(b.display);
      const prev = byWindow.get(w);
      if (!prev) {
        byWindow.set(w, cand);
        continue;
      }
      const pick =
        prev.atMs != null && cand.atMs != null && prev.atMs !== cand.atMs
          ? prev.atMs > cand.atMs ? prev : cand
          : prev.frac <= cand.frac ? prev : cand;
      byWindow.set(w, pick);
    }
  }
  if (byWindow.size === 0) return null;
  const buckets = [...byWindow.values()];
  for (const b of buckets) delete b.atMs;
  return {
    plan: matchedPlan || 'Magpie',
    buckets
  };
}

/**
 * 重置时刻 → 中文倒计时（"4小时20分后重置" / "2天3小时后重置" / "已重置"），
 * 非法时刻返回 ''（调用方省略该段）。纯函数，时区由 Date 解析 ISO 串自动处理。
 */
export function formatQuotaReset(resetTime, now = Date.now()) {
  const t = new Date(String(resetTime || '')).getTime();
  if (!Number.isFinite(t)) return '';
  const min = Math.round((t - (Number(now) || Date.now())) / 60000);
  if (min <= 0) return '已重置';
  if (min < 60) return `${min}分钟后重置`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 48) return m ? `${h}小时${m}分后重置` : `${h}小时后重置`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}天${hh}小时后重置` : `${d}天后重置`;
}

/**
 * 根据 SQLite (usage.getSessionStats) 返回的已完成请求列表，
 * 构建幂等的会话分桶（bucket）。
 * - 完整兼容子代理（querySource === 'subagent'）与辅助查询（session_title 等）：
 *   子代理与辅助查询的 Token、费用与请求次数均计入会话总量，同时归并到所属主轮次，
 *   避免辅助查询篡改本轮模型名或冲掉本轮主对话统计。
 */
export function buildBucketFromRequests(sessionId, requests, enableCost = true, opts = {}) {
  const list = Array.isArray(requests) ? requests : [];
  const includeSubagents = opts?.includeSubagents !== false;
  const costOpts = {
    extended: Boolean(opts?.extendedPricing),
    priceMultiplier: opts?.priceMultiplier
  };
  const turnMap = new Map();
  const turnList = [];
  const turnReqKeys = new Map(); // turnKey -> Set(去重请求键)，reqCount 口径 = 模型请求数
  const reqSeen = {};
  const stepsSeen = {};
  const reqEvents = []; // 滚动窗口额度估算的数据源：{ m: 模型名, t: epoch ms }，严格保持二元结构兼容单测
  const usageEvents = []; // 扩展事件流：{ m, p, q, t, in, out, hit, cw, cost }

  let totalTokens = 0;
  let totalInput = 0;
  let outputTokens = 0;
  let hitTokens = 0;
  let missTokens = 0;
  let reasoningTokens = 0;
  let totalCost = 0;
  let totalEquivCost = 0;
  let subagentTokens = 0;
  let subagentInput = 0;
  let subagentOutput = 0;
  let subagentCost = 0;
  let subagentEquivCost = 0;
  let subagentReqCount = 0;
  let lastStartedAt = 0;
  let latestMainTurnKey = null;

  // 预扫描是否存在任何 main_turn 行（若整个会话本身就是子代理会话，则直接按原 turnId 聚合）
  const hasAnyMainTurn = list.some((r) => r && (!r.querySource || r.querySource === 'main_turn'));

  for (let idx = 0; idx < list.length; idx++) {
    const r = list[idx];
    if (!r || typeof r !== 'object') continue;
    const qSource = String(r.querySource || 'main_turn');
    const isAuxOrSub = qSource !== 'main_turn';
    if (isAuxOrSub && !includeSubagents) continue;

    if (r.id) stepsSeen[String(r.id)] = 1;
    if (r.logicalRequestId) stepsSeen[String(r.logicalRequestId)] = 1;

    const input = Number(r.input) || 0;
    const output = Number(r.output) || 0;
    const reasoning = Number(r.reasoning) || 0;
    const cached = Math.min(input, Math.max(0, Number(r.cached) || 0));
    const cacheWrite = Math.max(0, Number(r.cacheWrite) || 0);
    const miss = Math.max(0, input - cached);
    const total = input + output;
    const model = String(r.modelId || r.model || '');
    const providerId = String(r.providerId || '');
    const startedAt = Number(r.startedAt) || 0;
    if (startedAt > lastStartedAt) lastStartedAt = startedAt;

    const cost = enableCost
      ? calculateCost(model, cached, miss, output, startedAt ? new Date(startedAt) : undefined, {
          ...costOpts,
          providerId,
          cacheWriteTokens: cacheWrite
        })
      : 0;

    const equivCost = enableCost
      ? calculateCost(model, cached, miss, output, startedAt ? new Date(startedAt) : undefined, {
          ...costOpts,
          extended: true,
          forceCostForQuota: true,
          providerId,
          cacheWriteTokens: cacheWrite
        })
      : 0;

    // 若为子代理或标题等辅助请求，且当前会话有主轮次，则挂靠到最近的主轮次上，避免虚增对话轮数或覆盖 lastTurn.model
    const rawTurnKey = String(r.turnId || r.id || `idx_${idx}`);
    let turnKey = rawTurnKey;
    if (!isAuxOrSub) {
      latestMainTurnKey = rawTurnKey;
    } else if (hasAnyMainTurn && latestMainTurnKey) {
      turnKey = latestMainTurnKey;
    }

    const reqKey = String(r.logicalRequestId || r.id || `idx_${idx}`);
    if (!reqSeen[reqKey]) {
      reqSeen[reqKey] = 1;
      reqEvents.push({ m: model, t: startedAt });
      usageEvents.push({
        m: model,
        p: providerId,
        q: qSource,
        t: startedAt,
        in: input,
        out: output,
        hit: cached,
        cw: cacheWrite,
        cost
      });
      if (qSource === 'subagent') {
        subagentReqCount++;
      }
    }

    if (qSource === 'subagent') {
      subagentTokens += total;
      subagentInput += input;
      subagentOutput += output;
      subagentCost += cost;
      subagentEquivCost += equivCost;
    }

    // 关键逻辑：当 hasAnyMainTurn 为 true 且当前行为子代理/辅助行 (isAuxOrSub) 时：
    // 绝不将 subagent/aux 行的 Token、cost、equivCost 或 turnReqKey 累加到主 turn 对象中！
    // 从而保证 turn（以及 lastTurn / 本轮）严格纯粹反映主轮次对话。
    if (!hasAnyMainTurn || !isAuxOrSub) {
      if (!turnReqKeys.has(turnKey)) turnReqKeys.set(turnKey, new Set());
      turnReqKeys.get(turnKey).add(reqKey);

      let turn = turnMap.get(turnKey);
      if (!turn) {
        turn = {
          hit: 0,
          miss: 0,
          input: 0,
          output: 0,
          reasoning: 0,
          total: 0,
          ratio: 0,
          cost: 0,
          equivCost: 0,
          reqCount: 0,
          model,
          talkId: sessionId,
          turnId: turnKey,
          viaSteps: true,
          at: startedAt
        };
        turnMap.set(turnKey, turn);
        turnList.push(turn);
      }

      turn.hit += cached;
      turn.miss += miss;
      turn.input += input;
      turn.output += output;
      turn.reasoning += reasoning;
      turn.total += total;
      turn.cost += cost;
      turn.equivCost = (turn.equivCost || 0) + equivCost;
      // 仅主轮次请求或尚无模型名时更新 turn.model，防止 session_title/subagent 的小模型名覆盖主对话模型
      if (model && (!isAuxOrSub || !turn.model)) turn.model = model;
      if (providerId && (!isAuxOrSub || !turn.providerId)) turn.providerId = providerId;
      if (startedAt >= (turn.at || 0)) turn.at = startedAt;
      const tDenom = turn.hit + turn.miss;
      turn.ratio = tDenom > 0 ? turn.hit / tDenom : 0;
    }

    totalTokens += total;
    totalInput += input;
    outputTokens += output;
    hitTokens += cached;
    missTokens += miss;
    reasoningTokens += reasoning;
    totalCost += cost;
    totalEquivCost += equivCost;
  }

  const sDenom = hitTokens + missTokens;
  const avgRatio = sDenom > 0 ? hitTokens / sDenom : 0;
  for (const t of turnList) {
    t.reqCount = turnReqKeys.get(t.turnId) ? turnReqKeys.get(t.turnId).size : 0;
  }
  const bucketReqCount = Object.keys(reqSeen).length;
  const lastTurn = turnList.length > 0 ? { ...turnList[turnList.length - 1] } : null;

  return {
    turns: turnList.length,
    totalTokens,
    totalInput,
    outputTokens,
    hitTokens,
    missTokens,
    reasoningTokens,
    totalCost,
    totalEquivCost,
    reqCount: bucketReqCount,
    subagentTokens,
    subagentInput,
    subagentOutput,
    subagentCost,
    subagentEquivCost,
    subagentReqCount,
    reqEvents,
    usageEvents,
    avgRatio,
    lastAt: lastStartedAt || Date.now(),
    lastTurn,
    turnsById: Object.fromEntries(turnList.map((t) => [t.turnId, t])),
    stepsSeen,
    currentMsgKey: lastTurn ? lastTurn.turnId : null,
    fromDb: true
  };
}

function parseExtraDetail(payload) {
  let d = payload?.eventExtraDetail;
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d);
    } catch {
      return null;
    }
  }
  return d && typeof d === 'object' ? d : null;
}

function extractTokenNumbers(d) {
  const rawCached =
    Number(
      d.cached_tokens ??
        d.cached_input_tokens ??
        d.cache_read_input_tokens ??
        d.cached_content_token_count ??
        d.prompt_cache_hit_tokens ??
        d.prompt_tokens_details?.cached_tokens ??
        0
    ) || 0;
  const cacheWrite =
    Number(
      d.cache_creation_input_tokens ??
        d.cache_write_input_tokens ??
        d.prompt_cache_miss_tokens_created ??
        0
    ) || 0;
  const input = Number(d.input_tokens ?? d.prompt_tokens ?? 0) || 0;
  const output = Number(d.output_tokens ?? d.completion_tokens ?? 0) || 0;
  const reasoning = Number(d.reasoning_tokens ?? d.reasoning_content_tokens ?? 0) || 0;
  const cached = input > 0 ? Math.min(input, Math.max(0, rawCached)) : Math.max(0, rawCached);
  return { rawCached, cached, cacheWrite: Math.max(0, cacheWrite), input, output, reasoning };
}

const MAX_SEEN_PER_TALK = 300;
const MAX_TURNS_PER_TALK = 100;
// 滚动窗口请求事件上限：5h 档官方限额 150 次，1000 条余量充足且控制持久化体积
const MAX_REQ_EVENTS_PER_TALK = 1000;

function trimObjectKeys(obj, maxKeys) {
  if (!obj || typeof obj !== 'object') return;
  const keys = Object.keys(obj);
  if (keys.length <= maxKeys) return;
  const drop = keys.length - maxKeys;
  for (let i = 0; i < drop; i++) {
    delete obj[keys[i]];
  }
}

function ensureBucket(state, talkId) {
  state.byTalk = state.byTalk || {};
  let bk = state.byTalk[talkId];
  if (!bk) {
    bk = state.byTalk[talkId] = {
      turns: 0,
      totalTokens: 0,
      totalInput: 0,
      outputTokens: 0,
      hitTokens: 0,
      missTokens: 0,
      reasoningTokens: 0,
      totalCost: 0,
      totalEquivCost: 0,
      subagentTokens: 0,
      subagentInput: 0,
      subagentOutput: 0,
      subagentCost: 0,
      subagentEquivCost: 0,
      subagentReqCount: 0,
      reqCount: 0,
      reqEvents: [],
      usageEvents: [],
      avgRatio: 0,
      lastAt: 0,
      lastTurn: null,
      turnsById: {},
      stepsSeen: {},
      currentMsgKey: null
    };
  } else {
    bk.turnsById = bk.turnsById || {};
    bk.stepsSeen = bk.stepsSeen || {};
    bk.reqEvents = Array.isArray(bk.reqEvents) ? bk.reqEvents : [];
    bk.usageEvents = Array.isArray(bk.usageEvents) ? bk.usageEvents : [];
    if (bk.lastTurn) {
      const ltKey = bk.lastTurn.turnId || bk.lastTurn.id;
      if (ltKey && !bk.turnsById[ltKey]) {
        bk.turnsById[ltKey] = bk.lastTurn;
      }
    }
  }
  return bk;
}

/**
 * 会话隔离的遥测事件摄入核心：
 * 1. 仅当 opts.updateActiveTalk === true 或 state.activeTalkId == null 时才从遥测更新 activeTalkId，
 *    防止后台运行会话篡改前台已锁定的会话 ID；
 * 2. 废除全局 curMsg 单例，改为每个会话分桶内独立的 turnsById 与 stepsSeen，
 *    彻底解决多会话并发 step 交替导致 turns 虚增与 lastTurn 被覆盖的问题；
 * 3. agent_step 不再限制 step_type === 'generation'（兼容模型先输出 thought 直接调工具时
 *    token 挂在 step_type === 'reasoning' 上的情况），且与 message_completion 严格按 msgKey 去重。
 */
export function ingestTelemetryPayload(state, payload, opts = {}) {
  if (!state || !payload || typeof payload !== 'object') return false;
  const enableCost = opts.enableCost !== undefined ? Boolean(opts.enableCost) : true;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const updateActiveTalk = Boolean(opts.updateActiveTalk);

  if (
    payload.talkId != null &&
    payload.talkId !== 'draft' &&
    (updateActiveTalk || state.activeTalkId == null)
  ) {
    state.activeTalkId = payload.talkId;
  }

  const elName = payload.elementName;
  if (elName !== 'agent_step' && elName !== 'message_completion') {
    return false;
  }

  const d = parseExtraDetail(payload);
  if (!d) return false;

  if (elName === 'agent_step') {
    if (String(d.token_usage_scope ?? 'model_request') !== 'model_request') {
      return false;
    }
  }

  const { rawCached, cached, cacheWrite, input, output, reasoning } = extractTokenNumbers(d);
  if (!input && !output && !rawCached) return false;

  const model = String(d.model_name || d.model || state.currentModel || 'unknown');
  const providerId = String(d.provider_id || d.provider || '');
  state.currentModel = model;

  const talkId = payload.talkId ?? state.activeTalkId ?? '__global__';
  const bucketTalkId = talkId === '__global__' ? null : talkId;
  const bucket = ensureBucket(state, talkId);
  const msgId = String(payload.messageId ?? '');

  let msgKey = '';
  let isNewTurn = false;

  if (elName === 'agent_step') {
    const reqId = String(d.model_request_id || '');
    const stepKey = String(
      d.step_id || (msgId || reqId ? `${msgId}:${reqId}` : '')
    );
    if ((stepKey && bucket.stepsSeen[stepKey]) || (reqId && bucket.stepsSeen[reqId])) {
      return false;
    }
    if (stepKey) {
      bucket.stepsSeen[stepKey] = 1;
    }
    if (reqId) {
      bucket.stepsSeen[reqId] = 1;
    }

    if (msgId) {
      msgKey = msgId;
    } else if (bucket.currentMsgKey && now - (bucket.lastAt || 0) <= 120000) {
      msgKey = bucket.currentMsgKey;
    } else {
      msgKey = `anon_${now}`;
    }
    bucket.currentMsgKey = msgKey;

    if (!bucket.turnsById[msgKey]) {
      bucket.turnsById[msgKey] = {
        hit: 0,
        miss: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        total: 0,
        ratio: 0,
        cost: 0,
        equivCost: 0,
        reqCount: 1,
        model,
        talkId: bucketTalkId,
        turnId: msgKey,
        viaSteps: true,
        at: now
      };
      bucket.turns = (bucket.turns || 0) + 1;
      isNewTurn = true;
    } else {
      const t0 = bucket.turnsById[msgKey];
      t0.viaSteps = true;
      // 通过 stepsSeen 门禁的每个 step 都对应一个未见过的新 model_request_id
      // （门禁同时按 step_id 与 model_request_id 去重），故计一次新请求
      t0.reqCount = (t0.reqCount || 0) + 1;
    }
    // 每个通过门禁的新请求都记入滚动窗口事件流（模型 + 时刻），供额度估算按窗口与桶组过滤
    bucket.reqEvents.push({ m: model, t: now });
  } else {
    // message_completion: 若该会话分桶已由 SQLite 权威校准或该消息已有 step 记录则跳过
    if (bucket.fromDb && (bucket.turns || 0) > 0) {
      return false;
    }
    msgKey = msgId || `done_${Math.floor(now / 500)}`;
    const doneKey = `done:${msgKey}`;
    if (bucket.turnsById[msgKey] || bucket.stepsSeen[doneKey]) {
      return false;
    }
    bucket.stepsSeen[doneKey] = 1;
    bucket.turnsById[msgKey] = {
      hit: 0,
      miss: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      total: 0,
      ratio: 0,
      cost: 0,
      equivCost: 0,
      reqCount: 1,
      model,
      talkId: bucketTalkId,
      turnId: msgKey,
      viaSteps: false,
      at: now
    };
    bucket.turns = (bucket.turns || 0) + 1;
    isNewTurn = true;
    bucket.reqEvents.push({ m: model, t: now });
  }

  const miss = Math.max(0, input - cached);
  const total = input + output;
  const cost = enableCost
    ? calculateCost(model, cached, miss, output, opts.date || new Date(now), {
        extended: Boolean(opts.extendedPricing),
        priceMultiplier: opts.priceMultiplier,
        providerId,
        cacheWriteTokens: cacheWrite
      })
    : 0;

  const equivCost = enableCost
    ? calculateCost(model, cached, miss, output, opts.date || new Date(now), {
        extended: true,
        forceCostForQuota: true,
        priceMultiplier: opts.priceMultiplier,
        providerId,
        cacheWriteTokens: cacheWrite
      })
    : 0;

  bucket.usageEvents.push({
    m: model,
    p: providerId,
    q: 'main_turn',
    t: now,
    in: input,
    out: output,
    hit: cached,
    cw: cacheWrite,
    cost
  });

  const turnObj = bucket.turnsById[msgKey];
  turnObj.hit = (turnObj.hit || 0) + cached;
  turnObj.miss = (turnObj.miss || 0) + miss;
  turnObj.input = (turnObj.input || 0) + input;
  turnObj.output = (turnObj.output || 0) + output;
  turnObj.reasoning = (turnObj.reasoning || 0) + reasoning;
  turnObj.total = (turnObj.total || 0) + total;
  turnObj.cost = (turnObj.cost || 0) + cost;
  turnObj.equivCost = (turnObj.equivCost || 0) + equivCost;
  turnObj.model = model;
  if (providerId) turnObj.providerId = providerId;
  turnObj.talkId = bucketTalkId;
  turnObj.turnId = msgKey;
  turnObj.at = now;
  const tDenom = turnObj.hit + turnObj.miss;
  turnObj.ratio = tDenom > 0 ? turnObj.hit / tDenom : 0;

  bucket.totalTokens = (bucket.totalTokens || 0) + total;
  bucket.totalInput = (bucket.totalInput || 0) + input;
  bucket.outputTokens = (bucket.outputTokens || 0) + output;
  bucket.hitTokens = (bucket.hitTokens || 0) + cached;
  bucket.missTokens = (bucket.missTokens || 0) + miss;
  bucket.reasoningTokens = (bucket.reasoningTokens || 0) + reasoning;
  bucket.totalCost = (bucket.totalCost || 0) + cost;
  bucket.totalEquivCost = (bucket.totalEquivCost || 0) + equivCost;
  bucket.reqCount = (bucket.reqCount || 0) + 1;
  const bDenom = bucket.hitTokens + bucket.missTokens;
  bucket.avgRatio = bDenom > 0 ? bucket.hitTokens / bDenom : 0;
  bucket.lastAt = now;
  bucket.lastTurn = { ...turnObj };
  trimObjectKeys(bucket.stepsSeen, MAX_SEEN_PER_TALK);
  trimObjectKeys(bucket.turnsById, MAX_TURNS_PER_TALK);
  if (bucket.reqEvents.length > MAX_REQ_EVENTS_PER_TALK) {
    bucket.reqEvents.splice(0, bucket.reqEvents.length - MAX_REQ_EVENTS_PER_TALK);
  }
  if (bucket.usageEvents.length > MAX_REQ_EVENTS_PER_TALK) {
    bucket.usageEvents.splice(0, bucket.usageEvents.length - MAX_REQ_EVENTS_PER_TALK);
  }

  if (
    String(talkId) === String(state.activeTalkId ?? '') ||
    !state.lastTurn ||
    state.lastTurn.talkId == null
  ) {
    state.lastTurn = { ...bucket.lastTurn };
  }

  state.session = state.session || {
    turns: 0,
    hitTokens: 0,
    missTokens: 0,
    totalInput: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    totalEquivCost: 0,
    reqCount: 0,
    avgRatio: 0
  };
  const sess = state.session;
  if (isNewTurn) sess.turns = (sess.turns || 0) + 1;
  sess.hitTokens = (sess.hitTokens || 0) + cached;
  sess.missTokens = (sess.missTokens || 0) + miss;
  sess.totalInput = (sess.totalInput || 0) + input;
  sess.outputTokens = (sess.outputTokens || 0) + output;
  sess.reasoningTokens = (sess.reasoningTokens || 0) + reasoning;
  sess.totalTokens = (sess.totalTokens || 0) + total;
  sess.totalCost = (sess.totalCost || 0) + cost;
  sess.totalEquivCost = (sess.totalEquivCost || 0) + equivCost;
  sess.reqCount = (sess.reqCount || 0) + 1;
  const sDenom = sess.hitTokens + sess.missTokens;
  sess.avgRatio = sDenom > 0 ? sess.hitTokens / sDenom : 0;

  return true;
}

/**
 * 会话感知的状态选择（支持 DOM 实时探测会话 ID 覆盖与 draft 草稿会话隔离）：
 * 活跃会话有分桶（byTalk[activeTalkId]）时优先用桶；全局 lastTurn 仅在
 * 归属可确认（talkId 为 null 的旧存档 / 与活跃会话一致 / 无活跃会话兼容模式）时回退，
 * 全局 session 累加器禁止用于「本会话」展示。
 *
 * 返回 { lt, sess }：lt = 本轮数据，sess = 本会话分桶（可为 null）。
 */
export function pickScoped(state, domTalkId) {
  if (domTalkId !== undefined && domTalkId === 'draft') {
    return { lt: null, sess: null };
  }
  const activeTalkId = domTalkId !== undefined ? domTalkId : state.activeTalkId;
  if (activeTalkId === 'draft') {
    return { lt: null, sess: null };
  }
  const bucket = activeTalkId != null ? (state.byTalk || {})[activeTalkId] : null;

  let lt = (bucket && bucket.lastTurn) || null;
  if (!lt) {
    const g = state.lastTurn;
    if (activeTalkId != null) {
      if (g && (g.talkId == null || String(g.talkId) === String(activeTalkId))) {
        lt = g;
      }
    } else if (domTalkId === null) {
      if (g && g.talkId == null) {
        lt = g;
      }
    } else if (g) {
      lt = g;
    }
  }

  const sess = bucket && (bucket.turns || 0) > 0 ? bucket : null;
  return { lt, sess };
}
