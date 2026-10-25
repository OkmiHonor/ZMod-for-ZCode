import fs from 'node:fs';
import path from 'node:path';
import { getConfigPath, ensureDirectories } from './paths.js';

const DEFAULT_CONFIG = {
  version: 2,
  enabled: true,
  theme: 'default',
  plugins: {},
  datasources: []
};

/** Keep unicode letters/numbers so Chinese names stay readable; join runs of anything else with '-'. */
function slugify(name) {
  return String(name || '')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

class ConfigManager {
  constructor() {
    this._cache = null;
    this._listeners = new Set();
  }

  get() {
    if (this._cache) return this._cache;
    ensureDirectories();
    const filePath = getConfigPath();
    if (!fs.existsSync(filePath)) {
      this._cache = structuredClone(DEFAULT_CONFIG);
      this.save(this._cache);
      return this._cache;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      this._cache = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      return this._cache;
    } catch (err) {
      console.error('[ZMod:Config] Failed to parse config.json, using defaults:', err);
      this._cache = structuredClone(DEFAULT_CONFIG);
      return this._cache;
    }
  }

  save(newConfig) {
    ensureDirectories();
    const filePath = getConfigPath();
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    this._cache = newConfig;
    const serialized = JSON.stringify(this._cache, null, 2);
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, filePath);
    this._notify(this._cache);
  }

  set(key, value) {
    const config = structuredClone(this.get());
    config[key] = value;
    this.save(config);
  }

  getPluginConfig(pluginId) {
    const config = this.get();
    return config.plugins[pluginId] || { enabled: true, settings: {} };
  }

  isPluginEnabled(pluginId, defaultEnabled = true) {
    const p = this.getPluginConfig(pluginId);
    return typeof p.enabled === 'boolean' ? p.enabled : defaultEnabled;
  }

  setPluginEnabled(pluginId, enabled) {
    const config = structuredClone(this.get());
    if (!config.plugins[pluginId]) {
      config.plugins[pluginId] = { enabled, settings: {} };
    } else {
      config.plugins[pluginId].enabled = enabled;
    }
    this.save(config);
  }

  /**
   * 清除插件的 enabled 开关键（remove 语义）：配置里不再留开关记录，重装后
   * 回到默认启用。"关闭但保留" 语义走 setPluginEnabled(id, false)，不走这里。
   * settings 数据与插件配置整体保留；除空 settings 外无任何残留时顺带删插件键
   * （setPluginEnabled 会播种 settings:{}，这类空壳不视为有效配置）。
   * @returns {boolean} 是否实际删除了 enabled 键
   */
  deletePluginEnabled(pluginId) {
    const config = structuredClone(this.get());
    const entry = config.plugins[pluginId];
    if (!entry || entry.enabled === undefined) return false;
    delete entry.enabled;
    const hasPayload = Object.keys(entry).some((k) => k !== 'settings') ||
      (entry.settings && typeof entry.settings === 'object' && Object.keys(entry.settings).length > 0);
    if (!hasPayload) {
      delete config.plugins[pluginId];
    }
    this.save(config);
    return true;
  }

  getPluginSetting(pluginId, key, defaultValue = undefined) {
    const p = this.getPluginConfig(pluginId);
    if (p.settings && p.settings[key] !== undefined) {
      return p.settings[key];
    }
    return defaultValue;
  }

  setPluginSetting(pluginId, key, value) {
    const config = structuredClone(this.get());
    if (!config.plugins[pluginId]) {
      config.plugins[pluginId] = { enabled: true, settings: {} };
    }
    if (!config.plugins[pluginId].settings) {
      config.plugins[pluginId].settings = {};
    }
    config.plugins[pluginId].settings[key] = value;
    this.save(config);
  }

  /**
   * Data source instances. Shape: { id, type, name, settings: {} }.
   * Secret-typed settings MUST be split out by the caller into the vault —
   * config.json never stores credentials.
   */
  getDatasources() {
    const config = this.get();
    return Array.isArray(config.datasources) ? config.datasources : [];
  }

  saveDatasource(instance) {
    if (!instance || typeof instance !== 'object' || typeof instance.type !== 'string') {
      throw new Error('[ZMod:Config] datasource instance requires a "type" string');
    }
    const config = structuredClone(this.get());
    if (!Array.isArray(config.datasources)) config.datasources = [];
    const entry = {
      id: typeof instance.id === 'string' && instance.id ? instance.id : null,
      type: instance.type,
      name: typeof instance.name === 'string' && instance.name ? instance.name : instance.type,
      settings: instance.settings && typeof instance.settings === 'object' ? instance.settings : {}
    };
    if (!entry.id) {
      const base = slugify(entry.name) || 'ds';
      let candidate = base;
      let n = 2;
      while (config.datasources.some((d) => d.id === candidate)) candidate = `${base}-${n++}`;
      entry.id = candidate;
    }
    const idx = config.datasources.findIndex((d) => d.id === entry.id);
    if (idx >= 0) config.datasources[idx] = entry;
    else config.datasources.push(entry);
    this.save(config);
    return entry;
  }

  deleteDatasource(id) {
    const config = structuredClone(this.get());
    if (!Array.isArray(config.datasources)) return false;
    const next = config.datasources.filter((d) => d.id !== id);
    if (next.length === config.datasources.length) return false;
    config.datasources = next;
    this.save(config);
    return true;
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify(config) {
    for (const fn of this._listeners) {
      try {
        fn(config);
      } catch (e) {
        console.error('[ZMod:Config] Listener error:', e);
      }
    }
  }

  reset() {
    this._cache = null;
  }

  /**
   * Watch config.json for external edits (CLI, scripts, user hand-editing)
   * and hot-apply them: reload the cache and notify listeners. Our own
   * save() writes the identical serialization the watcher would re-read, so
   * self-writes are naturally no-ops; parse failures keep the current cache.
   */
  startHotReload() {
    if (this._watcher) return;
    ensureDirectories();
    const dir = path.dirname(getConfigPath());
    let timer = null;
    const reload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const raw = fs.readFileSync(getConfigPath(), 'utf8');
          const next = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
          if (JSON.stringify(next) === JSON.stringify(this.get())) return;
          this._cache = next;
          console.log('[ZMod:Config] external change detected, hot-reloaded');
          this._notify(this._cache);
        } catch {
          // mid-write or malformed JSON: keep serving the last good cache
        }
      }, 150);
    };
    try {
      this._watcher = fs.watch(dir, { persistent: false }, (event, filename) => {
        if (!filename || filename.startsWith('config.json')) reload();
      });
    } catch (err) {
      console.error('[ZMod:Config] hot-reload watcher failed:', err?.message || err);
    }
  }
}

export const configManager = new ConfigManager();
