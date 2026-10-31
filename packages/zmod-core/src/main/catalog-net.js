let electron = null;
try {
  electron = await import('electron');
} catch {}
const session = electron?.session ?? electron?.default?.session;
const net = electron?.net ?? electron?.default?.net;

/**
 * 目录拉取专用会话：跟随系统代理。
 *
 * 宿主把 defaultSession 钉死在 fallbackProxyMode:"direct"（applyDesktopChromiumNetworkPolicies），
 * 未配置宿主自身 httpProxy 时渲染层一切外网请求都直连——国内直连 GitHub Pages 系的
 * 插件目录源时好时坏。这里用独立 partition 开一条走路系统代理（Clash 等）的会话，
 * 只服务 dsh-compat 的目录拉取，不碰宿主任何其他网络行为。
 */
const CATALOG_PARTITION = 'persist:zmod-catalog';
let proxyConfigured = false;

function ensureSystemProxySession() {
  if (!session) return null;
  const s = session.fromPartition(CATALOG_PARTITION);
  if (!proxyConfigured) {
    proxyConfigured = true;
    s.setProxy({ mode: 'system' }).catch(() => {});
  }
  return s;
}

export function registerCatalogNet(gateway) {
  gateway.register('net.fetchText', async ({ url, headers, timeoutMs }) => {
    if (!net || !session) return { ok: false, error: 'electron-net-unavailable' };
    let href;
    try {
      const u = new URL(String(url));
      if (u.protocol !== 'https:') return { ok: false, error: 'https-only' };
      href = u.href;
    } catch {
      return { ok: false, error: 'bad-url' };
    }
    const cleanHeaders = {};
    for (const [k, v] of Object.entries(headers || {})) {
      if (typeof v === 'string') cleanHeaders[String(k).toLowerCase()] = v;
    }
    try {
      ensureSystemProxySession();
      const res = await net.fetch(href, {
        partition: CATALOG_PARTITION,
        headers: cleanHeaders,
        signal: AbortSignal.timeout(Math.max(3000, Math.min(Number(timeoutMs) || 25000, 60000)))
      });
      const text = await res.text();
      const resHeaders = {};
      res.headers.forEach((v, k) => {
        resHeaders[k.toLowerCase()] = v;
      });
      return { ok: res.ok, status: res.status, headers: resHeaders, text };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
}
