import { definePlugin } from '@zmod/sdk';
import {
  buildBucketFromRequests,
  calculateQuotaPercent,
  formatCost,
  ingestTelemetryPayload,
  pickScoped,
  resolveQuotaTable
} from './lib.js';

/**
 * Usage & Token statistics — v2 port of v1 token-monitor (v3.x).
 *
 * Dual-engine session-aware architecture (v1.4.0):
 * 1. Self-contained per-session telemetry state machine (turnsById / stepsSeen)
 *    + DOM session detection ([data-session-id]) + draft isolation;
 * 2. Optional authoritative SQLite calibration (usage.getSessionStats RPC) when
 *    supported by the host runtime, falling back gracefully on older runtimes;
 * 3. Cost estimation covers DeepSeek (official USD×7, peak/off-peak) + Bailian
 *    (DashScope RMB fixed) model families; subscription quota estimation
 *    (requests/day, e.g. Google AI Pro) with custom JSON override.
 */

const STORAGE_KEY = 'zmod_token_stats_v2_3';
const LEGACY_STORAGE_KEYS = ['zmod_token_stats_v2_2', 'zmod_token_stats_v2_1'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function freshState() {
  return {
    byTalk: {},
    lastTurn: { hit: 0, miss: 0, input: 0, output: 0, reasoning: 0, total: 0, ratio: 0, cost: 0, reqCount: 0, model: '' },
    session: {
      turns: 0, hitTokens: 0, missTokens: 0, totalInput: 0, outputTokens: 0,
      reasoningTokens: 0, totalTokens: 0, totalCost: 0, reqCount: 0, avgRatio: 0
    },
    currentModel: '',
    activeTalkId: null,
    updatedAt: null
  };
}

function detectDomTalkId(popEl) {
  try {
    for (const trig of document.querySelectorAll(
      '[data-chat-toolbar-popover-trigger="true"], [data-slot="hover-card-trigger"][data-state="open"]'
    )) {
      const isOpen =
        trig.getAttribute('data-state') === 'open' ||
        trig.closest('[data-slot="hover-card-trigger"]')?.getAttribute('data-state') === 'open';
      if (isOpen) {
        const sid = trig.closest('[data-session-id]')?.getAttribute('data-session-id');
        if (sid) return sid;
      }
    }
    if (popEl) {
      const sid = popEl.closest?.('[data-session-id]')?.getAttribute('data-session-id');
      if (sid) return sid;
    }
    const panes = [...document.querySelectorAll('[data-session-id]')].filter((el) => {
      if (!el.isConnected) return false;
      const rect = el.getBoundingClientRect?.();
      return rect ? rect.width > 0 && rect.height > 0 : true;
    });
    if (panes.length >= 1) {
      return panes[panes.length - 1].getAttribute('data-session-id') || null;
    }
  } catch {}
  return undefined;
}

export default definePlugin({
  id: 'usage-stats',
  name: 'Token 用量统计',
  version: '1.4.0',
  description: '非侵入拦截客户端遥测统计 Token 消耗/缓存命中（会话感知，跨会话不串数），费用估算覆盖 DeepSeek 系 + 百炼系模型，订阅源额度估算，余额走数据源系统',
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
      description: 'DeepSeek 系按官方定价（USD×7 折算、峰谷时段），百炼系按 RMB 固定价，仅供参考',
      default: true
    },
    quota: {
      type: 'group',
      title: '额度估算'
    },
    enableQuota: {
      type: 'switch',
      title: '订阅额度估算',
      description: '按订阅商官方公布档位估算额度消耗（支持 5小时额度与周额度，浮窗明确标注周期）',
      default: true
    },
    quotaWindow: {
      type: 'select',
      title: '额度统计周期',
      description: '选择订阅额度的统计窗口：Google AI Pro / Antigravity 支持 5小时滚动 或 周额度',
      options: [
        { value: '5h', label: '5小时额度 (滚动窗口)' },
        { value: 'weekly', label: '周额度 (每周额度)' },
        { value: 'daily', label: '日额度 (每日额度)' }
      ],
      default: '5h'
    },
    customQuota: {
      type: 'text',
      title: '自定义额度表 (JSON)',
      description: 'JSON 字典覆盖内置额度，如 {"gemini-3.8-pro": 50}（模型名 → 周期请求次数上限）',
      default: '{}'
    }
  },

  async start(ctx) {
    const { settings: s, patcher, cleanup } = ctx;
    const state = freshState();

    // ---- restore persisted stats; legacy keys migrate (copy → new key → clear) ----
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        for (const k of LEGACY_STORAGE_KEYS) {
          const legacy = localStorage.getItem(k);
          if (legacy) {
            raw = legacy;
            try { localStorage.setItem(STORAGE_KEY, legacy); } catch {}
            break;
          }
        }
      }
      for (const k of LEGACY_STORAGE_KEYS) localStorage.removeItem(k);
      const saved = JSON.parse(raw || 'null');
      if (saved && ((saved.session?.turns || 0) > 0 || (saved.lastTurn?.input || 0) > 0 || saved.byTalk)) {
        Object.assign(state.session, saved.session || {});
        state.lastTurn = { ...state.lastTurn, ...(saved.lastTurn || {}) };
        state.byTalk = saved.byTalk || {};
        state.currentModel = saved.currentModel || '';
        state.activeTalkId = saved.activeTalkId ?? null;
      }
    } catch {}

    let persistT = null;
    let liveRefresh = null;
    const persist = () => {
      if (persistT) return;
      persistT = setTimeout(() => {
        persistT = null;
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({
            lastTurn: state.lastTurn,
            session: state.session,
            byTalk: state.byTalk,
            currentModel: state.currentModel,
            activeTalkId: state.activeTalkId
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

    // ---- Optional SQLite authoritative session calibration ----
    const inflightSync = new Map();
    const lastSyncAt = new Map();
    const pendingSyncTimers = new Map();

    const syncTalkFromDb = (talkId) => {
      const tid = String(talkId || '').trim();
      if (!tid || tid === 'draft' || typeof ctx.invoke !== 'function') {
        return Promise.resolve(false);
      }
      if (inflightSync.has(tid)) {
        return inflightSync.get(tid);
      }
      const p = (async () => {
        try {
          lastSyncAt.set(tid, Date.now());
          const res = await ctx.invoke('usage.getSessionStats', { sessionId: tid }).catch(() => null);
          if (!res || !res.ok || !Array.isArray(res.requests)) return false;
          const bucket = buildBucketFromRequests(tid, res.requests, s.get('enableCost', true));
          if (res.requests.length > 0 || !state.byTalk[tid]) {
            state.byTalk[tid] = bucket;
            if (bucket.lastTurn && String(tid) === String(state.activeTalkId ?? '')) {
              state.lastTurn = { ...bucket.lastTurn };
              state.currentModel = bucket.lastTurn.model || state.currentModel;
            }
            syncGlobal();
            return true;
          }
          return false;
        } finally {
          inflightSync.delete(tid);
        }
      })();
      inflightSync.set(tid, p);
      return p;
    };

    const scheduleTalkDbSync = (talkId, delayMs = 250) => {
      const tid = String(talkId || '').trim();
      if (!tid || tid === 'draft') return;
      if (pendingSyncTimers.has(tid)) {
        clearTimeout(pendingSyncTimers.get(tid));
      }
      const timer = setTimeout(() => {
        pendingSyncTimers.delete(tid);
        syncTalkFromDb(tid);
      }, delayMs);
      pendingSyncTimers.set(tid, timer);
    };

    // ---- usage ingestion ----
    const ingestTelemetry = (payload) => {
      try {
        if (!payload) return;
        const domSid = detectDomTalkId();
        let activeChanged = false;
        if (domSid && domSid !== 'draft' && String(domSid) !== String(state.activeTalkId ?? '')) {
          state.activeTalkId = domSid;
          activeChanged = true;
        }
        const ingested = ingestTelemetryPayload(state, payload, {
          enableCost: s.get('enableCost', true),
          updateActiveTalk: !domSid
        });
        if (ingested || activeChanged) {
          syncGlobal();
        }
        if (payload.talkId && payload.talkId !== 'draft') {
          scheduleTalkDbSync(payload.talkId, 250);
        }
      } catch {}
    };

    // ---- telemetry interception ----
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

    /* ---- official usage-popover enhancement ---- */
    const POPOVER_MARK = 'zmod-usage-rows';
    const fmtWan = (n) => {
      n = Number(n) || 0;
      if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
      if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + '万';
      return String(Math.round(n));
    };

    function buildPopoverRows(popEl) {
      const domSid = detectDomTalkId(popEl);
      let switched = false;
      if (domSid && domSid !== 'draft' && String(domSid) !== String(state.activeTalkId ?? '')) {
        state.activeTalkId = domSid;
        switched = true;
      }
      if (domSid && domSid !== 'draft') {
        const prevSync = lastSyncAt.get(domSid) || 0;
        if (switched || !state.byTalk[domSid] || Date.now() - prevSync > 1500) {
          syncTalkFromDb(domSid);
        }
      }

      const { lt, sess } = pickScoped(state, domSid);
      const wrap = document.createElement('div');
      wrap.className = 'flex flex-col gap-1.5 border-t border-border pt-2 mt-2';
      wrap.setAttribute('data-' + POPOVER_MARK, '1');
      const row = (label, value) =>
        `<div class="flex items-baseline justify-between gap-4"><span class="text-ui-sm text-foreground-subtle">${esc(label)}</span><span class="text-ui-sm font-medium tabular-nums text-foreground">${esc(value)}</span></div>`;
      const sessionVal = !sess
        ? '—'
        : sess.totalInput != null
          ? `入 ${fmtWan(sess.totalInput)} / 出 ${fmtWan(sess.outputTokens)} / 命中 ${fmtWan(sess.hitTokens)}`
          : `${sess.turns} 轮 / 共 ${fmtWan(sess.totalTokens)} / 命中 ${fmtWan(sess.hitTokens)}`;
      const costOn = s.get('enableCost', true);
      // 额度行：订阅源（如 Google AI Pro）按 5小时 / 周额度档位估算，周期在标签中明确标出
      let quotaRow = '';
      const quotaModel = (lt && lt.model) || state.currentModel;
      const customQuotaRaw = s.get('customQuota', '{}');
      const quotaWindow = s.get('quotaWindow', '5h');
      const qt = quotaModel ? resolveQuotaTable(quotaModel, customQuotaRaw, quotaWindow) : null;
      const isQuotaModel = Boolean(qt);

      if (s.get('enableQuota', true) && qt) {
        const reqCount = (sess && sess.reqCount) || 0;
        if (reqCount > 0) {
          const pct = calculateQuotaPercent(quotaModel, reqCount, customQuotaRaw, quotaWindow);
          const limit = qt.limit || qt.daily || 1;
          const quotaLabel = `会话额度 (${qt.windowLabel || '5小时额度'})`;
          quotaRow = row(
            quotaLabel,
            `${reqCount} / ${limit} 次 (${pct >= 100 ? '⚠ ' : ''}${pct.toFixed(1)}%)`
          );
        }
      }

      // 互斥铁律：命中订阅额度的模型（如 Google AI Pro 买断订阅源），不显示费用（本轮与会话均不量化金钱）
      const showCost = costOn && !isQuotaModel;
      const turnCostSuffix =
        showCost && lt && (lt.cost || 0) > 0 ? ` · ¥${formatCost(lt.cost)}` : '';
      const sessionCostRow =
        showCost && sess && (sess.totalCost || 0) > 0
          ? row('会话费用估算', '¥' + formatCost(sess.totalCost))
          : '';

      wrap.innerHTML =
        row('本轮', lt && lt.total > 0 ? `入 ${fmtWan(lt.input)} / 出 ${fmtWan(lt.output)}${turnCostSuffix}` : '—') +
        row('本会话', sessionVal) +
        sessionCostRow +
        quotaRow;
      return wrap;
    }

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
        const host = pop.querySelector('[class*="bg-menu"]') || pop.querySelector('[class*="space-y-3"]') || pop;
        const anchor = [...host.children].find((c) => /今日余额/.test(c.textContent || ''));
        const rows = buildPopoverRows(pop);
        if (anchor) host.insertBefore(rows, anchor);
        else host.appendChild(rows);
        console.log('[usage-stats] enhanced official usage popover');
      }
    }
    liveRefresh = () => {
      for (const old of document.querySelectorAll(`[data-${POPOVER_MARK}]`)) {
        if (!old.isConnected) continue;
        const pop = old.closest(POPOVER_SELECTOR);
        old.replaceWith(buildPopoverRows(pop));
      }
    };

    const popObserver = new MutationObserver(() => enhancePopover());
    popObserver.observe(document.body, { childList: true, subtree: true });
    cleanup(() => popObserver.disconnect());

    cleanup(() => {
      try { delete window.__zmod_token_stats__; } catch {}
      if (persistT) clearTimeout(persistT);
      for (const t of pendingSyncTimers.values()) clearTimeout(t);
      pendingSyncTimers.clear();
    });
    console.log('[usage-stats] ready (v1.4.0; telemetry + sqlite calibration)');
  }
});
