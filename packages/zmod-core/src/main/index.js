import { registerPrivileges, registerProtocolHandler } from './protocol.js';
import { rpcGateway, installTelemetryTap } from './rpc.js';
import { installNotificationTap } from './notifications.js';
import { installWindowShortcuts } from './shortcuts.js';
import { ensureDirectories, getUserDataDir } from '../common/paths.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let electronModule = null;
let electronApp = null;
try {
  electronModule = await import('electron');
  electronApp = electronModule.app ?? electronModule.default?.app;
} catch {
  // Not in Electron (unit tests)
}

function installAgentRouterHook() {
  try {
    const dataDir = getUserDataDir();
    // 优先加载插件目录自包含的 agent-router.cjs（实现插件解耦独立更新），不存在时回退基座内置兜底
    const pluginHook = path.join(dataDir, 'plugins', 'smart-subagent', 'agent-router.cjs');
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const fallbackHook = path.join(currentDir, 'agent-router.cjs');
    const hookFile = fs.existsSync(pluginHook) ? pluginHook : fallbackHook;
    const hookPath = hookFile.replaceAll(path.sep, '/');

    // 子进程（agent 补丁钩子）读插件配置依赖此变量：agent-router.cjs 按 ZMOD_USER_DATA_DIR
    // 定位 <data>/plugin-data/smart-subagent/config.json，需在 fork 前显式写入以便继承。
    process.env.ZMOD_USER_DATA_DIR = dataDir;
    const existing = process.env.NODE_OPTIONS || '';
    if (!existing.includes('agent-router.cjs')) {
      process.env.NODE_OPTIONS = `${existing} --require "${hookPath}"`.trim();
      console.log(`[ZMod:Core] agent router preload hook installed: ${hookPath}`);
    }

    const up = electronModule?.utilityProcess ?? electronModule?.default?.utilityProcess;
    if (up && typeof up.fork === 'function' && !up.__zmod_hooked) {
      const origFork = up.fork;
      up.fork = function (modulePath, options = {}) {
        const opts = { ...options };
        const env = { ...(opts.env || process.env) };
        if (!env.NODE_OPTIONS || !env.NODE_OPTIONS.includes('agent-router.cjs')) {
          env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require "${hookPath}"`.trim();
        }
        opts.env = env;
        return origFork.call(this, modulePath, opts);
      };
      up.__zmod_hooked = true;
      console.log('[ZMod:Core] utilityProcess.fork hooked for subagent router');
    }
  } catch (err) {
    console.error('[ZMod:Core] failed to install agent router hook:', err);
  }
}

let initialized = false;

/**
 * Main runtime entry. Loaded dynamically from the patched host main process
 * (see packages/zmod-cli/src/patches/main-tail.js); the host head patch has
 * already registered scheme privileges synchronously before app ready.
 */
export function bootstrap() {
  if (initialized) return;
  initialized = true;
  console.log('[ZMod:Core] main runtime bootstrap');

  try {
    ensureDirectories();
    registerPrivileges(); // safety net; normally a no-op (head patch did it pre-ready)
    installAgentRouterHook();
    rpcGateway.attach();
  } catch (err) {
    console.error('[ZMod:Core] bootstrap failed:', err);
    return;
  }

  const whenReady = electronApp
    ? electronApp.isReady()
      ? Promise.resolve()
      : electronApp.whenReady()
    : Promise.resolve();

  whenReady
    .then(() => {
      registerProtocolHandler();
      installWindowShortcuts();
      // Official telemetry handler registers around app ready; retry once
      // shortly after in case it is not there yet.
      if (!installTelemetryTap()) {
        setTimeout(() => installTelemetryTap(), 3000).unref?.();
      }
      // Notification tap rides a send-style channel; retry covers the case
      // where the official renderer registers it after our first attempt.
      if (!installNotificationTap()) {
        setTimeout(() => installNotificationTap(), 3000).unref?.();
      }
      console.log('[ZMod:Core] main runtime ready');
    })
    .catch((err) => console.error('[ZMod:Core] ready hook failed:', err));
}

bootstrap();

export { configManager } from '../common/config.js';
export { secretVault } from './vault.js';
export { rpcGateway };
