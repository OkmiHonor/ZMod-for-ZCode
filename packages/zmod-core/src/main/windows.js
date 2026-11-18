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

/**
 * 销毁所有 ZMod helper 窗口（带 __zmodHelperWindow 标记）。
 * 主窗口隐藏（关闭到托盘）时调用，避免隐藏的辅助窗口混进宿主
 * getAllWindows() 顶掉主窗口，导致托盘恢复失效。
 * 返回被销毁的窗口 id 列表，便于单测断言。
 */
export function dismissHelperWindows(deps = {}) {
  const BW = deps.BrowserWindow ?? electronBrowserWindow;
  if (!BW?.getAllWindows) return [];
  const removed = [];
  for (const win of BW.getAllWindows()) {
    try {
      if (win.isDestroyed?.() || !win.__zmodHelperWindow) continue;
      win.destroy?.();
      removed.push(win.id);
    } catch {}
  }
  return removed;
}

export function installWindowLifecycleHook(deps = {}) {
  const app = deps.app ?? electronApp;
  const BW = deps.BrowserWindow ?? electronBrowserWindow;

  const hookWindow = (win) => {
    if (!win || win.isDestroyed?.() || win.__zmodLifecycleHooked) return;
    win.__zmodLifecycleHooked = true;
    const winId = win.id;

    const attachTrayGuard = () => {
      // browser-window-created 时 URL 常仍是 about:blank，必须等导航完成
      // 才能准确识别主窗口；用标记保证只挂一次 hide 监听。
      if (win.__zmodTrayGuardHooked) return;
      if (classifyWindow(win) !== 'main') return;
      win.__zmodTrayGuardHooked = true;
      // 关闭到托盘时主窗口会触发 hide。宿主托盘恢复只处理 getAllWindows()
      // 里的主窗口，隐藏的 ZMod helper 窗口（气泡 HUD）会顶掉它，导致
      // 「托盘点开却显示不出来」。主窗口一隐藏就清掉所有 helper 窗口，
      // 保证恢复时窗口列表干净、必然选中主窗口。
      win.on?.('hide', () => dismissHelperWindows(deps));
    };

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
        attachTrayGuard();
      } catch {}
    };

    if (win.webContents?.on) {
      win.webContents.on('did-finish-load', onFinishLoad);
    }
    // 已加载完毕的窗口（runtime 后于窗口创建时）：URL 此时已就绪，直接挂
    attachTrayGuard();

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
