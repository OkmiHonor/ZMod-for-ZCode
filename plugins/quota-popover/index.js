import { definePlugin } from '@zmod/sdk';
import {
  matchInstance, matchSelection, parseModelButtonLabel, selectMagpieBuckets,
  scrollWrap, applyCardPrefs, parseCardPrefs
} from './lib.js';

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

/* ================= 卡片自定义（滚动 / 外观 / 排序 / 文本） =================
   排序采用「字符串层」而非 DOM 后处理：每张子卡由 makeHtml(label) 生成，
   文本自定义直接重生成该卡即可精确定位文案，且 prefs 缺省时输出逐字节不变。
   外观走「注入一次性 <style> + scope class + CSS 变量覆盖」链：
     applyQpStyle() 注入 #zmod-qp-style，其中 :root 声明 --zmod-qp-* 变量，
     容器挂 .zmod-qp-scope；覆盖规则仅在取值非默认时生成，默认零覆盖、
     视觉 1:1 不变（balCard 等 v1 字节级复刻不改动，硬替换风险大）。
   覆盖链：非默认 → 生成 .zmod-qp-scope 后代规则（!important 压过 Tailwind
   原子类与 inline style）→ 紧凑模式另以 .zmod-qp-compact 收窄到详情卡。 */

const QP_DEFAULTS = {
  scrollScope: 'both',
  maxCardHeight: 320,
  cardRadius: 10,
  accentColor: '#10b981',
  cardGap: 8,
  fontScale: 100,
  compactMode: false,
  sortMode: 'default',
  cardOrder: '',
  hiddenCards: '',
  customLabels: '{}',
  advancedPrefs: '{}'
};
const QP_KEYS = Object.keys(QP_DEFAULTS);
const QP_SCOPES = ['both', 'popover', 'detail', 'none'];
const QP_SORTS = ['default', 'custom', 'labelAsc', 'labelDesc'];

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// 颜色白名单：#hex(3~8) 或纯字母关键字，杜绝 CSS 注入
function normAccent(v) {
  const s = String(v ?? '').trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(s) || /^[a-zA-Z]+$/.test(s) ? s : QP_DEFAULTS.accentColor;
}

function splitKeys(v) {
  return String(v ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
}

// 组装传给 render 的 prefs；cardPrefs 一律过 parseCardPrefs 校验（含高级入口覆盖）
function buildQPPrefs(s) {
  const p = {};
  for (const k of QP_KEYS) p[k] = s.get(k, QP_DEFAULTS[k]);
  p.cardRadius = clampInt(p.cardRadius, 0, 24, 10);
  p.cardGap = clampInt(p.cardGap, 0, 24, 8);
  p.fontScale = clampInt(p.fontScale, 80, 140, 100);
  p.maxCardHeight = clampInt(p.maxCardHeight, 120, 800, 320);
  p.accentColor = normAccent(p.accentColor);
  p.compactMode = Boolean(p.compactMode);
  p.scrollScope = QP_SCOPES.includes(p.scrollScope) ? p.scrollScope : 'both';
  let customLabels = {};
  try {
    const raw = typeof p.customLabels === 'string' ? JSON.parse(p.customLabels) : p.customLabels;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) customLabels = raw;
  } catch { /* 非法 JSON 视作空字典 */ }
  const base = parseCardPrefs({
    hiddenKeys: splitKeys(p.hiddenCards),
    order: splitKeys(p.cardOrder),
    customLabels,
    sortMode: QP_SORTS.includes(p.sortMode) ? p.sortMode : 'default'
  });
  try {
    const adv = JSON.parse(p.advancedPrefs);
    // 高级入口只在用户真的填了内容时按字段覆盖基础三项
    p.cardPrefs = adv && typeof adv === 'object' && !Array.isArray(adv) && Object.keys(adv).length
      ? parseCardPrefs({ ...base, ...adv })
      : base;
  } catch { p.cardPrefs = base; }
  return p;
}

// CSS 变量声明：始终注入（方便调试/外部主题联动），实际覆盖由 qpCustomCss 决定
function qpVars(p) {
  return `:root{` +
    `--zmod-qp-radius:${p.cardRadius}px;` +
    `--zmod-qp-accent:${p.accentColor};` +
    `--zmod-qp-gap:${p.cardGap}px;` +
    `--zmod-qp-font:${p.fontScale}%;` +
    `--zmod-qp-maxh:${p.maxCardHeight}px}`;
}

// 外观覆盖链：只对非默认取值生成规则（默认零视觉变化）；amber/rose 阈值告警色保留
function qpCustomCss(p) {
  const sel = '.zmod-qp-scope';
  let css = '';
  if (p.cardRadius !== 10) {
    const r = p.cardRadius;
    css += `${sel} .rounded-lg,${sel} .rounded-xl,${sel} .rounded-full{border-radius:${r}px !important}` +
           `${sel} [style*="border-radius"]{border-radius:${r}px !important}`;
  }
  if (p.cardGap !== 8) {
    css += `${sel} .grid,${sel} .flex.flex-wrap,${sel} [style*="display:grid"]{gap:${p.cardGap}px !important}`;
  }
  if (p.accentColor !== QP_DEFAULTS.accentColor) {
    const a = p.accentColor;
    css += `${sel} .bg-success{background-color:${a} !important}` +
           `${sel} [class~="bg-emerald-500"]{background-color:${a} !important}` +
           `${sel} [class*="text-emerald-"]{color:${a} !important}` +
           `${sel} [class*="border-emerald-"]{border-color:${a} !important}`;
  }
  if (p.fontScale !== 100) {
    // Electron/Chromium 下 zoom 能等比缩放 px/rem 混排的卡片文字；
    // 容器 font-size:% 对 rem 无效，故用 zoom 并在数字节点上做溢出兜底
    css += `${sel}{zoom:${(p.fontScale / 100).toFixed(2)};min-width:0}` +
           `${sel} [style*="font-size"]{overflow:hidden;text-overflow:ellipsis}`;
  }
  return css;
}

function qpStyleText(p) {
  // 滚动容器保持 flex 列 + 与浮窗 wrap 相同的 gap：balWrap 会产出「平台链接行 +
  // 卡片网格」两个兄弟 div，原来是 wrap 的 flex 子项（gap-2.5 = 0.625rem），
  // 包一层后若不还原 flex/gap，两行间距会从 16px 掉到 6px（.zmod-bal-pl 自身
  // margin-bottom），破坏 v1 1:1。detail 主体是单个根 div，flex 化无副作用。
  let css =
    '.zmod-qp-scroll{scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.45) transparent;' +
    'display:flex;flex-direction:column;gap:0.625rem}' +
    '.zmod-qp-scroll::-webkit-scrollbar{width:6px;height:6px}' +
    '.zmod-qp-scroll::-webkit-scrollbar-track{background:transparent}' +
    '.zmod-qp-scroll::-webkit-scrollbar-thumb{background:rgba(148,163,184,.45);border-radius:3px}' +
    '.zmod-qp-scope{min-width:0}';
  if (p.compactMode) {
    // 紧凑模式只作用于带 .zmod-qp-compact 的设置页详情卡
    css += '.zmod-qp-scope.zmod-qp-compact{padding:8px !important}' +
           '.zmod-qp-scope.zmod-qp-compact .qp-footer{display:none}' +
           '.zmod-qp-scope.zmod-qp-compact .grid{gap:6px !important}' +
           '.zmod-qp-scope.zmod-qp-compact [class~="p-3"]{padding:6px !important}' +
           '.zmod-qp-scope.zmod-qp-compact [class~="gap-2.5"]{gap:5px !important}';
  }
  return qpVars(p) + css + qpCustomCss(p);
}

function applyQpStyle(p) {
  try {
    let st = document.getElementById('zmod-qp-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'zmod-qp-style';
      document.head.appendChild(st);
    }
    st.textContent = qpStyleText(p);
  } catch { /* head 不可用则退化为默认外观 */ }
}

function scrollOpts(p, surface) {
  return {
    enabled: p.scrollScope === 'both' || p.scrollScope === surface,
    maxHeight: p.maxCardHeight,
    scope: p.scrollScope
  };
}

/* 卡片条目工具：prefs 既可传完整 prefs（取 .cardPrefs）也可直接传 cardPrefs，
   两种都过 applyCardPrefs；缺省 {} 时其返回顺序不变、html 不变。 */
function cardPrefsOf(prefs) {
  if (!prefs || typeof prefs !== 'object') return {};
  return prefs.cardPrefs && typeof prefs.cardPrefs === 'object' ? prefs.cardPrefs : prefs;
}

function mkCard(key, label, makeHtml, slot = 'grid') {
  return { key, label, makeHtml, slot };
}

// 仅当用户真的开了自定义（排序/隐藏/改名）时，才在卡片根节点打 data-qp-key /
// data-qp-label 便于在 DOM 里定位；默认态不打，保证输出逐字节不变。
function isCustomizing(prefs) {
  const p = cardPrefsOf(prefs);
  return p.sortMode != null && p.sortMode !== 'default' ||
    (Array.isArray(p.hiddenKeys) && p.hiddenKeys.length > 0) ||
    (Array.isArray(p.order) && p.order.length > 0) ||
    (p.customLabels && typeof p.customLabels === 'object' && Object.keys(p.customLabels).length > 0);
}

function tagCardRoot(html, key, label) {
  return String(html ?? '').replace(/<([a-zA-Z][\w-]*)([^>]*)>/, (full, tag, rest) => {
    if (/\bdata-qp-key=/.test(rest)) return full;
    return `<${tag} data-qp-key="${esc(key)}" data-qp-label="${esc(label)}"${rest}>`;
  });
}

function orderedCards(cards, prefs) {
  const ordered = applyCardPrefs(cards, cardPrefsOf(prefs));
  const tagging = isCustomizing(prefs);
  return ordered.map((c) => {
    const key = c && c.key;
    const label = String((c && c.label) ?? '');
    const slot = (c && c.slot) || 'grid';
    const html = c && typeof c.makeHtml === 'function'
      ? c.makeHtml(String(c.label ?? ''))
      : String((c && c.html) ?? '');
    return { key, label, slot, html: tagging ? tagCardRoot(html, key, label) : html };
  });
}

function cardHtmlList(cards, prefs) {
  return orderedCards(cards, prefs).map((c) => c.html);
}

// 浮窗 kit 的薄封装：把 {key,label,makeHtml} 过偏好后交给 v1 原函数拼装，
// 缺省 prefs 时输出与改造前逐字节一致（balWrap / v1CardWrap 本身不改动）
function balWrapPref(cards, plat, prefs) {
  return balWrap(cardHtmlList(cards, prefs), plat);
}

function v1CardWrapPref(title, cards, prefs) {
  const list = cardHtmlList(cards, prefs);
  return v1CardWrap(title, list, list.length > 1 ? 2 : 1);
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
function renderV1DetailBody(type, status, prefs) {
  if (!status) return `<div class="text-ui-sm text-foreground-subtle">状态查询中…</div>`;
  if (!status.ok) return `<div class="text-ui-sm text-foreground-subtle">${esc(status.message || '查询失败')}</div>`;
  const rows = status.rows || [];
  const grid = (cards) => `<div class="grid grid-cols-2 gap-3 max-sm:grid-cols-1">${cardHtmlList(cards, prefs).join('')}</div>`;
  const flexWrap = (cards) => `<div class="flex flex-wrap gap-2.5">${cardHtmlList(cards, prefs).join('')}</div>`;
  // 默认字节级不变：容器结构（grid / flex-wrap / 分组双容器）保持原样，
  // 只在拼装处把卡片数组过 applyCardPrefs
  if (type === 'antigravity') {
    const cards = (status.groups || []).map((g) => {
      const label = g.name || '配额组';
      return mkCard(`group.${label}`, label, (name) => {
        const b5 = (g.buckets || []).find((b) => b.window === '5h');
        const bw = (g.buckets || []).find((b) => b.window === 'weekly');
        const p5 = b5 ? Math.max(0, Math.min(100, Math.round(b5.frac * 100))) : null;
        const pw = bw ? Math.max(0, Math.min(100, Math.round(bw.frac * 100))) : null;
        const resetStr = b5 && b5.reset ? fmtDateCN(b5.reset) : bw && bw.reset ? fmtDateCN(bw.reset) : '';
        return (
          `<div class="flex-1 min-w-[210px] rounded-lg border border-border/60 bg-surface-hover/20 p-3 flex flex-col justify-between gap-2.5 hover:border-border transition-colors">` +
          `<div class="flex items-center justify-between">` +
          `<span class="text-ui-xs font-semibold text-foreground tracking-tight">${esc(name)}</span>` +
          (resetStr ? `<span class="text-[11px] font-mono text-foreground-subtle">${esc(resetStr)}</span>` : '') +
          `</div>` +
          `<div class="space-y-2">${p5 !== null ? barRow('5小时滚动限额', p5) : ''}${pw !== null ? barRow('每周可用总额', pw) : ''}</div>` +
          `</div>`
        );
      });
    });
    if (cards.length) return flexWrap(cards);
    return `<div class="text-ui-sm text-foreground-subtle">配额组里没有可用桶</div>`;
  }
  if (type === 'magpie') {
    // 每账号一卡：桶即模型配额窗口（window=模型名，frac=剩余比例），下方 30 天用量
    const cards = (status.groups || []).map((g) => {
      const label = g.name || '配额';
      return mkCard(`group.${label}`, label, (name) => {
        const bars = (g.buckets || [])
          .map((b) => barRow(b.window || '窗口', Math.max(0, Math.min(100, Math.round(b.frac * 100)))))
          .join('');
        return (
          `<div class="flex-1 min-w-[210px] rounded-lg border border-border/60 bg-surface-hover/20 p-3 flex flex-col justify-between gap-2.5 hover:border-border transition-colors">` +
          `<div class="flex items-center justify-between gap-2">` +
          `<span class="text-ui-xs font-semibold text-foreground tracking-tight">${esc(name)}</span>` +
          (g.plan ? `<span class="text-[10px] font-mono text-foreground-subtle truncate">${esc(g.plan)}</span>` : '') +
          `</div>` +
          `<div class="space-y-2">${bars}</div>` +
          `</div>`
        );
      });
    });
    const usage = status.usage;
    const orderedGroup = orderedCards(cards, prefs);
    const groupCards = orderedGroup.map((c) => c.html).join('');
    let usageRow = '';
    if (usage && isFinite(usage.calls) && usage.calls > 0) {
      const usageCards = [
        mkCard('usage.calls', '30 天调用', (l) =>
          bentoSubCard(l, `${usage.calls} 次`, { foot: usage.errors ? `失败 ${usage.errors} 次` : null })),
        mkCard('usage.cost', '30 天费用（网关估算）', (l) =>
          bentoSubCard(l, usage.cost != null ? '$' + usage.cost.toFixed(2) : '—', {
            foot: `入 ${fmtTokCn(usage.input)} · 出 ${fmtTokCn(usage.output)} · 缓存 ${fmtTokCn(usage.cacheRead)}`
          }))
      ];
      usageRow = `<div class="flex flex-wrap gap-2.5">${cardHtmlList(usageCards, prefs).join('')}</div>`;
    }
    if (!groupCards && !usageRow) return `<div class="text-ui-sm text-foreground-subtle">配额窗口里没有可用数据</div>`;
    return `<div class="space-y-2.5">` +
      (groupCards ? `<div class="flex flex-wrap gap-2.5">${groupCards}</div>` : '') +
      usageRow +
      `</div>`;
  }
  if (type === 'deepseek') {
    const total = parseFloat(status.balance) || 0;
    const grant = numFrom(rowValue(rows, '赠送余额'));
    const top = numFrom(rowValue(rows, '充值余额'));
    const cur = status.currency || '¥';
    if (grant > 0) {
      return grid([
        mkCard('balance.topup', '充值余额 (永久有效)', (l) => bentoSubCard(l, `${cur} ${top.toFixed(2)}`)),
        mkCard('balance.gift', '赠送余额', (l) => bentoSubCard(l, `${cur} ${grant.toFixed(2)}`, { accent: true }))
      ]);
    }
    return [
      mkCard('balance.total', '当前可用余额 (按量扣减)', (l) =>
        `<div class="rounded-lg border border-border/60 bg-surface-hover/20 p-3 flex items-baseline justify-between">` +
        `<div class="space-y-0.5">` +
        `<div class="text-[11px] text-foreground-subtle font-medium">${esc(l)}</div>` +
        `<div class="text-ui-2xl font-bold font-mono tracking-tight text-foreground">${esc(cur)} ${total.toFixed(2)} <span class="text-ui-sm font-normal text-foreground-subtle">${esc(codeOf(status))}</span></div>` +
        `</div>` +
        `<span class="text-ui-xs text-foreground-subtle font-mono">API 直连</span></div>`)
    ].map((c) => cardHtmlList([c], prefs)[0]).join('');
  }
  if (type === 'bailian-bss') {
    const avail = parseFloat(status.balance) || 0;
    const voucher = numFrom(rowValue(rows, '可用代金券'));
    const detail = rowValue(rows, '代金券明细');
    const cards = [mkCard('balance.cash', '现金可用余额 (实时)', (l) =>
      bentoSubCard(l, `${status.currency || '¥'} ${avail.toFixed(2)}`, { foot: '按量付费账单抵扣' }))];
    if (isFinite(voucher) && voucher > 0) {
      cards.push(mkCard('balance.voucher', '有效代金券 (优先抵扣)', (l) =>
        bentoSubCard(l, `${status.currency || '¥'} ${voucher.toFixed(2)}`, { accent: true, foot: voucherSub(detail) })));
    }
    return grid(cards);
  }
  if (type === 'siliconflow') {
    const total = parseFloat(status.balance) || 0;
    const charge = numFrom(rowValue(rows, '充值余额')) || 0;
    const gift = numFrom(rowValue(rows, '赠送余额')) || 0;
    const cur = status.currency || '¥';
    if (gift > 0) {
      return grid([
        mkCard('balance.topup', '充值余额', (l) => bentoSubCard(l, `${cur} ${charge.toFixed(2)}`, { foot: `账户总额 ${cur}${total.toFixed(2)}` })),
        mkCard('balance.gift', '赠送余额', (l) => bentoSubCard(l, `${cur} ${gift.toFixed(2)}`, { accent: true }))
      ]);
    }
    return cardHtmlList([mkCard('balance.total', '当前可用余额 (硅基流动)', (l) =>
      bentoSubCard(l, `${cur} ${total.toFixed(2)}`))], prefs)[0];
  }
  if (type === 'moonshot') {
    const avail = parseFloat(status.balance) || 0;
    const cash = numFrom(rowValue(rows, '现金余额'));
    const voucher = numFrom(rowValue(rows, '代金券余额')) || 0;
    const cur = status.currency || '¥';
    if (voucher > 0) {
      return grid([
        mkCard('balance.total', '可用总额 (Moonshot)', (l) => bentoSubCard(l, `${cur} ${avail.toFixed(2)}`, { foot: isFinite(cash) ? `现金余额 ${cur}${cash.toFixed(2)}` : null })),
        mkCard('balance.voucher', '有效代金券', (l) => bentoSubCard(l, `${cur} ${voucher.toFixed(2)}`, { accent: true }))
      ]);
    }
    return cardHtmlList([mkCard('balance.total', '当前可用余额 (Moonshot)', (l) =>
      bentoSubCard(l, `${cur} ${avail.toFixed(2)}`))], prefs)[0];
  }
  if (type === 'zhipu-coding-plan' || type === 'minimax') {
    const cards = (status.groups || []).map((g) => {
      const label = g.name || '套餐配额';
      return mkCard(`group.${label}`, label, (name) => {
        const bars = (g.buckets || [])
          .map((b) => barRow(b.window || '配额窗口', Math.max(0, Math.min(100, Math.round(b.frac * 100)))))
          .join('');
        return (
          `<div class="flex-1 min-w-[210px] rounded-lg border border-border/60 bg-surface-hover/20 p-3 flex flex-col justify-between gap-2.5 hover:border-border transition-colors">` +
          `<div class="flex items-center justify-between gap-2">` +
          `<span class="text-ui-xs font-semibold text-foreground tracking-tight">${esc(name)}</span>` +
          (g.plan ? `<span class="text-[10px] font-mono text-foreground-subtle truncate">${esc(g.plan)}</span>` : '') +
          `</div>` +
          `<div class="space-y-2">${bars}</div>` +
          `</div>`
        );
      });
    });
    if (cards.length) return flexWrap(cards);
  }
  if (type === 'newapi' || type === 'openrouter' || (type === 'openai-compatible' && (status.totalUsed !== undefined || status.unlimited))) {
    const cur = status.currency || '$';
    const unlimited = Boolean(status.unlimited);
    const avail = parseFloat(status.balance) || 0;
    const used = Number(status.totalUsed) || 0;
    const granted = Number(status.totalGranted) || 0;
    const frac = status.remainingFrac != null ? Number(status.remainingFrac) : null;
    const cards = [
      mkCard('quota.remaining', '剩余可用额度', (l) => bentoSubCard(l, unlimited ? '无限额度 (∞)' : `${cur} ${avail.toFixed(2)}`, {
        accent: true,
        foot: status.expiresAt ? `到期时间: ${status.expiresAt}` : '反代网关 / 令牌实时额度'
      }), 'grid'),
      mkCard('quota.used', '累计已消耗额度', (l) => bentoSubCard(l, `${cur} ${used.toFixed(2)}`, {
        foot: !unlimited && granted > 0 ? `授信总额: ${cur}${granted.toFixed(2)}` : null
      }), 'grid')
    ];
    if (isFinite(frac)) {
      cards.push(mkCard('quota.frac', '剩余额度比例', (l) =>
        `<div class="rounded-lg border border-border/60 bg-surface-hover/20 p-3">${barRow(l, Math.max(0, Math.min(100, Math.round(frac * 100))))}</div>`, 'bar'));
    }
    const ordered = orderedCards(cards, prefs);
    const gridHtml = ordered.filter((c) => c.slot === 'grid').map((c) => c.html).join('');
    const barHtml = ordered.filter((c) => c.slot === 'bar').map((c) => c.html).join('');
    return `<div class="space-y-2.5">` +
      `<div class="grid grid-cols-2 gap-3 max-sm:grid-cols-1">${gridHtml}</div>` +
      barHtml +
      `</div>`;
  }
  // generic engines: label/value lines in a Bento sub-card
  const rowsForCards = (status.balance != null
    ? [{ label: '余额', value: `${status.currency || ''}${money(status.balance) ?? status.balance}` }, ...rows]
    : rows
  ).slice(0, 8);
  const cards = rowsForCards.map((r) => {
    const label = String(r.label ?? '');
    return mkCard(`rows.${label}`, label, (name) =>
      `<div class="flex items-baseline justify-between gap-3"><span class="text-ui-sm text-foreground-subtle">${esc(name)}</span><span class="text-ui-sm font-medium tabular-nums text-foreground">${esc(r.value)}</span></div>`);
  });
  const lines = cardHtmlList(cards, prefs).join('');
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
  bailian: { name: '阿里云百炼', url: 'https://billing-cost.console.aliyun.com/' },
  siliconflow: { name: '硅基流动控制台', url: 'https://cloud.siliconflow.cn/expensebill' },
  moonshot: { name: 'Moonshot 开放平台', url: 'https://platform.moonshot.cn/console/pay' },
  openrouter: { name: 'OpenRouter Activity', url: 'https://openrouter.ai/activity' },
  zhipu: { name: '智谱开放平台', url: 'https://open.bigmodel.cn/usercenter/proj-mgmt/rate-limits' },
  minimax: { name: 'MiniMax 开放平台', url: 'https://platform.minimaxi.com/' }
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

/** 78054272 → 7805.4万 — magpie 用量卡的中文数量级缩写 */
function fmtTokCn(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(Math.round(n));
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
  const c = String(status.currency || '¥').trim();
  if (c === '¥') return 'CNY';
  if (c === '$') return 'USD';
  return c.toUpperCase();
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
  siliconflow: '账户余额 · 硅基流动',
  moonshot: '账户余额 · Moonshot',
  openrouter: '账户额度 · OpenRouter',
  newapi: '网关额度 · NewAPI',
  'zhipu-coding-plan': '套餐配额 · 智谱 GLM',
  minimax: '套餐余量 · MiniMax',
  antigravity: '模型配额 · Antigravity',
  magpie: '模型配额 · Magpie'
};

/** Render one datasource instance's popover section in v1 card semantics:
    branded types get the v1 balance/quota cards, error/unconfigured states get
    the v1 infoCard text rows, unknown types fall back to v1 cardWrap layout. */
function renderV1Section(type, status, sel, instName, prefs) {
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
      return balWrapPref([
        mkCard('balance.topup', '充值余额', (l) =>
          balCard(l, sign + (top > 0 ? top : Math.max(0, parseFloat(total) - grant)).toFixed(2), code)),
        mkCard('balance.gift', '赠送余额', (l) =>
          balCard(l, sign + grant.toFixed(2), code))
      ], PLAT_LINKS.deepseek, prefs);
    }
    return balWrapPref([
      mkCard('balance.total', '余额', (l) => balCard(l, sign + parseFloat(total).toFixed(2), code))
    ], PLAT_LINKS.deepseek, prefs);
  }
  if (type === 'siliconflow') {
    const total = money(status.balance);
    if (total == null) {
      return v1CardWrap(ERROR_TITLES.siliconflow, [v1InfoCard('状态', '余额数据为空')], 1);
    }
    const sign = signOf(status), code = codeOf(status);
    const gift = numFrom(rowValue(rows, '赠送余额')) || 0;
    const charge = numFrom(rowValue(rows, '充值余额')) || 0;
    if (gift > 0) {
      return balWrapPref([
        mkCard('balance.topup', '充值余额', (l) => balCard(l, sign + charge.toFixed(2), code)),
        mkCard('balance.gift', '赠送余额', (l) => balCard(l, sign + gift.toFixed(2), code))
      ], PLAT_LINKS.siliconflow, prefs);
    }
    return balWrapPref([
      mkCard('balance.total', '可用余额', (l) => balCard(l, sign + parseFloat(total).toFixed(2), code))
    ], PLAT_LINKS.siliconflow, prefs);
  }
  if (type === 'moonshot') {
    const total = money(status.balance);
    if (total == null) {
      return v1CardWrap(ERROR_TITLES.moonshot, [v1InfoCard('状态', '余额数据为空')], 1);
    }
    const sign = signOf(status), code = codeOf(status);
    const voucher = numFrom(rowValue(rows, '代金券余额')) || 0;
    const cards = [mkCard('balance.total', '可用余额', (l) =>
      balCard(l, sign + parseFloat(total).toFixed(2), code))];
    if (voucher > 0) {
      cards.push(mkCard('balance.voucher', '代金券', (l) =>
        balCard(l, sign + voucher.toFixed(2), code)));
    }
    return balWrapPref(cards, PLAT_LINKS.moonshot, prefs);
  }
  if (type === 'mimo') {
    const total = money(status.balance);
    if (total == null) {
      return v1CardWrap(ERROR_TITLES.mimo, [v1InfoCard('状态', '余额数据为空')], 1);
    }
    const sign = signOf(status), code = codeOf(status);
    const cards = [mkCard('balance.total', '账户余额', (l) =>
      balCard(l, sign + parseFloat(total).toFixed(2), code))];
    const cost = rowValue(rows, '本月消费');
    if (cost != null) {
      const tok = rowValue(rows, '本月 Token');
      cards.push(mkCard('usage.month', '本月消费', (l) =>
        balCard(l, String(cost), code, tok ? tok + ' tok' : null)));
    }
    return balWrapPref(cards, PLAT_LINKS.mimo, prefs);
  }
  if (type === 'bailian-bss') {
    const total = money(status.balance);
    if (total == null) {
      return v1CardWrap(ERROR_TITLES['bailian-bss'], [v1InfoCard('状态', '余额数据为空')], 1);
    }
    const sign = signOf(status);
    const cards = [mkCard('balance.cash', '现金余额', (l) =>
      balCard(l, sign + parseFloat(total).toFixed(2), 'CNY'))];
    const voucher = numFrom(rowValue(rows, '可用代金券'));
    const detail = rowValue(rows, '代金券明细');
    // v1 rule: an empty voucher card carries no information — single card then
    if (isFinite(voucher) && (voucher > 0 || detail)) {
      cards.push(mkCard('balance.voucher', '可用代金券', (l) =>
        balCard(l, sign + voucher.toFixed(2), 'CNY', detail || null)));
    }
    return balWrapPref(cards, PLAT_LINKS.bailian, prefs);
  }
  if (type === 'newapi' || type === 'openrouter' || (type === 'openai-compatible' && (status.totalUsed !== undefined || status.unlimited))) {
    const sign = signOf(status), code = codeOf(status);
    const unlimited = Boolean(status.unlimited);
    const avail = money(status.balance);
    const used = Number(status.totalUsed);
    const granted = Number(status.totalGranted);
    const cards = [
      mkCard('quota.remaining', '剩余额度', (l) => balCard(
        l, unlimited ? '无限额度' : sign + (avail ?? '0.00'),
        unlimited ? '' : code, status.expiresAt ? `到期 ${status.expiresAt}` : null
      ), 'bal')
    ];
    if (isFinite(used)) {
      cards.push(mkCard('quota.used', '已用额度', (l) => balCard(
        l, sign + used.toFixed(2), code,
        !unlimited && isFinite(granted) && granted > 0 ? `总额 ${sign}${granted.toFixed(2)}` : null
      ), 'bal'));
    }
    if (status.remainingFrac != null && isFinite(Number(status.remainingFrac))) {
      cards.push(mkCard('quota.frac', '额度剩余比例', (l) =>
        `<div class="mt-2">${v1QuotaCard(l, Number(status.remainingFrac), null)}</div>`, 'bar'));
    }
    const ordered = orderedCards(cards, prefs);
    const plat = type === 'openrouter' ? PLAT_LINKS.openrouter : null;
    let html = balWrap(ordered.filter((c) => c.slot === 'bal').map((c) => c.html), plat);
    html += ordered.filter((c) => c.slot === 'bar').map((c) => c.html).join('');
    return html;
  }
  if (type === 'zhipu-coding-plan' || type === 'minimax') {
    const groups = status.groups || [];
    const cards = [];
    for (const g of groups) {
      for (const b of g.buckets || []) {
        const label = b.window || g.name || '套餐额度';
        cards.push(mkCard(`quota.${g.name || 'g'}.${b.window || 'w'}`, label, (l) =>
          v1QuotaCard(l, b.frac, b.reset)));
      }
    }
    const title = type === 'zhipu-coding-plan' ? '套餐配额 · 智谱 Coding Plan' : '套餐余量 · MiniMax';
    if (cards.length) return v1CardWrapPref(title, cards, prefs);
    return v1CardWrap(ERROR_TITLES[type] || title, [v1InfoCard('状态', '套餐配额为空')], 1);
  }
  if (type === 'antigravity') {
    const groups = status.groups || [];
    const model = String((sel && sel.model) || '').toLowerCase();
    const wantArgon = /argon/i.test(model);
    const wantC = /claude|gpt|opus|sonnet/i.test(model);
    const wantG = /gemini|google/i.test(model);
    let selGroup = null;
    if (wantArgon) selGroup = groups.find((g) => /argon/i.test(g.name));
    if (!selGroup && wantC) selGroup = groups.find((g) => /claude|gpt/i.test(g.name));
    if (!selGroup && wantG) selGroup = groups.find((g) => /gemini|google/i.test(g.name) && !/argon/i.test(g.name));
    const cards = [];
    const addQuota = (g, b, label) => cards.push(
      mkCard(`quota.${g.name || 'g'}.${b.window || 'w'}`, label, (l) => v1QuotaCard(l, b.frac, b.reset)));
    if (selGroup) {
      for (const b of selGroup.buckets || []) addQuota(selGroup, b, agWinLabel(b));
    } else {
      // model unknown → one weekly bar per group (v1 degraded layout)
      for (const g of groups) {
        for (const b of g.buckets || []) {
          if (String(b.window || '').toLowerCase() === 'weekly') {
            addQuota(g, b, (g.name || '配额组') + ' · 每周');
          }
        }
      }
    }
    if (cards.length) {
      return v1CardWrapPref('模型配额 · ' + (selGroup ? selGroup.name || 'Antigravity' : 'Antigravity'), cards, prefs);
    }
    return v1CardWrap(ERROR_TITLES.antigravity, [v1InfoCard('状态', '配额组里没有可用桶')], 1);
  }
  if (type === 'magpie') {
    // 桶即模型配额窗口（window=模型名/池名，frac=剩余比例）：与 antigravity 卡同策略，
    // 只显示当前模型对应的订阅源窗口（selectMagpieBuckets 词边界匹配+模型族兜底），
    // 都没命中才退回全量；30 天调用仅在退回全量时补一张（过滤视图下属噪音）；
    // 费用不在浮窗展示（订阅制，避免误导）——此语义不随 prefs 改变
    const groups = status.groups || [];
    const multi = groups.length > 1;
    const model = String((sel && sel.model) || '').toLowerCase();
    const picked = selectMagpieBuckets(model, groups);
    const pairs = picked || [];
    const cards = [];
    const addQuota = (g, b) => {
      const label = multi ? `${g.name} · ${b.window}` : b.window;
      cards.push(mkCard(`quota.${g.name || 'g'}.${b.window || 'w'}`, label, (l) =>
        v1QuotaCard(l, b.frac, b.reset)));
    };
    for (const { group: g, bucket: b } of pairs) addQuota(g, b);
    if (!picked) {
      for (const g of groups) {
        for (const b of g.buckets || []) addQuota(g, b);
      }
      const usage = status.usage;
      if (usage && isFinite(usage.calls) && usage.calls > 0) {
        cards.push(mkCard('usage.calls', '30天调用', (l) =>
          v1InfoCard(l, `${usage.calls} 次`)));
      }
    }
    if (cards.length) return v1CardWrapPref('模型配额 · Magpie', cards, prefs);
    return v1CardWrap(ERROR_TITLES.magpie, [v1InfoCard('状态', '配额窗口里没有可用数据')], 1);
  }
  // generic engines (custom-http / openai-compatible / console-web): v1 never
  // had a family for these — keep its typography (balCard + infoCard rows)
  const cards = [];
  if (status.balance != null) {
    cards.push(mkCard('balance.main', '余额', (l) =>
      balCard(l, String(status.currency || '¥') + (money(status.balance) ?? status.balance), codeOf(status))));
  }
  for (const r of rows.slice(0, 6)) {
    if (r && r.label) {
      const label = String(r.label);
      cards.push(mkCard(`rows.${label}`, label, (l) => v1InfoCard(l, String(r.value))));
    }
  }
  if (cards.length) {
    return v1CardWrapPref('今日余额 · ' + (instName || type), cards, prefs);
  }
  return v1CardWrap('今日余额 · ' + (instName || type), [v1InfoCard('状态', '无数据行')], 1);
}

const REFRESH_MARK = 'zmod-quota-refresh';

export default definePlugin({
  id: 'quota-popover',
  name: '余量弹窗与模型页余量',
  version: '1.7.0',
  description: '官方「上下文容量」浮窗追加今日余额卡（v1 token-monitor 卡片语义 1:1）+ 官方设置模型页供应商详情注入 v1 Bento 账户额度卡（数据源驱动，不改官方文件），新增卡片滚动/样式/排序/文本自定义设置',
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
    },
    groupScroll: {
      type: 'group',
      title: '滚动'
    },
    scrollScope: {
      type: 'select',
      title: '哪里的卡片可以滚动',
      description: '卡片内容太多时，选择哪一处能上下滚动。两个地方都用（默认）／只浮窗／只设置页／都不滚动',
      options: [
        { label: '浮窗和设置页', value: 'both' },
        { label: '只浮窗', value: 'popover' },
        { label: '只设置页', value: 'detail' },
        { label: '都不滚动', value: 'none' }
      ],
      default: 'both'
    },
    maxCardHeight: {
      type: 'slider',
      title: '卡片最高显示多高',
      description: '余额卡内容太多时，最多显示多高，超出就能上下滚动（默认 320，范围 120–800）',
      min: 120,
      max: 800,
      step: 10,
      default: 320
    },
    groupAppearance: {
      type: 'group',
      title: '卡片外观'
    },
    cardRadius: {
      type: 'slider',
      title: '卡片圆角',
      description: '卡片四个角的圆润程度，0 是方角，24 是最圆（默认 10，跟现在一样）',
      min: 0,
      max: 24,
      step: 1,
      default: 10
    },
    accentColor: {
      type: 'text',
      title: '强调色',
      description: '进度条、百分比数字等用的颜色，填 # 开头的色号（如 #10b981）或颜色英文名，留空/填错自动恢复默认绿色',
      placeholder: '#10b981',
      default: '#10b981'
    },
    cardGap: {
      type: 'slider',
      title: '卡片之间的间距',
      description: '卡片和卡片之间留多少空隙，0 是紧贴，24 是最松（默认 8，跟现在一样）',
      min: 0,
      max: 24,
      step: 1,
      default: 8
    },
    fontScale: {
      type: 'slider',
      title: '卡片文字大小',
      description: '整体放大或缩小卡片里的文字，100 是原始大小（默认），80 更小，140 更大',
      min: 80,
      max: 140,
      step: 5,
      default: 100
    },
    compactMode: {
      type: 'switch',
      title: '设置页紧凑模式',
      description: '只影响设置页的供应商详情卡：收紧留白、隐藏底部「ZMod 数据源 · 更新于…」那行。浮窗保持原样不变',
      default: false
    },
    groupSort: {
      type: 'group',
      title: '内容排序'
    },
    sortMode: {
      type: 'select',
      title: '卡片排序方式',
      description: '卡片按什么顺序排。原来的顺序（默认）／我指定的顺序／按名称拼音正序／按名称拼音倒序',
      options: [
        { label: '原来的顺序', value: 'default' },
        { label: '我指定的顺序', value: 'custom' },
        { label: '按名称正序', value: 'labelAsc' },
        { label: '按名称倒序', value: 'labelDesc' }
      ],
      default: 'default'
    },
    cardOrder: {
      type: 'text',
      title: '卡片顺序（自定义排序时用）',
      description: '填卡片 key 的顺序，用逗号隔开；没填的卡片按原顺序排后面。留空就是原来的顺序',
      placeholder: '例如：balance.gift,balance.topup',
      default: ''
    },
    hiddenCards: {
      type: 'text',
      title: '隐藏哪些卡片',
      description: '填不想显示的卡片 key，用逗号隔开；留空就全部显示。全填满了会自动恢复全部显示，避免卡里一片空白',
      placeholder: '例如：usage.calls,quota.frac',
      default: ''
    },
    groupText: {
      type: 'group',
      title: '文本自定义'
    },
    customLabels: {
      type: 'text',
      title: '改卡片上的文字',
      description: '把卡片标题换成你想要的叫法，填一段 JSON 字典，左边是卡片 key、右边是新文字。留 {} 就是用原文案',
      placeholder: '{"balance.gift":"赠款"}',
      default: '{}'
    },
    advancedPrefs: {
      type: 'text',
      title: '高级设置（可覆盖上面几项）',
      description: '给会写 JSON 的人用：填 {"sortMode":"custom","order":["balance.gift"],"hiddenKeys":[],"customLabels":{}} 之类，会覆盖上面的排序/隐藏/改名。留 {} 不生效',
      placeholder: '{}',
      default: '{}'
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

    /* 卡片自定义：默认取值下视觉/内容 100% 不变；用户改设置即时重注入样式并重渲染两面。
       prefsRev 每次变更自增，供设置页详情卡在「快照没变但设置变了」时也强制重建。 */
    let prefs = buildQPPrefs(s);
    let prefsRev = 0;
    applyQpStyle(prefs);
    function onPrefsChanged() {
      prefs = buildQPPrefs(s);
      prefsRev += 1;
      applyQpStyle(prefs);
      rerenderPopover();
      rerenderDetail();
    }
    const prefOffs = [];
    // 当前运行时的 settings.onChange 只接单个 key（内部拼 setting:<id>:<key>），
    // 因此按 key 逐个注册；theme-workshop 的「数组批量监听」实际也是循环注册
    for (const k of QP_KEYS) prefOffs.push(s.onChange(k, onPrefsChanged));
    cleanup(() => {
      for (const off of prefOffs) { try { off?.(); } catch {} }
      try { document.getElementById('zmod-qp-style')?.remove(); } catch {}
    });

    let snapshot = []; // { inst, status? }
    let snapshotAt = 0;
    let refreshPromise = null;
    let providerCatalog = [];
    let catalogAt = 0;
    function refreshProviderCatalog(force) {
      if (typeof ctx.invoke !== 'function') return Promise.resolve();
      if (!force && Date.now() - catalogAt < 30000 && providerCatalog.length > 0) {
        return Promise.resolve();
      }
      catalogAt = Date.now();
      return Promise.resolve()
        .then(() => ctx.invoke('usage.getProviderCatalog', {}))
        .then((res) => {
          if (res && res.ok && Array.isArray(res.providers)) {
            providerCatalog = res.providers;
          }
        })
        .catch(() => {});
    }
    function refreshSnapshot(force) {
      if (refreshPromise && !force) return refreshPromise;
      const p = (async () => {
        await refreshProviderCatalog(force);
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
      return matchSelection(sel, snapshot, providerCatalog);
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
      wrap.className = 'flex flex-col gap-2.5 border-t border-border pt-2 mt-2 zmod-qp-scope';
      wrap.setAttribute('data-' + POPOVER_MARK, inst.id);
      // 滚动只包卡片主体；标题/链接/刷新按钮不进滚动容器，避免被滚走或点不到
      wrap.innerHTML = scrollWrap(
        renderV1Section(inst.type, status, sel, inst.name, prefs),
        scrollOpts(prefs, 'popover')
      );
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
      existing.classList.add('zmod-qp-scope');
      existing.innerHTML = scrollWrap(
        renderV1Section(inst.type, status, sel, inst.name, prefs),
        scrollOpts(prefs, 'popover')
      );
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
      card.dataset.prefsRev = String(prefsRev);
      card.className = 'rounded-xl border border-border bg-surface p-4 space-y-3 shadow-xs zmod-qp-scope' +
        (prefs.compactMode ? ' zmod-qp-compact' : '');
      const ok = status && status.ok;
      const rows = ok ? status.rows || [] : [];
      // header meta per v1: money sources show 可用总额, subscription sources show their tier pill
      let meta = '';
      if (ok && (inst.type === 'antigravity' || inst.type === 'magpie' || inst.type === 'zhipu-coding-plan' || inst.type === 'minimax')) {
        const tier = rowValue(rows, '订阅档位');
        if (tier) {
          meta = `<span class="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20 tracking-wider">${esc(tier)}</span>`;
        }
      } else if (ok && status.unlimited) {
        meta = `<span class="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 tracking-wider">无限额度</span>`;
      } else if (ok && status.balance != null && isFinite(parseFloat(status.balance))) {
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
        scrollWrap(
          renderV1DetailBody(inst.type, status, prefs),
          scrollOpts(prefs, 'detail')
        ) +
        `<div class="qp-footer text-ui-xs text-foreground-subtle/70">ZMod 数据源 · ${ok ? '更新于 ' + new Date(snapshotAt).toLocaleTimeString() : esc(status?.message || '查询失败')}</div>`;
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
        // 快照没变但设置变了（prefsRev 自增）时也要重建，否则改设置不生效
        if (existing && existing.getAttribute(`data-${DETAIL_MARK}`) === inst.id &&
            Number(existing.dataset.snapshotAt || 0) === snapshotAt &&
            Number(existing.dataset.prefsRev || 0) === prefsRev) continue;
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
