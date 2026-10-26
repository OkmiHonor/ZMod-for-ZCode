let electronContextBridge = null;
let electronIpcRenderer = null;
try {
  const electron = await import('electron');
  electronContextBridge = electron.contextBridge || electron.default?.contextBridge;
  electronIpcRenderer = electron.ipcRenderer || electron.default?.ipcRenderer;
} catch {
  // Not in Electron
}

const RPC_CHANNEL = 'zmod:rpc:invoke';

export function bootstrap() {
  if (!electronContextBridge || !electronIpcRenderer) return;

  const api = {
    version: '1.6.0',
    invoke: async (method, params = {}) => {
      return electronIpcRenderer.invoke(RPC_CHANNEL, { method, params });
    },
    on: (channel, listener) => {
      const wrapped = (event, ...args) => listener(...args);
      electronIpcRenderer.on(channel, wrapped);
      return () => electronIpcRenderer.removeListener(channel, wrapped);
    }
  };

  try {
    electronContextBridge.exposeInMainWorld('zmodAPI', api);
    console.log('[ZMod:Preload] zmodAPI exposed into main world');
  } catch (err) {
    console.error('[ZMod:Preload] Failed to expose zmodAPI:', err);
  }
}
