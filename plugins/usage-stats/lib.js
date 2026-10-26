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
 * 根据 SQLite (usage.getSessionStats) 返回的已完成 main_turn 请求列表，
 * 构建幂等的会话分桶（bucket）。
 */
export function buildBucketFromRequests(sessionId, requests, enableCost = true) {
  const list = Array.isArray(requests) ? requests : [];
  const turnMap = new Map();
  const turnList = [];
  const stepsSeen = {};

  let totalTokens = 0;
  let totalInput = 0;
  let outputTokens = 0;
  let hitTokens = 0;
  let missTokens = 0;
  let reasoningTokens = 0;
  let totalCost = 0;
  let lastStartedAt = 0;

  for (let idx = 0; idx < list.length; idx++) {
    const r = list[idx];
    if (!r || typeof r !== 'object') continue;
    if (r.id) stepsSeen[String(r.id)] = 1;
    if (r.logicalRequestId) stepsSeen[String(r.logicalRequestId)] = 1;

    const input = Number(r.input) || 0;
    const output = Number(r.output) || 0;
    const reasoning = Number(r.reasoning) || 0;
    const cached = Math.min(input, Math.max(0, Number(r.cached) || 0));
    const miss = Math.max(0, input - cached);
    const total = input + output;
    const model = String(r.modelId || r.model || '');
    const startedAt = Number(r.startedAt) || 0;
    if (startedAt > lastStartedAt) lastStartedAt = startedAt;

    const cost = enableCost
      ? calculateCost(model, cached, miss, output, startedAt ? new Date(startedAt) : undefined)
      : 0;

    const turnKey = String(r.turnId || r.id || `idx_${idx}`);
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
    if (model) turn.model = model;
    if (startedAt >= (turn.at || 0)) turn.at = startedAt;
    const tDenom = turn.hit + turn.miss;
    turn.ratio = tDenom > 0 ? turn.hit / tDenom : 0;

    totalTokens += total;
    totalInput += input;
    outputTokens += output;
    hitTokens += cached;
    missTokens += miss;
    reasoningTokens += reasoning;
    totalCost += cost;
  }

  const sDenom = hitTokens + missTokens;
  const avgRatio = sDenom > 0 ? hitTokens / sDenom : 0;
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
  const input = Number(d.input_tokens ?? d.prompt_tokens ?? 0) || 0;
  const output = Number(d.output_tokens ?? d.completion_tokens ?? 0) || 0;
  const reasoning = Number(d.reasoning_tokens ?? d.reasoning_content_tokens ?? 0) || 0;
  const cached = input > 0 ? Math.min(input, Math.max(0, rawCached)) : Math.max(0, rawCached);
  return { rawCached, cached, input, output, reasoning };
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

  const { rawCached, cached, input, output, reasoning } = extractTokenNumbers(d);
  if (!input && !output && !rawCached) return false;

  const model = String(d.model_name || d.model || state.currentModel || 'unknown');
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
        model,
        talkId: bucketTalkId,
        turnId: msgKey,
        viaSteps: true,
        at: now
      };
      bucket.turns = (bucket.turns || 0) + 1;
      isNewTurn = true;
    } else {
      bucket.turnsById[msgKey].viaSteps = true;
    }
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
      model,
      talkId: bucketTalkId,
      turnId: msgKey,
      viaSteps: false,
      at: now
    };
    bucket.turns = (bucket.turns || 0) + 1;
    isNewTurn = true;
  }

  const miss = Math.max(0, input - cached);
  const total = input + output;
  const cost = enableCost
    ? calculateCost(model, cached, miss, output, opts.date || new Date(now))
    : 0;

  const turnObj = bucket.turnsById[msgKey];
  turnObj.hit = (turnObj.hit || 0) + cached;
  turnObj.miss = (turnObj.miss || 0) + miss;
  turnObj.input = (turnObj.input || 0) + input;
  turnObj.output = (turnObj.output || 0) + output;
  turnObj.reasoning = (turnObj.reasoning || 0) + reasoning;
  turnObj.total = (turnObj.total || 0) + total;
  turnObj.cost = (turnObj.cost || 0) + cost;
  turnObj.model = model;
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
  const bDenom = bucket.hitTokens + bucket.missTokens;
  bucket.avgRatio = bDenom > 0 ? bucket.hitTokens / bDenom : 0;
  bucket.lastAt = now;
  bucket.lastTurn = { ...turnObj };

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
