import fs from 'node:fs';
import path from 'node:path';
import { getVaultPath, ensureDirectories } from '../common/paths.js';

let electronSafeStorage = null;
try {
  const electron = await import('electron');
  electronSafeStorage = electron.safeStorage || electron.default?.safeStorage;
} catch {
  // Not in Electron environment
}

class SecretVault {
  constructor() {
    this._cache = null;
  }

  isAvailable() {
    return Boolean(electronSafeStorage && electronSafeStorage.isEncryptionAvailable());
  }

  _readVault() {
    if (this._cache) return this._cache;
    ensureDirectories();
    const vaultPath = getVaultPath();
    if (!fs.existsSync(vaultPath)) {
      this._cache = {};
      return this._cache;
    }
    try {
      const raw = fs.readFileSync(vaultPath, 'utf8');
      this._cache = JSON.parse(raw);
      return this._cache;
    } catch (err) {
      console.error('[ZMod:Vault] Failed to read vault file:', err);
      this._cache = {};
      return this._cache;
    }
  }

  _writeVault(data) {
    ensureDirectories();
    const vaultPath = getVaultPath();
    const tmpPath = `${vaultPath}.tmp.${Date.now()}`;
    this._cache = data;
    fs.writeFileSync(tmpPath, JSON.stringify(this._cache, null, 2), 'utf8');
    fs.renameSync(tmpPath, vaultPath);
  }

  get(key) {
    const rawVault = this._readVault();
    const entry = rawVault[key];
    if (!entry) return null;

    if (this.isAvailable()) {
      try {
        const buffer = Buffer.from(entry.data, 'hex');
        return electronSafeStorage.decryptString(buffer);
      } catch (err) {
        console.error(`[ZMod:Vault] Failed to decrypt key "${key}":`, err);
        return null;
      }
    }

    // Fallback if saved unencrypted or in dev
    if (entry.unencrypted) {
      return Buffer.from(entry.data, 'base64').toString('utf8');
    }
    console.warn(`[ZMod:Vault] safeStorage not available to decrypt "${key}"`);
    return null;
  }

  set(key, plainText) {
    const rawVault = structuredClone(this._readVault());
    if (plainText === null || plainText === undefined) {
      delete rawVault[key];
      this._writeVault(rawVault);
      return;
    }

    if (this.isAvailable()) {
      const encrypted = electronSafeStorage.encryptString(String(plainText));
      rawVault[key] = {
        data: encrypted.toString('hex'),
        updatedAt: Date.now()
      };
    } else {
      console.warn(`[ZMod:Vault] safeStorage unavailable, saving with base64 wrapper for "${key}"`);
      rawVault[key] = {
        data: Buffer.from(String(plainText), 'utf8').toString('base64'),
        unencrypted: true,
        updatedAt: Date.now()
      };
    }

    this._writeVault(rawVault);
  }

  has(key) {
    const rawVault = this._readVault();
    return Boolean(rawVault[key]);
  }

  delete(key) {
    this.set(key, null);
  }

  keys() {
    return Object.keys(this._readVault());
  }

  reset() {
    this._cache = null;
  }

  /**
   * Watch secure.vault for external edits (scripts pre-provisioning entries
   * via the base64 unencrypted wrapper). Just drop the cache — next get/set
   * re-reads from disk; self-writes repopulate the same content anyway.
   */
  startExternalWatch(onChange) {
    if (this._watcher) return;
    ensureDirectories();
    const dir = path.dirname(getVaultPath());
    let timer = null;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const before = JSON.stringify(this._cache ?? null);
        this._cache = null;
        const raw = this._readVault();
        if (JSON.stringify(raw) !== before) {
          console.log('[ZMod:Vault] external change detected, cache dropped');
          try { onChange?.(); } catch {}
        }
      }, 150);
    };
    try {
      this._watcher = fs.watch(dir, { persistent: false }, (event, filename) => {
        if (!filename || filename.startsWith('secure.vault')) reload();
      });
    } catch (err) {
      console.error('[ZMod:Vault] external watch failed:', err?.message || err);
    }
  }
}

export const secretVault = new SecretVault();
