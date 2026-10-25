import fs from 'node:fs';
import path from 'node:path';

/**
 * installed.json source ledger — records what is actually installed in the
 * ZMod data directory: <dataDir>/installed.json
 *
 * Shape:
 * {
 *   "plugins": {
 *     "<id>": {
 *       "version": "1.0.0",
 *       "source": "builtin" | "registry" | "git" | "zip" | "dir",
 *       "sourceRef": "",
 *       "shasum": "",
 *       "installedAt": "ISO8601"
 *     }
 *   }
 * }
 */

const KNOWN_SOURCES = new Set(['builtin', 'registry', 'git', 'zip', 'dir']);

function installedPath(dataDir) {
  return path.join(dataDir, 'installed.json');
}

/**
 * Read the whole ledger. Missing file or corrupt JSON degrade gracefully to an
 * empty ledger (warned, never thrown) so a broken file cannot brick the loader.
 */
export function readInstalled(dataDir) {
  const filePath = installedPath(dataDir);
  if (!fs.existsSync(filePath)) {
    console.warn(`[ZMod:Installed] ${filePath} 不存在，返回空账本`);
    return { plugins: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (
      !parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      !parsed.plugins || typeof parsed.plugins !== 'object' || Array.isArray(parsed.plugins)
    ) {
      console.warn(`[ZMod:Installed] ${filePath} 结构异常（缺少 plugins 对象），返回空账本`);
      return { plugins: {} };
    }
    return { plugins: parsed.plugins };
  } catch (err) {
    console.warn(`[ZMod:Installed] ${filePath} 解析失败，返回空账本: ${err?.message || err}`);
    return { plugins: {} };
  }
}

/** Single entry lookup; returns the entry object or null. */
export function getInstalledEntry(dataDir, id) {
  const ledger = readInstalled(dataDir);
  return Object.prototype.hasOwnProperty.call(ledger.plugins, id)
    ? ledger.plugins[id]
    : null;
}

/**
 * Insert or overwrite the entry for one plugin id. Writes go through
 * tmp-file + rename so a crash never leaves a half-written ledger.
 * `source` must be one of the KNOWN_SOURCES values; installedAt defaults to now.
 */
export function recordInstalled(dataDir, id, entry) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('[ZMod:Installed] recordInstalled 需要非空字符串 id');
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('[ZMod:Installed] recordInstalled 需要 entry 对象');
  }
  if (!KNOWN_SOURCES.has(entry.source)) {
    throw new Error(`[ZMod:Installed] source 必须是 ${[...KNOWN_SOURCES].join(' | ')} 之一，当前为 ${JSON.stringify(entry.source)}`);
  }
  const ledger = readInstalled(dataDir);
  ledger.plugins[id] = {
    version: entry.version ?? '',
    sourceRef: entry.sourceRef ?? '',
    shasum: entry.shasum ?? '',
    ...entry,
    source: entry.source,
    installedAt: entry.installedAt ?? new Date().toISOString()
  };
  writeAtomic(dataDir, ledger);
  return ledger.plugins[id];
}

/** Drop one plugin from the ledger. Returns true when it existed. */
export function removeInstalled(dataDir, id) {
  const ledger = readInstalled(dataDir);
  if (!Object.prototype.hasOwnProperty.call(ledger.plugins, id)) return false;
  delete ledger.plugins[id];
  writeAtomic(dataDir, ledger);
  return true;
}

function writeAtomic(dataDir, ledger) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = installedPath(dataDir);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(ledger, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}
