import { definePlugin } from '@zmod/sdk';
import {
  buildBucketFromRequests,
  formatCost,
  ingestTelemetryPayload,
  isSubscriptionProvider,
  pickScoped,
  resolveQuotaTable
} from './lib.js';

/**
 * Usage & Token statistics — v2 port of v1 token-monitor (v3.x).
 *
 * Dual-engine session-aware architecture (v1.5.0):
 * 1. Self-contained per-session telemetry state machine (turnsById / stepsSeen)
 *    + DOM session detection ([data-session-id]) + draft isolation;
 * 2. Authoritative SQLite calibration (usage.getSessionStats + usage.getWindowStats RPC)
 *    including child subagent sessions and auxiliary queries;
 * 3. Full-spectrum cost estimation (DeepSeek, Bailian, GLM, Kimi, Claude, GPT, Gemini,
 *    MiniMax, Doubao, Grok) with prompt-cache write multiplier and proxy channel multiplier;
 * 4. Multi-mode quota tracking: real-time Antigravity & Magpie gateway snapshots, plus
 *    cross-session rolling-window quota by requests, spend (¥/$), or tokens.
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
    lastTurn: { hit: 0, miss: 0, input: 0, output: 0, reasoning: 0, total: 0, ratio: 0, cost: 0, equivCost: 0, reqCount: 0, model: '' },
    session: {
      turns: 0, hitTokens: 0, missTokens: 0, totalInput: 0, outputTokens: 0,
      reasoningTokens: 0, totalTokens: 0, totalCost: 0, totalEquivCost: 0, reqCount: 0, avgRatio: 0
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
  version: '1.5.1',
  description: '非侵入拦截客户端遥测统计 Token 消耗/缓存命中（会话感知 + 子代理消耗追踪），全模型费用估算（含 Cache 写入与反代倍率），订阅与按额度消耗统计（跨会话滚动窗口 + Antigravity/Magpie 网关真实余量 + 按次数/金额/Token 多口径）',
  author: 'ZMod Team',

  settings: {
    view: {
      type: 'group',
      title: '展示'
    },
    includeSubagents: {
      type: 'switch',
      title: '计入子代理与辅助查询消耗',
      description: '统计并展示当前会话派生子代理 (Subagent) 的 Token、请求次数与费用',
      default: true
    },
    pricing: {
      type: 'group',
      title: '费用估算'
    },
    enableCost: {
      type: 'switch',
      title: '启用费用估算',
      description: 'DeepSeek 系按官方定价（USD×7 折算、峰谷时段），百炼系按 RMB 固定价，并支持扩展主流模型定价，仅供参考',
      default: true
    },
    extendedPricing: {
      type: 'switch',
      title: '扩展主流模型定价 (Claude/GPT/GLM/Kimi/Gemini)',
      description: '对非买断订阅渠道的 Claude、GPT、GLM、Kimi、MiniMax 等模型启用 API 费用估算（含 Cache 写入溢价）',
      default: true
    },
    priceMultiplier: {
      type: 'number',
      title: '渠道/反代价格倍率',
      description: '反代网关或中转站分组倍率（如 1.0 为官方原价，0.5 为半价渠道）',
      default: 1
    },
    quota: {
      type: 'group',
      title: '额度估算'
    },
    enableQuota: {
      type: 'switch',
      title: '订阅额度估算',
      description: '支持 Antigravity/Magpie 网关真实余量与跨会话滚动窗口额度统计（5小时额度/日额度/周额度）',
      default: true
    },
    quotaWindow: {
      type: 'select',
      title: '额度统计周期',
      description: '选择订阅额度的统计窗口；检测到 Antigravity/Magpie 网关快照时优先显示网关真实余量，否则跨所有会话按此窗口做滚动统计',
      options: [
        { value: '5h', label: '5小时额度 (滚动窗口)' },
        { value: 'weekly', label: '周额度 (每周额度)' },
        { value: 'daily', label: '日额度 (每日额度)' }
      ],
      default: '5h'
    },
    quotaMode: {
      type: 'select',
      title: '本地额度计量口径',
      description: '选择按请求次数、按周期金额消耗、或按周期 Token 消耗统计',
      options: [
        { value: 'auto', label: '自动识别 (订阅按次数 / 自定义单位)' },
        { value: 'requests', label: '按请求次数 (Requests)' },
        { value: 'cost', label: '按周期金额 (¥/$ Spend)' },
        { value: 'tokens', label: '按周期 Token 数' }
      ],
      default: 'auto'
    },
    periodicQuotaLimit: {
      type: 'number',
      title: '通用周期额度上限 (0 为不启用)',
      description: '对未单独配置 customQuota 的模型生效的周期上限（按金额时单位为元，按 Token 时单位为万，按次数时为次数）',
      default: 0
    },
    customQuota: {
      type: 'text',
      title: '自定义额度表 (JSON)',
      description: 'JSON 字典覆盖内置额度，支持次数/金额/Token/通配符，如 {"gemini-3.8-pro": 50, "claude*": "$5", "*": "500w"}',
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

    const getCalcOpts = () => ({
      includeSubagents: s.get('includeSubagents', true),
      extendedPricing: s.get('extendedPricing', true),
      priceMultiplier: Number(s.get('priceMultiplier', 1)) || 1
    });

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
          const calcOpts = getCalcOpts();
          const res = await ctx.invoke('usage.getSessionStats', {
            sessionId: tid,
            includeSubagents: calcOpts.includeSubagents
          }).catch(() => null);
          if (!res || !res.ok || !Array.isArray(res.requests)) return false;
          const bucket = buildBucketFromRequests(tid, res.requests, s.get('enableCost', true), calcOpts);
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
        const calcOpts = getCalcOpts();
        const ingested = ingestTelemetryPayload(state, payload, {
          enableCost: s.get('enableCost', true),
          extendedPricing: calcOpts.extendedPricing,
          priceMultiplier: calcOpts.priceMultiplier,
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
      const enableQuota = s.get('enableQuota', true);
      const quotaModel = (lt && lt.model) || state.currentModel;
      const activeProviderId = (lt && lt.providerId) || '';
      const customQuotaRaw = s.get('customQuota', '{}');
      const quotaWindow = s.get('quotaWindow', '5h');
      const quotaMode = s.get('quotaMode', 'auto');
      const periodicQuotaLimit = Number(s.get('periodicQuotaLimit', 0)) || 0;
      const qt = quotaModel
        ? resolveQuotaTable(quotaModel, customQuotaRaw, quotaWindow, { quotaMode, periodicQuotaLimit })
        : null;

      // 判定是否属于买断/订阅制模型（如 Google AI Pro / Magpie / coding-plan / 按次数订阅）
      const isSub = isSubscriptionProvider(activeProviderId, quotaModel);
      const isBuyoutQuotaModel =
        isSub ||
        Boolean(qt && (!qt.unit || qt.unit === 'requests') && quotaMode !== 'cost');

      const isQuotaModel = enableQuota && (isBuyoutQuotaModel || Boolean(qt));
      const showCost = costOn && !isBuyoutQuotaModel;

      let turnVal = '—';
      let subagentRow = '';
      let sessionCostOrQuotaRow = '';

      if (isQuotaModel) {
        // ---- 订阅 / 额度模式 (Google AI Pro, Magpie 订阅, coding-plan, customQuota 限额) ----
        // 1. 本轮消耗
        if (lt && lt.total > 0) {
          const turnReqs = (lt && lt.reqCount) || 1;
          let suffix = '';
          if (qt && qt.unit === 'cost') {
            const sym = qt.currency === '$' ? '$' : '¥';
            const turnCost = qt.currency === '$' ? (lt.equivCost || lt.cost || 0) / 7 : (lt.equivCost || lt.cost || 0);
            const pct = qt.limit > 0 ? (turnCost / qt.limit) * 100 : 0;
            suffix = ` · ${sym}${formatCost(turnCost)}${qt.limit > 0 ? ` (耗额 ${pct.toFixed(1)}%)` : ''}`;
          } else if (qt && qt.unit === 'tokens') {
            const pct = qt.limit > 0 ? (lt.total / qt.limit) * 100 : 0;
            suffix = qt.limit > 0 ? ` (耗额 ${pct.toFixed(1)}%)` : '';
          } else if (qt && qt.limit > 0) {
            const turnPct = (turnReqs / qt.limit) * 100;
            const eq = lt.equivCost > 0 ? ` · 折合 ¥${formatCost(lt.equivCost)}` : '';
            suffix = ` · ${turnReqs}次 (耗额 ${turnPct.toFixed(1)}%)${eq}`;
          } else if (lt.equivCost > 0) {
            suffix = ` · 折合 ¥${formatCost(lt.equivCost)}`;
          } else if (turnReqs > 1) {
            suffix = ` · ${turnReqs}次`;
          }
          turnVal = `入 ${fmtWan(lt.input)} / 出 ${fmtWan(lt.output)}${suffix}`;
        }

        // 2. 子代理消耗
        if (s.get('includeSubagents', true) && sess && (sess.subagentReqCount || 0) > 0) {
          const eq = sess.subagentEquivCost > 0 ? ` · 折合 ¥${formatCost(sess.subagentEquivCost)}` : '';
          if (qt && qt.limit > 0 && (!qt.unit || qt.unit === 'requests')) {
            const subPct = (sess.subagentReqCount / qt.limit) * 100;
            subagentRow = row(
              '子代理消耗',
              `${sess.subagentReqCount} 次 (耗额 ${subPct.toFixed(1)}%) · 入 ${fmtWan(sess.subagentInput)} / 出 ${fmtWan(sess.subagentOutput)}${eq}`
            );
          } else {
            subagentRow = row(
              '子代理消耗',
              `${sess.subagentReqCount} 次 · 入 ${fmtWan(sess.subagentInput)} / 出 ${fmtWan(sess.subagentOutput)}${eq}`
            );
          }
        }

        // 3. 本会话额度消耗
        if (sess && ((sess.reqCount || 0) > 0 || (sess.totalTokens || 0) > 0)) {
          if (qt && qt.unit === 'cost') {
            const sym = qt.currency === '$' ? '$' : '¥';
            const usedCost = qt.currency === '$' ? (sess.totalEquivCost || sess.totalCost || 0) / 7 : (sess.totalEquivCost || sess.totalCost || 0);
            const pct = qt.limit > 0 ? (usedCost / qt.limit) * 100 : 0;
            sessionCostOrQuotaRow = row(
              '本会话额度消耗',
              `${sym}${formatCost(usedCost)} / ${sym}${qt.limit} (耗额 ${pct.toFixed(1)}%) · ${sess.reqCount || 0} 次`
            );
          } else if (qt && qt.unit === 'tokens') {
            const pct = qt.limit > 0 ? ((sess.totalTokens || 0) / qt.limit) * 100 : 0;
            sessionCostOrQuotaRow = row(
              '本会话额度消耗',
              `${fmtWan(sess.totalTokens)} / ${fmtWan(qt.limit)} (耗额 ${pct.toFixed(1)}%) · ${sess.reqCount || 0} 次`
            );
          } else if (qt && qt.limit > 0) {
            const pct = ((sess.reqCount || 0) / qt.limit) * 100;
            const eqCost = sess.totalEquivCost || 0;
            sessionCostOrQuotaRow = row(
              '本会话额度消耗',
              `共 ${sess.reqCount || 0} 次 (耗额 ${pct.toFixed(1)}%)${eqCost > 0 ? ` · 折合 ¥${formatCost(eqCost)}` : ''}`
            );
          } else {
            const eqCost = sess.totalEquivCost || 0;
            sessionCostOrQuotaRow = row(
              '本会话额度消耗',
              `共 ${sess.reqCount || sess.turns || 0} 次请求${eqCost > 0 ? ` · 折合 ¥${formatCost(eqCost)}` : ''}`
            );
          }
        }
      } else {
        // ---- 按量付费 / API / 代理模型 ----
        // 1. 本轮
        const turnCostSuffix = showCost && lt && (lt.cost || 0) > 0 ? ` · ¥${formatCost(lt.cost)}` : '';
        turnVal = lt && lt.total > 0 ? `入 ${fmtWan(lt.input)} / 出 ${fmtWan(lt.output)}${turnCostSuffix}` : '—';

        // 2. 子代理消耗
        if (s.get('includeSubagents', true) && sess && (sess.subagentReqCount || 0) > 0) {
          subagentRow = row(
            '子代理消耗',
            `${sess.subagentReqCount} 次 · 入 ${fmtWan(sess.subagentInput)} / 出 ${fmtWan(sess.subagentOutput)}${
              showCost && (sess.subagentCost || 0) > 0 ? ` · ¥${formatCost(sess.subagentCost)}` : ''
            }`
          );
        }

        // 3. 本会话花费
        if (showCost && sess && (sess.totalCost || 0) > 0) {
          sessionCostOrQuotaRow = row(
            '本会话花费',
            `¥${formatCost(sess.totalCost)}${sess.reqCount > 0 ? ` (${sess.reqCount} 次请求)` : ''}`
          );
        }
      }

      // 网关真实余量由数据源卡片（quota-popover「模型配额 · Magpie」）统一展示，
      // 这里不再重复渲染——曾在此处维护的 网关余量 行与卡片信息重复，已移除

      wrap.innerHTML =
        row('本轮', turnVal) +
        row('本会话', sessionVal) +
        subagentRow +
        sessionCostOrQuotaRow;
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
        // 浮窗已关闭时 closest 返回 null，迟到 RPC 不应重建崩溃
        if (!pop) continue;
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
    console.log('[usage-stats] ready (v1.5.1; telemetry + sqlite subagents + multi-mode quota + gateway quota)');
  }
});
