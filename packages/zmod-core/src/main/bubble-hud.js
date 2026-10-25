let electron = null;
try {
  electron = await import('electron');
} catch {
  // Not in Electron (unit tests)
}
const electronBrowserWindow = electron?.BrowserWindow ?? electron?.default?.BrowserWindow;
const electronScreen = electron?.screen ?? electron?.default?.screen;

/**
 * 通用气泡 HUD 服务（泛化自宿主 CUA 操作指示气泡，视觉基因与窗口参数 1:1 复刻）。
 * 插件经 RPC bubble.show 触发四态任务通知：success / error / waiting / info。
 * v0.1 纯展示：鼠标穿透，不可交互。
 */

export const BUBBLE_KINDS = ['success', 'error', 'waiting', 'info'];

const KIND_SET = new Set(BUBBLE_KINDS);
const ACCENTS = { success: '#16a34a', error: '#dc2626', waiting: '#d97706', info: '#2563eb' };

// 宿主 padding 基因：容器 padding-top 6 / bottom 12，内容行高 38
const PAD = { top: 6, right: 8, bottom: 12, left: 8 };
const WINDOW_HEIGHT = PAD.top + 38 + PAD.bottom;

// 宽度估算基因：icon(20) + gap(10) + 文案 + 左右 padding(36) + 余量(20)，CJK≈13.4、ASCII≈7.3
const ICON_W = 20;
const ICON_GAP = 10;
const TEXT_PAD = 36;
const SLACK = 20;
const MIN_WIDTH = 200;
const CJK_CHAR_W = 13.4;
const ASCII_CHAR_W = 7.3;
// 定位基因：workArea 顶部视觉边距 12，扣除容器 padding-top 6（宿主原式 y+12-6）
const TOP_MARGIN = 12;

const TITLE_MAX = 120;
const BODY_MAX = 160;
const DURATION_MIN = 500;
const DURATION_MAX = 30000;
const DURATION_DEFAULT = 5000;
const LEAVE_MS = 120; // 宿主退场动画时长，之后 hide()
const RETRY_MS = 250; // 宿主 discardFailedWindow 后的重建间隔

const defaultSchedule = (fn, ms) => setTimeout(fn, ms);
const defaultCancelSchedule = (timer) => clearTimeout(timer);
const defaultLogger = {
  info: (...args) => console.log('[ZMod:BubbleHud]', ...args),
  warn: (...args) => console.warn('[ZMod:BubbleHud]', ...args),
  debug: (...args) => console.debug('[ZMod:BubbleHud]', ...args)
};

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function truncate(text, max) {
  return text.length <= max ? text : Array.from(text).slice(0, max).join('');
}

function clampDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return DURATION_DEFAULT;
  return Math.min(Math.max(Math.round(n), DURATION_MIN), DURATION_MAX);
}

function estimateTextWidth(text) {
  let sum = 0;
  for (const ch of text) {
    sum += ch.codePointAt(0) >= 0x2e80 ? CJK_CHAR_W : ASCII_CHAR_W;
  }
  return sum;
}

function windowWidth(title, body) {
  const text = body ? `${title} · ${body}` : title;
  return Math.max(MIN_WIDTH, Math.round(ICON_W + ICON_GAP + estimateTextWidth(text) + TEXT_PAD + SLACK));
}

function iconMarkup(kind) {
  if (kind === 'waiting') {
    return (
      '<span class="dots" aria-hidden="true">' +
      '<span class="dot"></span><span class="dot"></span><span class="dot"></span></span>'
    );
  }
  const paths = {
    success: '<path d="M3.5 8.6l3 3L12.5 5"/>',
    error: '<path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/>',
    info: '<circle cx="8" cy="8" r="6.3"/><path d="M8 7.3v3.6"/><path d="M8 5v.1"/>'
  };
  return (
    `<svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" ` +
    `stroke="${ACCENTS[kind]}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${paths[kind]}</svg>`
  );
}

function bubbleHtml(spec) {
  const text = spec.body ? `${escapeHtml(spec.title)} · ${escapeHtml(spec.body)}` : escapeHtml(spec.title);
  return `<!doctype html>
<html lang="en" data-state="active">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
    body { display: flex; align-items: center; justify-content: center; padding: 6px 8px 12px; font-family: "Segoe UI Variable", "Segoe UI", sans-serif; }
    .indicator {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; height: 38px; padding: 0 18px;
      color: #202124; background: rgba(255, 255, 255, 0.96);
      border: 1px solid rgba(15, 23, 42, 0.14); border-radius: 12px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08), 0 6px 12px -6px rgba(15, 23, 42, 0.18);
      font-size: 13px; font-weight: 600; line-height: 1; white-space: nowrap;
      opacity: 1; transform: translateY(0);
      transition: opacity 120ms ease, transform 120ms ease;
      animation: enter 140ms ease-out both;
    }
    .icon { flex: 0 0 auto; }
    .dots { display: flex; align-items: center; gap: 3px; }
    .dot { width: 4px; height: 4px; border-radius: 50%; background: ${ACCENTS.waiting}; animation: pulse 1.2s ease-in-out infinite; }
    .dot:nth-child(2) { animation-delay: 120ms; }
    .dot:nth-child(3) { animation-delay: 240ms; }
    html[data-state="leaving"] .indicator { opacity: 0; transform: translateY(-6px); }
    @keyframes enter { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes pulse { 0%, 70%, 100% { opacity: .35; transform: scale(.8); } 35% { opacity: 1; transform: scale(1); } }
    @media (prefers-color-scheme: dark) {
      .indicator { color: #f8fafc; background: rgba(35, 38, 43, 0.96); border-color: rgba(255, 255, 255, 0.14); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18), 0 6px 12px -6px rgba(0, 0, 0, 0.28); }
    }
    @media (prefers-reduced-motion: reduce) {
      .indicator, .dot { animation: none; transition: opacity 1ms linear; transform: none; }
      html[data-state="leaving"] .indicator { transform: none; }
    }
  </style>
</head>
<body><div class="indicator" role="status" aria-live="polite">${iconMarkup(spec.kind)}<span>${text}</span></div></body>
</html>`;
}

function bubbleDataUrl(spec) {
  return `data:text/html;base64,${Buffer.from(bubbleHtml(spec), 'utf8').toString('base64')}`;
}

/**
 * 单窗复用控制器。deps 全量可注入（照宿主 createWindowsCuaOperationIndicator
 * 的 DI 设计）以便单测；窗口创建延迟到首次 show，那时 app 必然 ready。
 */
export function createBubbleHudController(deps) {
  const platform = deps.platform ?? process.platform;
  const BrowserWindow = deps.BrowserWindow ?? electronBrowserWindow;
  const screen = deps.screen ?? electronScreen;
  const schedule = deps.schedule ?? defaultSchedule;
  const cancelSchedule = deps.cancelSchedule ?? defaultCancelSchedule;
  const logger = deps.logger ?? defaultLogger;

  const state = {
    win: null,
    autoHideTimer: null,
    leaveTimer: null,
    retryTimer: null,
    lastShow: null
  };

  function cancelAutoHide() {
    if (state.autoHideTimer) {
      cancelSchedule(state.autoHideTimer);
      state.autoHideTimer = null;
    }
  }

  function cancelLeave() {
    if (state.leaveTimer) {
      cancelSchedule(state.leaveTimer);
      state.leaveTimer = null;
    }
  }

  function cancelRetry() {
    if (state.retryTimer) {
      cancelSchedule(state.retryTimer);
      state.retryTimer = null;
    }
  }

  function createWindow(width) {
    const win = new BrowserWindow({
      width,
      height: WINDOW_HEIGHT,
      alwaysOnTop: true,
      focusable: false,
      frame: false,
      hasShadow: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      transparent: true,
      backgroundColor: '#00000000',
      autoHideMenuBar: true,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      movable: false,
      webPreferences: { contextIsolation: true, devTools: false, nodeIntegration: false, sandbox: true }
    });
    state.win = win;
    win.setIgnoreMouseEvents(true); // 穿透：纯展示不可交互
    win.setContentProtection(true); // 不进录屏/截图
    win.on('closed', () => {
      cancelAutoHide();
      cancelLeave();
      if (state.win === win) state.win = null;
    });
    return win;
  }

  function discardWindow(win) {
    if (!win) return;
    if (state.win === win) state.win = null;
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (err) {
      logger.debug('discard partial window failed:', err?.message || err);
    }
  }

  function positionWindow(win, width) {
    const point = screen.getCursorScreenPoint();
    const { workArea } = screen.getDisplayNearestPoint(point);
    win.setBounds({
      width,
      height: WINDOW_HEIGHT,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + TOP_MARGIN - PAD.top)
    });
  }

  function showOnTop(win) {
    win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  }

  function setLeavingState(win) {
    try {
      win.webContents
        .executeJavaScript('document.documentElement.dataset.state="leaving"')
        .catch(() => {});
    } catch {}
  }

  function hideOrDestroy(win) {
    try {
      win.hide();
      return;
    } catch (err) {
      logger.warn('hide failed, destroying window:', err?.message || err);
    }
    if (state.win === win) state.win = null;
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (err) {
      logger.warn('destroy after failed hide failed:', err?.message || err);
    }
  }

  function beginHide() {
    cancelAutoHide();
    if (state.leaveTimer || !state.win || state.win.isDestroyed()) return;
    const win = state.win;
    setLeavingState(win);
    state.leaveTimer = schedule(() => {
      state.leaveTimer = null;
      if (win === state.win && !win.isDestroyed()) hideOrDestroy(win);
    }, LEAVE_MS);
  }

  function scheduleAutoHide(durationMs) {
    cancelAutoHide();
    state.autoHideTimer = schedule(() => {
      state.autoHideTimer = null;
      beginHide();
    }, durationMs);
  }

  async function present(spec) {
    const width = windowWidth(spec.title, spec.body);
    let win = state.win && !state.win.isDestroyed() ? state.win : null;
    if (!win) win = createWindow(width);
    cancelAutoHide();
    cancelLeave();
    positionWindow(win, width);
    await win.loadURL(bubbleDataUrl(spec));
    // load 期间窗口可能被关闭或被更新的 show 接管
    if (state.win !== win || win.isDestroyed()) return;
    showOnTop(win);
    scheduleAutoHide(spec.durationMs);
  }

  function scheduleRetry() {
    if (state.retryTimer || !state.lastShow) return;
    state.retryTimer = schedule(async () => {
      state.retryTimer = null;
      if (!state.lastShow || (state.win && !state.win.isDestroyed())) return;
      try {
        await present(state.lastShow);
      } catch (err) {
        logger.warn('bubble retry failed:', err?.message || err);
        discardWindow(state.win);
        scheduleRetry();
      }
    }, RETRY_MS);
  }

  async function show(params) {
    const kind = params?.kind;
    if (!KIND_SET.has(kind)) return { ok: false, error: 'Invalid kind' };
    if (typeof params.title !== 'string' || !params.title.trim()) {
      return { ok: false, error: 'Title is required' };
    }
    if (params.body != null && typeof params.body !== 'string') {
      return { ok: false, error: 'Invalid body' };
    }
    if (platform !== 'win32') return { ok: true, shown: false };

    const spec = {
      kind,
      title: truncate(params.title, TITLE_MAX),
      body: params.body ? truncate(params.body, BODY_MAX) : '',
      durationMs: clampDuration(params.durationMs)
    };
    state.lastShow = spec;
    cancelRetry();
    try {
      await present(spec);
      return { ok: true, shown: true };
    } catch (err) {
      // ERR_ABORTED：更新的 show 已抢先 reload 同一窗口，内容以最新呈现为准，无需重建
      if (String(err?.code || err?.message || err).includes('ERR_ABORTED')) {
        return { ok: true, shown: true };
      }
      logger.warn('failed to show bubble, will retry:', err?.message || err);
      discardWindow(state.win);
      scheduleRetry();
      return { ok: false, error: String(err?.message || err) };
    }
  }

  function hide() {
    cancelRetry();
    state.lastShow = null;
    beginHide();
    return { ok: true };
  }

  function status() {
    return {
      platform,
      windowAlive: !!(state.win && !state.win.isDestroyed())
    };
  }

  return { show, hide, status };
}

let registered = false;

/**
 * 幂等注册：成功返回 true，重复注册或 gateway 不合法返回 false。
 * deps 注入面（照宿主工厂设计，全部可注入以便单测）：
 * { platform, BrowserWindow, screen, schedule, cancelSchedule, logger }
 */
export function registerBubbleHud(gateway, injected = {}) {
  if (registered) return false;
  if (!gateway || typeof gateway.register !== 'function') return false;
  const controller = createBubbleHudController({
    platform: injected.platform,
    BrowserWindow: injected.BrowserWindow,
    screen: injected.screen,
    schedule: injected.schedule,
    cancelSchedule: injected.cancelSchedule,
    logger: injected.logger
  });
  gateway.register('bubble.show', (params) => controller.show(params || {}));
  gateway.register('bubble.hide', () => controller.hide());
  gateway.register('bubble.status', () => controller.status());
  registered = true;
  defaultLogger.info('bubble HUD ready (methods: bubble.show / bubble.hide / bubble.status)');
  return true;
}
