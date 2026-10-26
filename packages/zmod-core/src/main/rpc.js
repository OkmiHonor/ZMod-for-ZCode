import path from 'node:path';
import fs from 'node:fs';
import { configManager } from '../common/config.js';
import { autodetectDatasources } from '../common/autodetect.js';
import { secretVault } from './vault.js';
import { getPluginsDir, getUserDataDir, getPluginDataDir } from '../common/paths.js';
import { readInstalled } from '../common/installed.js';
import { registerPluginHost } from './plugin-host.js';
import { registerPluginAssetApi } from './plugin-assets.js';
import { registerBubbleHud } from './bubble-hud.js';
import { registerWhaleService } from './whale-service.js';
import { notificationTapStatus } from './notifications.js';

let electron = null;
try {
  electron = await import('electron');
} catch {
  // Not in Electron (unit tests)
}
const electronIpcMain = electron?.ipcMain ?? electron?.default?.ipcMain;
const electronShell = electron?.shell ?? electron?.default?.shell;
const electronBrowserWindow = electron?.BrowserWindow ?? electron?.default?.BrowserWindow;
const electronGlobalShortcut = electron?.globalShortcut ?? electron?.default?.globalShortcut;
const electronApp = electron?.app ?? electron?.default?.app;

export const RPC_CHANNEL = 'zmod:rpc:invoke';

/**
 * DWM window material (acrylic/mica), v1 __zmodAcrylic recipe:
 * - ORDER MATTERS: setBackgroundMaterial FIRST, then the (translucent)
 *   background color as a fallback wash. The reverse order gets overridden.
 * - TIMING MATTERS: an early call (renderer kernel boot) is clobbered by the
 *   official startup sequence, so the desired state is stored here and
 *   re-applied on every main-window did-finish-load, plus one delayed retry.
 */
const materialState = { material: null, tint: '#00000000' };
let materialWatchInstalled = false;

function isMainWindow(win) {
  try {
    if (!win || win.isDestroyed()) return false;
    const url = win.webContents?.getURL() || '';
    return url.includes('out/renderer/index.html') && !url.includes('windowKind=');
  } catch {
    return false;
  }
}

function windowsBuild() {
  const parts = String(process.getSystemVersion?.() || '').split('.').map(Number);
  return parts[2] || 0;
}

function applyMaterialToWindow(win) {
  if (!isMainWindow(win)) return { success: true, supported: true, skipped: true };
  if (materialState.material === 'none' || !materialState.material) {
    try {
      win.setBackgroundMaterial('auto');
      win.setBackgroundColor('#ffffff');
    } catch {}
    return { success: true, supported: true };
  }
  if (windowsBuild() < 22621) {
    return { success: true, supported: false, error: 'Windows build < 22621' };
  }
  try {
    win.setBackgroundMaterial(materialState.material); // material first…
    if (typeof materialState.tint === 'string' && /^#[0-9a-fA-F]{6,8}$/.test(materialState.tint)) {
      try { win.setBackgroundColor(materialState.tint); } catch {} // …color wash second
    }
    console.log(`[ZMod:RPC] DWM material "${materialState.material}" applied to main window`);
    return { success: true, supported: true };
  } catch (err) {
    return { success: true, supported: false, error: String(err?.message || err) };
  }
}

export function setWindowMaterial(material, tint) {
  if (typeof material !== 'string' || !material) return { success: false, error: 'Invalid material' };
  materialState.material = material;
  if (typeof tint === 'string' && /^#[0-9a-fA-F]{6,8}$/.test(tint)) materialState.tint = tint;

  installMaterialWatch();

  let result = { success: true, supported: true };
  if (electronBrowserWindow) {
    for (const w of electronBrowserWindow.getAllWindows()) {
      const r = applyMaterialToWindow(w);
      if (r.supported === false) result = r;
      else if (r.skipped !== true) result = r;
    }
    // one delayed retry: the official startup may still touch the window
    setTimeout(() => {
      try {
        for (const w of electronBrowserWindow.getAllWindows()) applyMaterialToWindow(w);
      } catch {}
    }, 5000).unref?.();
  }
  return result;
}

function installMaterialWatch() {
  if (materialWatchInstalled || !electronApp || !electronBrowserWindow) return;
  materialWatchInstalled = true;
  const watchWindow = (w) => {
    try {
      w.webContents.on('did-finish-load', () => {
        if (!materialState.material || materialState.material === 'none') return;
        applyMaterialToWindow(w);
      });
    } catch {}
  };
  const hookExisting = () => {
    for (const w of electronBrowserWindow.getAllWindows()) watchWindow(w);
  };
  if (electronApp.isReady()) hookExisting();
  else electronApp.once('ready', hookExisting);
  electronApp.on('browser-window-created', (_e, w) => watchWindow(w));
}

const NET_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Main-process HTTP proxy for renderer plugins. The ZCode renderer cannot
 * reach third-party APIs directly (CORS + sandbox), so data source providers
 * route through here. Only public http(s) endpoints are allowed.
 */
export async function netFetch({ url, method = 'GET', headers = {}, body, timeoutMs = 15000 }) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, status: 0, error: 'Invalid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, status: 0, error: 'Only http/https URLs are allowed' };
  }
  const m = String(method || 'GET').toUpperCase();
  if (!NET_METHODS.has(m)) {
    return { ok: false, status: 0, error: `Method not allowed: ${m}` };
  }
  const safeHeaders = {};
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof k === 'string' && typeof v === 'string') safeHeaders[k] = v;
    }
  }
  // 自管 AbortController 超时：AbortSignal.timeout 的底层 timer 在进程退出时
  // 可能触发 libuv 断言崩溃，宿主常驻进程统一禁用
  const ctrl = new AbortController();
  const timeoutTimer = setTimeout(
    () => ctrl.abort(new Error('timeout')),
    Math.min(Math.max(Number(timeoutMs) || 15000, 1000), 60000)
  );
  timeoutTimer.unref?.();
  const opts = { method: m, headers: safeHeaders, signal: ctrl.signal };
  if (body != null && m !== 'GET' && m !== 'HEAD') {
    opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const doFetch = electron?.net?.fetch || electron?.default?.net?.fetch || globalThis.fetch;
  try {
    const res = await doFetch(parsed.href, opts);
    const text = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
    return {
      ok: res.ok,
      status: res.status,
      headers: { 'content-type': res.headers?.get('content-type') || '' },
      text
    };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err), text: '' };
  } finally {
    clearTimeout(timeoutTimer);
  }
}

function getMainWindow() {
  if (!electronBrowserWindow) return null;
  const windows = electronBrowserWindow.getAllWindows();
  return (
    windows.find((w) => (w.webContents?.getURL() || '').includes('out/renderer/index.html')) ||
    windows[0] ||
    null
  );
}

class RpcGateway {
  constructor() {
    this._handlers = new Map();
    this._bossKeyAccelerator = null;
    this._registerBuiltInHandlers();
  }

  register(method, handler) {
    this._handlers.set(method, handler);
  }

  /** Single entry point shared by the IPC bridge and the zmod-local://rpc fetch channel. */
  async dispatch(method, params) {
    const handler = this._handlers.get(method);
    if (!handler) {
      throw new Error(`[ZMod:RPC] Unknown method: "${method}"`);
    }
    return handler(params || {});
  }

  _registerBuiltInHandlers() {
    // ---- Config ----
    this.register('config.get', async () => configManager.get());

    this.register('config.getPluginConfig', async ({ pluginId }) =>
      configManager.getPluginConfig(pluginId)
    );

    this.register('config.setPluginSetting', async ({ pluginId, key, value }) => {
      configManager.setPluginSetting(pluginId, key, value);
      return { success: true };
    });

    this.register('config.setPluginEnabled', async ({ pluginId, enabled }) => {
      configManager.setPluginEnabled(pluginId, enabled);
      return { success: true };
    });

    // ---- Data source instances (credentials live in the vault, never here) ----
    this.register('datasource.list', async () => configManager.getDatasources());

    this.register('datasource.save', async ({ instance }) => configManager.saveDatasource(instance));

    this.register('datasource.delete', async ({ id }) => ({
      success: configManager.deleteDatasource(id)
    }));

    this.register('datasource.autodetect', async () => {
      // %APPDATA% = <home>/AppData/Roaming → two levels up is the home dir
      const home = process.env.APPDATA
        ? path.resolve(process.env.APPDATA, '..', '..')
        : (electronApp?.getPath?.('home') || process.env.USERPROFILE || process.env.HOME || '');
      const existing = configManager.getDatasources().map((d) => d.type);
      const proposals = autodetectDatasources({ homeDir: home, existingTypes: existing });
      return { proposals };
    });

    // ---- Outbound HTTP proxy (main-process fetch: no CORS, Chromium network stack) ----
    this.register('net.fetch', async (params) => netFetch(params));

    // ---- Secret vault (safeStorage / DPAPI) ----
    this.register('vault.get', async ({ key }) => secretVault.get(key));
    this.register('vault.set', async ({ key, value }) => {
      secretVault.set(key, value);
      return { success: true };
    });
    this.register('vault.has', async ({ key }) => secretVault.has(key));
    this.register('vault.delete', async ({ key }) => {
      secretVault.delete(key);
      return { success: true };
    });
    this.register('vault.keys', async () => secretVault.keys());

    // ---- System ----
    this.register('system.openExternal', async ({ url }) => {
      if (electronShell && typeof url === 'string' && /^https?:\/\//i.test(url)) {
        await electronShell.openExternal(url);
        return { success: true };
      }
      return { success: false, error: 'Invalid URL' };
    });

    // ---- Window host features (acrylic backplate, boss key, reload) ----
    this.register('window.reload', async () => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        try {
          if (typeof win.webContents.reloadIgnoringCache === 'function') {
            win.webContents.reloadIgnoringCache();
          } else {
            win.webContents.reload();
          }
          return { success: true };
        } catch (err) {
          return { success: false, error: String(err?.message || err) };
        }
      }
      return { success: false, error: 'No main window' };
    });

    this.register('window.setMaterial', async ({ material, tint }) => {
      return setWindowMaterial(material, tint);
    });

    this.register('window.registerBossKey', async ({ accelerator }) => {
      if (!electronGlobalShortcut) return { success: false, error: 'globalShortcut unavailable' };
      if (typeof accelerator !== 'string' || !accelerator.trim()) {
        return { success: false, error: 'Invalid accelerator' };
      }
      try {
        if (this._bossKeyAccelerator && this._bossKeyAccelerator !== accelerator) {
          electronGlobalShortcut.unregister(this._bossKeyAccelerator);
        }
        const ok = electronGlobalShortcut.register(accelerator, () => this._toggleMainWindow());
        if (ok) this._bossKeyAccelerator = accelerator;
        return { success: ok, accelerator };
      } catch (err) {
        return { success: false, error: String(err?.message || err) };
      }
    });

    this.register('window.unregisterBossKey', async () => {
      if (electronGlobalShortcut && this._bossKeyAccelerator) {
        try {
          electronGlobalShortcut.unregister(this._bossKeyAccelerator);
        } catch {}
        this._bossKeyAccelerator = null;
      }
      return { success: true };
    });

    // ---- Subagent Router (smart-subagent plugin host bridge) ----
    this.register('subagentRouter.syncConfig', async (payload) => {
      try {
        const pDir = getPluginDataDir('smart-subagent');
        if (!fs.existsSync(pDir)) fs.mkdirSync(pDir, { recursive: true });
        const cfgPath = path.join(pDir, 'config.json');
        fs.writeFileSync(cfgPath, JSON.stringify(payload || {}, null, 2), 'utf8');
        console.log('[ZMod:RPC] subagentRouter config synced:', payload?.enabled);
        return { success: true };
      } catch (err) {
        return { success: false, error: err?.message || String(err) };
      }
    });

    this.register('subagentRouter.getConfig', async () => {
      try {
        const cfgPath = path.join(getPluginDataDir('smart-subagent'), 'config.json');
        if (fs.existsSync(cfgPath)) {
          return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        }
      } catch {}
      return { enabled: false };
    });

    // ---- Plugin asset access (fetch() cannot read zmod-local:// URLs) ----
    // scope 'plugin' (default) reads <plugins>/<id>/, scope 'data' reads the
    // update-surviving <plugin-data>/<id>/ written via plugin.writeAsset.
    this.register('plugin.readAsset', async ({ pluginId, relPath, scope }) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(String(pluginId || ''))) {
        return { ok: false, error: 'Invalid plugin id' };
      }
      const clean = String(relPath || '')
        .replace(/\\/g, '/')
        .replace(/\.\.+/g, '')
        .replace(/^\/+/, '');
      if (!clean || /[\0:<>"|?*]/.test(clean)) return { ok: false, error: 'Invalid path' };
      const base = scope === 'data' ? getPluginDataDir(pluginId) : path.join(getPluginsDir(), pluginId);
      const root = path.resolve(base);
      const file = path.join(base, clean);
      if (!path.resolve(file).startsWith(root + path.sep)) {
        return { ok: false, error: 'Path escapes plugin dir' };
      }
      try {
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, error: 'Not found' };
        const buf = fs.readFileSync(file);
        return { ok: true, base64: buf.toString('base64'), size: buf.length };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    });

    // ---- Telemetry tap (v1 __zmodTelemetryTap recipe) ----
    // Wraps the official "zcode:report-telemetry-event" invoke handler once,
    // forwarding message_completion payloads to the renderer over
    // "zmod:telemetry-event" (consumed via the preload bridge's on()).
    this.register('telemetry.tapStatus', async () => ({
      installed: telemetryTapInstalled
    }));

    // ---- Notification tap (official send-style task notifications) ----
    this.register('notification.tapStatus', async () => notificationTapStatus());

    // ---- Plugin discovery + plugin host (install/remove/update/marketplace) ----
    this.register('plugins.discover', async () => {
      const results = [];
      const pluginsDir = getPluginsDir();
      if (!fs.existsSync(pluginsDir)) return results;
      // 账本注入 installed:{source,installedAt}|null —— 面板按 installed.source
      // 是否为 'builtin' 甄别基座随发插件（discover 本身不区分）
      const ledger = readInstalled(getUserDataDir()).plugins;
      for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pluginId = entry.name;
        const entryPath = path.join(pluginsDir, pluginId, 'index.js');
        if (!fs.existsSync(entryPath)) continue;
        let manifest = { id: pluginId, name: pluginId, version: '1.0.0' };
        const manifestPath = path.join(pluginsDir, pluginId, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          try {
            manifest = { ...manifest, ...JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
          } catch {}
        }
        // ?v=<version>-<mtimeMs> 防渲染层 import() 模块缓存（resolveHostFile 会 strip query）
        const mtimeMs = fs.statSync(entryPath).mtimeMs;
        const ver = typeof manifest.version === 'string' ? manifest.version : '0';
        const installedRec = ledger[pluginId];
        results.push({
          ...manifest,
          id: pluginId,
          entryUrl: `zmod-local://plugins/${pluginId}/index.js?v=${ver}-${mtimeMs}`,
          styleUrl: fs.existsSync(path.join(pluginsDir, pluginId, 'style.css'))
            ? `zmod-local://plugins/${pluginId}/style.css`
            : null,
          installed: installedRec
            ? { source: installedRec.source, installedAt: installedRec.installedAt }
            : null
        });
      }
      return results;
    });

    registerPluginHost(this);

    // ---- Plugin persistent data dir assets (survive plugin updates) ----
    registerPluginAssetApi({ register: (method, handler) => this.register(method, handler) });

    // ---- Bubble HUD (task notification overlay, windows-only; window is
    // created lazily on the first bubble.show, when app is guaranteed ready) ----
    registerBubbleHud(this);

    // ---- Whale widget services (custom skins directory + sqlite model probe) ----
    registerWhaleService(this);
  }

  _toggleMainWindow() {
    const win = getMainWindow();
    if (!win) return;
    try {
      if (win.isVisible() && win.isFocused()) {
        win.hide();
      } else {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      }
    } catch (err) {
      console.error('[ZMod:RPC] boss key toggle failed:', err);
    }
  }

  attach() {
    if (!electronIpcMain) return;
    electronIpcMain.handle(RPC_CHANNEL, async (_event, payload) => {
      const { method, params } = payload || {};
      try {
        return await this.dispatch(method, params);
      } catch (err) {
        console.error(`[ZMod:RPC] "${method}" failed:`, err?.message || err);
        throw err;
      }
    });
    this.startHotReloadBridge();
  }

  /**
   * Config/vault hot reload: pick up external edits (CLI, scripts, manual
   * JSON editing) without a client restart, and push "zmod:config-changed"
   * to every renderer so datasource lists and settings pages live-refresh.
   */
  startHotReloadBridge() {
    if (this._hotReloadBridge) return;
    this._hotReloadBridge = true;
    const broadcast = () => {
      if (!electronBrowserWindow) return;
      for (const w of electronBrowserWindow.getAllWindows()) {
        try {
          w.webContents?.send?.('zmod:config-changed', { ts: Date.now() });
        } catch {}
      }
    };
    configManager.startHotReload();
    configManager.subscribe(broadcast);
    secretVault.startExternalWatch(broadcast);
  }
}

export const rpcGateway = new RpcGateway();

/**
 * Telemetry tap, ported from v1 __zmodTelemetryTap: swap the official
 * invoke handler for a wrapper that mirrors message_completion events to the
 * renderer via webContents.send("zmod:telemetry-event"). Installed at runtime
 * bootstrap (after the official handler exists — tail-import guarantees that).
 */
const TELEMETRY_CH = 'zcode:report-telemetry-event';
const TELEMETRY_FWD = 'zmod:telemetry-event';
let telemetryTapInstalled = false;

export function installTelemetryTap() {
  if (telemetryTapInstalled || !electronIpcMain) return telemetryTapInstalled;
  try {
    const handlers = electronIpcMain._invokeHandlers;
    const orig = handlers && typeof handlers.get === 'function' ? handlers.get(TELEMETRY_CH) : null;
    if (typeof orig !== 'function') {
      console.log('[ZMod:RPC] telemetry tap: official handler not found, skip');
      return false;
    }
    electronIpcMain.removeHandler(TELEMETRY_CH);
    electronIpcMain.handle(TELEMETRY_CH, async (event, ...args) => {
      try {
        // The official preload API is variadic: reportTelemetryEvent(name, data)
        // arrives here as args[0]=name(string), args[1]=data — while some callers
        // pass a single object. Normalize before filtering.
        const payload =
          args[0] && typeof args[0] === 'object'
            ? args[0]
            : { elementName: args[0], eventExtraDetail: args[1] };
        const elem = payload?.elementName ?? payload?.eventName;
        if (elem === 'message_completion' || elem === 'agent_step') {
          const win = getMainWindow();
          win?.webContents?.send?.(TELEMETRY_FWD, payload);
        }
      } catch {}
      return orig(event, ...args);
    });
    telemetryTapInstalled = true;
    console.log(`[ZMod:RPC] telemetry tap ready → ${TELEMETRY_FWD}`);
  } catch (err) {
    console.error('[ZMod:RPC] telemetry tap failed:', err?.message || err);
  }
  return telemetryTapInstalled;
}
