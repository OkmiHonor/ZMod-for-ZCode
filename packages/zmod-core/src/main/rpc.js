import path from 'node:path';
import fs from 'node:fs';
import { configManager } from '../common/config.js';
import { secretVault } from './vault.js';
import { getPluginsDir } from '../common/paths.js';

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

export const RPC_CHANNEL = 'zmod:rpc:invoke';

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

    // ---- Window host features (acrylic backplate, boss key) ----
    this.register('window.setMaterial', async ({ material, tint }) => {
      const win = getMainWindow();
      if (!win) return { success: false, error: 'Main window not found' };
      if (material === 'none' || !material) {
        try {
          win.setBackgroundMaterial('auto');
          win.setBackgroundColor('#ffffff');
          return { success: true, supported: true };
        } catch {
          return { success: true, supported: false };
        }
      }
      try {
        if (typeof tint === 'string' && /^#[0-9a-fA-F]{6,8}$/.test(tint)) {
          win.setBackgroundColor(tint);
        }
        win.setBackgroundMaterial(material);
        return { success: true, supported: true };
      } catch (err) {
        return { success: true, supported: false, error: String(err?.message || err) };
      }
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

    // ---- Plugin discovery ----
    this.register('plugins.discover', async () => {
      const results = [];
      const pluginsDir = getPluginsDir();
      if (!fs.existsSync(pluginsDir)) return results;
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
        results.push({
          ...manifest,
          id: pluginId,
          entryUrl: `zmod-local://plugins/${pluginId}/index.js`,
          styleUrl: fs.existsSync(path.join(pluginsDir, pluginId, 'style.css'))
            ? `zmod-local://plugins/${pluginId}/style.css`
            : null
        });
      }
      return results;
    });
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
  }
}

export const rpcGateway = new RpcGateway();
