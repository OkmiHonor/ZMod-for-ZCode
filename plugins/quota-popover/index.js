import { definePlugin } from '@zmod/sdk';

/**
 * Quota popover + provider-detail quota card — runtime-injected parity of v1's
 * patch-styles-popover. No official file is touched; both surfaces are located
 * by DOM traits (data-testid / data-slot) and re-checked on mutation.
 *
 * Surface 1 (composer 上下文容量 hover-card): append a 今日余额 section,
 *   one card grid per datasource instance — v1 layout (section title + 2-col
 *   big-number cards). Statuses come from the shared 60s-TTL datasource cache.
 * Surface 2 (settings 模型设置 provider detail): inject an account-quota card
 *   between the API Key block and 模型列表, matching provider → datasource
 *   instance by base-URL host(:port) first, then by name overlap. No match →
 *   no card (v1 only decorated providers it had quota data for).
 */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function pctFromValue(v) {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(String(v ?? ''));
  if (!m) return null;
  const n = parseFloat(m[1]);
  return isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

const LEVEL_CLASSES = {
  ok: 'border-emerald-500/20 bg-emerald-500/8 text-emerald-600 dark:text-emerald-400',
  mid: 'border-amber-500/20 bg-amber-500/8 text-amber-600 dark:text-amber-400',
  low: 'border-rose-500/20 bg-rose-500/8 text-rose-600 dark:text-rose-400'
};
const levelOf = (pct) =>
  pct == null ? null : pct >= 50 ? LEVEL_CLASSES.ok : pct >= 20 ? LEVEL_CLASSES.mid : LEVEL_CLASSES.low;

function hostOf(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return '';
  }
}

/** longest common substring length of two normalized strings */
function commonLen(a, b) {
  let best = 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : 0;
      best = Math.max(best, dp[j]);
      prev = tmp;
    }
  }
  return best;
}

/** provider → instance match: base-URL host(:port) equality wins, then a
    ≥4-char normalized name overlap (provider display name vs instance name) */
function matchInstance(providerName, providerBaseUrl, instances) {
  const ph = hostOf(providerBaseUrl);
  if (ph) {
    const byHost = instances.find((i) => hostOf(i.settings?.url) === ph);
    if (byHost) return byHost;
  }
  const pn = String(providerName || '').toLowerCase().replace(/\s+/g, '');
  if (pn.length < 4) return null;
  let best = null, bestLen = 3;
  for (const i of instances) {
    const n = String(i.name || '').toLowerCase().replace(/\s+/g, '');
    if (n.length < 4) continue;
    const l = pn.includes(n) || n.includes(pn) ? Math.min(pn.length, n.length) : commonLen(pn, n);
    if (l > bestLen) { best = i; bestLen = l; }
  }
  return best;
}

/* ---- card builders (official token classes, v1 Bento layout) ---- */

function bigTile(label, value, hint, pct) {
  const lv = levelOf(pct);
  const bar = lv
    ? `<div class="h-1 w-full overflow-hidden rounded-full bg-surface-hover/80"><div class="h-full rounded-full ${lv.dot}" style="width:${pct}%"></div></div>`
    : '';
  return `<div class="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-background/60 px-3.5 py-3">` +
    `<span class="truncate text-ui-sm text-foreground-subtle">${esc(label)}</span>` +
    `<span class="truncate text-lg font-semibold tabular-nums text-foreground">${esc(value)}</span>` +
    bar +
    (hint ? `<span class="truncate text-ui-xs text-foreground-subtle">${esc(hint)}</span>` : '') +
    `</div>`;
}

function pillFor(row) {
  const pct = pctFromValue(row.value);
  const cls = levelOf(pct) || 'border-border bg-surface text-foreground-subtle';
  const dot = levelOf(pct) ? `<span class="inline-block size-1.5 rounded-full ${levelOf(pct) === LEVEL_CLASSES.ok ? 'bg-emerald-500' : levelOf(pct) === LEVEL_CLASSES.mid ? 'bg-amber-500' : 'bg-rose-500'}"></span>` : '';
  return `<span class="inline-flex h-5 max-w-full items-center gap-1.5 rounded-md border px-1.5 font-mono text-[11px] font-medium select-none ${cls}" title="${esc(row.label)}">` +
    `${dot}<span class="truncate leading-none">${esc(row.value)}</span></span>`;
}

/** All rows are percentages (≥3) → compact pill cloud (antigravity shape);
    otherwise balance/rows render as big-number tiles (deepseek/bailian shape). */
function instanceCardBody(status) {
  if (!status) return `<div class="text-ui-sm text-foreground-subtle">状态查询中…</div>`;
  if (!status.ok) return `<div class="text-ui-sm text-foreground-subtle">${esc(status.message || '查询失败')}</div>`;
  const rows = status.rows || [];
  const allPct = rows.length >= 3 && rows.every((r) => pctFromValue(r.value) != null);
  if (allPct) {
    return `<div class="flex flex-wrap items-center gap-1.5">${rows.map(pillFor).join('')}</div>`;
  }
  let html = '';
  if (status.balance != null) html += bigTile('账户余额', `${status.currency || ''}${status.balance}`);
  for (const r of rows.slice(0, 6)) {
    const pct = pctFromValue(r.value);
    if (pct != null) {
      const reset = /(\d{1,2}月\d{1,2}日)/.exec(r.value)?.[1] || '';
      html += bigTile(r.label, pct + '%', reset, pct);
    } else {
      html += bigTile(r.label, r.value);
    }
  }
  return `<div class="grid grid-cols-2 gap-2">${html}</div>`;
}

const REFRESH_MARK = 'zmod-quota-refresh';

export default definePlugin({
  id: 'quota-popover',
  name: '余量弹窗与模型页余量',
  version: '2.0.0',
  description: '官方「上下文容量」浮窗追加今日余额卡 + 官方设置模型页供应商详情注入账户额度卡（数据源驱动，v1 视觉对齐）',
  author: 'ZMod Team',

  async start(ctx) {
    const { cleanup } = ctx;
    const ds = ctx.datasources;
    if (!ds) {
      console.warn('[quota-popover] datasource API unavailable — plugin idle');
      return;
    }

    let snapshot = []; // { inst, status? }
    let snapshotAt = 0;
    async function refreshSnapshot(force) {
      const insts = ds.getInstances();
      snapshot = await Promise.all(
        insts.map(async (inst) => ({
          inst,
          status: await ds.getStatus(inst.id, force ? { force: true } : undefined).catch(() => null)
        }))
      );
      snapshotAt = Date.now();
    }
    const snapAfter = async (minAgeMs) => {
      if (Date.now() - snapshotAt > minAgeMs) await refreshSnapshot(false).catch(() => {});
    };

    /* ================= Surface 1: composer hover-card ================= */
    const POPOVER_MARK = 'zmod-quota-cards';
    /* only the composer capacity hover-card — generic popover/menu surfaces
       (dropdowns, settings popovers containing the word 用量) must not receive cards */
    const POPOVER_SELECTOR = '[data-slot="hover-card-content"]';

    /* Current composer selection: the toolbar model-selector button carries
       "供应商名/模型名  effort" in its aria-label — the same display name the
       settings detail header shows, so instance matching stays consistent. */
    function currentSelection() {
      for (const gauge of document.querySelectorAll('[data-slot="hover-card-trigger"]')) {
        if (!/上下文/.test(gauge.getAttribute('aria-label') || '')) continue;
        let bar = gauge;
        for (let i = 0; i < 6 && bar.parentElement; i++) {
          bar = bar.parentElement;
          if (bar.querySelectorAll('button').length > 3) break;
        }
        for (const btn of bar.querySelectorAll('button')) {
          const label = (btn.getAttribute('aria-label') || '').trim();
          // the gauge's own label ("上下文已用 12,345 / 总量 …") also contains a
          // slash — only the model selector has "provider/model effort" shape;
          // the preset-provider case drops the prefix ("GLM-5.3-Flash 低")
          if (/上下文已用|^添加上下文$|^切换模式$|^电脑操作$|^发送$/.test(label)) continue;
          const m = /^(.+)\/(.+?)\s*(?:极高|高|中|低)?$/.exec(label);
          if (m) return { provider: m[1].trim(), model: m[2].trim() };
          if (/.+\s(?:极高|高|中|低)$/.test(label)) {
            return { provider: '', model: label.replace(/\s+(极高|高|中|低)$/, '').trim() };
          }
        }
      }
      return null;
    }

    /** Which instance follows the current selection: explicit keywords →
        provider-name overlap → model-name match in antigravity status data. */
    function matchSelection(sel) {
      if (!sel) return null;
      const kw = (i) => String(i.settings?.modelKeywords || '').split(/[,，]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      const hay = (sel.provider + ' ' + sel.model).toLowerCase();
      for (const { inst } of snapshot) {
        if (kw(inst).some((k) => hay.includes(k))) return inst;
      }
      const byName = matchInstance(sel.provider, '', snapshot.map((s) => s.inst));
      if (byName) return byName;
      for (const { inst, status } of snapshot) {
        if ((status?.models || []).some((m) => m.name === sel.model.toLowerCase() || sel.model.toLowerCase().includes(m.name))) return inst;
      }
      return null;
    }

    function buildPopoverBlock(hasOfficialBalance) {
      /* v1 whitelist parity: when the official GLM 今日余额 card renders,
         v1's patch returned early — no ZMod balance section alongside it */
      if (hasOfficialBalance) return null;
      /* v1 behavior: only the source matching the current provider/model is
         shown; unmatched selections render no balance section at all */
      const sel = currentSelection();
      const inst = matchSelection(sel);
      if (!inst) return null;
      const status = snapshot.find((s) => s.inst.id === inst.id)?.status;
      const wrap = document.createElement('div');
      wrap.className = 'flex flex-col gap-2.5 border-t border-border pt-2.5 mt-2.5';
      wrap.setAttribute('data-' + POPOVER_MARK, '1');
      const head =
        `<div class="flex items-center justify-between gap-3">` +
        `<span class="text-ui-sm font-medium text-foreground">${esc(inst.name)}</span>` +
        `<span class="text-ui-xs text-foreground-subtle">${esc(sel ? sel.provider : inst.type)}</span></div>`;
      let body;
      if (!status) body = `<div class="text-ui-sm text-foreground-subtle">状态查询中…</div>`;
      else if (!status.ok) body = `<div class="text-ui-sm text-foreground-subtle">${esc(status.message || '查询失败')}</div>`;
      else {
        const tiles = [];
        if (status.balance != null) tiles.push(bigTile('账户余额', `${status.currency || ''}${status.balance}`));
        for (const r of (status.rows || []).slice(0, 6)) {
          const pct = pctFromValue(r.value);
          if (pct != null) {
            // "98.9% 剩余 · 10月31日重置" → big "98.9%" + progress bar + hint
            const reset = /(\d{1,2}月\d{1,2}日)/.exec(r.value)?.[1] || '';
            tiles.push(bigTile(r.label, pct + '%', reset, pct));
          } else {
            tiles.push(bigTile(r.label, r.value));
          }
        }
        body = `<div class="grid grid-cols-2 gap-2">${tiles.join('')}</div>`;
      }
      wrap.innerHTML = head + body;
      return wrap;
    }

    async function enhancePopovers() {
      const pops = [...document.querySelectorAll(POPOVER_SELECTOR)].filter(
        (p) => p.isConnected && !p.querySelector(`[data-${POPOVER_MARK}]`) && /上下文|今日余额|命中率/.test(p.textContent || '')
      );
      if (pops.length === 0) return;
      await snapAfter(15000);
      for (const pop of pops) {
        const text = pop.textContent || '';
        const hasOfficialBalance = /今日余额/.test(text) && /\d{1,2}月\d{1,2}日/.test(text);
        const block = buildPopoverBlock(hasOfficialBalance);
        if (!block) continue;
        const host = pop.querySelector('[class*="flex-col"]')?.lastElementChild?.parentElement || pop;
        host.appendChild(block);
        console.log('[quota-popover] appended balance cards to official popover');
      }
    }

    /* ============ Surface 2: provider detail account-quota card ============ */
    const DETAIL_MARK = 'zmod-provider-quota';

    function buildDetailCard(inst, status) {
      const card = document.createElement('div');
      card.setAttribute('data-' + DETAIL_MARK, inst.id);
      card.dataset.snapshotAt = String(snapshotAt || 0);
      card.className = 'rounded-xl border border-border bg-surface/40 p-4';
      const total = status && status.ok && status.balance != null ? `可用总额: ${status.currency || ''}${status.balance}` : '';
      const title = /额度$/.test(inst.name) ? inst.name : inst.name + '账户额度';
      card.innerHTML =
        `<div class="flex items-center justify-between gap-3 pb-2">` +
        `<div class="flex min-w-0 items-baseline gap-2">` +
        `<span class="text-ui-base font-semibold text-foreground">${esc(title)}</span>` +
        `<span class="text-ui-xs text-foreground-subtle">${esc(total)}</span></div>` +
        `<button type="button" data-${REFRESH_MARK}="${inst.id}" class="inline-flex h-7 shrink-0 items-center rounded-md border border-border px-2.5 text-ui-sm text-foreground-subtle hover:bg-surface-hover hover:text-foreground">刷新</button>` +
        `</div>${instanceCardBody(status)}` +
        `<div class="pt-1.5 text-ui-xs text-foreground-subtle/70">ZMod 数据源 · ${status && status.ok ? '更新于 ' + new Date(snapshotAt).toLocaleTimeString() : esc(status?.message || '查询失败')}</div>`;
      card.querySelector(`[data-${REFRESH_MARK}]`)?.addEventListener('click', async () => {
        await refreshSnapshot(true).catch(() => {});
        rerenderDetail();
      });
      return card;
    }

    function detailTargets() {
      // one target per open model-settings detail pane
      const scrolls = [...document.querySelectorAll('[data-model-provider-detail-scroll]')].filter((s) => s.isConnected);
      const out = [];
      for (const scroll of scrolls) {
        const name = scroll.querySelector('[data-testid="model-provider-header"] .text-ui-lg, [data-testid="model-provider-header"] [class*="font-semibold"]')?.textContent?.trim();
        const baseUrl = scroll.querySelector('[data-testid="model-provider-base-url-input"]')?.value || '';
        // insert before the 模型列表 block (its header span sits in a flex row)
        const modelListRow = [...scroll.querySelectorAll('span.text-ui-base')].find((s) => s.textContent.trim() === '模型列表');
        const insertBefore = modelListRow?.closest('div');
        out.push({ scroll, name, baseUrl, insertBefore });
      }
      return out;
    }

    function rerenderDetail() {
      for (const t of detailTargets()) {
        // transient React states may briefly hide name/baseUrl — skipping (not
        // removing) on those avoids flapping the card out of the DOM
        if (!t.name && !t.baseUrl) continue;
        const inst = matchInstance(t.name, t.baseUrl, snapshot.map((s) => s.inst));
        const existing = t.scroll.querySelector(`[data-${DETAIL_MARK}]`);
        if (!inst) {
          existing?.remove();
          continue;
        }
        const status = snapshot.find((s) => s.inst.id === inst.id)?.status;
        const fresh = buildDetailCard(inst, status);
        if (existing) existing.replaceWith(fresh);
        else if (t.insertBefore && t.insertBefore.parentElement) {
          t.insertBefore.parentElement.insertBefore(fresh, t.insertBefore);
          console.log('[quota-popover] injected account-quota card for provider', t.name, '→ instance', inst.id);
        }
      }
    }

    async function enhanceSettings() {
      const targets = detailTargets();
      if (targets.length === 0) return;
      await snapAfter(15000);
      for (const t of targets) {
        if (!t.name && !t.baseUrl) continue;
        const inst = matchInstance(t.name, t.baseUrl, snapshot.map((s) => s.inst));
        const existing = t.scroll.querySelector(`[data-${DETAIL_MARK}]`);
        if (!inst) {
          existing?.remove();
          continue;
        }
        if (existing && existing.getAttribute(`data-${DETAIL_MARK}`) === inst.id && Number(existing.dataset.snapshotAt || 0) === snapshotAt) continue;
        const status = snapshot.find((s) => s.inst.id === inst.id)?.status;
        const fresh = buildDetailCard(inst, status);
        if (existing) existing.replaceWith(fresh);
        else if (t.insertBefore && t.insertBefore.parentElement) {
          t.insertBefore.parentElement.insertBefore(fresh, t.insertBefore);
          console.log('[quota-popover] injected account-quota card for provider', t.name, '→ instance', inst.id);
        }
      }
    }

    /* re-render pass shared by both surfaces; snapshot refresh is TTL-gated so
       mutations never burst requests; the refresh button forces one on demand */
    let scheduled = false;
    function onMutation() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        Promise.allSettled([enhancePopovers(), enhanceSettings()]).catch(() => {});
      });
    }
    const observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['value'] });
    cleanup(() => observer.disconnect());

    // Base URL is a controlled React input — poll lightly instead of relying
    // on mutation events for value edits while the settings dialog is open
    const pollT = setInterval(() => {
      if (document.querySelector('[data-model-provider-detail-scroll]')) onMutation();
    }, 1500);
    cleanup(() => clearInterval(pollT));

    await refreshSnapshot(false).catch(() => {});
    console.log('[quota-popover] armed (popover cards + provider-detail quota card)');
  }
});
