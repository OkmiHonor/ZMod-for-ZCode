let electron = null;
try {
  electron = await import('electron');
} catch {
  // Not in Electron (unit tests)
}
const electronIpcMain = electron?.ipcMain ?? electron?.default?.ipcMain;
const electronBrowserWindow = electron?.BrowserWindow ?? electron?.default?.BrowserWindow;

export const NOTIFY_CH = 'zcode:show-task-notification';
export const NOTIFY_FWD = 'zmod:notification-event';

let tapInstalled = false;

function defaultGetFocused() {
  try {
    return electronBrowserWindow.getAllWindows().some((w) => w.isFocused());
  } catch {
    return false;
  }
}

/**
 * Notification event tap: the official ZCode renderer reports task
 * notifications over the send-style channel NOTIFY_CH (send keeps multiple
 * listeners coexisting — we only add our own, no handler surgery). Events are
 * normalized and forwarded to the original sender only (sender-targeted, NOT
 * broadcast), so the requesting renderer window picks them up via the preload
 * bridge's on().
 */
export function installNotificationTap(deps = {}) {
  const ipcMain = deps.ipcMain ?? electronIpcMain;
  const getFocused = typeof deps.getFocused === 'function' ? deps.getFocused : defaultGetFocused;
  if (tapInstalled || !ipcMain || typeof ipcMain.on !== 'function') return tapInstalled;
  try {
    ipcMain.on(NOTIFY_CH, (event, payload) => {
      try {
        if (!payload || typeof payload !== 'object') {
          console.log('[ZMod:Notifications] dropped non-object notification payload');
          return;
        }
        let anyFocused = false;
        try {
          anyFocused = !!getFocused();
        } catch {}
        const fwd = {
          status: payload.status,
          taskId: payload.taskId,
          requestId: payload.requestId,
          title: payload.title,
          body: payload.body,
          ts: Date.now(),
          anyFocused
        };
        event.sender?.send?.(NOTIFY_FWD, fwd);
      } catch (err) {
        console.error('[ZMod:Notifications] forward failed:', err?.message || err);
      }
    });
    tapInstalled = true;
    console.log(`[ZMod:Notifications] tap ready on ${NOTIFY_CH} → ${NOTIFY_FWD}`);
  } catch (err) {
    console.error('[ZMod:Notifications] install failed:', err?.message || err);
  }
  return tapInstalled;
}

export function notificationTapStatus() {
  return { installed: !!tapInstalled };
}
