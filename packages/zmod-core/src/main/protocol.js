import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getPluginsDir, getThemesDir, getUserDataDir } from '../common/paths.js';

let electronProtocol = null;
let electronNet = null;
try {
  const electron = await import('electron');
  electronProtocol = electron.protocol || electron.default?.protocol;
  electronNet = electron.net || electron.default?.net;
} catch {
  // Not in Electron
}

export const SCHEME = 'zmod-local';

/**
 * Register the privileged scheme.
 * MUST be called before app.whenReady().
 */
export function registerPrivileges() {
  if (!electronProtocol) return;
  try {
    electronProtocol.registerSchemesAsPrivileged([
      {
        scheme: SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          allowServiceWorkers: false
        }
      }
    ]);
  } catch (err) {
    console.warn('[ZMod:Protocol] registerSchemesAsPrivileged error (already registered?):', err.message);
  }
}

/**
 * Register the request handler.
 * Called after app.whenReady().
 */
export function registerProtocolHandler(rootDir) {
  if (!electronProtocol || !electronNet) return;

  electronProtocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname; // 'core', 'plugins', 'themes'
      const pathname = decodeURIComponent(url.pathname);

      let targetFile = null;

      if (host === 'core') {
        // Look in runtime core renderer directory or built package
        targetFile = path.join(rootDir, 'src', 'renderer', pathname);
        if (!fs.existsSync(targetFile)) {
          targetFile = path.join(getUserDataDir(), 'core', pathname);
        }
      } else if (host === 'plugins') {
        // Look in user plugins directory first, then root plugins
        const parts = pathname.replace(/^\//, '').split('/');
        const pluginId = parts[0];
        const subPath = parts.slice(1).join('/');

        const userPluginFile = path.join(getPluginsDir(), pluginId, subPath);
        const builtInPluginFile = path.join(rootDir, '..', '..', 'plugins', pluginId, subPath);

        if (fs.existsSync(userPluginFile)) {
          targetFile = userPluginFile;
        } else if (fs.existsSync(builtInPluginFile)) {
          targetFile = builtInPluginFile;
        }
      } else if (host === 'themes') {
        targetFile = path.join(getThemesDir(), pathname);
      }

      if (targetFile && fs.existsSync(targetFile)) {
        return electronNet.fetch(pathToFileURL(targetFile).toString());
      }

      return new Response(`[ZMod:Protocol] File not found: ${request.url}`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain' }
      });
    } catch (err) {
      console.error('[ZMod:Protocol] Request handler error:', err);
      return new Response(`Internal error: ${err.message}`, { status: 500 });
    }
  });
}
