let electron = null;
try {
  electron = await import('electron');
} catch {
  // Not in Electron (unit tests)
}

const electronBrowserWindow = electron?.BrowserWindow ?? electron?.default?.BrowserWindow;
const electronApp = electron?.app ?? electron?.default?.app;

export const sharedStyles = new Map();

/**
 * Classify a window into 'main' | 'child' | 'helper' | 'destroyed'.
 */
export function classifyWindow(win) {
  try {
    if (!win || win.isDestroyed?.()) return 'destroyed';
    const url = win.webContents?.getURL?.() || '';
    if (
      win.__zmodHelperWindow ||
      ((url.startsWith('data:text/html') || url.startsWith('about:blank')) && !!win.isAlwaysOnTop?.())
    ) {
      return 'helper';
    }
    if (url.includes('out/renderer/index.html') && !url.includes('windowKind=')) {
      return 'main';
    }
    return 'child';
  } catch {
    return 'destroyed';
  }
}

/**
 * Describe a window state.
 */
export function describeWindow(win) {
  try {
    if (!win || win.isDestroyed?.()) {
      return { id: win?.id ?? -1, kind: 'destroyed', title: '', url: '', isVisible: false, isFocused: false };
    }
    return {
      id: win.id,
      kind: classifyWindow(win),
      title: win.getTitle?.() || '',
      url: win.webContents?.getURL?.() || '',
      isVisible: !!win.isVisible?.(),
      isFocused: !!win.isFocused?.()
    };
  } catch {
    return { id: win?.id ?? -1, kind: 'destroyed', title: '', url: '', isVisible: false, isFocused: false };
  }
}

function applyStyleToWindow(win, entry) {
  try {
    if (!win || win.isDestroyed?.()) return;
    const kind = classifyWindow(win);
    if (!entry.targetKinds.includes(kind)) return;
    const styleTagId = `zmod-shared-style-${entry.id}`;
    const code = `(() => {
      let el = document.getElementById(${JSON.stringify(styleTagId)});
      if (!el) {
        el = document.createElement('style');
        el.id = ${JSON.stringify(styleTagId)};
        document.head.appendChild(el);
      }
      el.textContent = ${JSON.stringify(entry.css)};
    })()`;
    win.webContents?.executeJavaScript?.(code)?.catch?.(() => {});
  } catch {}
}

function removeStyleFromWindow(win, styleId) {
  try {
    if (!win || win.isDestroyed?.()) return;
    const styleTagId = `zmod-shared-style-${styleId}`;
    const code = `(() => {
      document.getElementById(${JSON.stringify(styleTagId)})?.remove();
    })()`;
    win.webContents?.executeJavaScript?.(code)?.catch?.(() => {});
  } catch {}
}

function broadcastLifecycle(eventPayload, deps = {}) {
  const BW = deps.BrowserWindow ?? electronBrowserWindow;
  if (!BW?.getAllWindows) return;
  for (const win of BW.getAllWindows()) {
    try {
      if (win.isDestroyed?.()) continue;
      const kind = classifyWindow(win);
      if (kind === 'main' || kind === 'child') {
        win.webContents?.send?.('zmod:window-lifecycle', eventPayload);
      }
    } catch {}
  }
}

export function setSharedWindowStyle({ id, css, targetKinds = ['main', 'child'] } = {}, deps = {}) {
  if (typeof id !== 'string' || !id.trim()) {
    return { ok: false, error: 'Invalid style id' };
  }
  const cleanId = id.trim();
  const entry = {
    id: cleanId,
    css: String(css || ''),
    targetKinds: Array.isArray(targetKinds) ? targetKinds : ['main', 'child']
  };
  sharedStyles.set(cleanId, entry);

  const BW = deps.BrowserWindow ?? electronBrowserWindow;
  if (BW?.getAllWindows) {
    for (const win of BW.getAllWindows()) {
      applyStyleToWindow(win, entry);
    }
  }
  return { ok: true, id: cleanId };
}

export function removeSharedWindowStyle({ id } = {}, deps = {}) {
  if (typeof id !== 'string' || !id.trim()) {
    return { ok: false, error: 'Invalid style id' };
  }
  const cleanId = id.trim();
  sharedStyles.delete(cleanId);

  const BW = deps.BrowserWindow ?? electronBrowserWindow;
  if (BW?.getAllWindows) {
    for (const win of BW.getAllWindows()) {
      removeStyleFromWindow(win, cleanId);
    }
  }
  return { ok: true, id: cleanId };
}

export function listWindows(deps = {}) {
  const BW = deps.BrowserWindow ?? electronBrowserWindow;
  if (!BW?.getAllWindows) {
    return { ok: true, windows: [] };
  }
  const list = BW.getAllWindows()
    .filter((w) => !w.isDestroyed?.())
    .map(describeWindow);
  return { ok: true, windows: list };
}

export function installWindowLifecycleHook(deps = {}) {
  const app = deps.app ?? electronApp;
  const BW = deps.BrowserWindow ?? electronBrowserWindow;

  const hookWindow = (win) => {
    if (!win || win.isDestroyed?.() || win.__zmodLifecycleHooked) return;
    win.__zmodLifecycleHooked = true;
    const winId = win.id;

    const onFinishLoad = () => {
      try {
        if (win.isDestroyed?.()) return;
        for (const entry of sharedStyles.values()) {
          applyStyleToWindow(win, entry);
        }
        broadcastLifecycle({
          event: 'created',
          window: describeWindow(win),
          ts: Date.now()
        }, deps);
      } catch {}
    };

    if (win.webContents?.on) {
      win.webContents.on('did-finish-load', onFinishLoad);
    }

    win.once?.('closed', () => {
      broadcastLifecycle({
        event: 'closed',
        windowId: winId,
        ts: Date.now()
      }, deps);
    });
  };

  if (BW?.getAllWindows) {
    for (const win of BW.getAllWindows()) {
      hookWindow(win);
    }
  }
  if (app?.on) {
    app.on('browser-window-created', (_e, win) => hookWindow(win));
  }
}

export function registerWindowLifecycleService(gateway) {
  gateway.register('window.list', async (deps) => listWindows(deps));
  gateway.register('window.setSharedStyle', async (params) => setSharedWindowStyle(params));
  gateway.register('window.removeSharedStyle', async (params) => removeSharedWindowStyle(params));
}
