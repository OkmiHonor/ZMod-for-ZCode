import fs from 'node:fs';
import path from 'node:path';
import { getConfigPath, ensureDirectories } from './paths.js';

const DEFAULT_CONFIG = {
  version: 2,
  enabled: true,
  theme: 'default',
  plugins: {}
};

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
}

export const configManager = new ConfigManager();
