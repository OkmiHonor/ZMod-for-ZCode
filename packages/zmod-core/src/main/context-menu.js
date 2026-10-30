let electron = null;
try {
  electron = await import('electron');
} catch {
  // Not in Electron (unit tests)
}

const electronMenu = electron?.Menu ?? electron?.default?.Menu;
const electronBrowserWindow = electron?.BrowserWindow ?? electron?.default?.BrowserWindow;
const electronApp = electron?.app ?? electron?.default?.app;

export const menuItems = new Map();

/**
 * Register a context menu item.
 */
export function registerContextMenuItem({ pluginId, id, label, when = 'always', order = 100 } = {}) {
  if (typeof pluginId !== 'string' || !pluginId.trim()) {
    return { ok: false, error: 'pluginId is required' };
  }
  if (typeof id !== 'string' || !id.trim()) {
    return { ok: false, error: 'id is required' };
  }
  if (typeof label !== 'string' || !label.trim()) {
    return { ok: false, error: 'label is required' };
  }
  const cleanPluginId = pluginId.trim();
  const cleanId = id.trim();
  const validWhen = ['always', 'selection', 'editable', 'link'].includes(when) ? when : 'always';
  const itemKey = `${cleanPluginId}:${cleanId}`;
  const item = {
    pluginId: cleanPluginId,
    id: cleanId,
    label: label.trim(),
    when: validWhen,
    order: Number.isFinite(order) ? Number(order) : 100
  };
  menuItems.set(itemKey, item);
  return { ok: true, key: itemKey };
}

/**
 * Unregister a context menu item or all items belonging to a plugin.
 */
export function unregisterContextMenuItem({ pluginId, id } = {}) {
  if (typeof pluginId !== 'string' || !pluginId.trim()) {
    return { ok: false, error: 'pluginId is required' };
  }
  const cleanPluginId = pluginId.trim();
  if (id != null && typeof id === 'string' && id.trim()) {
    const key = `${cleanPluginId}:${id.trim()}`;
    menuItems.delete(key);
  } else {
    for (const [key, item] of menuItems.entries()) {
      if (item.pluginId === cleanPluginId) {
        menuItems.delete(key);
      }
    }
  }
  return { ok: true };
}

/**
 * Pure function: Match items against context menu parameters.
 */
export function matchContextMenuItems(params = {}) {
  const items = [];
  for (const item of menuItems.values()) {
    let match = false;
    switch (item.when) {
      case 'selection':
        match = Boolean(params.selectionText && String(params.selectionText).trim().length > 0);
        break;
      case 'editable':
        match = Boolean(params.isEditable);
        break;
      case 'link':
        match = Boolean(params.linkURL);
        break;
      case 'always':
      default:
        match = true;
        break;
    }
    if (match) {
      items.push(item);
    }
  }
  items.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return String(a.label || '').localeCompare(String(b.label || ''));
  });
  return items;
}

/**
 * Sanitize context menu click payload.
 */
export function buildContextPayload(params = {}) {
  return {
    x: Number(params.x) || 0,
    y: Number(params.y) || 0,
    selectionText: String(params.selectionText || '').slice(0, 10000),
    isEditable: Boolean(params.isEditable),
    linkURL: String(params.linkURL || ''),
    srcURL: String(params.srcURL || ''),
    pageURL: String(params.pageURL || '')
  };
}

/**
 * Install Electron context menu hook on windows.
 */
export function installContextMenuHook(deps = {}) {
  const Menu = deps.Menu ?? electronMenu;
  const BW = deps.BrowserWindow ?? electronBrowserWindow;
  const app = deps.app ?? electronApp;

  const hookWindow = (win) => {
    if (!win || win.isDestroyed?.() || win.__zmodContextMenuHooked) return;
    win.__zmodContextMenuHooked = true;

    if (!win.webContents?.on) return;
    win.webContents.on('context-menu', (_event, params) => {
      try {
        const matched = matchContextMenuItems(params);
        if (matched.length === 0 || !Menu?.buildFromTemplate) return;

        const template = matched.map((item) => ({
          label: item.label,
          click: () => {
            try {
              win.webContents?.send?.('zmod:context-menu-click', {
                key: `${item.pluginId}:${item.id}`,
                pluginId: item.pluginId,
                id: item.id,
                context: buildContextPayload(params)
              });
            } catch {}
          }
        }));

        if (params.isEditable || (params.selectionText && String(params.selectionText).trim().length > 0)) {
          template.push({ type: 'separator' });
          if (params.isEditable) {
            template.push({ role: 'cut' });
          }
          if (params.selectionText && String(params.selectionText).trim().length > 0) {
            template.push({ role: 'copy' });
          }
          if (params.isEditable) {
            template.push({ role: 'paste' });
          }
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({ window: win });
      } catch (err) {
        console.error('[ZMod:ContextMenu] hook error:', err);
      }
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

export function registerContextMenuService(gateway) {
  gateway.register('contextMenu.register', async (params) => registerContextMenuItem(params));
  gateway.register('contextMenu.unregister', async (params) => unregisterContextMenuItem(params));
  gateway.register('contextMenu.list', async () => ({ ok: true, items: [...menuItems.values()] }));
}
