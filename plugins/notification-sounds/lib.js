/**
 * notification-sounds — pure logic, zero deps, node-testable.
 *
 * Kept free of any DOM/Audio/Electron references so `node --test` can drive
 * it directly; the runtime half lives in index.js.
 */

export const EVENTS = [
  { status: 'permission_request', label: '需要确认' },
  { status: 'elicitation_request', label: '计划/输入确认' },
  { status: 'completed', label: '任务完成' },
  { status: 'failed', label: '任务失败' }
];

/** Per-event sound override map. '' = follow `default`. */
export function defaultSoundMap() {
  return {
    default: 'builtin:pop',
    permission_request: '',
    elicitation_request: '',
    completed: '',
    failed: ''
  };
}

/** Event override wins when truthy, otherwise the global default. */
export function resolveSound(soundMap, status) {
  const m = soundMap && typeof soundMap === 'object' ? soundMap : {};
  const override = m[status];
  if (override) return override;
  return m.default || '';
}

/**
 * Dedupe key mirroring the official 3s notification dedupe semantics:
 * request-style events (permission/elicitation) have no stable task identity —
 * they key on the body text; task events key on taskId|requestId.
 */
export function dedupeKey(evt) {
  const status = String(evt?.status ?? '');
  if (status === 'permission_request' || status === 'elicitation_request') {
    return `s:${status}:${evt.body}`;
  }
  return `t:${status}:${evt.taskId}|${evt.requestId}`;
}

/**
 * Sliding-window dedupe. Prunes entries older than the window, returns true
 * only for unseen keys, records the timestamp of first sighting (mutates the
 * seen Map so callers can share one map across events).
 */
export function shouldPlay(evt, seen, now, windowMs = 3000) {
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
 * Merge the builtin sound index (from assets/index.json, listed order) with
 * user-uploaded assets (plugin.listAssets rows: {name,size,mtimeMs}).
 * Returns normalized [{id,name,file,scope,durationMs?}] — builtin first
 * (scope 'plugin'), then user (scope 'data', id `user:<name>`) sorted by name.
 * Malformed entries (non-object / missing id-or-name / missing file) are
 * dropped: builtin rows need id+file, user rows need name (used as id+file).
 */
export function mergeLibrary(builtinSounds, userAssets) {
  const out = [];
  for (const s of Array.isArray(builtinSounds) ? builtinSounds : []) {
    if (!s || typeof s !== 'object') continue;
    if (!s.id || !s.file) continue;
    const entry = { id: String(s.id), name: String(s.name || s.id), file: String(s.file), scope: 'plugin' };
    if (Number.isFinite(s.durationMs)) entry.durationMs = s.durationMs;
    out.push(entry);
  }
  const users = [];
  for (const a of Array.isArray(userAssets) ? userAssets : []) {
    if (!a || typeof a !== 'object') continue;
    const name = a.name || a.id;
    if (!name) continue;
    users.push({ id: `user:${name}`, name: String(a.name || name), file: String(name), scope: 'data' });
  }
  users.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return out.concat(users);
}

/** Renderer-safe base64 → bytes (global atob, no Buffer). */
export function base64ToUint8Array(b64) {
  const bin = atob(String(b64 ?? ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Event-bus channels the B3 settings card uses to notify the runtime half. */
export const CHANNELS = {
  libraryChanged: 'ns:library-changed',
  settingsChanged: 'ns:settings-changed'
};
