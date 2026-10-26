import { definePlugin } from '@zmod/sdk';
import { calculateCost, pickScoped } from './lib.js';

/**
 * Usage & Token statistics — v2 port of v1 token-monitor (v3.x).
 *
 * Non-invasive telemetry interception: AOP-hook on window.zcode.reportTelemetryEvent
 * (no official file is touched). Maintains the same global contract
 * window.__zmod_token_stats__ that v1 exposed, so future ports (whale widget)
 * can consume it unchanged.
 *
 * Session-aware (v1 v3.5 parity): per-talk buckets (byTalk) drive the popover's
 * 「本轮/本会话」 rows so numbers never leak across talks; the global `session`
 * accumulator is kept only for the window.__zmod_token_stats__ contract.
 *
 * Cost estimation covers DeepSeek-family models only (pricing table + peak/
 * off-peak windows live in lib.js). Balance display is NOT handled here — it
 * lives in the datasource system (official-providers deepseek preset +
 * balance-cards plugin).
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function freshState() {
  return {
    byTalk: {},
    lastTurn: { hit: 0, miss: 0, input: 0, output: 0, reasoning: 0, total: 0, ratio: 0, cost: 0, model: '' },
    session: {
      turns: 0, hitTokens: 0, missTokens: 0, totalInput: 0, outputTokens: 0,
      reasoningTokens: 0, totalTokens: 0, totalCost: 0, avgRatio: 0
    },
    currentModel: '',
    activeTalkId: null,
    updatedAt: null
  };
}

export default definePlugin({
  id: 'usage-stats',
  name: 'Token 用量统计',
  version: '1.2.0',
  description: '非侵入拦截客户端遥测统计 Token 消耗/缓存命中（会话感知，跨会话不串数），费用估算仅 DeepSeek 系模型，余额走数据源系统',
  author: 'ZMod Team',

  settings: {
    view: {
      type: 'group',
      title: '展示'
    },
    pricing: {
      type: 'group',
      title: '费用估算'
    },
    enableCost: {
      type: 'switch',
      title: '启用费用估算',
      description: '按 DeepSeek 定价表（峰谷时段）估算费用，仅供参考',
      default: true
    }
  },

  async start(ctx) {
    const { settings: s, patcher, cleanup } = ctx;
    const state = freshState();

    // ---- restore persisted stats ----
    try {
      const saved = JSON.parse(localStorage.getItem('zmod_token_stats_v2_1') || 'null');
      if (saved && ((saved.session?.turns || 0) > 0 || (saved.lastTurn?.input || 0) > 0)) {
        Object.assign(state.session, saved.session || {});
        state.lastTurn = { ...state.lastTurn, ...(saved.lastTurn || {}) };
        state.byTalk = saved.byTalk || {};
        state.currentModel = saved.currentModel || '';
        state.activeTalkId = saved.activeTalkId ?? null;
      }
    } catch {}

    let persistT = null;
    // 浮层开着时状态一变就整块重渲染注入行（buildPopoverRows 定义在后，经此间接调用）
    let liveRefresh = null;
    const persist = () => {
      if (persistT) return;
      persistT = setTimeout(() => {
        persistT = null;
        try {
          localStorage.setItem('zmod_token_stats_v2_1', JSON.stringify({
            lastTurn: state.lastTurn, session: state.session, byTalk: state.byTalk,
            currentModel: state.currentModel, activeTalkId: state.activeTalkId
          }));
        } catch {}
      }, 800);
    };

    const syncGlobal = () => {
      state.updatedAt = Date.now();
      try { window.__zmod_token_stats__ = state; } catch {}
      persist();
      liveRefresh?.();
    };
    syncGlobal();

    // ---- usage ingestion ----
    // 逐请求 agent_step(generation, token_usage_scope=model_request) 是官方
    // 「平均缓存命中率」的同口径数据源；message_completion 是整条消息聚合，
    // 个别 provider（如 zai 托管 GLM）聚合口径偏差大。以 step 为主，
    // message_completion 只在该消息没有任何 step 事件时兜底，避免双计。
    const seen = new Map(); // dedupe key → 1, LRU-ish
    const seenKeys = [];
    const remember = (k) => {
      if (seen.has(k)) return;
      seen.set(k, 1);
      seenKeys.push(k);
      if (seenKeys.length > 800) seen.delete(seenKeys.shift());
    };

    // 正在累计的「本轮」：同一条 message 的 generation steps 逐段累加
    let curMsg = null;

    const addUsage = (model, cached, input, output, reasoning, talkId, isNewMessage) => {
      const miss = Math.max(0, input - cached);
      const total = input + output;
      const denom = cached + miss;
      const ratio = denom > 0 ? cached / denom : 0;
      const cost = s.get('enableCost', true) ? calculateCost(model, cached, miss, output) : 0;

      state.lastTurn = {
        hit: (curMsg.hit += cached), miss: (curMsg.miss += miss),
        input: (curMsg.input += input), output: (curMsg.output += output),
        reasoning: (curMsg.reasoning += reasoning),
        total: (curMsg.total += total),
        ratio: (curMsg.hit + curMsg.miss) > 0 ? curMsg.hit / (curMsg.hit + curMsg.miss) : 0,
        cost: (curMsg.cost += cost), model,
        // 归属标记：pickScoped 据此判断全局 lastTurn 能否跨会话回退（旧存档无此字段视为 null = 兼容）
        talkId: curMsg.talkId
      };

      const sess = state.session;
      if (isNewMessage) sess.turns += 1;
      sess.hitTokens += cached;
      sess.missTokens += miss;
      sess.totalInput += input;
      sess.outputTokens += output;
      sess.reasoningTokens += reasoning;
      sess.totalTokens += total;
      sess.totalCost += cost;
      const sDenom = sess.hitTokens + sess.missTokens;
      sess.avgRatio = sDenom > 0 ? sess.hitTokens / sDenom : 0;

      if (talkId != null) {
        const bk = state.byTalk[talkId] = state.byTalk[talkId] || { turns: 0, totalTokens: 0, hitTokens: 0, lastAt: 0 };
        if (isNewMessage) bk.turns += 1;
        bk.totalTokens = (bk.totalTokens || 0) + total;
        bk.totalInput = (bk.totalInput || 0) + input;
        bk.outputTokens = (bk.outputTokens || 0) + output;
        bk.hitTokens = (bk.hitTokens || 0) + cached;
        bk.totalCost = (bk.totalCost || 0) + cost;
        bk.lastAt = Date.now();
        bk.lastTurn = { ...state.lastTurn, at: Date.now() };
        if (String(talkId) !== String(state.activeTalkId ?? '')) state.activeTalkId = talkId;
      }
      syncGlobal();
    };

    const parseDetail = (payload) => {
      let d = payload.eventExtraDetail;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return undefined; } }
      return d;
    };
    const numbers = (d) => ({
      cached: Number(
        d.cached_tokens ?? d.cached_input_tokens ?? d.cache_read_input_tokens ??
        d.cached_content_token_count ?? d.prompt_cache_hit_tokens ??
        d.prompt_tokens_details?.cached_tokens ?? 0
      ) || 0,
      input: Number(d.input_tokens ?? d.prompt_tokens ?? 0) || 0,
      output: Number(d.output_tokens ?? d.completion_tokens ?? 0) || 0,
      reasoning: Number(d.reasoning_tokens ?? d.reasoning_content_tokens ?? 0) || 0
    });

    const ingestTelemetry = (payload) => {
      try {
        if (!payload) return;
        if (payload.talkId != null && String(payload.talkId) !== String(state.activeTalkId ?? '')) {
          state.activeTalkId = payload.talkId;
          syncGlobal();
        }
        if (payload.elementName !== 'agent_step' && payload.elementName !== 'message_completion') return;
        const d = parseDetail(payload);
        if (!d) return;
        const model = d.model_name || d.model || state.currentModel || 'unknown';
        state.currentModel = model;
        const msgId = payload.messageId ?? '';

        if (payload.elementName === 'agent_step') {
          // 只吃真实模型请求（generation），reasoning/tool_call 空步直接跳过
          if (String(d.token_usage_scope ?? 'model_request') !== 'model_request') return;
          if (String(d.step_type ?? 'generation') !== 'generation') return;
          const n = numbers(d);
          if (!n.input && !n.output && !n.cached) return;
          const dedupeKey = `step:${d.step_id ?? `${msgId}:${d.model_request_id ?? ''}`}`;
          if (seen.has(dedupeKey)) return;
          remember(dedupeKey);
          let isNewMessage = false;
          // messageId 为空的宿主：同一条 curMsg 会被永久粘连（turns 不再增长）——
          // 两次 step 间隔超过 2 分钟即视为新消息开桶
          const staleNoId = !msgId && curMsg && Date.now() - (curMsg.lastStepAt || 0) > 120000;
          if (!curMsg || staleNoId || (msgId && curMsg.id !== msgId) || curMsg.talkId !== payload.talkId) {
            curMsg = { id: msgId, talkId: payload.talkId, hit: 0, miss: 0, input: 0, output: 0, reasoning: 0, total: 0, cost: 0, lastStepAt: Date.now() };
            isNewMessage = true;
            if (msgId) remember(`msg:${msgId}`);
          }
          curMsg.lastStepAt = Date.now();
          addUsage(model, n.cached, n.input, n.output, n.reasoning, payload.talkId, isNewMessage);
        } else {
          // message_completion 聚合：该消息已由 step 流统计过则跳过
          const n = numbers(d);
          if (!n.input && !n.output && !n.cached) return;
          const viaSteps = msgId && seen.has(`msg:${msgId}`);
          const dedupeKey = `done:${msgId || ':' + Math.floor(Date.now() / 500)}`;
          if (seen.has(dedupeKey)) return;
          remember(dedupeKey);
          if (viaSteps) return;
          curMsg = { id: msgId, talkId: payload.talkId, hit: 0, miss: 0, input: 0, output: 0, reasoning: 0, total: 0, cost: 0, lastStepAt: Date.now() };
          addUsage(model, n.cached, n.input, n.output, n.reasoning, payload.talkId, true);
        }
      } catch {}
    };

    // ---- telemetry interception ----
    // Primary: main-process tap forwards message_completion events over the
    // preload bridge (window.zcode itself is a frozen contextBridge object —
    // patching it throws). Fallback: renderer-side after-patch, kept for hosts
    // where the bridge channel is unavailable.
    let hooked = false;
    if (window.zmodAPI && typeof window.zmodAPI.on === 'function') {
      try {
        const off = window.zmodAPI.on('zmod:telemetry-event', (payload) => {
          ingestTelemetry(payload);
        });
        cleanup(off);
        hooked = true;
        console.log('[usage-stats] subscribed to main-process telemetry tap (zmod:telemetry-event)');
      } catch (e) {
        console.warn('[usage-stats] bridge subscription failed:', e?.message || e);
      }
    }
    if (!hooked && window.zcode && typeof window.zcode.reportTelemetryEvent === 'function') {
      try {
        patcher.after(window.zcode, 'reportTelemetryEvent', (_result, ...args) => {
          try {
            const [eventName, data] = args;
            const payload = eventName && typeof eventName === 'object' ? eventName : { ...data, elementName: eventName };
            if (payload) ingestTelemetry(payload);
          } catch {}
        });
        hooked = true;
        console.log('[usage-stats] telemetry hook installed on window.zcode.reportTelemetryEvent');
      } catch (e) {
        console.warn('[usage-stats] window.zcode is read-only (contextBridge); no telemetry source:', e?.message || e);
      }
    }
    if (!hooked) {
      console.warn('[usage-stats] no telemetry source available — stats will stay empty');
    }

    /* ---- official usage-popover enhancement (v1 patch-styles-popover parity,
       runtime-injected: no official file is touched) ----
       When the official 上下文容量/用量 popover opens, append ZMod stat rows
       (本轮/会话 tokens + hit ratio) inside it, styled with the host's own
       token classes. Anchored on DOM traits, immune to bundle re-hashes. */
    const POPOVER_MARK = 'zmod-usage-rows';
    /* v1 label format: 命中率 本轮 x / 均 y · 本轮 入 / 出 · 本会话 入 / 出 / 命中（万单位） */
    const fmtWan = (n) => {
      n = Number(n) || 0;
      if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
      if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + '万';
      return String(Math.round(n));
    };
    function buildPopoverRows() {
      // 会话感知渲染（pickScoped）：活跃会话分桶优先，跨会话不串数；
      // 全局 session 累加器只服务 window.__zmod_token_stats__ 契约，不进 popover。
      const { lt, sess } = pickScoped(state);
      const wrap = document.createElement('div');
      wrap.className = 'flex flex-col gap-1.5 border-t border-border pt-2 mt-2';
      wrap.setAttribute('data-' + POPOVER_MARK, '1');
      const row = (label, value) =>
        `<div class="flex items-baseline justify-between gap-4"><span class="text-ui-sm text-foreground-subtle">${esc(label)}</span><span class="text-ui-sm font-medium tabular-nums text-foreground">${esc(value)}</span></div>`;
      // 旧存档分桶没有 totalInput/outputTokens —— 降级为轮次/总量口径
      const sessionVal = !sess
        ? '—'
        : sess.totalInput != null
          ? `入 ${fmtWan(sess.totalInput)} / 出 ${fmtWan(sess.outputTokens)} / 命中 ${fmtWan(sess.hitTokens)}`
          : `${sess.turns} 轮 / 共 ${fmtWan(sess.totalTokens)} / 命中 ${fmtWan(sess.hitTokens)}`;
      wrap.innerHTML =
        // 命中率不在此重复：官方「平均缓存命中率」行即同口径数据，v2.1 起 ZMod 行只补 token 量与费用
        row('本轮', lt && lt.total > 0 ? `入 ${fmtWan(lt.input)} / 出 ${fmtWan(lt.output)}` : '—') +
        row('本会话', sessionVal) +
        // 费用仅 DeepSeek 系模型计价（lib.js 内置门禁），非 DeepSeek 恒为 0 → 显示 —
        (s.get('enableCost', true) && sess && (sess.totalCost || 0) > 0
          ? row('会话费用估算', '¥' + sess.totalCost.toFixed(3))
          : '');
      return wrap;
    }

    /* Real container (3.16.3): the composer context gauge is a Radix hover-card —
       [data-slot="hover-card-content"][data-side="top"][data-state="open"].
       It opens on hover only; synthetic el.click() never opens it. Tooltip/menu
       surfaces are excluded from the generic fallback so stray floating panels
       containing the word "Token" can't receive rows. */
    const POPOVER_SELECTOR = [
      '[data-slot="hover-card-content"]',
      '[data-slot="popover-content"]',
      '[data-state="open"][data-side]:not([data-slot="tooltip-content"]):not([data-slot*="menu"]):not([data-slot*="select"])'
    ].join(', ');
    function enhancePopover() {
      for (const pop of document.querySelectorAll(POPOVER_SELECTOR)) {
        if (!pop.isConnected || pop.querySelector(`[data-${POPOVER_MARK}]`)) continue;
        const text = pop.textContent || '';
        if (!/上下文|缓存命中|用量|Token/i.test(text)) continue;
        // native rows live in the padded official column (bg-menu p-3
        // space-y-3) — injecting there inherits the native padding and
        // rhythm exactly like v1, whose rows were spliced into the same
        // container. Stats go before the official 今日余额 card (v1 order:
        // rows above official cards); mt-2 is a no-op inside space-y-3.
        const host = pop.querySelector('[class*="bg-menu"]') || pop.querySelector('[class*="space-y-3"]') || pop;
        const anchor = [...host.children].find((c) => /今日余额/.test(c.textContent || ''));
        const rows = buildPopoverRows();
        if (anchor) host.insertBefore(rows, anchor);
        else host.appendChild(rows);
        console.log('[usage-stats] enhanced official usage popover');
      }
    }
    liveRefresh = () => {
      for (const old of document.querySelectorAll(`[data-${POPOVER_MARK}]`)) {
        if (!old.isConnected) continue;
        old.replaceWith(buildPopoverRows());
      }
    };

    const popObserver = new MutationObserver(() => enhancePopover());
    popObserver.observe(document.body, { childList: true, subtree: true });
    cleanup(() => popObserver.disconnect());

    cleanup(() => {
      try { delete window.__zmod_token_stats__; } catch {}
      if (persistT) clearTimeout(persistT);
    });
    console.log('[usage-stats] ready (v1 token-monitor port; balance via datasources)');
  }
});
