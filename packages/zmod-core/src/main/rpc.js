import path from 'node:path';
import fs from 'node:fs';
import { configManager } from '../common/config.js';
import { secretVault } from './vault.js';
import { getPluginsDir, getUserDataDir } from '../common/paths.js';

let electronIpcMain = null;
let electronShell = null;
try {
  const electron = await import('electron');
  electronIpcMain = electron.ipcMain || electron.default?.ipcMain;
  electronShell = electron.shell || electron.default?.shell;
} catch {
  // Not in Electron
}

export const RPC_CHANNEL = 'zmod:rpc:invoke';

class RpcGateway {
  constructor() {
    this._handlers = new Map();
    this._registerBuiltInHandlers();
  }

  register(method, handler) {
    this._handlers.set(method, handler);
  }

  _registerBuiltInHandlers() {
    // Config Handlers
    this.register('config.get', async () => {
      return configManager.get();
    });

    this.register('config.getPluginConfig', async ({ pluginId }) => {
      return configManager.getPluginConfig(pluginId);
    });

    this.register('config.setPluginSetting', async ({ pluginId, key, value }) => {
      configManager.setPluginSetting(pluginId, key, value);
      return { success: true };
    });

    this.register('config.setPluginEnabled', async ({ pluginId, enabled }) => {
      configManager.setPluginEnabled(pluginId, enabled);
      return { success: true };
    });

    // Vault Handlers
    this.register('vault.get', async ({ key }) => {
      return secretVault.get(key);
    });

    this.register('vault.set', async ({ key, value }) => {
      secretVault.set(key, value);
      return { success: true };
    });

    this.register('vault.has', async ({ key }) => {
      return secretVault.has(key);
    });

    // System Handlers
    this.register('system.openExternal', async ({ url }) => {
      if (electronShell && typeof url === 'string' && /^https?:\/\//i.test(url)) {
        await electronShell.openExternal(url);
        return { success: true };
      }
      return { success: false, error: 'Invalid URL' };
    });

    // Plugin Discovery
    this.register('plugins.discover', async ({ rootDir }) => {
      const results = [];
      const scanDir = (dir, isBuiltIn) => {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const pluginId = entry.name;
            const manifestPath = path.join(dir, pluginId, 'manifest.json');
            const entryPath = path.join(dir, pluginId, 'index.js');
            if (fs.existsSync(entryPath)) {
              let manifest = { id: pluginId, name: pluginId, version: '1.0.0' };
              if (fs.existsSync(manifestPath)) {
                try {
                  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                } catch {}
              }
              results.push({
                ...manifest,
                id: pluginId,
                isBuiltIn,
                entryUrl: `zmod-local://plugins/${pluginId}/index.js`,
                styleUrl: fs.existsSync(path.join(dir, pluginId, 'style.css'))
                  ? `zmod-local://plugins/${pluginId}/style.css`
                  : null
              });
            }
          }
        }
      };

      // 1. Built-in plugins
      if (rootDir) {
        scanDir(path.resolve(rootDir, '..', '..', 'plugins'), true);
      }
      // 2. User plugins
      scanDir(getPluginsDir(), false);

      return results;
    });
  }

  attach() {
    if (!electronIpcMain) return;
    electronIpcMain.handle(RPC_CHANNEL, async (event, payload) => {
      const { method, params } = payload || {};
      const handler = this._handlers.get(method);
      if (!handler) {
        throw new Error(`[ZMod:RPC] Unknown method: "${method}"`);
      }
      try {
        return await handler(params || {}, event);
      } catch (err) {
        console.error(`[ZMod:RPC] Error executing "${method}":`, err);
        throw err;
      }
    });
  }
}

export const rpcGateway = new RpcGateway();
