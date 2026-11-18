/**
 * Builtin data source providers (merged from the former official-providers and
 * account-quota plugins — the base kernel now ships them directly).
 *
 * Everything is configuration-driven: zero endpoints and zero credentials are
 * hardcoded. Users create instances in 设置 → ZMod → 数据源.
 *
 * All presets share one generic JSON engine: send an HTTP request, extract
 * values via dot-paths from the JSON response. `custom-http` exposes the
 * engine directly; the branded presets merely pre-fill sensible defaults.
 *
 * `official-account` is the zero-credential passive reader of the official
 * entitlement data. Two channels, both zero-request:
 *
 * 1. Port sniffer (best effort): the main process hands the renderer a
 *    MessagePort to the host service broker (`zcode:service-port`, relayed
 *    into the page via window.postMessage). Frames broadcast to every
 *    listener, so entitlement-shaped responses/event-pushes can be captured.
 *    NOTE: the relay usually fires before these listeners register, so this
 *    channel only lands in some boots — it is a bonus, not the primary path.
 *
 * 2. Official usage popover DOM (primary): when the official 上下文容量
 *    hover-card opens it renders the 今日余额 cards (model · remaining% ·
 *    reset date). We parse those rows on the fly.
 *
 * Frame format (reversed from out/renderer bundles): tag-byte + LEB128-length
 * payloads — 0 undefined · 1 string · 2/3 bytes · 4 array · 5 JSON · 6 varint;
 * request [100, id, channel, method] + arg; response [201/202/203, id] + data;
 * event push [204, id] + data.
 */

/* ------------------------------------------------------------------ *
 * Generic JSON engine (former official-providers)
 * ------------------------------------------------------------------ */

function dot(obj, dotted) {
  if (!dotted) return undefined;
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Shared fetchStatus for the generic JSON engine.
 * settings: url, method, headersJson, body, token(secret), pathsJson
 * pathsJson: { "余额": "data.balance", "今日用量": "data.usage.today" }
 */
async function jsonEngineStatus(settings, ctx) {
  if (!settings.url) return { ok: false, message: '未配置请求地址（url）' };
  let headers = {};
  if (settings.headersJson) {
    try {
      headers = JSON.parse(settings.headersJson);
    } catch {
      return { ok: false, message: '请求头 JSON 格式错误' };
    }
  }
  if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
  const res = await ctx.net.fetch({
    url: settings.url,
    method: settings.method || 'GET',
    headers,
    body: settings.body || undefined
  });
  if (!res.ok && res.status === 0) {
    return { ok: false, message: res.error || '网络请求失败' };
  }
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    return { ok: false, message: `响应不是 JSON（HTTP ${res.status}）` };
  }
  if (!res.ok) {
    const apiErr = dot(json, 'message') || dot(json, 'error.message') || dot(json, 'error');
    return { ok: false, message: `HTTP ${res.status}${apiErr ? `：${apiErr}` : ''}` };
  }
  let paths = {};
  if (settings.pathsJson) {
    try {
      paths = JSON.parse(settings.pathsJson);
    } catch {
      return { ok: false, message: '提取路径 JSON 格式错误（应为 {"显示名": "a.b.c"}）' };
    }
  }
  const rows = [];
  for (const [label, p] of Object.entries(paths)) {
    const v = dot(json, p);
    if (v !== undefined && v !== null) rows.push({ label, value: String(v) });
  }
  if (rows.length === 0) {
    rows.push({ label: '响应', value: summarize(json) });
  }
  return { ok: true, rows };
}

function summarize(json) {
  const s = JSON.stringify(json);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

/** 1.2M → 120万；1.2e9 → 12亿 — magpie 用量行的中文数量级缩写 */
function fmtTokensCn(n) {
  n = Number(n) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(Math.round(n));
}

/* Antigravity Tools 网关配额（v1 quota 桥的 antigravity 源等价）：优先 GET
   {网关}/api/accounts/{id}/quota → quota_groups[].buckets[]（window=weekly/5h，
   remaining_fraction 剩余比例）；当本地网关未启动或未填 accountId 时，自动通过
   主进程 usage.getAntigravityQuota RPC 读取 ~/.antigravity_tools/accounts/*.json
   本地文件快照兜底，确保网关关闭时配额依然准确。 */
function formatAgSnapshotToStatus(snap) {
  const groups = Array.isArray(snap.groups) ? snap.groups : [];
  const fmtReset = (t) => {
    try {
      const d = new Date(t);
      if (isNaN(d.getTime())) return '';
      return `${d.getMonth() + 1}月${d.getDate()}日`;
    } catch { return ''; }
  };
  const rows = [];
  for (const g of groups) {
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      const frac = Number(b.frac ?? b.remaining_fraction);
      if (!isFinite(frac)) continue;
      const win = b.window === 'weekly' ? '每周' : b.window === '5h' ? '5 小时' : b.window || '';
      const reset = fmtReset(b.reset || b.reset_time);
      rows.push({
        label: `${g.display_name || g.name || '配额'} · ${win}`,
        value: `${(frac * 100).toFixed(1)}% 剩余${reset ? ` · ${reset}重置` : ''}`
      });
    }
  }
  if (rows.length === 0) return { ok: false, message: '配额组里没有可用桶' };
  const tier = snap.tier || snap.subscription_tier || '';
  return {
    ok: true,
    rows: tier ? [{ label: '订阅档位', value: String(tier) }, ...rows] : rows,
    models: (Array.isArray(snap.models) ? snap.models : [])
      .filter((m) => m && m.name && isFinite(Number(m.percentage)))
      .map((m) => ({ name: String(m.name).toLowerCase(), percentage: Number(m.percentage), reset: m.reset || m.reset_time || '' })),
    groups: groups.map((g) => ({
      name: String(g.display_name || g.name || ''),
      buckets: (Array.isArray(g.buckets) ? g.buckets : [])
        .filter((b) => isFinite(Number(b.frac ?? b.remaining_fraction)))
        .map((b) => ({ window: b.window, frac: Number(b.frac ?? b.remaining_fraction), reset: b.reset || b.reset_time || '' }))
    }))
  };
}

async function antigravityQuotaStatus(settings, ctx) {
  const base = String(settings.url || 'http://127.0.0.1:8045').replace(/\/+$/, '');
  const id = String(settings.accountId || '').trim();
  let httpErr = '';
  if (id) {
    const res = await ctx.net.fetch({
      url: `${base}/api/accounts/${encodeURIComponent(id)}/quota`,
      method: 'GET',
      headers: settings.token ? { Authorization: `Bearer ${settings.token}` } : {}
    });
    if (res.ok) {
      let json = null;
      try { json = JSON.parse(res.text); } catch { json = null; }
      if (json && Array.isArray(json.quota_groups) && json.quota_groups.length > 0) {
        return formatAgSnapshotToStatus({
          tier: json.subscription_tier,
          groups: json.quota_groups,
          models: json.models
        });
      }
      httpErr = '响应无 quota_groups（账号 ID 是否正确）';
    } else if (res.status === 0) {
      httpErr = (res.error || '网络请求失败') + '（网关未启动？）';
    } else {
      httpErr = `HTTP ${res.status}`;
    }
  } else {
    httpErr = '未配置账号 ID';
  }

  // 离线兜底：当网关未启动或未填 accountId 时，尝试主进程本地账号文件快照
  if (typeof ctx?.invoke === 'function') {
    try {
      const snap = await ctx.invoke('usage.getAntigravityQuota', { accountId: id });
      if (snap && snap.ok) {
        const formatted = formatAgSnapshotToStatus(snap);
        if (formatted.ok) return { ...formatted, source: 'local-file' };
      }
    } catch {}
  }
  return { ok: false, message: httpErr || '未配置账号 ID' };
}

/* Magpie 本地网关（magpie.exe）专属遥测通道：优先 GET {网关}/v1/magpie/quotas →
   data[].windows[] + GET /v1/magpie/usage?period=30d；当 magpie.exe 未启动时，
   自动通过主进程 usage.getMagpieQuota RPC 读取 ~/.config/magpie/quota-history.json
   本地文件快照兜底。 */
function formatMagpieLocalToStatus(snap) {
  const groups = Array.isArray(snap.groups) ? snap.groups : [];
  const models = Array.isArray(snap.models) ? snap.models : [];
  const usage = snap.usage || null;
  const fmtReset = (t) => {
    try {
      const d = new Date(t);
      if (isNaN(d.getTime())) return '';
      return `${d.getMonth() + 1}月${d.getDate()}日`;
    } catch { return ''; }
  };
  const rows = [];
  for (const g of groups) {
    for (const b of Array.isArray(g.buckets) ? g.buckets : []) {
      const frac = Number(b.frac);
      if (!isFinite(frac)) continue;
      const reset = fmtReset(b.reset);
      rows.push({
        label: `${g.name || '配额'} · ${b.window || '窗口'}`,
        value: `${(frac * 100).toFixed(1)}% 剩余${reset ? ` · ${reset}重置` : ''}`
      });
    }
  }
  if (rows.length === 0) return { ok: false, message: '配额窗口里没有可用数据' };
  if (usage && isFinite(Number(usage.calls)) && usage.calls > 0) {
    rows.push({ label: '30天调用', value: `${usage.calls} 次${usage.errors ? ` · 失败 ${usage.errors}` : ''}` });
    rows.push({ label: '30天 Tokens', value: `入 ${fmtTokensCn(usage.input)} · 出 ${fmtTokensCn(usage.output)} · 缓存 ${fmtTokensCn(usage.cacheRead)}` });
    if (usage.cost != null) rows.push({ label: '30天费用', value: `$${Number(usage.cost).toFixed(2)}` });
  }
  const plan = snap.plan || groups.map((g) => g.plan).find(Boolean) || '';
  return {
    ok: true,
    rows: plan ? [{ label: '订阅档位', value: plan }, ...rows] : rows,
    models,
    groups,
    usage,
    source: 'local-file'
  };
}

export async function magpieStatus(settings, ctx) {
  const base = String(settings.url || 'http://127.0.0.1:3425').replace(/\/+$/, '');
  const headers = settings.token ? { Authorization: `Bearer ${settings.token}` } : {};
  const res = await ctx.net.fetch({ url: `${base}/v1/magpie/quotas`, method: 'GET', headers });
  const tryLocalFallback = async (fallbackMsg) => {
    if (typeof ctx?.invoke === 'function') {
      try {
        const snap = await ctx.invoke('usage.getMagpieQuota', {});
        if (snap && snap.ok) {
          const formatted = formatMagpieLocalToStatus(snap);
          if (formatted.ok) return formatted;
        }
      } catch {}
    }
    return { ok: false, message: fallbackMsg };
  };
  if (!res.ok && res.status === 0) {
    return tryLocalFallback((res.error || '网络请求失败') + '（magpie 网关未启动？）');
  }
  let json = null;
  try { json = JSON.parse(res.text); } catch {
    return tryLocalFallback(`响应不是 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) {
    const apiErr = dot(json, 'error.message');
    return tryLocalFallback(`HTTP ${res.status}${apiErr ? `：${apiErr}` : ''}`);
  }
  const accounts = Array.isArray(json.data) ? json.data : [];
  const fmtReset = (t) => {
    try {
      const d = new Date(t);
      if (isNaN(d.getTime())) return '';
      return `${d.getMonth() + 1}月${d.getDate()}日`;
    } catch { return ''; }
  };
  const rows = [];
  const groups = [];
  const models = [];
  for (const acc of accounts) {
    const accName = String(acc.name || acc.provider || '配额');
    const buckets = [];
    for (const w of Array.isArray(acc.windows) ? acc.windows : []) {
      const remaining = Number(w.remaining);
      if (!isFinite(remaining)) continue;
      const reset = fmtReset(w.resetsAt);
      rows.push({
        label: `${accName} · ${w.name || '窗口'}`,
        value: `${remaining.toFixed(1)}% 剩余${reset ? ` · ${reset}重置` : ''}`
      });
      buckets.push({
        window: String(w.name || ''),
        frac: remaining / 100,
        reset: w.resetsAt || '',
        display: String(w.display || '')
      });
      if (w.name && isFinite(Number(w.used))) {
        models.push({ name: String(w.name).toLowerCase(), percentage: Number(w.used), reset: w.resetsAt || '' });
      }
    }
    groups.push({ name: accName, plan: String(acc.plan || ''), buckets });
  }
  if (rows.length === 0) {
    return tryLocalFallback('响应无配额窗口（网关未登录上游账号？）');
  }
  let usage = null;
  try {
    const u = await ctx.net.fetch({ url: `${base}/v1/magpie/usage?period=30d`, method: 'GET', headers });
    if (u.ok) {
      const uj = JSON.parse(u.text);
      if (uj && isFinite(Number(uj.calls))) {
        usage = {
          period: String(uj.period || '30d'),
          calls: Number(uj.calls),
          errors: Number(uj.errors) || 0,
          input: Number(uj.input) || 0,
          output: Number(uj.output) || 0,
          cacheRead: Number(uj.cache_read) || 0,
          cost: isFinite(Number(uj.cost)) ? Number(uj.cost) : null
        };
        rows.push({ label: '30天调用', value: `${usage.calls} 次${usage.errors ? ` · 失败 ${usage.errors}` : ''}` });
        rows.push({ label: '30天 Tokens', value: `入 ${fmtTokensCn(usage.input)} · 出 ${fmtTokensCn(usage.output)} · 缓存 ${fmtTokensCn(usage.cacheRead)}` });
        if (usage.cost != null) rows.push({ label: '30天费用', value: `$${usage.cost.toFixed(2)}` });
      }
    }
  } catch { /* usage is optional */ }
  const plan = groups.map((g) => g.plan).find(Boolean);
  return {
    ok: true,
    rows: plan ? [{ label: '订阅档位', value: plan }, ...rows] : rows,
    // structured raw data for model-level matching + quota rendering (quota-popover)
    models,
    groups,
    usage
  };
}

/* Aliyun BSS RPC signing (v1 quota-bridge parity): RFC3986 percentEncode +
   HMAC-SHA1 over "GET&%2F&" + encoded query, endpoint business.aliyuncs.com.
   Signed in the renderer via WebCrypto (zmod-local:// is a secure scheme). */
function bssEnc(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function bssCall(action, id, secret, ctx) {
  const params = {
    Action: action,
    Format: 'JSON',
    Version: '2017-12-14',
    AccessKeyId: id,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  };
  const sorted = Object.keys(params).sort().map((k) => `${bssEnc(k)}=${bssEnc(params[k])}`).join('&');
  const strToSign = 'GET&%2F&' + bssEnc(sorted);
  const keyBytes = new TextEncoder().encode(secret + '&');
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(strToSign));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  const res = await ctx.net.fetch({
    url: `https://business.aliyuncs.com/?${sorted}&Signature=${bssEnc(sig)}`,
    method: 'GET'
  });
  let json = null;
  try { json = JSON.parse(res.text); } catch { /* handled below */ }
  return { status: res.status, json };
}

/* Xiaomi MiMo console endpoints (v1 TokenMeter parity): balance/usage live on
   the platform domain only; the cookie must contain api-platform_ph. */
function cookieValue(cookie, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(String(cookie));
  return m ? m[1] : '';
}

async function mimoStatus(settings, ctx) {
  const cookie = String(settings.cookie || '').trim();
  if (!cookie) {
    return {
      ok: false,
      message: '未配置登录 Cookie — 登录 platform.xiaomimimo.com 后从 DevTools 复制整串 Cookie（须含 api-platform_ph，约 24h 过期需更新）'
    };
  }
  const ph = cookieValue(cookie, 'api-platform_ph');
  const headers = {
    Cookie: cookie,
    'x-timezone': 'Asia/Shanghai',
    Origin: 'https://platform.xiaomimimo.com',
    Referer: 'https://platform.xiaomimimo.com/console/usage'
  };
  const bal = await ctx.net.fetch({
    url: `https://platform.xiaomimimo.com/api/v1/balance${ph ? `?api-platform_ph=${encodeURIComponent(ph)}` : ''}`,
    method: 'GET',
    headers: { ...headers, Referer: 'https://platform.xiaomimimo.com/console/usage' }
  });
  if (bal.status === 401) return { ok: false, message: 'Cookie 已失效 — 重新复制 platform.xiaomimimo.com 登录 Cookie' };
  let balJson = null;
  try { balJson = JSON.parse(bal.text); } catch { return { ok: false, message: `响应不是 JSON（HTTP ${bal.status}）` }; }
  if (!balJson || balJson.code !== 0 || !balJson.data) {
    return { ok: false, message: `接口错误 ${balJson?.code ?? bal.status}${balJson?.msg ? '：' + balJson.msg : ''}` };
  }
  const rows = [];
  try {
    const usage = await ctx.net.fetch({
      url: `https://platform.xiaomimimo.com/api/v1/usage${ph ? `?api-platform_ph=${encodeURIComponent(ph)}` : ''}`,
      method: 'GET',
      headers: { ...headers, Referer: 'https://platform.xiaomimimo.com/console/usage' }
    });
    const uj = JSON.parse(usage.text);
    const mc = parseFloat(uj?.data?.costUsage?.currentMonthCost);
    const tt = parseInt(uj?.data?.tokenUsage?.totalToken, 10);
    if (isFinite(mc)) rows.push({ label: '本月消费', value: `¥${mc.toFixed(2)}` });
    if (isFinite(tt)) rows.push({ label: '本月 Token', value: tt >= 1e6 ? (tt / 1e6).toFixed(1) + 'M' : String(tt) });
  } catch { /* usage is optional */ }
  return { ok: true, balance: String(parseFloat(balJson.data.balance)), currency: '¥', rows };
}

async function bailianBssStatus(settings, ctx) {
  const id = String(settings.accessKeyId || '').trim();
  const secret = String(settings.accessKeySecret || '').trim();
  if (!id || !secret) return { ok: false, message: '未配置 RAM AccessKey（需 AliyunBSSReadOnlyAccess 授权）' };
  let bal;
  try {
    bal = await bssCall('QueryAccountBalance', id, secret, ctx);
  } catch (e) {
    return { ok: false, message: (e?.message || String(e)) + '（网络请求失败）' };
  }
  if (bal.status !== 200) {
    return { ok: false, message: `HTTP ${bal.status}${bal.json?.Message ? '：' + bal.json.Message : ''}` };
  }
  const bj = bal.json || {};
  if (!bj.Data || bj.Data.AvailableAmount == null) {
    return { ok: false, message: (bj.Code ? bj.Code + ': ' : '返回结构异常：') + (bj.Message || '空数据') };
  }
  const rows = [];
  // vouchers are non-fatal (v1 parity: failure just drops the row)
  try {
    const vc = await bssCall('QueryCashCoupons', id, secret, ctx);
    const list = vc.json?.Data && (vc.json.Data.CashCoupon || vc.json.Data.UserCoupons || vc.json.Data.Coupons);
    if (Array.isArray(list)) {
      let sum = 0, n = 0, expire = null;
      for (const c of list) {
        const st = String(c?.Status || '').toLowerCase();
        if (st && !/valid|normal|effective|available/.test(st)) continue;
        const v = parseFloat(c && (c.Balance != null ? c.Balance : c.FaceValue));
        if (isFinite(v) && v > 0) {
          sum += v; n++;
          const d = String(c?.ValidEndTime || c?.ExpiryTime || '').trim().slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!expire || d < expire)) expire = d;
        }
      }
      if (n > 0) {
        rows.push({ label: '可用代金券', value: `¥${sum.toFixed(2)}` });
        rows.push({ label: '代金券明细', value: `${n} 张 · 最近 ${expire} 到期` });
      }
    }
  } catch { /* optional */ }
  return { ok: true, balance: String(parseFloat(bj.Data.AvailableAmount)), currency: '¥', rows };
}

/* ------------------------------------------------------------------ *
 * NewAPI / OneAPI / Veloera / VoAPI / Sub2API 反代网关与常见订阅源适配器
 * ------------------------------------------------------------------ */

function normalizeGatewayBaseUrl(rawUrl) {
  let u = String(rawUrl || '').trim().replace(/\/+$/, '');
  u = u.replace(
    /\/(v1\/dashboard\/billing\/(subscription|usage|credit_grants)|dashboard\/billing\/(subscription|usage|credit_grants)|api\/usage\/token|api\/user\/self|api\/v1\/subscriptions\/summary|api\/v1\/auth\/me|v1\/chat\/completions|v1\/messages|v1)$/i,
    ''
  );
  return u.replace(/\/+$/, '');
}

/**
 * NewAPI / OneAPI 内部额度单位换算：
 * 标准 OneAPI / NewAPI 内部 QuotaPerUnit = 500,000（即 500,000 内部单位 = $1.00）。
 * 若用户显式配置了 quotaPerUnit 则按配置折算；默认 500000 下，当返回值为整数且绝对值 >= 1000
 * （或 >= quotaPerUnit / 100）时按内部单位除以 quotaPerUnit，若网关已直接返回小数美元则保持原值。
 */
function convertGatewayQuota(rawVal, quotaPerUnit = 500000, forceUnit = false) {
  const n = Number(rawVal);
  if (!Number.isFinite(n)) return 0;
  const unit = Number(quotaPerUnit);
  if (Number.isFinite(unit) && unit > 1) {
    if (forceUnit || (Number.isInteger(n) && Math.abs(n) >= 1000) || Math.abs(n) >= unit / 10) {
      return n / unit;
    }
  }
  return n;
}

function fmtDateShort(tsOrIso) {
  if (!tsOrIso) return '';
  try {
    const n = Number(tsOrIso);
    if (Number.isFinite(n) && n <= 0) return '';
    const d = Number.isFinite(n) ? new Date(n < 1e11 ? n * 1000 : n) : new Date(String(tsOrIso));
    if (isNaN(d.getTime()) || d.getFullYear() < 2020) return '';
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

/**
 * 通用反代网关查询引擎（NewAPI / OneAPI / Veloera / VoAPI / DoneHub / Sub2API）：
 * 自动按优先级探测：
 * 1. GET {base}/api/usage/token（NewAPI 令牌级额度：total_granted / total_used / total_available / unlimited_quota）
 * 2. GET {base}/v1/dashboard/billing/subscription + /v1/dashboard/billing/usage（OneAPI/OpenAI 兼容账单：hard_limit_usd - total_usage/100）
 * 3. GET {base}/api/user/self（NewAPI/Veloera 账户级额度，支持 New-Api-User / Veloera-User 请求头，quota / used_quota）
 * 4. GET {base}/api/v1/subscriptions/summary（Sub2API 订阅池：daily/weekly/monthly 窗口）
 */
export async function newapiStatus(settings, ctx) {
  const rawUrl = String(settings.url || settings.baseUrl || '').trim();
  if (!rawUrl) return { ok: false, message: '未配置反代网关地址（url）' };

  // 若用户在 openai-compatible 下显式配置了 pathsJson，优先尝试用户自定义路径提取
  const hasCustomPaths = Boolean(settings.pathsJson && String(settings.pathsJson).trim() && String(settings.pathsJson).trim() !== '{}');
  if (hasCustomPaths && !/\/(v1|api)$/i.test(rawUrl.replace(/\/+$/, ''))) {
    const customRes = await jsonEngineStatus(settings, ctx);
    if (customRes.ok) return customRes;
  }

  let extraHeaders = {};
  if (settings.headersJson) {
    try {
      extraHeaders = JSON.parse(settings.headersJson);
    } catch {
      return { ok: false, message: '附加请求头 JSON 格式错误' };
    }
  }
  const token = String(settings.token || '').trim();
  const userId = String(settings.userId || '').trim();
  const cur = String(settings.currency || '$').trim() || '$';
  const rawUnit = Number(settings.quotaPerUnit);
  const quotaPerUnit = Number.isFinite(rawUnit) && rawUnit > 0 ? rawUnit : 500000;

  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (userId) {
    headers['New-Api-User'] = userId;
    headers['Veloera-User'] = userId;
    headers['User-id'] = userId;
  }

  const base = normalizeGatewayBaseUrl(rawUrl);
  if (!base) return { ok: false, message: '网关地址格式无效' };

  let lastErr = '';

  // 通道 1: GET /api/usage/token (NewAPI / OneAPI 令牌级额度接口)
  try {
    const r1 = await ctx.net.fetch({ url: `${base}/api/usage/token`, method: 'GET', headers });
    if (r1.ok) {
      const j1 = JSON.parse(r1.text);
      const d = (j1 && typeof j1.data === 'object' && j1.data) ? j1.data : j1;
      if (d && (d.object === 'token_usage' || d.total_available !== undefined || d.total_granted !== undefined || d.unlimited_quota !== undefined)) {
        const unlimited = Boolean(d.unlimited_quota) || Number(d.total_granted) >= 1e13 || Number(d.total_available) < 0;
        const used = convertGatewayQuota(d.total_used ?? 0, quotaPerUnit);
        const avail = unlimited ? 0 : Math.max(0, convertGatewayQuota(d.total_available ?? 0, quotaPerUnit));
        const grantedRaw = convertGatewayQuota(d.total_granted ?? 0, quotaPerUnit);
        const granted = grantedRaw > 0 ? grantedRaw : avail + used;
        const frac = !unlimited && granted > 0 ? Math.max(0, Math.min(1, avail / granted)) : null;
        const exp = fmtDateShort(d.expires_at);
        const rows = [];
        if (d.name) rows.push({ label: '令牌名称', value: String(d.name) });
        rows.push({ label: '剩余额度', value: unlimited ? '无限额度' : `${cur}${avail.toFixed(2)}` });
        rows.push({ label: '已用额度', value: `${cur}${used.toFixed(2)}` });
        if (!unlimited && granted > 0) {
          rows.push({ label: '总额度', value: `${cur}${granted.toFixed(2)}` });
        }
        if (exp) rows.push({ label: '到期时间', value: exp });
        const groups = frac !== null
          ? [{
              name: d.name ? `令牌 · ${d.name}` : '令牌额度',
              buckets: [{ window: '剩余额度', frac, reset: exp ? new Date(Number(d.expires_at) < 1e11 ? Number(d.expires_at) * 1000 : Number(d.expires_at)).toISOString() : '' }]
            }]
          : [];
        return {
          ok: true,
          balance: unlimited ? '∞' : avail.toFixed(2),
          currency: cur,
          unlimited,
          totalGranted: granted,
          totalUsed: used,
          totalAvailable: avail,
          remainingFrac: frac,
          expiresAt: exp,
          rows,
          groups
        };
      }
    } else if (r1.status === 0) {
      lastErr = r1.error || '网络请求失败';
    } else {
      lastErr = `HTTP ${r1.status}`;
    }
  } catch {}

  // 通道 2: GET /v1/dashboard/billing/subscription + /v1/dashboard/billing/usage
  try {
    const rSub = await ctx.net.fetch({ url: `${base}/v1/dashboard/billing/subscription`, method: 'GET', headers });
    if (rSub.ok) {
      const sub = JSON.parse(rSub.text);
      if (sub && (sub.hard_limit_usd !== undefined || sub.system_hard_limit_usd !== undefined || sub.object === 'billing_subscription')) {
        const hardLimit = Number(sub.hard_limit_usd ?? sub.system_hard_limit_usd ?? 0);
        // OneAPI/NewAPI 若余额本身放大了 500000 倍则还原，>= 1e8 代表无限额度
        const unlimited = hardLimit >= 1e8 || sub.unlimited_quota === true;
        let usedUsd = 0;
        try {
          const now = new Date();
          const start = new Date(now.getTime() - 99 * 86400_000);
          const fmtD = (dt) => dt.toISOString().slice(0, 10);
          const rUse = await ctx.net.fetch({
            url: `${base}/v1/dashboard/billing/usage?start_date=${fmtD(start)}&end_date=${fmtD(now)}`,
            method: 'GET',
            headers
          });
          if (rUse.ok) {
            const uj = JSON.parse(rUse.text);
            if (uj && Number.isFinite(Number(uj.total_usage))) {
              // OpenAI / OneAPI / NewAPI billing/usage 的 total_usage 单位为美分 (cents)
              usedUsd = Number(uj.total_usage) / 100;
            }
          }
        } catch {}
        const granted = unlimited ? 0 : hardLimit;
        const avail = unlimited ? 0 : Math.max(0, granted - usedUsd);
        const frac = !unlimited && granted > 0 ? Math.max(0, Math.min(1, avail / granted)) : null;
        const exp = fmtDateShort(sub.access_until);
        const rows = [
          { label: '剩余额度', value: unlimited ? '无限额度' : `${cur}${avail.toFixed(2)}` },
          { label: '已用额度', value: `${cur}${usedUsd.toFixed(2)}` }
        ];
        if (!unlimited && granted > 0) {
          rows.push({ label: '总额度', value: `${cur}${granted.toFixed(2)}` });
        }
        if (exp) rows.push({ label: '到期时间', value: exp });
        const groups = frac !== null
          ? [{
              name: sub.plan?.title || '网关订阅额度',
              buckets: [{ window: '剩余额度', frac, reset: '' }]
            }]
          : [];
        return {
          ok: true,
          balance: unlimited ? '∞' : avail.toFixed(2),
          currency: cur,
          unlimited,
          totalGranted: granted,
          totalUsed: usedUsd,
          totalAvailable: avail,
          remainingFrac: frac,
          expiresAt: exp,
          rows,
          groups
        };
      }
    } else if (rSub.status === 0) {
      lastErr = rSub.error || '网络请求失败';
    } else {
      lastErr = `HTTP ${rSub.status}`;
    }
  } catch {}

  // 通道 3: GET /api/user/self (NewAPI / OneAPI / Veloera 账户级详情，需系统访问令牌 + New-Api-User)
  try {
    const rSelf = await ctx.net.fetch({ url: `${base}/api/user/self`, method: 'GET', headers });
    if (rSelf.ok) {
      const js = JSON.parse(rSelf.text);
      const u = js?.data && typeof js.data === 'object' ? js.data : null;
      if (u && (u.quota !== undefined || u.used_quota !== undefined)) {
        const avail = Math.max(0, convertGatewayQuota(u.quota ?? 0, quotaPerUnit, true));
        const used = Math.max(0, convertGatewayQuota(u.used_quota ?? 0, quotaPerUnit, true));
        const granted = avail + used;
        const frac = granted > 0 ? Math.max(0, Math.min(1, avail / granted)) : null;
        const rows = [];
        if (u.display_name || u.username) rows.push({ label: '账户', value: String(u.display_name || u.username) });
        if (u.group) rows.push({ label: '分组', value: String(u.group) });
        rows.push({ label: '剩余额度', value: `${cur}${avail.toFixed(2)}` });
        rows.push({ label: '历史已用', value: `${cur}${used.toFixed(2)}` });
        if (Number.isFinite(Number(u.request_count))) {
          rows.push({ label: '请求次数', value: `${u.request_count} 次` });
        }
        const groups = frac !== null
          ? [{
              name: u.group ? `账户 (${u.group})` : '账户额度',
              buckets: [{ window: '剩余比例', frac, reset: '' }]
            }]
          : [];
        return {
          ok: true,
          balance: avail.toFixed(2),
          currency: cur,
          totalGranted: granted,
          totalUsed: used,
          totalAvailable: avail,
          remainingFrac: frac,
          rows,
          groups
        };
      }
    }
  } catch {}

  // 通道 4: Sub2API 订阅汇总 (/api/v1/subscriptions/summary 或 /api/v1/auth/me)
  try {
    const rSub2 = await ctx.net.fetch({ url: `${base}/api/v1/subscriptions/summary`, method: 'GET', headers });
    if (rSub2.ok) {
      const j2 = JSON.parse(rSub2.text);
      const d2 = j2?.data && typeof j2.data === 'object' ? j2.data : j2;
      const subs = Array.isArray(d2?.subscriptions) ? d2.subscriptions : Array.isArray(d2?.active_subscriptions) ? d2.active_subscriptions : [];
      if (subs.length > 0 || d2?.balance !== undefined) {
        const rows = [];
        const groups = [];
        for (const s of subs) {
          const gName = String(s.group_name || s.name || '订阅套餐');
          const buckets = [];
          for (const [wKey, uField, lField] of [
            ['日额度', 'daily_usage_usd', 'daily_limit_usd'],
            ['周额度', 'weekly_usage_usd', 'weekly_limit_usd'],
            ['月额度', 'monthly_usage_usd', 'monthly_limit_usd']
          ]) {
            const lim = Number(s[lField]);
            const use = Number(s[uField]) || 0;
            if (Number.isFinite(lim) && lim > 0) {
              const rem = Math.max(0, lim - use);
              const frac = Math.max(0, Math.min(1, rem / lim));
              buckets.push({ window: wKey, frac, reset: s.expires_at || '' });
              rows.push({ label: `${gName} · ${wKey}`, value: `剩余 ${cur}${rem.toFixed(2)} / ${cur}${lim.toFixed(2)}` });
            }
          }
          if (buckets.length > 0) groups.push({ name: gName, buckets });
        }
        const bal = d2?.balance !== undefined ? Number(d2.balance) : null;
        return {
          ok: true,
          balance: Number.isFinite(bal) ? bal.toFixed(2) : undefined,
          currency: cur,
          rows,
          groups
        };
      }
    }
  } catch {}

  if (hasCustomPaths) {
    return jsonEngineStatus(settings, ctx);
  }
  return {
    ok: false,
    message: lastErr
      ? `网关额度探测未命中（${lastErr}）— 请确认令牌有效，或在下方填写自定义取值路径`
      : '网关未开启 /api/usage/token 或 /v1/dashboard/billing/subscription 接口'
  };
}

/** OpenRouter 官方余额与 Key 限额（GET /api/v1/credits + /api/v1/key） */
export async function openrouterStatus(settings, ctx) {
  const token = String(settings.token || '').trim();
  if (!token) return { ok: false, message: '未配置 OpenRouter API Key' };
  const base = String(settings.url || 'https://openrouter.ai').replace(/\/(api\/v1\/(credits|key|auth\/key)|api\/v1|v1)\/?$/i, '').replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${token}` };

  let totalCredits = null, totalUsage = null;
  try {
    const rc = await ctx.net.fetch({ url: `${base}/api/v1/credits`, method: 'GET', headers });
    if (rc.ok) {
      const jc = JSON.parse(rc.text);
      if (jc?.data && Number.isFinite(Number(jc.data.total_credits))) {
        totalCredits = Number(jc.data.total_credits);
        totalUsage = Number(jc.data.total_usage) || 0;
      }
    }
  } catch {}

  let keyData = null;
  try {
    const rk = await ctx.net.fetch({ url: `${base}/api/v1/key`, method: 'GET', headers });
    if (rk.ok) {
      const jk = JSON.parse(rk.text);
      if (jk?.data) keyData = jk.data;
    } else if (totalCredits === null) {
      if (rk.status === 0) return { ok: false, message: rk.error || '网络请求失败' };
      return { ok: false, message: `HTTP ${rk.status}` };
    }
  } catch {}

  if (totalCredits === null && !keyData) {
    return { ok: false, message: '无法获取 OpenRouter 账户或 Key 额度信息' };
  }

  const rows = [];
  const groups = [];
  let balance = null;
  let remainingFrac = null;

  if (totalCredits !== null) {
    const avail = Math.max(0, totalCredits - (totalUsage || 0));
    balance = avail.toFixed(2);
    remainingFrac = totalCredits > 0 ? Math.max(0, Math.min(1, avail / totalCredits)) : null;
    rows.push({ label: '账户总充值', value: `$${totalCredits.toFixed(2)}` });
    rows.push({ label: '账户总消耗', value: `$${(totalUsage || 0).toFixed(2)}` });
  }

  if (keyData) {
    const kLimit = keyData.limit != null ? Number(keyData.limit) : null;
    const kRem = keyData.limit_remaining != null ? Number(keyData.limit_remaining) : null;
    const kUsage = Number(keyData.usage) || 0;
    if (balance === null && Number.isFinite(kRem)) {
      balance = Math.max(0, kRem).toFixed(2);
    }
    if (Number.isFinite(kLimit) && kLimit > 0 && Number.isFinite(kRem)) {
      const f = Math.max(0, Math.min(1, kRem / kLimit));
      if (remainingFrac === null) remainingFrac = f;
      groups.push({
        name: keyData.label ? `Key · ${keyData.label}` : 'Key 限额',
        buckets: [{ window: keyData.limit_reset || '剩余限额', frac: f, reset: '' }]
      });
      rows.push({ label: 'Key 剩余限额', value: `$${Math.max(0, kRem).toFixed(2)} / $${kLimit.toFixed(2)}` });
    }
    rows.push({ label: 'Key 累计消耗', value: `$${kUsage.toFixed(2)}` });
    if (Number.isFinite(Number(keyData.usage_daily)) && Number(keyData.usage_daily) > 0) {
      rows.push({ label: '今日消耗', value: `$${Number(keyData.usage_daily).toFixed(2)}` });
    }
    if (Number.isFinite(Number(keyData.usage_weekly)) && Number(keyData.usage_weekly) > 0) {
      rows.push({ label: '本周消耗', value: `$${Number(keyData.usage_weekly).toFixed(2)}` });
    }
  }

  return {
    ok: true,
    balance: balance ?? '0.00',
    currency: '$',
    totalGranted: totalCredits,
    totalUsed: totalUsage ?? (keyData ? Number(keyData.usage) || 0 : 0),
    remainingFrac,
    rows,
    groups
  };
}

/** 硅基流动 SiliconFlow 账户余额（GET /v1/user/info → totalBalance / chargeBalance / balance） */
export async function siliconflowStatus(settings, ctx) {
  const token = String(settings.token || '').trim();
  if (!token) return { ok: false, message: '未配置硅基流动 API Key' };
  const rawUrl = String(settings.url || 'https://api.siliconflow.cn/v1/user/info').trim();
  const url = /\/v1\/user\/info$/i.test(rawUrl)
    ? rawUrl
    : rawUrl.replace(/\/(v1\/chat\/completions|v1)\/?$/i, '').replace(/\/+$/, '') + '/v1/user/info';
  const res = await ctx.net.fetch({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok && res.status === 0) return { ok: false, message: res.error || '网络请求失败' };
  let json = null;
  try { json = JSON.parse(res.text); } catch { return { ok: false, message: `响应不是 JSON（HTTP ${res.status}）` }; }
  if (!res.ok || !json?.data) {
    return { ok: false, message: json?.message || `HTTP ${res.status}` };
  }
  const d = json.data;
  const total = parseFloat(d.totalBalance ?? d.balance ?? 0) || 0;
  const charge = parseFloat(d.chargeBalance ?? 0) || 0;
  const gift = parseFloat(d.balance ?? 0) || 0;
  const rows = [
    { label: '充值余额', value: `${charge.toFixed(2)}` },
    { label: '赠送余额', value: `${gift.toFixed(2)}` }
  ];
  if (d.name || d.email) rows.push({ label: '账户', value: String(d.name || d.email) });
  return {
    ok: true,
    balance: String(total),
    currency: '¥',
    rows
  };
}

/** Moonshot / Kimi 开放平台余额（GET /v1/users/me/balance → available_balance / cash_balance / voucher_balance） */
export async function moonshotStatus(settings, ctx) {
  const token = String(settings.token || '').trim();
  if (!token) return { ok: false, message: '未配置 Moonshot API Key' };
  const rawUrl = String(settings.url || 'https://api.moonshot.cn/v1/users/me/balance').trim();
  const url = /\/users\/me\/balance$/i.test(rawUrl)
    ? rawUrl
    : rawUrl.replace(/\/(v1\/chat\/completions|v1)\/?$/i, '').replace(/\/+$/, '') + '/v1/users/me/balance';
  const res = await ctx.net.fetch({
    url,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok && res.status === 0) return { ok: false, message: res.error || '网络请求失败' };
  let json = null;
  try { json = JSON.parse(res.text); } catch { return { ok: false, message: `响应不是 JSON（HTTP ${res.status}）` }; }
  if (!res.ok || !json?.data) {
    return { ok: false, message: json?.error?.message || `HTTP ${res.status}` };
  }
  const d = json.data;
  // 官方规范：必须以 available_balance 为准，cash_balance 为负时不可与 voucher 相加
  const avail = parseFloat(d.available_balance ?? 0) || 0;
  const cash = parseFloat(d.cash_balance ?? 0) || 0;
  const voucher = parseFloat(d.voucher_balance ?? 0) || 0;
  const rows = [
    { label: '现金余额', value: `¥${cash.toFixed(2)}` },
    { label: '代金券余额', value: `¥${voucher.toFixed(2)}` }
  ];
  return {
    ok: true,
    balance: String(avail),
    currency: '¥',
    rows
  };
}

/** 智谱 GLM / Z.ai Coding Plan 套餐配额（GET /api/monitor/usage/quota/limit） */
export async function zhipuCodingPlanStatus(settings, ctx) {
  const token = String(settings.token || '').trim();
  if (!token) return { ok: false, message: '未配置智谱 / Z.ai API Key' };
  const rawUrl = String(settings.url || 'https://open.bigmodel.cn/api/monitor/usage/quota/limit').trim();
  let url = rawUrl;
  if (!/\/monitor\/usage\/quota\/limit/i.test(url)) {
    const host = /z\.ai/i.test(url) ? 'https://api.z.ai' : 'https://open.bigmodel.cn';
    url = `${host}/api/monitor/usage/quota/limit`;
  }
  const res = await ctx.net.fetch({
    url,
    method: 'GET',
    headers: {
      Authorization: /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok && res.status === 0) return { ok: false, message: res.error || '网络请求失败' };
  let json = null;
  try { json = JSON.parse(res.text); } catch { return { ok: false, message: `响应不是 JSON（HTTP ${res.status}）` }; }
  if (!res.ok || (json.code && json.code !== 200 && json.success !== true)) {
    return { ok: false, message: json?.msg || json?.message || `HTTP ${res.status}` };
  }
  const limits = Array.isArray(json?.data?.limits) ? json.data.limits : [];
  if (limits.length === 0) {
    return { ok: false, message: '未查询到 Coding Plan 套餐配额（确认账号已开通 GLM Coding 套餐）' };
  }
  const rows = [];
  const buckets = [];
  const planName = String(json?.data?.planName || json?.data?.level || 'GLM Coding Plan');
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue;
    const type = String(item.type || '');
    const usedPct = Number(item.percentage);
    if (!Number.isFinite(usedPct)) continue;
    const remPct = Math.max(0, Math.min(100, 100 - usedPct));
    const resetIso = item.nextResetTime ? new Date(Number(item.nextResetTime)).toISOString() : '';
    const winLabel = type === 'TOKENS_LIMIT' ? '5小时 Token 额度' : type === 'TIME_LIMIT' ? 'MCP 工具额度' : (item.name || type || '套餐额度');
    buckets.push({
      window: winLabel,
      frac: remPct / 100,
      reset: resetIso
    });
    const resetStr = fmtDateShort(item.nextResetTime);
    rows.push({
      label: winLabel,
      value: `${remPct.toFixed(1)}% 剩余${resetStr ? ` · ${resetStr}` : ''}`
    });
  }
  if (buckets.length === 0) return { ok: false, message: '套餐配额列表为空' };
  return {
    ok: true,
    rows: [{ label: '订阅档位', value: planName }, ...rows],
    groups: [{ name: planName, plan: planName, buckets }]
  };
}

/** MiniMax Token Plan / Coding Plan 套餐余量（GET /v1/api/openplatform/coding_plan/remains 或 /v1/token_plan/remains） */
export async function minimaxStatus(settings, ctx) {
  const token = String(settings.token || '').trim();
  if (!token) return { ok: false, message: '未配置 MiniMax API Key' };
  const rawUrl = String(settings.url || 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains').trim();
  const base = rawUrl.replace(/\/(v1\/api\/openplatform\/coding_plan\/remains|v1\/token_plan\/remains|anthropic|v1).*$/i, '').replace(/\/+$/, '') || 'https://api.minimaxi.com';
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let json = null;
  let lastStatus = 0;
  for (const ep of ['/v1/api/openplatform/coding_plan/remains', '/v1/token_plan/remains']) {
    const r = await ctx.net.fetch({ url: `${base}${ep}`, method: 'GET', headers });
    lastStatus = r.status;
    if (r.ok) {
      try {
        const parsed = JSON.parse(r.text);
        if (Array.isArray(parsed?.model_remains) || Array.isArray(parsed?.data?.model_remains)) {
          json = parsed;
          break;
        }
      } catch {}
    }
  }
  if (!json) {
    return { ok: false, message: lastStatus === 0 ? '网络请求失败' : `未查询到 MiniMax 套餐余量（HTTP ${lastStatus}）` };
  }
  const list = Array.isArray(json.model_remains) ? json.model_remains : (json.data?.model_remains || []);
  const rows = [];
  const buckets = [];
  const models = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const name = String(m.model_name || 'MiniMax');
    const total = Number(m.current_interval_total_count) || 0;
    const usedOrRem = Number(m.current_interval_usage_count) || 0;
    if (total <= 0) continue;
    // MiniMax 接口 current_interval_usage_count 在部分版本中表示剩余次数或已用次数，支持布尔或比例归一
    const remCount = m.current_interval_remaining_count != null
      ? Number(m.current_interval_remaining_count)
      : Math.max(0, total - usedOrRem);
    const frac = Math.max(0, Math.min(1, remCount / total));
    const resetIso = m.end_time ? new Date(Number(m.end_time) < 1e11 ? Number(m.end_time) * 1000 : Number(m.end_time)).toISOString() : '';
    buckets.push({ window: name, frac, reset: resetIso });
    models.push({ name: name.toLowerCase(), percentage: Math.round((1 - frac) * 100), reset: resetIso });
    rows.push({
      label: `${name} · 5小时窗口`,
      value: `剩余 ${(frac * 100).toFixed(1)}% (${remCount}/${total})`
    });
  }
  if (buckets.length === 0) return { ok: false, message: 'MiniMax 套餐无可用模型配额记录' };
  return {
    ok: true,
    rows: [{ label: '订阅档位', value: 'MiniMax Token Plan' }, ...rows],
    models,
    groups: [{ name: 'MiniMax Token Plan', plan: 'Token Plan', buckets }]
  };
}

const COMMON_ENGINE_SETTINGS = {
  url: {
    type: 'text',
    title: '请求地址',
    description: '完整 http(s) 接口地址，GET 请求直接返回 JSON 的接口最简单',
    placeholder: 'https://example.com/api/balance'
  },
  modelKeywords: {
    type: 'text',
    title: '供应商/模型匹配关键字（可选）',
    description: '逗号分隔。当前选中的供应商名或模型名含任一关键字时，用量浮窗显示此源；留空则按实例名称相似度自动匹配',
    placeholder: '百炼, qwen'
  },
  method: {
    type: 'select',
    title: '请求方法',
    default: 'GET',
    options: [
      { value: 'GET', label: 'GET' },
      { value: 'POST', label: 'POST' }
    ]
  },
  token: {
    type: 'secret',
    title: '访问令牌（可选）',
    description: '将以 Authorization: Bearer <令牌> 头发送，加密保存'
  },
  headersJson: {
    type: 'text',
    title: '附加请求头（可选）',
    description: 'JSON 对象格式，如 {"X-Api-Key": "..."}',
    placeholder: '{}'
  },
  body: {
    type: 'text',
    title: '请求体（可选）',
    description: 'POST 时的请求体内容'
  },
  pathsJson: {
    type: 'text',
    title: '结果提取路径',
    description: 'JSON 对象：显示名 → 响应中的取值路径。如 {"余额": "data.balance"}',
    placeholder: '{"余额": "data.balance"}'
  }
};

function preset(overrides) {
  const custom = overrides.settings || {};
  return {
    ...overrides,
    settings: Object.fromEntries(
      Object.entries({ ...COMMON_ENGINE_SETTINGS, ...custom }).map(([key, def]) => [
        key,
        key in COMMON_ENGINE_SETTINGS ? { ...COMMON_ENGINE_SETTINGS[key], ...def } : def
      ])
    ),
    // per-preset overrides win; the generic JSON engine is only the fallback
    fetchStatus: overrides.fetchStatus || jsonEngineStatus,
    test: overrides.test || jsonEngineStatus
  };
}

/* ------------------------------------------------------------------ *
 * official-account passive collection (former account-quota)
 * ------------------------------------------------------------------ */

const MSG_PROMISE_SUCCESS = 201;
const MSG_EVENT_FIRE = 204;
const REQ_PROMISE = 100;
const TARGET_CHANNEL = 'usage-stats';
const TARGET_METHOD = 'getEntitlementSnapshot';

function readVarint(r) {
  let value = 0, shift = 0;
  for (;;) {
    const byte = r.buf[r.pos++];
    value += (byte & 127) * Math.pow(2, shift);
    if (!(byte & 128)) return value;
    shift += 7;
  }
}

function readValue(r) {
  const tag = r.buf[r.pos++];
  switch (tag) {
    case 0: return undefined;
    case 1: {
      const len = readVarint(r);
      const s = r.buf.slice(r.pos, r.pos + len);
      r.pos += len;
      return new TextDecoder().decode(s);
    }
    case 2: case 3: {
      const len = readVarint(r);
      r.pos += len;
      return null;
    }
    case 4: {
      const n = readVarint(r);
      const a = [];
      for (let i = 0; i < n; i++) a.push(readValue(r));
      return a;
    }
    case 5: {
      const len = readVarint(r);
      const s = r.buf.slice(r.pos, r.pos + len);
      r.pos += len;
      return JSON.parse(new TextDecoder().decode(s));
    }
    case 6: return readVarint(r);
    default: return undefined;
  }
}

function decodeFrame(bytes) {
  try {
    const r = { buf: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), pos: 0 };
    const head = readValue(r);
    if (!Array.isArray(head) || head.length < 2) return null;
    const data = readValue(r);
    return { head, data };
  } catch {
    return null;
  }
}

function looksLikeEntitlement(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  if (keys.includes('ack') && keys.length <= 2) return false;
  return ['subscription', 'quota', 'remaining', 'entitlement', 'entitlements', 'limits'].some((k) => keys.includes(k));
}

/** Parse "今日余额" rows out of the official hover-card DOM.
 *  Row structure (3.16.3): grid cell per model —
 *    name div.truncate, value span.font-mono ("63%"), date span (" · 10月26日"). */
function rowsFromPopover(host) {
  const rows = [];
  // the balance section contains the header AND model rows (percent + reset date);
  // header-only divs also contain the literal 今日余额, so require a date too
  const sections = [...host.querySelectorAll('div')].filter(
    (d) => /今日余额/.test(d.textContent || '') && /\d{1,2}月\d{1,2}日/.test(d.textContent || '')
  );
  const section = sections[sections.length - 1];
  if (!section) return rows;
  const cells = section.querySelectorAll('div[class*="space-y-1.5"]');
  for (const cell of cells) {
    const name = cell.querySelector('div.truncate, [class*="truncate"]')?.textContent?.trim();
    const spans = [...cell.querySelectorAll('span')];
    const pctSpan = spans.find((s) => /^\d+(\.\d+)?%$/.test(s.textContent?.trim() || ''));
    if (!name || !pctSpan) continue;
    const date = spans.find((s) => /\d{1,2}月\d{1,2}日/.test(s.textContent || ''))?.textContent?.trim() || '';
    rows.push({ label: name, value: `${Math.round(parseFloat(pctSpan.textContent))}% 剩余${date ? ' · ' + date.replace(/^\s*·\s*/, '') : ''}` });
  }
  return rows;
}

let latest = null; // { rows, source, at }

function publishSnapshot() {
  try {
    window.__zmod_account_quota__ = latest && {
      rows: latest.rows,
      source: latest.source,
      observedAt: latest.at
    };
  } catch {}
}

/** Arm the passive collectors. Renderer-only: no-ops outside a DOM (tests). */
function armOfficialAccountCollectors() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__zmod_account_quota_armed__) return; // reload safety mirrors the kernel flag
  window.__zmod_account_quota_armed__ = true;
  publishSnapshot();

  /* channel 2 (primary): official popover DOM */
  const popObserver = new MutationObserver(() => {
    for (const pop of document.querySelectorAll('[data-slot="hover-card-content"]')) {
      if (!pop.isConnected || pop.getAttribute('data-zmod-acct-observed') === '1') continue;
      pop.setAttribute('data-zmod-acct-observed', '1');
      const rows = rowsFromPopover(pop);
      if (rows.length > 0) {
        latest = { rows, source: 'official-popover', at: Date.now() };
        publishSnapshot();
        console.log('[ZMod:DataSources] captured 今日余额 rows from official popover:', rows.map((r) => r.label + ' ' + r.value).join(' | '));
      }
    }
  });
  popObserver.observe(document.body, { childList: true, subtree: true });

  /* channel 1 (bonus): service-port frame sniffer */
  const pendingIds = new Map();
  const onMessage = (ev) => {
    const d = ev.data;
    if (!d || d.type !== 'zcode:service-port' || !ev.ports || !ev.ports.length) return;
    const port = ev.ports[0];
    port.addEventListener('message', (msg) => {
      const frame = decodeFrame(msg.data);
      if (!frame) return;
      const [type, id] = frame.head;
      if (type === REQ_PROMISE && frame.head.length >= 4 && frame.head[2] === TARGET_CHANNEL && frame.head[3] === TARGET_METHOD) {
        pendingIds.set(id, true);
        if (pendingIds.size > 20) pendingIds.delete(pendingIds.keys().next().value);
      } else if (type === MSG_PROMISE_SUCCESS && pendingIds.has(id) && looksLikeEntitlement(frame.data)) {
        pendingIds.delete(id);
        latest = { rows: [], snapshot: frame.data, source: 'service-port', at: Date.now() };
        publishSnapshot();
        console.log('[ZMod:DataSources] captured entitlement snapshot (service-port response)');
      } else if (type === MSG_EVENT_FIRE && looksLikeEntitlement(frame.data)) {
        latest = { rows: [], snapshot: frame.data, source: 'service-port', at: Date.now() };
        publishSnapshot();
        console.log('[ZMod:DataSources] captured entitlement snapshot (service-port event push)');
      }
    });
    // NEVER call port.start() here: the official client starts the flow itself
    // after boot; an early start() flushes queued server frames before the
    // official listener attaches and stalls app boot (verified empirically).
  };
  window.addEventListener('message', onMessage);
}

/* ------------------------------------------------------------------ *
 * Registration entry (called from the renderer boot sequence)
 * ------------------------------------------------------------------ */

/**
 * Register the builtin providers on the shared DataSourceRegistry. Provider
 * fetchStatus/test receive the registry's own provider ctx (net.fetch via
 * `net.fetch` RPC, secrets via the vault) — the same channels the plugin
 * ctx.datasources facade used, so the moved definitions are unchanged.
 */
export function registerBuiltinProviders(datasourceRegistry) {
  if (!datasourceRegistry || typeof datasourceRegistry.registerProvider !== 'function') {
    console.warn('[ZMod:DataSources] no datasource registry, builtin providers skipped');
    return 0;
  }

  const ds = datasourceRegistry;
  ds.registerProvider(
    preset({
      type: 'custom-http',
      label: '自定义 HTTP 接口',
      description: '任意返回 JSON 的接口：填地址、鉴权与取值路径即可接入'
    })
  );
  ds.registerProvider(
    preset({
      type: 'newapi',
      label: 'NewAPI / OneAPI 反代网关',
      description: '自动探测 /api/usage/token、/v1/dashboard/billing/subscription 与 /api/user/self（自动折算 500,000 内部单位 = $1，适配 NewAPI / OneAPI / Veloera / VoAPI / Sub2API 等主流中转站）',
      settings: {
        url: {
          title: '网关地址',
          description: '填写中转站根地址或 /v1 地址即可（如 https://api.example.com），会自动探测额度接口',
          placeholder: 'https://api.example.com'
        },
        token: {
          type: 'secret',
          title: 'API Key / 系统令牌',
          description: '中转站分发的 sk-... 令牌或系统访问令牌，以 Bearer 头发送，加密保存'
        },
        userId: {
          type: 'text',
          title: '用户 ID（可选）',
          description: '仅当使用系统访问令牌查询 /api/user/self 时需填写 New-Api-User ID；普通 sk- 令牌留空即可',
          placeholder: '留空即可'
        },
        currency: {
          type: 'select',
          title: '显示币种符号',
          default: '$',
          options: [
            { value: '$', label: '$ (USD / 刀)' },
            { value: '¥', label: '¥ (CNY / 元)' }
          ]
        },
        quotaPerUnit: {
          type: 'number',
          title: '内部额度换算比',
          description: 'NewAPI / OneAPI 默认 500000 内部单位 = 1 美元/元；如网关已直接返回真实金额可填 1',
          default: 500000
        },
        pathsJson: { default: '' }
      },
      fetchStatus: newapiStatus,
      test: async (settings, ctx) => {
        const r = await newapiStatus(settings, ctx);
        return r.ok ? { ok: true, message: `连接成功，剩余额度 ${r.currency || '$'}${r.balance}` } : r;
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'openai-compatible',
      label: 'OpenAI 兼容网关',
      description: '兼容 /v1/dashboard/billing、/api/usage/token 或自定义 JSON 路径的反代网关；留空提取路径时自动按 NewAPI / OneAPI 规范探测',
      settings: {
        method: { default: 'GET' },
        pathsJson: {
          default: '',
          placeholder: '{"总额度": "total_available", "已用": "total_usage"}',
          description: '留空则自动探测 /api/usage/token 与 /v1/dashboard/billing；也可手动填写 JSON 取值路径'
        }
      },
      fetchStatus: newapiStatus,
      test: async (settings, ctx) => {
        const r = await newapiStatus(settings, ctx);
        return r.ok ? { ok: true, message: '连接成功，网关额度接口可访问' } : r;
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'console-web',
      label: '控制台网页接口（Cookie）',
      description: '需要登录态 Cookie 的控制台余额接口；Cookie 加密保存，请自行确认接口地址与合规性',
      settings: {
        headersJson: {
          title: '附加请求头（含 Cookie）',
          description: '如 {"Cookie": "..."}；敏感值建议改用下方令牌字段',
          placeholder: '{"Cookie": "..."}'
        }
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'deepseek',
      label: 'DeepSeek 官方余额',
      description: 'DeepSeek 开放平台余额接口：充值/赠送双卡（api.deepseek.com），令牌加密保存',
      settings: {
        url: {
          title: '请求地址',
          default: 'https://api.deepseek.com/user/balance',
          placeholder: 'https://api.deepseek.com/user/balance'
        },
        token: {
          title: 'API Key',
          description: 'DeepSeek 开放平台的 API Key，以 Bearer 头发送，加密保存'
        },
        pathsJson: {
          default: '',
          placeholder: '{"总余额": "balance_infos.0.total_balance", "赠送": "balance_infos.0.granted_balance", "充值": "balance_infos.0.topped_up_balance"}',
          description: '默认留空即可自动使用官方双卡字段；响应含 balance_infos 数组'
        }
      },
      fetchStatus: async (settings, ctx) => {
        const url = settings.url || 'https://api.deepseek.com/user/balance';
        const res = await ctx.net.fetch({
          url,
          method: 'GET',
          headers: settings.token ? { Authorization: `Bearer ${settings.token}` } : {}
        });
        if (!res.ok && res.status === 0) return { ok: false, message: res.error || '网络请求失败' };
        let json = null;
        try { json = JSON.parse(res.text); } catch { return { ok: false, message: `响应不是 JSON（HTTP ${res.status}）` }; }
        if (!res.ok) {
          return { ok: false, message: `HTTP ${res.status}${json.error?.message ? '：' + json.error.message : ''}` };
        }
        if (!json.is_available || !Array.isArray(json.balance_infos) || !json.balance_infos.length) {
          return { ok: false, message: '账户不可用或无余额信息' };
        }
        const info = json.balance_infos[0];
        const cur = info.currency === 'CNY' ? '¥' : info.currency || '';
        return {
          ok: true,
          balance: String(parseFloat(info.total_balance || 0)),
          currency: cur,
          rows: [
            { label: '充值余额', value: String(parseFloat(info.topped_up_balance || 0)) },
            { label: '赠送余额', value: String(parseFloat(info.granted_balance || 0)) }
          ]
        };
      },
      test: async (settings, ctx) => {
        const r = await jsonEngineStatus({ ...settings, url: settings.url || 'https://api.deepseek.com/user/balance', method: 'GET' }, ctx);
        return r.ok ? { ok: true, message: '连接成功，余额接口可访问' } : r;
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'openrouter',
      label: 'OpenRouter 官方额度',
      description: 'OpenRouter 账户余额与 API Key 周期限额（/api/v1/credits + /api/v1/key），密钥加密保存',
      settings: {
        url: {
          title: '请求地址',
          default: 'https://openrouter.ai/api/v1/credits',
          placeholder: 'https://openrouter.ai/api/v1/credits'
        },
        modelKeywords: {
          placeholder: 'openrouter, claude, gpt, gemini'
        },
        token: {
          type: 'secret',
          title: 'API Key',
          description: 'OpenRouter 的 sk-or-v1-... 密钥，加密保存'
        },
        pathsJson: { default: '' }
      },
      fetchStatus: openrouterStatus,
      test: async (settings, ctx) => {
        const r = await openrouterStatus(settings, ctx);
        return r.ok ? { ok: true, message: `连接成功，可用余额 $${r.balance}` } : r;
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'siliconflow',
      label: '硅基流动 SiliconFlow',
      description: '硅基流动账户总余额、充值余额与赠送余额（api.siliconflow.cn/v1/user/info），密钥加密保存',
      settings: {
        url: {
          title: '请求地址',
          default: 'https://api.siliconflow.cn/v1/user/info',
          placeholder: 'https://api.siliconflow.cn/v1/user/info'
        },
        modelKeywords: {
          placeholder: '硅基流动, siliconflow'
        },
        token: {
          type: 'secret',
          title: 'API Key',
          description: '硅基流动 sk-... 密钥，加密保存'
        },
        pathsJson: { default: '' }
      },
      fetchStatus: siliconflowStatus,
      test: async (settings, ctx) => {
        const r = await siliconflowStatus(settings, ctx);
        return r.ok ? { ok: true, message: `连接成功，总余额 ¥${r.balance}` } : r;
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'moonshot',
      label: 'Moonshot / Kimi 开放平台',
      description: '月之暗面 Kimi 开放平台可用余额、现金与代金券（api.moonshot.cn/v1/users/me/balance），密钥加密保存',
      settings: {
        url: {
          title: '请求地址',
          default: 'https://api.moonshot.cn/v1/users/me/balance',
          placeholder: 'https://api.moonshot.cn/v1/users/me/balance'
        },
        modelKeywords: {
          placeholder: 'moonshot, kimi, 月之暗面'
        },
        token: {
          type: 'secret',
          title: 'API Key',
          description: 'Moonshot 开放平台 sk-... 密钥，加密保存'
        },
        pathsJson: { default: '' }
      },
      fetchStatus: moonshotStatus,
      test: async (settings, ctx) => {
        const r = await moonshotStatus(settings, ctx);
        return r.ok ? { ok: true, message: `连接成功，可用余额 ¥${r.balance}` } : r;
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'zhipu-coding-plan',
      label: '智谱 GLM / Z.ai Coding Plan',
      description: '智谱 BigModel / Z.ai Coding 套餐配额监控（5小时 Token 限额与 MCP 工具限额百分比），密钥加密保存',
      settings: {
        url: {
          title: '配额接口地址',
          default: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
          placeholder: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
        },
        modelKeywords: {
          placeholder: '智谱, bigmodel, zhipu, z.ai, glm'
        },
        token: {
          type: 'secret',
          title: 'API Key',
          description: '智谱开放平台或 Z.ai 的 API Key，加密保存'
        },
        pathsJson: { default: '' }
      },
      fetchStatus: zhipuCodingPlanStatus,
      test: async (settings, ctx) => {
        const r = await zhipuCodingPlanStatus(settings, ctx);
        return r.ok ? { ok: true, message: `连接成功，已获取 ${(r.rows || []).length} 项套餐指标` } : r;
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'minimax',
      label: 'MiniMax Token Plan 套餐',
      description: 'MiniMax Coding Plan / Token Plan 5小时模型调用余量（api.minimaxi.com），密钥加密保存',
      settings: {
        url: {
          title: '配额接口地址',
          default: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
          placeholder: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains'
        },
        modelKeywords: {
          placeholder: 'minimax, 海螺'
        },
        token: {
          type: 'secret',
          title: 'API Key',
          description: 'MiniMax 开放平台或 Token Plan 密钥，加密保存'
        },
        pathsJson: { default: '' }
      },
      fetchStatus: minimaxStatus,
      test: async (settings, ctx) => {
        const r = await minimaxStatus(settings, ctx);
        return r.ok ? { ok: true, message: `连接成功，${(r.rows || []).length} 条套餐记录` } : r;
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'antigravity',
      label: 'Antigravity 配额（反代网关）',
      description: 'Antigravity Tools 本地网关的账号分组配额（Gemini/Claude/GPT 周额与 5h 额，网关未启动时自动读本地快照），密钥加密保存',
      settings: {
        url: {
          title: '网关地址',
          default: 'http://127.0.0.1:8045',
          placeholder: 'http://127.0.0.1:8045'
        },
        accountId: {
          type: 'text',
          title: '账号 ID',
          description: '网关账号的 id，见 ~/.antigravity_tools/accounts.json 的 current_account_id（留空可自动读取本地当前账号）',
          placeholder: '9af6d73c-…'
        },
        token: {
          title: 'API Key',
          description: '网关 API Key（Antigravity Tools 设置里查看），以 Bearer 头发送，加密保存'
        },
        pathsJson: { default: '' }
      },
      fetchStatus: antigravityQuotaStatus,
      test: async (settings, ctx) => {
        const r = await antigravityQuotaStatus(settings, ctx);
        return r.ok ? { ok: true, message: `连接成功，${(r.rows || []).length} 条配额` } : r;
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'magpie',
      label: 'Magpie 本地网关',
      description: 'Magpie 网关的模型配额与 30 天用量（/v1/magpie/quotas + /usage，网关未启动时自动回退本地历史快照）',
      settings: {
        url: {
          title: '网关地址',
          default: 'http://127.0.0.1:3425',
          placeholder: 'http://127.0.0.1:3425'
        },
        modelKeywords: {
          title: '供应商/模型匹配关键字（可选）',
          description: '逗号分隔。当前选中的供应商名或模型名含任一关键字时，用量浮窗显示此源；留空则按实例名称相似度自动匹配',
          placeholder: 'magpie, zcode'
        },
        token: {
          title: '访问令牌（可选）',
          description: '本机网关默认免鉴权，留空即可；远程部署时以 Bearer 头发送，加密保存'
        },
        pathsJson: { default: '' }
      },
      fetchStatus: magpieStatus,
      test: async (settings, ctx) => {
        const r = await magpieStatus(settings, ctx);
        return r.ok
          ? { ok: true, message: `连接成功，${(r.groups || []).reduce((n, g) => n + (g.buckets || []).length, 0)} 个配额窗口` }
          : r;
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'bailian-bss',
      label: '阿里云百炼资金账户（BSS）',
      description: 'BSS QueryAccountBalance/QueryCashCoupons 查现金余额与代金券（RAM 用户 + AliyunBSSReadOnlyAccess 授权；sk- API Key 查不了余额，这是唯一正路）',
      settings: {
        accessKeyId: { type: 'secret', title: 'AccessKey ID', description: '阿里云 RAM 用户的 AccessKey ID，加密保存' },
        accessKeySecret: { type: 'secret', title: 'AccessKey Secret', description: 'RAM 用户的 AccessKey Secret，加密保存' },
        modelKeywords: {
          title: '供应商/模型匹配关键字（可选）',
          description: '逗号分隔。当前选中的供应商名或模型名含任一关键字时，用量浮窗显示此源；留空则按实例名称相似度自动匹配',
          placeholder: '百炼, qwen, dashscope'
        }
      },
      fetchStatus: bailianBssStatus,
      test: async (settings, ctx) => {
        const r = await bailianBssStatus(settings, ctx);
        return r.ok ? { ok: true, message: `连接成功，现金余额 ¥${r.balance}` } : r;
      }
    })
  );
  ds.registerProvider(
    preset({
      type: 'mimo',
      label: '小米 MiMo 账户',
      description: 'platform.xiaomimimo.com 控制台余额与本月消费（需登录 Cookie，约 24h 过期需更新）',
      settings: {
        cookie: { type: 'secret', title: '登录 Cookie', description: '登录 platform.xiaomimimo.com 后从 DevTools 复制整串 Cookie（须含 api-platform_ph），加密保存' },
        modelKeywords: {
          title: '供应商/模型匹配关键字（可选）',
          description: '逗号分隔。当前选中的供应商名或模型名含任一关键字时，用量浮窗显示此源；留空则按实例名称相似度自动匹配',
          placeholder: 'mimo, xiaomi, 小米'
        }
      },
      fetchStatus: mimoStatus,
      test: async (settings, ctx) => {
        const r = await mimoStatus(settings, ctx);
        return r.ok ? { ok: true, message: `连接成功，余额 ¥${r.balance}` } : r;
      }
    })
  );

  /* ---- official-account: the passive snapshot as a first-class source ----
     Collection stays builtin (this module owns official-account observation);
     registering it as a provider lets any datasource consumer (浮窗/设置页)
     use it like any other source — zero credentials, zero requests. */
  armOfficialAccountCollectors();
  ds.registerProvider({
    type: 'official-account',
    label: '官方账号额度（零凭据）',
    description: '被动读取官方登录账号的今日余额/配额（悬停输入框「上下文容量」打开官方弹窗即刷新），无需任何 API Key',
    settings: {
      modelKeywords: {
        title: '供应商/模型匹配关键字（可选）',
        description: '逗号分隔。当前选中的供应商名或模型名含任一关键字时，用量浮窗显示此源；留空则按实例名称相似度自动匹配',
        placeholder: 'glm, zai'
      }
    },
    fetchStatus: async () => {
      const q = typeof window === 'undefined' ? null : window.__zmod_account_quota__;
      if (q && Array.isArray(q.rows) && q.rows.length > 0) {
        return { ok: true, rows: q.rows, ts: q.observedAt };
      }
      return { ok: false, message: '暂无采集数据 — 悬停输入框「上下文容量」打开官方弹窗即可采集（零凭据，不发任何请求）' };
    },
    test: async () => {
      const q = typeof window === 'undefined' ? null : window.__zmod_account_quota__;
      return q && Array.isArray(q.rows) && q.rows.length > 0
        ? { ok: true, message: `已有 ${q.rows.length} 条采集数据` }
        : { ok: false, message: '暂无采集数据 — 打开一次官方用量弹窗后重试' };
    }
  });

  console.log('[ZMod:DataSources] registered 15 builtin data source providers');
  return 15;
}
