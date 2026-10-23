/**
 * ZMod Renderer Microkernel v2.0.0
 * Next-generation modular mod loader with declarative settings UI generator
 */

class EventBus {
  constructor() {
    this._events = new Map();
  }
  on(event, handler) {
    if (!this._events.has(event)) this._events.set(event, new Set());
    this._events.get(event).add(handler);
    return () => this.off(event, handler);
  }
  off(event, handler) {
    this._events.get(event)?.delete(handler);
  }
  emit(event, payload) {
    const handlers = this._events.get(event);
    if (!handlers) return;
    for (const fn of handlers) {
      try { fn(payload); } catch (e) { console.error(`[ZMod:Event] "${event}" handler error:`, e); }
    }
  }
}

class Patcher {
  constructor() {
    this._unpatches = [];
  }
  before(obj, method, fn) {
    const orig = obj[method];
    const unpatch = () => { obj[method] = orig; };
    obj[method] = function (...args) {
      fn.apply(this, args);
      return orig.apply(this, args);
    };
    this._unpatches.push(unpatch);
    return unpatch;
  }
  after(obj, method, fn) {
    const orig = obj[method];
    const unpatch = () => { obj[method] = orig; };
    obj[method] = function (...args) {
      const res = orig.apply(this, args);
      fn.apply(this, [res, ...args]);
      return res;
    };
    this._unpatches.push(unpatch);
    return unpatch;
  }
  instead(obj, method, fn) {
    const orig = obj[method];
    const unpatch = () => { obj[method] = orig; };
    obj[method] = function (...args) {
      return fn.apply(this, [orig.bind(this), ...args]);
    };
    this._unpatches.push(unpatch);
    return unpatch;
  }
  unpatchAll() {
    while (this._unpatches.length) {
      this._unpatches.pop()();
    }
  }
}

class UIManager {
  constructor(api) {
    this._api = api;
    this._styles = new Map();
  }

  injectStyle(id, css) {
    let el = document.getElementById(`zmod-style-${id}`);
    if (!el) {
      el = document.createElement('style');
      el.id = `zmod-style-${id}`;
      document.head.appendChild(el);
    }
    el.textContent = css;
    this._styles.set(id, el);
  }

  removeStyle(id) {
    const el = document.getElementById(`zmod-style-${id}`);
    if (el) {
      el.remove();
      this._styles.delete(id);
    }
  }

  showToast(message, type = 'info') {
    let container = document.getElementById('zmod-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'zmod-toast-container';
      container.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999999;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.style.cssText = 'padding:10px 16px;background:rgba(20,20,25,0.92);color:#fff;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.3);backdrop-filter:blur(10px);font-size:13px;pointer-events:auto;transition:all 0.3s;border:1px solid rgba(255,255,255,0.1);opacity:0;transform:translateY(10px);';
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  /**
   * Declarative Settings UI Generator
   * Automatically builds a settings form based on plugin.settings Schema!
   */
  renderPluginSettingsForm(plugin, container, onSettingChange) {
    container.innerHTML = '';
    const settings = plugin.settings || {};
    const keys = Object.keys(settings);

    if (keys.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:rgba(255,255,255,0.4);font-size:13px;padding:12px 0;';
      empty.textContent = '此插件无需额外设置。';
      container.appendChild(empty);
      return;
    }

    const form = document.createElement('div');
    form.style.cssText = 'display:flex;flex-direction:column;gap:16px;';

    for (const key of keys) {
      const def = settings[key];
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.06);';

      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:500;color:rgba(255,255,255,0.9);';
      label.textContent = def.title || key;

      if (def.description) {
        const desc = document.createElement('span');
        desc.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.45);font-weight:normal;line-height:1.4;';
        desc.textContent = def.description;
        row.appendChild(label);
        row.appendChild(desc);
      } else {
        row.appendChild(label);
      }

      // Render Control by Type
      if (def.type === 'switch') {
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.style.cssText = 'cursor:pointer;accent-color:#3b82f6;width:18px;height:18px;';
        toggle.checked = Boolean(plugin._activeSettings?.[key] ?? def.default);
        toggle.addEventListener('change', () => {
          onSettingChange(plugin.id, key, toggle.checked);
        });
        label.appendChild(toggle);
      } else if (def.type === 'slider') {
        const controlWrapper = document.createElement('div');
        controlWrapper.style.cssText = 'display:flex;align-items:center;gap:12px;';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = def.min ?? 0;
        slider.max = def.max ?? 100;
        slider.step = def.step ?? 1;
        slider.value = plugin._activeSettings?.[key] ?? def.default ?? 0;
        slider.style.cssText = 'flex:1;cursor:pointer;accent-color:#3b82f6;';

        const valDisplay = document.createElement('span');
        valDisplay.style.cssText = 'font-size:12px;font-family:monospace;color:rgba(255,255,255,0.7);min-width:36px;text-align:right;';
        valDisplay.textContent = slider.value;

        slider.addEventListener('input', () => {
          valDisplay.textContent = slider.value;
          onSettingChange(plugin.id, key, Number(slider.value));
        });
        controlWrapper.appendChild(slider);
        controlWrapper.appendChild(valDisplay);
        row.appendChild(controlWrapper);
      } else if (def.type === 'text' || def.type === 'number') {
        const input = document.createElement('input');
        input.type = def.type;
        input.placeholder = def.placeholder || '';
        input.value = plugin._activeSettings?.[key] ?? def.default ?? '';
        input.style.cssText = 'padding:6px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#fff;font-size:13px;outline:none;';
        input.addEventListener('change', () => {
          const val = def.type === 'number' ? Number(input.value) : input.value;
          onSettingChange(plugin.id, key, val);
        });
        row.appendChild(input);
      } else if (def.type === 'select') {
        const select = document.createElement('select');
        select.style.cssText = 'padding:6px 10px;background:rgba(30,30,35,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:6px;color:#fff;font-size:13px;outline:none;cursor:pointer;';
        for (const opt of def.options || []) {
          const optEl = document.createElement('option');
          optEl.value = opt.value;
          optEl.textContent = opt.label;
          if (opt.value === (plugin._activeSettings?.[key] ?? def.default)) {
            optEl.selected = true;
          }
          select.appendChild(optEl);
        }
        select.addEventListener('change', () => {
          onSettingChange(plugin.id, key, select.value);
        });
        row.appendChild(select);
      }

      form.appendChild(row);
    }
    container.appendChild(form);
  }
}

class PluginRegistry {
  constructor(api, ui, events) {
    this._api = api;
    this._ui = ui;
    this._events = events;
    this._plugins = new Map();
    this._instances = new Map();
  }

  register(def) {
    if (!def || !def.id) return;
    this._plugins.set(def.id, def);
    this._events.emit('plugin:registered', def);
  }

  async enable(id) {
    const plugin = this._plugins.get(id);
    if (!plugin) return;
    if (this._instances.has(id)) return; // already active

    // 1. Fetch saved settings via RPC
    let cfg = { enabled: true, settings: {} };
    if (this._api?.invoke) {
      cfg = await this._api.invoke('config.getPluginConfig', { pluginId: id });
    }
    plugin._activeSettings = cfg.settings || {};

    // 2. Inject styles if declared
    if (plugin.styles) {
      this._ui.injectStyle(id, plugin.styles);
    }

    // 3. Create Plugin Context
    const patcher = new Patcher();
    const settingsContext = {
      get: (key, fallback) => plugin._activeSettings[key] ?? plugin.settings?.[key]?.default ?? fallback,
      set: async (key, val) => {
        plugin._activeSettings[key] = val;
        if (this._api?.invoke) {
          await this._api.invoke('config.setPluginSetting', { pluginId: id, key, value: val });
        }
        this._events.emit(`setting:${id}:${key}`, val);
      },
      onChange: (key, fn) => this._events.on(`setting:${id}:${key}`, fn)
    };

    const ctx = {
      settings: settingsContext,
      ui: this._ui,
      events: this._events,
      patcher
    };

    try {
      if (typeof plugin.start === 'function') {
        await plugin.start(ctx);
      }
      this._instances.set(id, { plugin, ctx, patcher });
      if (this._api?.invoke) {
        await this._api.invoke('config.setPluginEnabled', { pluginId: id, enabled: true });
      }
      this._events.emit('plugin:enabled', id);
      console.log(`[ZMod:Renderer] Plugin "${id}" started successfully`);
    } catch (err) {
      console.error(`[ZMod:Renderer] Failed to start plugin "${id}":`, err);
      patcher.unpatchAll();
      this._ui.removeStyle(id);
    }
  }

  async disable(id) {
    const active = this._instances.get(id);
    if (!active) return;
    try {
      if (typeof active.plugin.stop === 'function') {
        await active.plugin.stop(active.ctx);
      }
    } catch (e) {
      console.error(`[ZMod:Renderer] Error stopping plugin "${id}":`, e);
    }
    active.patcher.unpatchAll();
    this._ui.removeStyle(id);
    this._instances.delete(id);

    if (this._api?.invoke) {
      await this._api.invoke('config.setPluginEnabled', { pluginId: id, enabled: false });
    }
    this._events.emit('plugin:disabled', id);
    console.log(`[ZMod:Renderer] Plugin "${id}" stopped`);
  }

  async loadAll() {
    if (!this._api?.invoke) return;
    try {
      const discovered = await this._api.invoke('plugins.discover', {});
      const globalConfig = await this._api.invoke('config.get', {});

      for (const item of discovered) {
        try {
          const mod = await import(item.entryUrl);
          const pluginDef = mod.default || mod;
          this.register(pluginDef);

          const isEnabled = globalConfig.plugins?.[pluginDef.id]?.enabled ?? true;
          if (isEnabled) {
            await this.enable(pluginDef.id);
          }
        } catch (err) {
          console.error(`[ZMod:Renderer] Failed to import plugin "${item.id}":`, err);
        }
      }
    } catch (err) {
      console.error('[ZMod:Renderer] Failed to discover plugins:', err);
    }
  }

  getAll() {
    return Array.from(this._plugins.values());
  }

  isActive(id) {
    return this._instances.has(id);
  }
}

// Global ZMod Object Setup
const api = window.zmodAPI || {
  version: '2.0.0-mock',
  invoke: async () => ({})
};

const events = new EventBus();
const ui = new UIManager(api);
const plugins = new PluginRegistry(api, ui, events);

window.ZMod = {
  version: '2.0.0',
  events,
  ui,
  plugins,
  api
};

// Auto-boot when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => plugins.loadAll());
} else {
  plugins.loadAll();
}

console.log('[ZMod:Renderer] Microkernel v2.0.0 loaded');
