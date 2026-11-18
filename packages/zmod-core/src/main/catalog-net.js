import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getLogsDir } from '../common/paths.js';

let electron = null;
try {
  electron = await import('electron');
} catch {}
const session = electron?.session ?? electron?.default?.session;
const net = electron?.net ?? electron?.default?.net;

/**
 * 目录拉取专用会话：显式系统代理。
 *
 * 宿主把 defaultSession 钉死在 fallbackProxyMode:"direct"（applyDesktopChromiumNetworkPolicies），
 * 未配置宿主自身 httpProxy 时渲染层一切外网请求都直连——国内直连 GitHub Pages 系的
 * 插件目录源时好时坏（无声挂起而非快速失败）。
 *
 * 实测 Electron 44 上 mode:'system' 的独立会话仍会挂起（原因未明），因此不走 system 模式：
 * 直接读 HKCU WinINET 的 ProxyEnable/ProxyServer（Clash 等代理工具写的就是这里），
 * 以 fixed_servers 显式指向代理端口。只服务 dsh-compat 的目录拉取，不碰宿主任何网络行为。
 */
const CATALOG_PARTITION = 'persist:zmod-catalog';
let proxyReady = null; // Promise<string>：解析出的 electron proxyRules，null = 无代理

/** 读 HKCU WinINET 代理设置，转为 electron proxyRules；无代理返回 null。 */
function readWinInetProxyRules() {
  try {
    const r = spawnSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', timeout: 3000 }
    );
    const out = String(r.stdout || '');
    const enable = /ProxyEnable\s+REG_DWORD\s+0x1/.test(out);
    const server = /ProxyServer\s+REG_SZ\s+(\S+)/.exec(out)?.[1] || '';
    if (!enable || !server) return null;
    // WinINET 形如 "127.0.0.1:7897" 或 "http=...;https=...;socks=..."；electron 可直接吃分号形式，
    // 纯 host:port 需补协议前缀以覆盖全部协议。
    if (server.includes('=')) return server;
    return `http://${server}`;
  } catch {
    return null;
  }
}

async function ensureProxySession() {
  if (!session) return null;
  const s = session.fromPartition(CATALOG_PARTITION);
  if (!proxyReady) {
    proxyReady = (async () => {
      const rules = readWinInetProxyRules();
      try {
        if (rules) await s.setProxy({ mode: 'fixed_servers', proxyRules: rules });
        else await s.setProxy({ mode: 'direct' });
      } catch {}
      logLine(`proxy-configured rules=${rules || 'direct'}`);
      return rules;
    })();
  }
  await proxyReady.catch(() => {});
  return s;
}

/** 主进程侧落地日志：渲染层看不到这里的成败，写文件供排障直读。 */
function logLine(line) {
  try {
    const dir = getLogsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'catalog-net.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

export function registerCatalogNet(gateway) {
  gateway.register('net.fetchText', async ({ url, headers, timeoutMs }) => {
    if (!net || !session) {
      logLine(`unavailable: electron net/session missing`);
      return { ok: false, error: 'electron-net-unavailable' };
    }
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
    const started = Date.now();
    const budget = Math.max(3000, Math.min(Number(timeoutMs) || 25000, 60000));
    const deadline = started + budget;
    await ensureProxySession();
    const s = session.fromPartition(CATALOG_PARTITION);
    // session / partition 两种传参按 Electron 版本择一可用；共享同一时间预算
    let lastErr = null;
    for (const init of [{ session: s }, { partition: CATALOG_PARTITION }]) {
      const remain = deadline - Date.now();
      if (remain <= 0) break;
      try {
        const res = await net.fetch(href, {
          ...init,
          headers: cleanHeaders,
          signal: AbortSignal.timeout(remain)
        });
        const text = await res.text();
        const resHeaders = {};
        res.headers.forEach((v, k) => {
          resHeaders[k.toLowerCase()] = v;
        });
        logLine(`ok status=${res.status} bytes=${text.length} ms=${Date.now() - started} url=${href}`);
        return { ok: res.ok, status: res.status, headers: resHeaders, text };
      } catch (err) {
        lastErr = err;
      }
    }
    const msg = String(lastErr?.message || lastErr);
    logLine(`fail ms=${Date.now() - started} url=${href} error=${msg}`);
    return { ok: false, error: msg };
  });
}
