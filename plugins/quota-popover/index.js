import { definePlugin } from '@zmod/sdk';
import { matchInstance, matchSelection, parseModelButtonLabel } from './lib.js';

/**
 * Quota popover + provider-detail quota card — runtime-injected parity of v1's
 * patch-styles-popover. No official file is touched; both surfaces are located
 * by DOM traits (data-testid / data-slot) and re-checked on mutation.
 *
 * Surface 1 (composer 上下文容量 hover-card): append a 今日余额 section in
 *   v1 token-monitor v3.8.1 card semantics — DS-console dark cards (balCard),
 *   platform link rows (balWrap), official-style quota bars (quotaCard) and
 *   infoCard text states, matched to the current selection like v1. Statuses
 *   come from the shared TTL datasource cache.
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

/* ---- v1 detail-card kit (Bento provider quota card, 1:1 of v1
   __zmodProviderQuotaCard) with two refinements over v1: the voucher footnote
   stays on one line (v1 wrapped mid-sentence, orphaning 到期) and amounts
   never wrap mid-number ---- */

function pctClass(p) {
  return p >= 50
    ? { text: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500' }
    : p >= 20
      ? { text: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500' }
      : { text: 'text-rose-600 dark:text-rose-400', bar: 'bg-rose-500' };
}

function fmtDateCN(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  } catch { return ''; }
}

/** v1 mkBar: mono label + colored % + h-1.5 track with colored fill */
function barRow(label, pct) {
  const c = pctClass(pct);
  return (
    `<div class="space-y-1">` +
    `<div class="flex items-center justify-between text-[11px] font-mono text-foreground-subtle">` +
    `<span>${esc(label)}</span><span class="font-semibold ${c.text}">${pct}%</span></div>` +
    `<div class="h-1.5 w-full rounded-full bg-surface-hover/80 overflow-hidden">` +
    `<div class="h-full rounded-full transition-all duration-300 ${c.bar}" style="width:${pct}%"></div>` +
    `</div></div>`
  );
}

/** 'N 张 · 最近 YYYY-MM-DD 到期' → 'N 张专属券 · 最近 M月D日到期' (single line) */
function voucherSub(detail) {
  const m = /^(\d+)\s*张\s*·\s*最近\s*(\d{4})-(\d{2})-(\d{2})\s*到期$/.exec(String(detail || '').trim());
  if (!m) return String(detail || '');
  return `${m[1]} 张专属券 · 最近 ${+m[3]}月${+m[4]}日到期`;
}

function bentoSubCard(title, value, opts = {}) {
  const boxCls = opts.accent ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-border/60 bg-surface-hover/20';
  const textCls = opts.accent ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground';
  const titleCls = opts.accent ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground-subtle';
  return (
    `<div class="rounded-lg border ${boxCls} p-3 space-y-1 min-w-0">` +
    `<div class="text-[11px] font-medium ${titleCls}">${esc(title)}</div>` +
    `<div class="text-ui-xl font-bold font-mono tracking-tight whitespace-nowrap ${textCls}">${esc(value)}</div>` +
    (opts.foot ? `<div class="text-[10px] text-foreground-subtle truncate">${esc(opts.foot)}</div>` : '') +
    `</div>`
  );
}

/** v1 Bento body per datasource type (user ruling 2026-10-25: the settings
    detail card follows v1's Bento form; small v1 flaws smoothed over) */
function renderV1DetailBody(type, status) {
  if (!status) return `<div class="text-ui-sm text-foreground-subtle">状态查询中…</div>`;
  if (!status.ok) return `<div class="text-ui-sm text-foreground-subtle">${esc(status.message || '查询失败')}</div>`;
  const rows = status.rows || [];
  if (type === 'antigravity') {
    const groupCards = (status.groups || []).map((g) => {
      const b5 = (g.buckets || []).find((b) => b.window === '5h');
      const bw = (g.buckets || []).find((b) => b.window === 'weekly');
      const p5 = b5 ? Math.max(0, Math.min(100, Math.round(b5.frac * 100))) : null;
      const pw = bw ? Math.max(0, Math.min(100, Math.round(bw.frac * 100))) : null;
      const resetStr = b5 && b5.reset ? fmtDateCN(b5.reset) : bw && bw.reset ? fmtDateCN(bw.reset) : '';
      return (
        `<div class="flex-1 min-w-[210px] rounded-lg border border-border/60 bg-surface-hover/20 p-3 flex flex-col justify-between gap-2.5 hover:border-border transition-colors">` +
        `<div class="flex items-center justify-between">` +
        `<span class="text-ui-xs font-semibold text-foreground tracking-tight">${esc(g.name || '配额组')}</span>` +
        (resetStr ? `<span class="text-[11px] font-mono text-foreground-subtle">${esc(resetStr)}</span>` : '') +
        `</div>` +
        `<div class="space-y-2">${p5 !== null ? barRow('5小时滚动限额', p5) : ''}${pw !== null ? barRow('每周可用总额', pw) : ''}</div>` +
        `</div>`
      );
    }).join('');
    if (groupCards) return `<div class="flex flex-wrap gap-2.5">${groupCards}</div>`;
    return `<div class="text-ui-sm text-foreground-subtle">配额组里没有可用桶</div>`;
  }
  if (type === 'deepseek') {
    const total = parseFloat(status.balance) || 0;
    const grant = numFrom(rowValue(rows, '赠送余额'));
    const top = numFrom(rowValue(rows, '充值余额'));
    const cur = status.currency || '¥';
    if (grant > 0) {
      return `<div class="grid grid-cols-2 gap-3 max-sm:grid-cols-1">` +
        bentoSubCard('充值余额 (永久有效)', `${cur} ${top.toFixed(2)}`) +
        bentoSubCard('赠送余额', `${cur} ${grant.toFixed(2)}`, { accent: true }) +
        `</div>`;
    }
    return (
      `<div class="rounded-lg border border-border/60 bg-surface-hover/20 p-3 flex items-baseline justify-between">` +
      `<div class="space-y-0.5">` +
      `<div class="text-[11px] text-foreground-subtle font-medium">当前可用余额 (按量扣减)</div>` +
      `<div class="text-ui-2xl font-bold font-mono tracking-tight text-foreground">${esc(cur)} ${total.toFixed(2)} <span class="text-ui-sm font-normal text-foreground-subtle">${esc(codeOf(status))}</span></div>` +
      `</div>` +
      `<span class="text-ui-xs text-foreground-subtle font-mono">API 直连</span></div>`
    );
  }
  if (type === 'bailian-bss') {
    const avail = parseFloat(status.balance) || 0;
    const voucher = numFrom(rowValue(rows, '可用代金券'));
    const detail = rowValue(rows, '代金券明细');
    return `<div class="grid grid-cols-2 gap-3 max-sm:grid-cols-1">` +
      bentoSubCard('现金可用余额 (实时)', `${status.currency || '¥'} ${avail.toFixed(2)}`, { foot: '按量付费账单抵扣' }) +
      (isFinite(voucher) && voucher > 0
        ? bentoSubCard('有效代金券 (优先抵扣)', `${status.currency || '¥'} ${voucher.toFixed(2)}`, { accent: true, foot: voucherSub(detail) })
        : '') +
      `</div>`;
  }
  // generic engines: label/value lines in a Bento sub-card
  const lines = (status.balance != null
    ? [{ label: '余额', value: `${status.currency || ''}${money(status.balance)}` }, ...rows]
    : rows
  ).slice(0, 8)
    .map((r) => `<div class="flex items-baseline justify-between gap-3"><span class="text-ui-sm text-foreground-subtle">${esc(r.label)}</span><span class="text-ui-sm font-medium tabular-nums text-foreground">${esc(r.value)}</span></div>`)
    .join('');
  return `<div class="rounded-lg border border-border/60 bg-surface-hover/20 p-3 space-y-1.5">${lines || '<div class="text-ui-sm text-foreground-subtle">无数据行</div>'}</div>`;
}

/* ================= v1 balance-card kit =================
   1:1 port of v1 token-monitor v3.8.1 popover helpers (patch-styles-popover
   HELPERS balCard/balWrap/cardWrap/quotaCard/infoCard). Inline styles are kept
   byte-identical — the popover's tailwind has no arbitrary-value classes, so
   v1 shipped these as inline styles and so do we. */

const PLAT_LINKS = {
  deepseek: { name: 'DeepSeek 开放平台', url: 'https://platform.deepseek.com/usage' },
  mimo: { name: '小米 MiMo 开放平台', url: 'https://platform.xiaomimimo.com/console/usage' },
  bailian: { name: '阿里云百炼', url: 'https://billing-cost.console.aliyun.com/' }
};

function pf(x) {
  try {
    return new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 1 }).format(x);
  } catch { return Math.round((Number(x) || 0) * 100) + '%'; }
}

function fmtReset(iso) {
  try {
    const t = Date.parse(iso);
    if (!isFinite(t)) return null;
    const d = t - Date.now();
    if (d <= 0) return '已刷新';
    const h = d / 3600000;
    if (h < 1) return Math.max(1, Math.round(d / 60000)) + '分钟后刷新';
    if (h < 48) return Math.round(h) + '小时后刷新';
    return Math.round(h / 24) + '天后刷新';
  } catch { return null; }
}

/** v1 balCard: dark rounded card, 11px title / 18px amount / 10px currency+sub */
function balCard(title, num, cur, sub) {
  return (
    `<div style="background:#2c2d2f;border-radius:10px;padding:10px 14px 12px;min-width:0">` +
    `<div style="font-size:11px;color:#b9bcc1;line-height:1.3">${esc(title)}</div>` +
    `<div style="margin-top:3px;display:flex;align-items:baseline;gap:4px;min-width:0">` +
    `<span style="font-size:18px;font-weight:600;color:#ffffff;letter-spacing:0.3px;font-variant-numeric:tabular-nums">${esc(num)}</span>` +
    (cur ? `<span style="font-size:10px;color:#8a8d92">${esc(cur)}</span>` : '') +
    `</div>` +
    (sub ? `<div style="margin-top:2px;font-size:10px;color:#9aa0a6">${esc(sub)}</div>` : '') +
    `</div>`
  );
}

/** v1 balWrap: optional platform link row + compact card grid */
function balWrap(cards, plat) {
  const list = cards.filter(Boolean);
  if (!list.length) return '';
  let html = '';
  if (plat && plat.name && plat.url) {
    html += `<div class="zmod-bal-pl"><a data-zmod-url="${esc(plat.url)}">${esc(plat.name)} ↗</a></div>`;
  }
  html += `<div style="display:grid;grid-template-columns:${list.length > 1 ? '1fr 1fr' : '1fr'};gap:8px">${list.join('')}</div>`;
  return html;
}

/** v1 cardWrap: sep border + section title + tailwind grid (info/quota cards) */
function v1CardWrap(title, cards, cols) {
  return (
    `<div class="border-t border-border pt-2">` +
    `<div class="mb-2 flex min-w-0 items-center gap-3">` +
    `<div class="flex min-w-0 flex-1 items-center gap-1.5">` +
    `<span class="min-w-0 truncate text-ui-base font-medium text-foreground">${esc(title)}</span>` +
    `</div></div>` +
    `<div class="grid gap-2 ${cols > 1 ? 'grid-cols-2' : 'grid-cols-1'}">${cards.join('')}</div>` +
    `</div>`
  );
}

/** v1 quotaCard: official Cmt 1:1 (subtle label + mono percent + green bar) */
function v1QuotaCard(label, frac, resetIso) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  const reset = resetIso ? fmtReset(resetIso) : null;
  return (
    `<div class="min-w-0 space-y-1.5">` +
    `<div class="min-w-0 space-y-0.5 text-ui-sm">` +
    `<div class="min-w-0 truncate text-foreground-subtle">${esc(label)}</div>` +
    `<div class="min-w-0 text-ui-sm tabular-nums">` +
    `<span class="font-mono text-foreground">${esc(pf(f))}</span>` +
    (reset ? `<span class="text-foreground-subtle"> · ${esc(reset)}</span>` : '') +
    `</div></div>` +
    `<div class="h-1.5 overflow-hidden rounded-full bg-surface-hover">` +
    `<div class="h-full rounded-full bg-success transition-[width] duration-500 ease-out motion-reduce:transition-none" style="width:${f * 100}%"></div>` +
    `</div></div>`
  );
}

/** v1 infoCard: subtle label + mono value text row (error/unconfigured states) */
function v1InfoCard(label, value) {
  return (
    `<div class="min-w-0 space-y-1.5">` +
    `<div class="min-w-0 truncate text-foreground-subtle text-ui-sm">${esc(label)}</div>` +
    `<div class="min-w-0 text-ui-sm tabular-nums">` +
    `<span class="font-mono text-foreground">${esc(value)}</span>` +
    `</div></div>`
  );
}

function rowValue(rows, label) {
  const r = (rows || []).find((x) => x && x.label === label);
  return r ? String(r.value) : null;
}

function money(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n.toFixed(2) : null;
}

/** tolerant numeric extraction — row values may carry currency prefixes (¥255.77) */
function numFrom(v) {
  const m = /-?\d+(?:\.\d+)?/.exec(String(v ?? ''));
  return m ? parseFloat(m[0]) : NaN;
}

function codeOf(status) {
  return String(status.currency || '¥') === '¥' ? 'CNY' : String(status.currency || '').toUpperCase();
}

function signOf(status) {
  return codeOf(status) === 'USD' ? '$' : '¥';
}

function agWinLabel(b) {
  const w = String(b.window || '').toLowerCase();
  if (w === '5h') return '5小时滚动';
  if (w === 'weekly') return '每周';
  if (w === 'daily') return '每日';
  if (w === 'monthly') return '每月';
  return w || '窗口';
}

const ERROR_TITLES = {
  deepseek: '账户余额 · DeepSeek',
  mimo: '今日余额 · MiMo',
  'bailian-bss': '账户余额 · 阿里云百炼',
  antigravity: '模型配额 · Antigravity'
};

/** Render one datasource instance's popover section in v1 card semantics:
    branded types get the v1 balance/quota cards, error/unconfigured states get
    the v1 infoCard text rows, unknown types fall back to v1 cardWrap layout. */
function renderV1Section(type, status, sel, instName) {
  if (!status) {
    return v1CardWrap('今日余额', [v1InfoCard('状态', '查询中…（首次刷新未完成）')], 1);
  }
  if (!status.ok) {
    return v1CardWrap(ERROR_TITLES[type] || '今日余额 · ' + (instName || type), [v1InfoCard('状态', status.message || '查询失败')], 1);
  }
  const rows = status.rows || [];
  if (type === 'deepseek') {
    const total = money(status.balance);
    if (total == null) {
      return v1CardWrap(ERROR_TITLES.deepseek, [v1InfoCard('状态', '余额数据为空')], 1);
    }
    const sign = signOf(status), code = codeOf(status);
    const grant = parseFloat(rowValue(rows, '赠送余额')) || 0;
    const top = parseFloat(rowValue(rows, '充值余额')) || 0;
    if (grant > 0) {
      return balWrap([
        balCard('充值余额', sign + (top > 0 ? top : Math.max(0, parseFloat(total) - grant)).toFixed(2), code),
        balCard('赠送余额', sign + grant.toFixed(2), code)
      ], PLAT_LINKS.deepseek);
    }
    return balWrap([balCard('余额', sign + parseFloat(total).toFixed(2), code)], PLAT_LINKS.deepseek);
  }
  if (type === 'mimo') {
    const total = money(status.balance);
    if (total == null) {
      return v1CardWrap(ERROR_TITLES.mimo, [v1InfoCard('状态', '余额数据为空')], 1);
    }
    const sign = signOf(status), code = codeOf(status);
    const cards = [balCard('账户余额', sign + parseFloat(total).toFixed(2), code)];
    const cost = rowValue(rows, '本月消费');
    if (cost != null) {
      const tok = rowValue(rows, '本月 Token');
      cards.push(balCard('本月消费', String(cost), code, tok ? tok + ' tok' : null));
    }
    return balWrap(cards, PLAT_LINKS.mimo);
  }
  if (type === 'bailian-bss') {
    const total = money(status.balance);
    if (total == null) {
      return v1CardWrap(ERROR_TITLES['bailian-bss'], [v1InfoCard('状态', '余额数据为空')], 1);
    }
    const sign = signOf(status);
    const cards = [balCard('现金余额', sign + parseFloat(total).toFixed(2), 'CNY')];
    const voucher = numFrom(rowValue(rows, '可用代金券'));
    const detail = rowValue(rows, '代金券明细');
    // v1 rule: an empty voucher card carries no information — single card then
    if (isFinite(voucher) && (voucher > 0 || detail)) {
      cards.push(balCard('可用代金券', sign + voucher.toFixed(2), 'CNY', detail || null));
    }
    return balWrap(cards, PLAT_LINKS.bailian);
  }
  if (type === 'antigravity') {
    const groups = status.groups || [];
    const model = String((sel && sel.model) || '').toLowerCase();
    const wantArgon = /argon/i.test(model);
    const wantC = /claude|gpt|opus|sonnet/i.test(model);
    const wantG = /gemini|google/i.test(model);
    let selGroup = null;
    if (wantArgon) {
      selGroup = groups.find((g) => /argon/i.test(g.name));
    }
    if (!selGroup && wantC) {
      selGroup = groups.find((g) => /claude|gpt/i.test(g.name));
    }
    if (!selGroup && wantG) {
      selGroup = groups.find((g) => /gemini|google/i.test(g.name) && !/argon/i.test(g.name));
    }
    const cards = [];
    if (selGroup) {
      for (const b of selGroup.buckets || []) cards.push(v1QuotaCard(agWinLabel(b), b.frac, b.reset));
    } else {
      // model unknown → one weekly bar per group (v1 degraded layout)
      for (const g of groups) {
        for (const b of g.buckets || []) {
          if (String(b.window || '').toLowerCase() === 'weekly') {
            cards.push(v1QuotaCard((g.name || '配额组') + ' · 每周', b.frac, b.reset));
          }
        }
      }
    }
    if (cards.length) {
      return v1CardWrap('模型配额 · ' + (selGroup ? selGroup.name || 'Antigravity' : 'Antigravity'), cards, cards.length > 1 ? 2 : 1);
    }
    return v1CardWrap(ERROR_TITLES.antigravity, [v1InfoCard('状态', '配额组里没有可用桶')], 1);
  }
  // generic engines (custom-http / openai-compatible / console-web): v1 never
  // had a family for these — keep its typography (balCard + infoCard rows)
  const cards = [];
  if (status.balance != null) {
    cards.push(balCard('余额', String(status.currency || '¥') + money(status.balance), codeOf(status)));
  }
  for (const r of rows.slice(0, 6)) {
    if (r && r.label) cards.push(v1InfoCard(r.label, String(r.value)));
  }
  if (cards.length) {
    return v1CardWrap('今日余额 · ' + (instName || type), cards, cards.length > 1 ? 2 : 1);
  }
  return v1CardWrap('今日余额 · ' + (instName || type), [v1InfoCard('状态', '无数据行')], 1);
}

const REFRESH_MARK = 'zmod-quota-refresh';

export default definePlugin({
  id: 'quota-popover',
  name: '余量弹窗与模型页余量',
  version: '1.4.1',
  description: '官方「上下文容量」浮窗追加今日余额卡（v1 token-monitor 卡片语义 1:1）+ 官方设置模型页供应商详情注入 v1 Bento 账户额度卡（数据源驱动，不改官方文件）',
  author: 'ZMod Team',

  settings: {
    refresh: {
      type: 'group',
      title: '刷新'
    },
    popoverRefresh: {
      type: 'switch',
      title: '弹出余量卡时实时刷新',
      description: '鼠标移入输入框小圆圈、余量卡弹出的瞬间强制造一次实时刷新（绕过数据源 TTL 缓存），只刷新当前匹配的实例',
      default: true
    },
    refreshCooldown: {
      type: 'number',
      title: '实时刷新冷却（秒）',
      description: '两次弹出刷新之间的最小间隔，默认 8 秒',
      default: 8
    }
  },

    async start(ctx) {
    const { cleanup } = ctx;
    const s = ctx.settings;
    const ds = ctx.datasources;
    if (!ds) {
      console.warn('[quota-popover] datasource API unavailable — plugin idle');
      return;
    }

    /* v1 parity: platform link row hover styles can't be inline — one-shot stylesheet */
    try {
      if (!document.getElementById('zmod-bal-style')) {
        const st = document.createElement('style');
        st.id = 'zmod-bal-style';
        st.textContent =
          '.zmod-bal-pl{display:flex;align-items:center;margin-bottom:6px}' +
          '.zmod-bal-pl a{font-size:11px;color:#9aa0a6;text-decoration:none;cursor:pointer}' +
          '.zmod-bal-pl a:hover{color:#d6d7d9;text-decoration:underline}';
        document.head.appendChild(st);
      }
    } catch { /* head unavailable — links degrade to plain text */ }


    let snapshot = []; // { inst, status? }
    let snapshotAt = 0;
    let refreshPromise = null;
    function refreshSnapshot(force) {
      if (refreshPromise && !force) return refreshPromise;
      const p = (async () => {
        const insts = ds.getInstances();
        snapshot = await Promise.all(
          insts.map(async (inst) => ({
            inst,
            status: await ds.getStatus(inst.id, force ? { force: true } : undefined).catch(() => null)
          }))
        );
        snapshotAt = Date.now();
        console.log(
          '[quota-popover] snapshot: ' +
          snapshot.map((s) => `${s.inst.id}=${s.status ? (s.status.ok ? 'ok' + (s.status.models ? '+models(' + s.status.models.length + ')' : '') : 'err') : 'null'}`).join(', ')
        );
      })().finally(() => {
        if (refreshPromise === p) refreshPromise = null;
      });
      refreshPromise = p;
      return p;
    }
    const snapAfter = (minAgeMs, onDone) => {
      if (Date.now() - snapshotAt > minAgeMs) {
        refreshSnapshot(false).then(() => onDone?.()).catch(() => {});
      }
    };

    /* ================= Surface 1: composer hover-card ================= */
    const POPOVER_MARK = 'zmod-quota-cards';
    /* only the composer capacity hover-card — generic popover/menu surfaces
       (dropdowns, settings popovers containing the word 用量) must not receive cards */
    const POPOVER_SELECTOR = '[data-slot="hover-card-content"]';

    /* Current composer selection: the toolbar model-selector button carries
       "供应商名/模型名  effort" in its aria-label — the same display name the
       settings detail header shows, so instance matching stays consistent.
       Parsing (effort-word stripping, non-model label exclusions) lives in
       lib.js next to the matching chain it feeds. */
    function currentSelection() {
      for (const gauge of document.querySelectorAll('[data-slot="hover-card-trigger"]')) {
        if (!/上下文/.test(gauge.getAttribute('aria-label') || '')) continue;
        let bar = gauge;
        for (let i = 0; i < 6 && bar.parentElement; i++) {
          bar = bar.parentElement;
          if (bar.querySelectorAll('button').length > 3) break;
        }
        for (const btn of bar.querySelectorAll('button')) {
          const sel = parseModelButtonLabel(btn.getAttribute('aria-label') || '');
          if (sel) return sel;
        }
      }
      return null;
    }

    /** Which instance follows the current selection — subscription source
        (供应商前缀段) decides first; model chain only for prefix-less labels. */
    function matchCurrentSelection(sel) {
      return matchSelection(sel, snapshot);
    }

    function bindPopoverLinks(wrap) {
      for (const a of wrap.querySelectorAll('.zmod-bal-pl a[data-zmod-url]')) {
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          ctx.invoke('system.openExternal', { url: a.dataset.zmodUrl }).catch(() => {});
        });
      }
    }

    function buildPopoverBlock(hasOfficialBalance) {
      /* v1 whitelist parity: when the official GLM 今日余额 card renders,
         v1's patch returned early — no ZMod balance section alongside it */
      if (hasOfficialBalance) return null;
      /* v1 behavior: only the source matching the current provider/model is
         shown; unmatched selections render no balance section at all */
      const sel = currentSelection();
      const inst = matchCurrentSelection(sel);
      if (!inst) {
        console.log('[quota-popover] no instance matched selection ' + JSON.stringify(sel));
        return null;
      }
      const status = snapshot.find((s) => s.inst.id === inst.id)?.status;
      const wrap = document.createElement('div');
      wrap.className = 'flex flex-col gap-2.5 border-t border-border pt-2 mt-2';
      wrap.setAttribute('data-' + POPOVER_MARK, inst.id);
      wrap.innerHTML = renderV1Section(inst.type, status, sel, inst.name);
      bindPopoverLinks(wrap);
      return wrap;
    }

    function rerenderPopover() {
      const existing = document.querySelector(`[data-${POPOVER_MARK}]`);
      if (!existing || !existing.isConnected) return;
      const pop = existing.closest(POPOVER_SELECTOR);
      const text = pop?.textContent || '';
      if (/今日余额/.test(text) && /\d{1,2}月\d{1,2}日/.test(text)) {
        existing.remove();
        return;
      }
      const sel = currentSelection();
      const inst = matchCurrentSelection(sel);
      if (!inst) {
        existing.remove();
        return;
      }
      if (existing.getAttribute('data-' + POPOVER_MARK) !== inst.id) {
        existing.setAttribute('data-' + POPOVER_MARK, inst.id);
      }
      const status = snapshot.find((s) => s.inst.id === inst.id)?.status;
      existing.innerHTML = renderV1Section(inst.type, status, sel, inst.name);
      bindPopoverLinks(existing);
    }

    /* one enhance cycle at a time + re-check the mark right before append:
       the popover opens through several React re-renders that drop injected
       nodes, and concurrent cycles would each see it unmarked and double-append */
    let enhancing = false;
    /* hover-triggered real-time refresh: the moment the capacity hover-card
       opens (Radix data-state flips to "open"), force-refresh the matched
       instance past the datasource TTL. Gated by a cooldown so repeated
       hovers can't hammer provider APIs; off via settings. */
    let popWasOpen = false;
    let lastHoverRefresh = 0;
    function hoverOpenRefresh(pops) {
      const openNow = pops.some((p) => p.getAttribute('data-state') === 'open');
      const justOpened = openNow && !popWasOpen;
      popWasOpen = openNow;
      if (!justOpened || !s.get('popoverRefresh', true)) return;
      const cooldown = Math.max(0, Number(s.get('refreshCooldown', 8)) || 0) * 1000;
      if (Date.now() - lastHoverRefresh < cooldown) return;
      const inst = matchCurrentSelection(currentSelection());
      if (!inst) return;
      lastHoverRefresh = Date.now();
      ds.getStatus(inst.id, { force: true })
        .then((st) => {
          const entry = snapshot.find((x) => x.inst.id === inst.id);
          if (entry) entry.status = st;
          else snapshot.push({ inst, status: st });
          console.log('[quota-popover] hover-triggered forced refresh:', inst.id);
          rerenderPopover();
        })
        .catch(() => {});
    }
    function enhancePopovers() {
      if (enhancing) return;
      enhancing = true;
      try {
        // defensive dedupe: pre-races may have left more than one block
        const existing = [...document.querySelectorAll(`[data-${POPOVER_MARK}]`)];
        for (let i = 1; i < existing.length; i++) existing[i].remove();
        const allPops = [...document.querySelectorAll(POPOVER_SELECTOR)].filter(
          (p) => p.isConnected && /上下文|今日余额|命中率/.test(p.textContent || '')
        );
        if (allPops.length === 0) {
          popWasOpen = false;
          return;
        }
        const pops = allPops.filter((p) => !p.querySelector(`[data-${POPOVER_MARK}]`));
        for (const pop of pops) {
          if (!pop.isConnected || pop.querySelector(`[data-${POPOVER_MARK}]`)) continue;
          const text = pop.textContent || '';
          const hasOfficialBalance = /今日余额/.test(text) && /\d{1,2}月\d{1,2}日/.test(text);
          const block = buildPopoverBlock(hasOfficialBalance);
          if (!block) continue;
          // native rows live in the padded official column (bg-menu p-3
          // space-y-3) — injecting there inherits the native padding and
          // rhythm exactly like v1, whose cards sat inside the same container
          const host = pop.querySelector('[class*="bg-menu"]') || pop.querySelector('[class*="space-y-3"]') || pop;
          host.appendChild(block);
          console.log('[quota-popover] appended balance cards to official popover (inst=' + block.getAttribute('data-' + POPOVER_MARK) + ')');
        }
        hoverOpenRefresh(allPops);
        snapAfter(15000, rerenderPopover);
      } finally {
        enhancing = false;
      }
    }

    /* ============ Surface 2: provider detail account-quota card ============ */
    const DETAIL_MARK = 'zmod-provider-quota';

    function buildDetailCard(inst, status) {
      const card = document.createElement('div');
      card.setAttribute('data-' + DETAIL_MARK, inst.id);
      card.dataset.snapshotAt = String(snapshotAt || 0);
      card.className = 'rounded-xl border border-border bg-surface p-4 space-y-3 shadow-xs';
      const ok = status && status.ok;
      const rows = ok ? status.rows || [] : [];
      // header meta per v1: money sources show 可用总额, antigravity shows its tier pill
      let meta = '';
      if (ok && inst.type === 'antigravity') {
        const tier = rowValue(rows, '订阅档位');
        if (tier) {
          meta = `<span class="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20 tracking-wider">${esc(tier)}</span>`;
        }
      } else if (ok && status.balance != null) {
        let total = parseFloat(status.balance) || 0;
        if (inst.type === 'bailian-bss') total += numFrom(rowValue(rows, '可用代金券')) || 0;
        const code = inst.type === 'bailian-bss' ? 'CNY' : codeOf(status);
        meta = `<span class="text-ui-xs font-mono text-foreground-subtle">可用总额: <span class="font-semibold text-foreground">${esc(status.currency || '¥')}${total.toFixed(2)} ${esc(code)}</span></span>`;
      }
      const title = /额度$/.test(inst.name) ? inst.name : inst.name + '账户额度';
      card.innerHTML =
        `<div class="flex items-center justify-between gap-3">` +
        `<div class="flex min-w-0 flex-wrap items-center gap-2">` +
        `<span class="text-ui-base font-semibold text-foreground">${esc(title)}</span>${meta}</div>` +
        `<button type="button" data-${REFRESH_MARK}="${inst.id}" class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/80 bg-surface px-2.5 py-1 text-ui-xs font-medium text-foreground-subtle hover:bg-surface-hover hover:text-foreground transition-all cursor-pointer shadow-2xs">刷新</button>` +
        `</div>` +
        renderV1DetailBody(inst.type, status) +
        `<div class="text-ui-xs text-foreground-subtle/70">ZMod 数据源 · ${ok ? '更新于 ' + new Date(snapshotAt).toLocaleTimeString() : esc(status?.message || '查询失败')}</div>`;
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

    function enhanceSettings() {
      const targets = detailTargets();
      if (targets.length === 0) return;
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
      snapAfter(15000, rerenderDetail);
    }

    /* re-render pass shared by both surfaces; snapshot refresh is TTL-gated so
       mutations never burst requests; the refresh button forces one on demand */
    let scheduled = false;
    function onMutation() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        try {
          enhancePopovers();
          enhanceSettings();
        } catch (e) {
          console.error('[quota-popover] error in mutation handler:', e);
        }
      });
    }
    const observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['value'] });
    cleanup(() => observer.disconnect());

    // Base URL is a controlled React input — poll lightly instead of relying
    // on mutation events for value edits while the settings dialog is open.
    // An open hover-card is polled too: React can re-render the popover and
    // drop the injected section without emitting further mutations, so the
    // section must be replayed idempotently while the card stays open (v1 hit
    // the same class of problem with its popover patcher).
    const pollT = setInterval(() => {
      if (document.querySelector('[data-model-provider-detail-scroll]') || document.querySelector(POPOVER_SELECTOR)) onMutation();
    }, 1500);
    cleanup(() => clearInterval(pollT));

    await refreshSnapshot(false).catch(() => {});
    console.log('[quota-popover] armed (popover cards + provider-detail quota card)');
  }
});
