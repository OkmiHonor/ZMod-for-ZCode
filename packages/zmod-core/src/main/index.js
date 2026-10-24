import { registerPrivileges, registerProtocolHandler } from './protocol.js';
import { rpcGateway, installTelemetryTap } from './rpc.js';
import { ensureDirectories } from '../common/paths.js';

let electronApp = null;
try {
  const electron = await import('electron');
  electronApp = electron.app ?? electron.default?.app;
} catch {
  // Not in Electron (unit tests)
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
      // Official telemetry handler registers around app ready; retry once
      // shortly after in case it is not there yet.
      if (!installTelemetryTap()) {
        setTimeout(() => installTelemetryTap(), 3000).unref?.();
      }
      console.log('[ZMod:Core] main runtime ready');
    })
    .catch((err) => console.error('[ZMod:Core] ready hook failed:', err));
}

bootstrap();

export { configManager } from '../common/config.js';
export { secretVault } from './vault.js';
export { rpcGateway };
