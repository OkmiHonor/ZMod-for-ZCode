/**
 * quota-popover — pure matching logic, zero deps, node-testable.
 *
 * Kept free of any DOM/Electron references so `node --test` can drive it
 * directly; the rendering/runtime half lives in index.js.
 */

export function hostOf(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return '';
  }
}

/** longest common substring length of two normalized strings */
export function commonLen(a, b) {
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

const HOST_TYPE_RULES = [
  { re: /(^|\.)(dashscope\.aliyuncs\.com|bailian\.aliyun\.com)$/i, type: 'bailian-bss' },
  { re: /(^|\.)deepseek\.com$/i, type: 'deepseek' },
  { re: /(^|\.)openrouter\.ai$/i, type: 'openrouter' },
  { re: /(^|\.)siliconflow\.(cn|com)$/i, type: 'siliconflow' },
  { re: /(^|\.)moonshot\.(cn|ai)$/i, type: 'moonshot' },
  { re: /(^|\.)(bigmodel\.cn|z\.ai)$/i, type: 'zhipu-coding-plan' },
  { re: /(^|\.)minimax(i)?\.(com|io|cn)$/i, type: 'minimax' },
  { re: /(^|\.)xiaomimimo\.com$/i, type: 'mimo' },
  { re: /^(127\.0\.0\.1|localhost):8045$/i, type: 'antigravity' },
  { re: /^(127\.0\.0\.1|localhost):3425$/i, type: 'magpie' }
];

/** provider → instance match:
    1. base-URL host(:port) exact equality with instance settings.url;
    2. known official provider host → datasource provider type (e.g. dashscope.aliyuncs.com → bailian-bss);
    3. ≥4-char normalized provider name overlap with instance name (allowing ≥2-char instance name when contained in providerName) or instance keywords. */
export function matchInstance(providerName, providerBaseUrl, instances) {
  const list = Array.isArray(instances) ? instances : [];
  const ph = hostOf(providerBaseUrl);
  if (ph) {
    const byHost = list.find((i) => hostOf(i?.settings?.url || i?.settings?.baseUrl) === ph);
    if (byHost) return byHost;
    for (const rule of HOST_TYPE_RULES) {
      if (rule.re.test(ph)) {
        const byType = list.find((i) => i?.type === rule.type);
        if (byType) return byType;
      }
    }
  }
  const pn = String(providerName || '').toLowerCase().replace(/\s+/g, '');
  if (pn.length < 4) return null;
  let best = null, bestLen = 3;
  for (const i of list) {
    const n = String(i?.name || '').toLowerCase().replace(/\s+/g, '');
    if (n.length >= 4) {
      const l = pn.includes(n) || n.includes(pn) ? Math.min(pn.length, n.length) : commonLen(pn, n);
      if (l > bestLen) { best = i; bestLen = l; }
    } else if (n.length >= 2 && pn.includes(n)) {
      // 支持用户将实例简写命名（如 "阿里云" 匹配 "阿里云百炼（中国）"）
      if (!best) best = i;
    }
  }
  if (best) return best;
  for (const i of list) {
    if (keywordsOf(i).some((k) => k.length >= 2 && pn.includes(k))) return i;
  }
  return null;
}

/* ---- composer model-selector button label parsing ---- */

// the capacity gauge's own label ("上下文已用 12,345 / 总量 …") also contains a
// slash; these are the toolbar buttons that must never parse as a model pick
const NON_MODEL_LABELS = /上下文已用|^添加上下文$|^切换模式$|^电脑操作$|^发送$/;
// effort words observed in the wild: 极高/最高/高/中/低/关闭 (关闭 = thinking
// off; 最高 seen on Google AI Pro) — a trailing word left in the model name
// breaks downstream model matching
const EFFORT_TAIL = /\s+(极高|最高|高|中|低|关闭)$/;
// Use non-greedy first-segment match ^([^/]+)\/ so multi-slash model IDs like
// "magpie/zcode/GLM-5.3-Flash 高" or "硅基流动/deepseek-ai/DeepSeek-V4-Flash 高"
// split cleanly into provider="硅基流动", model="deepseek-ai/DeepSeek-V4-Flash".
const SLASH_FORM = /^([^/]+)\/(.+?)\s*(?:极高|最高|高|中|低|关闭)?$/;

/** Toolbar model-selector aria-label → { provider, model }:
 *   "百炼/DeepSeek-V3 极高"    → { provider: '百炼', model: 'DeepSeek-V3' }
 *   "magpie/zcode/GLM-5.3-Flash 高" → { provider: 'magpie', model: 'zcode/GLM-5.3-Flash' }
 *   "GLM-5.3-Flash 低"         → { provider: '',     model: 'GLM-5.3-Flash' }
 *     (official GLM preset carries no provider prefix)
 *   anything else (gauge label, 发送, …) → null */
export function parseModelButtonLabel(label) {
  const l = String(label || '').trim();
  if (!l || NON_MODEL_LABELS.test(l)) return null;
  const m = SLASH_FORM.exec(l);
  if (m) return { provider: m[1].trim(), model: m[2].trim() };
  if (EFFORT_TAIL.test(l)) {
    return { provider: '', model: l.replace(EFFORT_TAIL, '').trim() };
  }
  return null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

const TYPE_DEFAULT_KEYWORDS = {
  antigravity: ['google', 'gemini', 'claude', 'gpt', 'antigravity'],
  deepseek: ['deepseek'],
  'bailian-bss': ['百炼', '阿里云', 'bailian', 'qwen', 'dashscope'],
  magpie: ['magpie', 'zcode'],
  mimo: ['mimo', 'xiaomi', '小米'],
  openrouter: ['openrouter'],
  siliconflow: ['硅基流动', 'siliconflow'],
  moonshot: ['moonshot', 'kimi', '月之暗面'],
  'zhipu-coding-plan': ['智谱', 'bigmodel', 'zhipu', 'z.ai', 'zai', 'glm'],
  minimax: ['minimax', 'minimaxi', '海螺']
};

function keywordsOf(inst) {
  const custom = String(inst?.settings?.modelKeywords || '')
    .split(/[,，]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const defaults = TYPE_DEFAULT_KEYWORDS[inst?.type] || [];
  for (const k of defaults) {
    if (!custom.includes(k)) custom.push(k);
  }
  return custom;
}

/** Which datasource instance follows the current composer selection.
 *
 * The subscription source (供应商前缀段) is the authority: when the toolbar
 * label carries a "供应商/模型" prefix, the provider segment alone picks the
 * instance — explicit keyword hit on the provider name first, then name
 * containment either direction ("百炼" ⊂ "阿里云百炼资金账户"), then optional
 * providerCatalog baseUrl/host bridge (for custom-named reverse proxies).
 * Only prefix-less labels (official GLM preset) fall back to the model chain. */
export function matchSelection(sel, snapshot, providerCatalog = null) {
  if (!sel || !Array.isArray(snapshot)) return null;
  const instances = snapshot.map((s) => s.inst).filter(Boolean);

  if (sel.provider) {
    const p = norm(sel.provider);
    if (p.length >= 2) {
      const byKw = instances.find((i) =>
        keywordsOf(i).some((k) => k.length >= 2 && (p.includes(k) || k.includes(p)))
      );
      if (byKw) return byKw;
      const byName = instances.find((i) => {
        const n = norm(i.name);
        return n.length >= 2 && (n.includes(p) || p.includes(n));
      });
      if (byName) return byName;
      // Bridge via ZCode provider catalog: resolve custom provider display name → baseUrl → matchInstance by host/type
      if (Array.isArray(providerCatalog) && providerCatalog.length > 0) {
        const cat = providerCatalog.find((c) => {
          const cn = norm(c?.name);
          const cid = norm(c?.id);
          return (cn && (cn === p || cn.includes(p) || p.includes(cn))) || (cid && cid === p);
        });
        if (cat && cat.baseUrl) {
          const byHostOrType = matchInstance(cat.name || sel.provider, cat.baseUrl, instances);
          if (byHostOrType) return byHostOrType;
        }
      }
    }
    // provider given but no instance follows it → 不注入
    return null;
  }

  const hay = norm(sel.model);
  for (const { inst } of snapshot) {
    if (keywordsOf(inst).some((k) => hay.includes(k))) return inst;
  }
  for (const { inst, status } of snapshot) {
    const s = sel.model.toLowerCase();
    const sBase = s.includes('/') ? s.split('/').pop() : s;
    if (
      (status?.models || []).some(
        (m) =>
          m.name === s ||
          m.name === sBase ||
          (sBase.length >= 4 && (sBase.includes(m.name) || m.name.includes(sBase)))
      )
    ) {
      return inst;
    }
  }
  return null;
}

/**
 * Magpie 卡片按当前模型选桶：与 antigravity 卡同策略，只显示当前模型对应的
 * 订阅源窗口——词边界精确匹配优先（GLM-5.3 不得吸走 GLM-5.3-Flash 的桶），
 * 再按模型族兜底（gemini / claude|gpt / glm|zcode / deepseek），
 * 都没命中返回 null（调用方退回全量展示，好过空卡）。
 */
export function selectMagpieBuckets(model, groups) {
  const list = Array.isArray(groups) ? groups : [];
  const m = String(model || '').toLowerCase();
  const mBase = m.includes('/') ? m.split('/').pop() : m;
  if (!mBase) return null;
  const glued = (c) => /[a-z0-9.-]/.test(c);
  const fuzzyHit = (short, long) => {
    const i = long.indexOf(short);
    if (i < 0) return false;
    const before = i > 0 ? long[i - 1] : '';
    const after = i + short.length < long.length ? long[i + short.length] : '';
    return !glued(before) && !glued(after);
  };
  const pairs = [];
  for (const g of list) {
    if (!g || typeof g !== 'object') continue;
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      if (!b || typeof b !== 'object') continue;
      const wl = String(b.window || '').toLowerCase();
      const wBase = wl.includes('/') ? wl.split('/').pop() : wl;
      if (wl === mBase || wBase === mBase || fuzzyHit(mBase, wBase) || fuzzyHit(wBase, mBase)) {
        pairs.push({ group: g, bucket: b });
      }
    }
  }
  if (pairs.length > 0) return pairs;
  const fam = /gemini|google/.test(mBase) ? /gemini/
    : /claude|gpt|opus|sonnet/.test(mBase) ? /claude|gpt/
    : /glm|zcode/.test(mBase) ? /glm/
    : /deepseek/.test(mBase) ? /deepseek/
    : null;
  if (!fam) return null;
  for (const g of list) {
    if (!g || typeof g !== 'object') continue;
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      if (fam.test(String(b.window || '').toLowerCase())) pairs.push({ group: g, bucket: b });
    }
  }
  return pairs.length > 0 ? pairs : null;
}

/* ================= card customization primitives =================
   Kept pure so the settings layer can be reasoned about and regression-tested
   without a DOM. index.js owns the wiring (reading settings, injecting styles). */

/** 滚动高度只允许整数且落在 [120,800]；非法值回退 320 —— 防止 text/number
    设置项塞进 NaN、超大值把浮窗撑破。 */
function clampMaxHeight(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 320;
  return Math.min(800, Math.max(120, Math.round(n)));
}

/** 把「卡片主体」包进可滚动容器。enabled=false 时逐字节原样返回，保证默认
    零回归；.zmod-qp-scroll 的细滚动条样式由 index.js 一次性注入 <style>。
    不加 pointer-events:none —— Radix hover-card 靠指针维持 open 态，吞掉
    指针事件会让浮窗在滚动时消失。 */
export function scrollWrap(innerHtml, opts = {}) {
  const html = typeof innerHtml === 'string' ? innerHtml : '';
  const o = opts && typeof opts === 'object' ? opts : {};
  // 是否包裹完全由调用方按 scrollScope 算好的显式布尔决定（enabled=true 才包），
  // 避免 scope 语义歧义导致默认行为意外变化
  if (o.enabled !== true) return html;
  const maxHeight = clampMaxHeight(o.maxHeight);
  return (
    `<div class="zmod-qp-scroll" data-qp-scroll="1" ` +
    `style="overflow-y:auto;overscroll-behavior:contain;max-height:${maxHeight}px;min-width:0">` +
    `${html}</div>`
  );
}

const SORT_MODES = ['default', 'custom', 'labelAsc', 'labelDesc'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function safeStrArray(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === 'string' && !FORBIDDEN_KEYS.has(x))
    .map((x) => x.slice(0, 100))
    .slice(0, 100);
}

export function parseCardPrefs(raw) {
  const out = { hiddenKeys: [], order: [], customLabels: {}, sortMode: 'default' };
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return out; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  out.hiddenKeys = safeStrArray(obj.hiddenKeys);
  out.order = safeStrArray(obj.order);
  out.sortMode = SORT_MODES.includes(obj.sortMode) ? obj.sortMode : 'default';
  if (obj.customLabels && typeof obj.customLabels === 'object' && !Array.isArray(obj.customLabels)) {
    const labels = {};
    for (const [k, v] of Object.entries(obj.customLabels)) {
      if (Object.keys(labels).length >= 50) break;
      if (FORBIDDEN_KEYS.has(k) || typeof v !== 'string') continue;
      labels[k.slice(0, 80)] = v.slice(0, 80);
    }
    out.customLabels = labels;
  }
  return out;
}

/** 按用户偏好重排/隐藏/重命名子卡。返回新数组且不修改入参；html 永不改写
    （文案替换由调用方拿新 label 重新生成）。全被隐藏时退回原数组，避免空白卡。 */
export function applyCardPrefs(cards, prefs = {}) {
  if (!Array.isArray(cards)) return [];
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const hidden = new Set(Array.isArray(p.hiddenKeys) ? p.hiddenKeys : []);
  const kept = cards.filter((c) => !hidden.has(c != null ? c.key : undefined));
  if (kept.length === 0) return cards.slice();
  const custom = p.customLabels && typeof p.customLabels === 'object' ? p.customLabels : {};
  const mapped = kept.map((c) => {
    if (!c || typeof c !== 'object') return c;
    const hasLabel = Object.prototype.hasOwnProperty.call(custom, c.key) &&
      typeof custom[c.key] === 'string';
    return hasLabel ? { ...c, label: custom[c.key] } : { ...c };
  });
  const labelOf = (c) => String((c && c.label) ?? '');
  if (p.sortMode === 'labelAsc' || p.sortMode === 'labelDesc') {
    const dir = p.sortMode === 'labelDesc' ? -1 : 1;
    mapped.sort((a, b) => dir * labelOf(a).localeCompare(labelOf(b), 'zh-CN'));
  } else if (p.sortMode === 'custom') {
    const order = Array.isArray(p.order)
      ? p.order.filter((x) => typeof x === 'string') : [];
    const rank = new Map();
    order.forEach((k, i) => { if (!rank.has(k)) rank.set(k, i); });
    // 未在 order 中的条目靠稳定排序保留原相对顺序追加在后
    mapped.sort((a, b) => {
      const ra = rank.has(a && a.key) ? rank.get(a.key) : Infinity;
      const rb = rank.has(b && b.key) ? rank.get(b.key) : Infinity;
      if (ra === Infinity && rb === Infinity) return 0;
      if (ra === Infinity) return 1;
      if (rb === Infinity) return -1;
      return ra - rb;
    });
  }
  return mapped;
}
