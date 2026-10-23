import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerPrivileges, registerProtocolHandler } from './protocol.js';
import { rpcGateway } from './rpc.js';
import { configManager } from '../common/config.js';
import { ensureDirectories } from '../common/paths.js';

let electronApp = null;
try {
  const electron = await import('electron');
  electronApp = electron.app || electron.default?.app;
} catch {
  // Not in Electron
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const coreRootDir = path.resolve(__dirname, '..', '..');

let initialized = false;

export function bootstrap() {
  if (initialized) return;
  initialized = true;

  console.log('[ZMod:Core] Main process bootstrap started');
  ensureDirectories();

  // 1. Privileged scheme must register synchronously before ready
  registerPrivileges();

  // 2. Attach unified RPC
  rpcGateway.attach();

  // 3. Register protocol handler when app ready
  if (electronApp) {
    if (electronApp.isReady()) {
      registerProtocolHandler(coreRootDir);
    } else {
      electronApp.whenReady().then(() => {
        registerProtocolHandler(coreRootDir);
      });
    }
  }

  console.log('[ZMod:Core] Main process bootstrap ready');
}

export { rpcGateway, configManager };
