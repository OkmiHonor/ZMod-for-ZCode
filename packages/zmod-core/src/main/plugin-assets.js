import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getPluginDataDir, getPluginsDir, getUserDataDir } from '../common/paths.js';

let electron = null;
try {
  electron = await import('electron');
} catch {}
const defaultFetch = electron?.net?.fetch ?? electron?.default?.net?.fetch ?? globalThis.fetch;

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

  // ---- Read-only directory listing under the plugin's own source dir ----
  // Mirrors plugin.readAsset's path discipline (whitelisted plugin id, no
  // traversal, no absolute paths, resolved containment under <plugins>/<id>),
  // but *rejects* `..` instead of stripping: a listing RPC exposes names, so
  // anything ambiguous is refused outright. relPath empty/missing lists the
  // plugin root. A missing dir is not an error — callers probe optional
  // subtrees (dsh-compat scans its dsh-plugins/ drop-in dir, absent on fresh
  // installs) and an empty listing simply means "nothing to load".
  register('plugin.listDir', async ({ pluginId, relPath }) => {
    if (!isValidPluginId(pluginId)) return { ok: false, error: 'Invalid plugin id' };
    const raw = String(relPath ?? '')
      .replace(/\\/g, '/')
      .trim();
    if (!raw) {
      // empty/missing relPath = plugin root listing (allowed, unlike readAsset)
    } else {
      if (/^\/+/.test(raw) || /^[a-zA-Z]:/.test(raw) || /[\0:<>"|?*]/.test(raw)) {
        return { ok: false, error: 'Invalid path' };
      }
      if (raw.split('/').some((seg) => !seg || /^\.\.+$/.test(seg))) {
        return { ok: false, error: 'Invalid path' };
      }
    }
    const root = path.resolve(getPluginsDir(), pluginId);
    const target = raw ? path.resolve(root, raw) : root;
    if (target !== root && !target.startsWith(root + path.sep)) {
      return { ok: false, error: 'Path escapes plugin dir' };
    }
    try {
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        return { ok: true, entries: [] };
      }
      const entries = fs
        .readdirSync(target, { withFileTypes: true })
        .map((e) => {
          const st = fs.statSync(path.join(target, e.name));
          return {
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
            size: st.size,
            mtimeMs: st.mtimeMs
          };
        })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { ok: true, entries };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });

  // ---- System32 bsdtar: zip / tgz / tar.gz universal extraction ----
  function tarBin() {
    return process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  }

  function validateSubdirPath(pluginId, relPath) {
    if (!isValidPluginId(pluginId)) return { ok: false, error: 'Invalid plugin id' };
    const raw = String(relPath ?? '')
      .replace(/\\/g, '/')
      .trim();
    if (!raw) return { ok: false, error: 'relPath cannot be empty' };
    if (/^\/+/.test(raw) || /^[a-zA-Z]:/.test(raw) || /[\0:<>"|?*]/.test(raw)) {
      return { ok: false, error: 'Invalid path' };
    }
    const segs = raw.split('/').filter(Boolean);
    if (!segs.length || segs.some((seg) => /^\.\.+$/.test(seg))) {
      return { ok: false, error: 'Invalid path' };
    }
    const root = path.resolve(getPluginsDir(), pluginId);
    const target = path.resolve(root, raw);
    // 严禁逃逸出插件目录，且严禁直接指向插件根目录本身（防止误删或覆盖 index.js/manifest.json）
    if (target === root || !target.startsWith(root + path.sep)) {
      return { ok: false, error: 'Path escapes plugin dir' };
    }
    return { ok: true, root, target, relPath: raw };
  }

  // 通用归档下载与解压安装到插件子目录：支持 npm tarball (.tgz) 与 zip
  register('plugin.installArchive', async ({ pluginId, relPath, url, fetchImpl, timeoutMs = 60000 }) => {
    const pCheck = validateSubdirPath(pluginId, relPath);
    if (!pCheck.ok) return { ok: false, error: pCheck.error };
    const targetDir = pCheck.target;

    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'Invalid archive URL (http/https only)' };
    }

    const tmpHolder = path.join(getUserDataDir(), 'tmp', `arch-${pluginId}-${Date.now()}`);
    fs.mkdirSync(tmpHolder, { recursive: true });
    const archiveFile = path.join(tmpHolder, 'archive.bin');
    const extractDir = path.join(tmpHolder, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    const fetchFn = fetchImpl || defaultFetch;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();

    try {
      const res = await fetchFn(url, { signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`下载失败 (HTTP ${res.status}): ${url}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(archiveFile, buf);

      // 调用 bsdtar 解压
      const tar = spawnSync(tarBin(), ['-xf', archiveFile, '-C', extractDir]);
      if (tar.error) throw new Error(`解压失败: ${tar.error.message}`);
      if (tar.status !== 0) throw new Error(`解压退出码异常 (exit ${tar.status})`);

      // 自动下钻剥离单层包裹目录（如 npm tarball 常见的 package/）
      const entries = fs.readdirSync(extractDir, { withFileTypes: true });
      const srcDir =
        entries.length === 1 && entries[0].isDirectory()
          ? path.join(extractDir, entries[0].name)
          : extractDir;

      // 目标替换：如已存在则先清理
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.cpSync(srcDir, targetDir, { recursive: true });

      return {
        ok: true,
        name: path.basename(targetDir),
        relPath: pCheck.relPath,
        filesCount: fs.readdirSync(targetDir).length
      };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    } finally {
      clearTimeout(timer);
      try {
        fs.rmSync(tmpHolder, { recursive: true, force: true });
      } catch {}
    }
  });

  // 通用安全删除插件子目录
  register('plugin.removeDir', async ({ pluginId, relPath }) => {
    const pCheck = validateSubdirPath(pluginId, relPath);
    if (!pCheck.ok) return { ok: false, error: pCheck.error };
    try {
      if (fs.existsSync(pCheck.target)) {
        fs.rmSync(pCheck.target, { recursive: true, force: true });
      }
      return { ok: true, relPath: pCheck.relPath };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  });
}
