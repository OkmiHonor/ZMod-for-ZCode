/**
 * bubble-notifications — pure logic, zero deps, node-testable.
 *
 * Kept free of any DOM/Electron references so `node --test` can drive it
 * directly; the runtime half lives in index.js.
 */

/** notification status → bubble.show kind（未知状态不映射，运行时据此跳过） */
export const STATUS_KIND = {
  completed: 'success',
  failed: 'error',
  permission_request: 'waiting',
  elicitation_request: 'waiting'
};

/** notification status → 总开关 settings 键（未知状态无开关，直接过滤） */
export const STATUS_SWITCH = {
  completed: 'onCompleted',
  failed: 'onFailed',
  permission_request: 'onWaiting',
  elicitation_request: 'onWaiting'
};

/**
 * Dedupe key mirroring the official 3s notification dedupe semantics:
 * request-style events (permission/elicitation) have no stable task identity —
 * they key on the body text; task events key on taskId|requestId.
 */
export function dedupeKey(evt) {
  const status = String(evt?.status ?? '');
  if (status === 'permission_request' || status === 'elicitation_request') {
    return `req:${evt.body}`;
  }
  return `task:${evt.taskId}|${evt.requestId}`;
}

/**
 * Sliding-window dedupe. Prunes entries older than the window, returns true
 * only for unseen keys, records the timestamp of first sighting (mutates the
 * seen Map so callers can share one map across events).
 */
export function shouldDedupePass(evt, seen, now, windowMs = 3000) {
  if (!(seen instanceof Map)) return false;
  for (const [k, ts] of seen) {
    if (now - ts >= windowMs) seen.delete(k);
  }
  const key = dedupeKey(evt);
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

/**
 * Full hot-path gate in pipeline order: 总开关 → 聚焦门 → 3s 去重镜 →
 * 分事件开关。Returns true when the bubble should be shown (and records the
 * dedupe sighting as a side effect, like the official notification pipeline).
 */
export function shouldShow(evt, snap, seen, now, windowMs = 3000) {
  if (!evt || typeof evt !== 'object') return false;
  if (!snap?.enabled) return false;
  if (evt.anyFocused && !snap.focusShow) return false;
  if (!shouldDedupePass(evt, seen, now, windowMs)) return false;
  const status = String(evt.status ?? '');
  const gate = STATUS_SWITCH[status];
  if (!gate) return false;
  return snap[gate] === true;
}

/**
 * Default copy per status; explicit title wins, body passes through as-is
 * (may be empty/undefined).
 */
export function defaultCopy(evt) {
  const status = String(evt?.status ?? '');
  const fallback =
    status === 'failed' ? '任务出错' : status === 'completed' ? '任务完成' : '等待你的确认';
  return {
    title: evt?.title || fallback,
    body: evt?.body
  };
}

/**
 * bubble.show 参数组装：kind 映射 + 默认文案 + durationMs 透传（snap 原值）+
 * 外观参数透传（position/margin/theme/scale/coordMode/coordX/coordY/offsetX/offsetY）。
 * scale 由 snap 百分比换算为倍数。
 */
export function showParams(evt, snap) {
  const res = {
    kind: STATUS_KIND[String(evt?.status ?? '')] || 'info',
    ...defaultCopy(evt),
    durationMs: snap?.duration,
    position: snap?.position,
    margin: snap?.margin,
    scale: typeof snap?.scale === 'number' ? snap.scale / 100 : undefined,
    theme: snap?.theme
  };
  if (snap?.coordMode != null) res.coordMode = snap.coordMode;
  if (snap?.coordX != null) res.coordX = snap.coordX;
  if (snap?.coordY != null) res.coordY = snap.coordY;
  if (snap?.offsetX != null) res.offsetX = snap.offsetX;
  if (snap?.offsetY != null) res.offsetY = snap.offsetY;
  if (snap?.pinned != null) res.pinned = snap.pinned;
  return res;
}

/**
 * 纯前端 DOM HUD 坐标样式计算（独立自闭环，零主进程依赖）：
 * 根据 snap 中的外观参数计算出绝对定位 style 对象 { left, top, transform }。
 * 纯数学运算，直接适配任何现代浏览器与 CSS 硬件加速 transform。
 */
export function computeBubbleStyle(snap) {
  const mode = snap?.coordMode === 'coord' ? 'coord' : 'preset';
  const pos = String(snap?.position || 'top-center');
  const margin = Number.isFinite(snap?.margin) ? snap.margin : 12;
  const offX = Number.isFinite(snap?.offsetX) ? snap.offsetX : 0;
  const offY = Number.isFinite(snap?.offsetY) ? snap.offsetY : 0;
  const scale = Number.isFinite(snap?.scale) ? snap.scale / 100 : 1;

  let left = '50%';
  let top = `${margin}px`;
  let tx = '-50%';
  let ty = '0';

  if (mode === 'coord') {
    const cx = Number.isFinite(snap?.coordX) ? snap.coordX : 50;
    const cy = Number.isFinite(snap?.coordY) ? snap.coordY : 2;
    left = `${cx}%`;
    top = `${cy}%`;
    tx = '-50%';
    ty = '-50%';
  } else {
    // preset 停靠模式
    if (pos.endsWith('-left')) {
      left = `${margin}px`;
      tx = '0';
    } else if (pos.endsWith('-right')) {
      left = `calc(100% - ${margin}px)`;
      tx = '-100%';
    } else {
      left = '50%';
      tx = '-50%';
    }

    if (pos.startsWith('bottom-')) {
      top = `calc(100% - ${margin}px)`;
      ty = '-100%';
    } else {
      top = `${margin}px`;
      ty = '0';
    }
  }

  const transform = `translate(${tx}, ${ty}) translate(${offX}px, ${offY}px) scale(${scale})`;
  return { left, top, transform };
}
