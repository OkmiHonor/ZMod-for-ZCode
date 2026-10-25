import path from 'node:path';
import fs from 'node:fs';
import { getPluginDataDir } from '../common/paths.js';

/**
 * Persistent per-plugin asset storage under <userData>/plugin-data/<pluginId>.
 * Unlike the plugin dir (wiped on update/remove), these files survive plugin
 * updates — plugins keep their user-picked sounds/settings files here via RPC.
 * Pure fs + paths, no electron import, so the unit test can drive it directly.
 */

export const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'webm', 'opus'];
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

const PLUGIN_ID_RE = /^[a-zA-Z0-9_-]+$/;
const INVALID_NAME_CHARS = /[\0:<>"|?*\\/]/;
// sane base64: standard alphabet, padding only at the end
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidPluginId(pluginId) {
  return typeof pluginId === 'string' && PLUGIN_ID_RE.test(pluginId);
}

/**
 * Flat single-segment name validation, mirroring plugin.readAsset's style:
 * whitelisted-invalid chars / separators rejected, non-empty after trim, plus
 * a resolved containment check under the plugin data dir anyway.
 */
function validateAssetName(pluginId, rawName) {
  const name = String(rawName ?? '').trim();
  if (!name || INVALID_NAME_CHARS.test(name)) return null;
  const dir = path.resolve(getPluginDataDir(pluginId));
  const target = path.resolve(dir, name);
  if (!target.startsWith(dir + path.sep)) return null;
  return name;
}

/**
 * Slugify a display name into a safe asset filename:
 * strip whitelisted-invalid chars, collapse whitespace/dot runs to '-',
 * keep unicode letters/numbers/'-', lowercase the extension (whitelist
 * checked case-insensitively before lowering), cap at 80 chars incl. ext.
 * Returns null when the resulting basename is empty or the ext is not an
 * allowed audio extension.
 */
export function slugifyAssetName(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  // 扁平单段名：展示名里出现路径分隔符一律拒绝（不允许剥离后静默改名）
  if (INVALID_NAME_CHARS.test(s)) return null;
  const dot = s.lastIndexOf('.');
  const baseRaw = dot > 0 ? s.slice(0, dot) : s;
  const extRaw = dot > 0 ? s.slice(dot + 1) : '';
  const ext = extRaw.toLowerCase();
  if (!ext || !AUDIO_EXTS.includes(ext)) return null;
  let base = baseRaw
    .replace(/[\0:<>"|?*\\/]/g, '')
    .replace(/[\s.]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '');
  if (!base || /^-+$/.test(base)) return null;
  const maxBase = 80 - ext.length - 1;
  if (maxBase < 1) return null;
  base = base.slice(0, maxBase).replace(/^-+|-+$/g, '');
  if (!base) return null;
  return `${base}.${ext}`;
}

function totalBytesExcluding(dir, excludeName) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === excludeName) continue;
    try {
      total += fs.statSync(path.join(dir, entry.name)).size;
    } catch {}
  }
  return total;
}

export function registerPluginAssetApi({ register }) {
  register('plugin.listAssets', async ({ pluginId }) => {
    if (!isValidPluginId(pluginId)) return { ok: false, error: 'Invalid plugin id' };
    const dir = path.resolve(getPluginDataDir(pluginId));
    if (!fs.existsSync(dir)) return { ok: true, assets: [] };
    try {
      const assets = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => {
          const st = fs.statSync(path.join(dir, e.name));
          return { name: e.name, size: st.size, mtimeMs: st.mtimeMs };
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { ok: true, assets };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  register('plugin.writeAsset', async ({ pluginId, name, base64 }) => {
    if (!isValidPluginId(pluginId)) return { ok: false, error: 'Invalid plugin id' };
    const finalName = slugifyAssetName(name);
    if (!finalName || !validateAssetName(pluginId, finalName)) {
      return { ok: false, error: 'Invalid name' };
    }
    if (typeof base64 !== 'string' || !BASE64_RE.test(base64)) {
      return { ok: false, error: 'Invalid base64 payload' };
    }
    const buf = Buffer.from(base64, 'base64');
    if (buf.length === 0) return { ok: false, error: 'Empty payload' };
    if (buf.length > MAX_FILE_BYTES) return { ok: false, error: 'File too large' };
    try {
      const dir = path.resolve(getPluginDataDir(pluginId));
      fs.mkdirSync(dir, { recursive: true });
      // quota: existing files (minus the target being replaced) + new size
      if (totalBytesExcluding(dir, finalName) + buf.length > MAX_TOTAL_BYTES) {
        return { ok: false, error: 'quota' };
      }
      // atomic write: temp file in the same dir, then rename over the target
      const target = path.join(dir, finalName);
      const tmpPath = `${target}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpPath, buf);
      fs.renameSync(tmpPath, target);
      return { ok: true, name: finalName, size: buf.length };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  register('plugin.deleteAsset', async ({ pluginId, name }) => {
    if (!isValidPluginId(pluginId)) return { ok: false, error: 'Invalid plugin id' };
    const clean = validateAssetName(pluginId, name);
    if (!clean) return { ok: false, error: 'Invalid name' };
    try {
      const file = path.join(path.resolve(getPluginDataDir(pluginId)), clean);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return { ok: false, error: 'Not found' };
      }
      fs.unlinkSync(file);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
}
