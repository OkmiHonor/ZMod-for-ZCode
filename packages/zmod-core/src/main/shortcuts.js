let electron = null;
try {
  electron = await import('electron');
} catch {
  // Not in Electron (unit tests)
}

const electronApp = electron?.app ?? electron?.default?.app;
const electronBrowserWindow = electron?.BrowserWindow ?? electron?.default?.BrowserWindow;

/**
 * Handle a raw input event from webContents "before-input-event".
 * Pure logic extracted for clean unit testability.
 *
 * Supported shortcuts:
 *   - Ctrl+R / Cmd+R / F5   → reload ignoring cache
 *   - F12 / Ctrl+Shift+I / Cmd+Option+I → toggle developer tools
 *
 * @param {object} input Electron input event descriptor
 * @param {object} win Target window-like object with webContents
 * @returns {string|null} Action taken ('reload' | 'devtools' | null)
 */
export function handleInputEvent(input, win) {
  if (!input || input.type !== 'keyDown' || !win?.webContents) return null;

  const key = String(input.key || '');
  const keyLower = key.toLowerCase();
  const isCtrl = !!(input.control || input.meta);
  const isShift = !!input.shift;
  const isAlt = !!input.alt;

  // 1. Reload (Ctrl+R / Cmd+R / F5 / Ctrl+Shift+R)
  const isR = keyLower === 'r';
  const isF5 = key === 'F5';
  if ((isCtrl && isR) || isF5) {
    try {
      if (typeof win.webContents.reloadIgnoringCache === 'function') {
        win.webContents.reloadIgnoringCache();
      } else if (typeof win.webContents.reload === 'function') {
        win.webContents.reload();
      }
      return 'reload';
    } catch (err) {
      console.error('[ZMod:Shortcuts] reload failed:', err);
      return null;
    }
  }

  // 2. DevTools (F12 / Ctrl+Shift+I / Cmd+Alt+I)
  const isF12 = key === 'F12';
  const isI = keyLower === 'i';
  const isDevToolsCombo = (isCtrl && isShift && isI) || (isCtrl && isAlt && isI);
  if (isF12 || isDevToolsCombo) {
    try {
      if (typeof win.webContents.toggleDevTools === 'function') {
        win.webContents.toggleDevTools();
        return 'devtools';
      }
    } catch (err) {
      console.error('[ZMod:Shortcuts] toggleDevTools failed:', err);
      return null;
    }
  }

  return null;
}

/**
 * Attach reload and devtools shortcuts to a single BrowserWindow.
 */
export function attachWindowShortcuts(win) {
  try {
    if (!win || win.isDestroyed?.() || win.__zmodShortcutsHooked) return false;
    const wc = win.webContents;
    if (!wc || typeof wc.on !== 'function') return false;

    win.__zmodShortcutsHooked = true;
    wc.on('before-input-event', (event, input) => {
      const action = handleInputEvent(input, win);
      if (action) {
        event.preventDefault?.();
      }
    });
    return true;
  } catch (err) {
    console.error('[ZMod:Shortcuts] attach failed:', err);
    return false;
  }
}

/**
 * Register global window listeners across existing and newly created windows.
 */
export function installWindowShortcuts(deps = {}) {
  const app = deps.app ?? electronApp;
  const BrowserWindow = deps.BrowserWindow ?? electronBrowserWindow;
  if (!app && !BrowserWindow) return false;

  const hookAll = () => {
    try {
      if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
        for (const w of BrowserWindow.getAllWindows()) {
          attachWindowShortcuts(w);
        }
      }
    } catch {}
  };

  try {
    if (app && typeof app.on === 'function') {
      app.on('browser-window-created', (_event, win) => {
        attachWindowShortcuts(win);
      });
      if (typeof app.isReady === 'function' && app.isReady()) {
        hookAll();
      } else if (typeof app.whenReady === 'function') {
        app.whenReady().then(hookAll).catch(() => {});
      } else {
        hookAll();
      }
    } else {
      hookAll();
    }
    console.log('[ZMod:Shortcuts] window shortcut handler installed (Ctrl+R, F5, F12, Ctrl+Shift+I)');
    return true;
  } catch (err) {
    console.error('[ZMod:Shortcuts] install failed:', err);
    return false;
  }
}
