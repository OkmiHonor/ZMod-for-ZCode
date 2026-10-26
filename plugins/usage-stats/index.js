import { definePlugin } from '@zmod/sdk';
import {
  ingestTelemetryPayload,
  pickScoped
} from './lib.js';

/**
 * Usage & Token statistics — v2 port of v1 token-monitor (v3.x).
 *
 * 100% self-contained in the plugin (zero core/main-process changes required):
 * - DOM session detection ([data-session-id]) + draft isolation;
 * - Per-talk buckets (byTalk) with isolated per-turn state (turnsById / stepsSeen)
 *   so concurrent background sessions never clobber the active session or
 *   inflate turn counts, and Ctrl+R reloads never double-count message_completion.
 */

const STORAGE_KEY = 'zmod_token_stats_v2_2';
const LEGACY_STORAGE_KEYS = ['zmod_token_stats_v2_1'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
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
  version: '1.3.0',
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

    // ---- purge legacy dirty cache & restore persisted stats ----
    try {
      for (const k of LEGACY_STORAGE_KEYS) {
        localStorage.removeItem(k);
      }
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
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

    // ---- usage ingestion (100% in-plugin, per-session isolated) ----
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
      if (domSid && domSid !== 'draft' && String(domSid) !== String(state.activeTalkId ?? '')) {
        state.activeTalkId = domSid;
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
      wrap.innerHTML =
        row('本轮', lt && lt.total > 0 ? `入 ${fmtWan(lt.input)} / 出 ${fmtWan(lt.output)}` : '—') +
        row('本会话', sessionVal) +
        (s.get('enableCost', true) && sess && (sess.totalCost || 0) > 0
          ? row('会话费用估算', '¥' + sess.totalCost.toFixed(3))
          : '');
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
    });
    console.log('[usage-stats] ready (v1.3.0; self-contained per-session telemetry)');
  }
});
