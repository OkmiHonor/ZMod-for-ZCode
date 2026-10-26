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

/** provider → instance match: base-URL host(:port) equality wins, then a
    ≥4-char normalized name overlap (provider display name vs instance name) */
export function matchInstance(providerName, providerBaseUrl, instances) {
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

/* ---- composer model-selector button label parsing ---- */

// the capacity gauge's own label ("上下文已用 12,345 / 总量 …") also contains a
// slash; these are the toolbar buttons that must never parse as a model pick
const NON_MODEL_LABELS = /上下文已用|^添加上下文$|^切换模式$|^电脑操作$|^发送$/;
// effort words observed in the wild: 极高/最高/高/中/低/关闭 (关闭 = thinking
// off; 最高 seen on Google AI Pro) — a trailing word left in the model name
// breaks downstream model matching
const EFFORT_TAIL = /\s+(极高|最高|高|中|低|关闭)$/;
const SLASH_FORM = /^(.+)\/(.+?)\s*(?:极高|最高|高|中|低|关闭)?$/;

/** Toolbar model-selector aria-label → { provider, model }:
 *   "百炼/DeepSeek-V3 极高"    → { provider: '百炼', model: 'DeepSeek-V3' }
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

function keywordsOf(inst) {
  const custom = String(inst?.settings?.modelKeywords || '')
    .split(/[,，]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (inst?.type === 'antigravity') {
    for (const k of ['google', 'gemini', 'claude', 'gpt', 'antigravity']) {
      if (!custom.includes(k)) custom.push(k);
    }
  } else if (inst?.type === 'deepseek') {
    if (!custom.includes('deepseek')) custom.push('deepseek');
  } else if (inst?.type === 'bailian-bss') {
    for (const k of ['百炼', 'bailian', 'qwen', 'dashscope']) {
      if (!custom.includes(k)) custom.push(k);
    }
  }
  return custom;
}

/** Which datasource instance follows the current composer selection.
 *
 * The subscription source (供应商前缀段) is the authority: when the toolbar
 * label carries a "供应商/模型" prefix, the provider segment alone picks the
 * instance — explicit keyword hit on the provider name first, then name
 * containment either direction ("百炼" ⊂ "阿里云百炼资金账户"). A model-name
 * keyword of an unrelated provider (deepseek under a 百炼 subscription) must
 * not steal the match, so the model chain does not run at all when a prefix
 * is present. Only prefix-less labels (official GLM preset) fall back to the
 * historical model chain: model keywords → antigravity status.models exact /
 * bidirectional-prefix match (gateway registers per-variant names
 * (gemini-3.8-flash-low) while the toolbar shows the base model
 * (gemini-3.8-flash) — either direction proves the same family).
 * No match → null → no injection (caller renders no balance section). */
export function matchSelection(sel, snapshot) {
  if (!sel) return null;
  const instances = snapshot.map((s) => s.inst);

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
    if ((status?.models || []).some((m) => m.name === s || (s.length >= 4 && (s.includes(m.name) || m.name.includes(s))))) return inst;
  }
  return null;
}
