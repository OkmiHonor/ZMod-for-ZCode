/**
 * ZMod Renderer Microkernel v2.0
 *
 * Loaded by the host via `<script type="module" src="zmod-local://core/index.js">`.
 * Everything (plugins, SDK) is fetched through the zmod-local:// custom protocol,
 * so no code is embedded in the host asar beyond this one-line script tag.
 */

const ZMOD_VERSION = '2.0.0';

if (window.__ZMOD_V2_INITIALIZED__) {
  // Reload safety: a fresh document never has this flag, but double execution
  // (e.g. manual re-injection) must not stack a second kernel.
  console.warn('[ZMod:Renderer] already initialized, skipping');
} else {
  window.__ZMOD_V2_INITIALIZED__ = true;
  main();
}

function main() {
  /* ------------------------------------------------------------------ *
   * Event bus
   * ------------------------------------------------------------------ */
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
      for (const fn of [...handlers]) {
        try {
          fn(payload);
        } catch (e) {
          console.error(`[ZMod:Event] "${event}" handler error:`, e);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Patcher — AOP hooks with full unpatch bookkeeping
   * ------------------------------------------------------------------ */
  class Patcher {
    constructor() {
      this._unpatches = [];
    }
    before(obj, method, fn) {
      const orig = obj[method];
      obj[method] = function (...args) {
        fn.call(this, args);
        return orig.apply(this, args);
      };
      const unpatch = () => {
        obj[method] = orig;
      };
      this._unpatches.push(unpatch);
      return unpatch;
    }
    after(obj, method, fn) {
      const orig = obj[method];
      obj[method] = function (...args) {
        const res = orig.apply(this, args);
        fn.call(this, res, ...args);
        return res;
      };
      const unpatch = () => {
        obj[method] = orig;
      };
      this._unpatches.push(unpatch);
      return unpatch;
    }
    instead(obj, method, fn) {
      const orig = obj[method];
      obj[method] = function (...args) {
        return fn.call(this, orig.bind(this), ...args);
      };
      const unpatch = () => {
        obj[method] = orig;
      };
      this._unpatches.push(unpatch);
      return unpatch;
    }
    unpatchAll() {
      while (this._unpatches.length) this._unpatches.pop()();
    }
  }

  /* ------------------------------------------------------------------ *
   * UIManager — namespaced styles, toasts, declarative settings form
   * ------------------------------------------------------------------ */
  class UIManager {
    injectStyle(id, css) {
      let el = document.getElementById(`zmod-style-${id}`);
      if (!el) {
        el = document.createElement('style');
        el.id = `zmod-style-${id}`;
        document.head.appendChild(el);
      }
      el.textContent = css;
      return el;
    }
    removeStyle(id) {
      document.getElementById(`zmod-style-${id}`)?.remove();
    }
    showToast(message, type = 'info') {
      let container = document.getElementById('zmod-toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'zmod-toast-container';
        container.style.cssText =
          'position:fixed;bottom:24px;right:24px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
        document.body.appendChild(container);
      }
      const toast = document.createElement('div');
      const accent =
        type === 'success' ? '#34d399' : type === 'warn' || type === 'error' ? '#fbbf24' : '#60a5fa';
      toast.style.cssText = `padding:10px 16px;background:rgba(24,24,28,0.94);color:#f3f4f6;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.35);backdrop-filter:blur(10px);font-size:13px;pointer-events:auto;transition:all 0.3s;border:1px solid rgba(255,255,255,0.1);border-left:3px solid ${accent};opacity:0;transform:translateY(10px);`;
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
      }, 2600);
    }

    /**
     * Declarative settings form renderer. Builds controls from the plugin's
     * settings schema (switch / slider / text / number / select / color).
     * `secret` renders as a password input and persists into the encrypted vault.
     */
    renderSettingsForm(plugin, activeSettings, onChange) {
      const form = document.createElement('div');
      form.style.cssText = 'display:flex;flex-direction:column;gap:14px;';
      const defs = plugin.settings || {};
      const keys = Object.keys(defs);
      if (keys.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:var(--zmod-fg-dim,#888);font-size:13px;padding:8px 0;';
        empty.textContent = '此插件无需额外设置。';
        form.appendChild(empty);
        return form;
      }
      for (const key of keys) {
        const def = defs[key];
        const row = document.createElement('div');
        row.style.cssText =
          'display:flex;flex-direction:column;gap:6px;padding-bottom:12px;border-bottom:1px solid var(--zmod-border,rgba(128,128,128,.18));';
        const label = document.createElement('label');
        label.style.cssText =
          'display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:500;color:var(--zmod-fg,#eee);';
        label.textContent = def.title || key;
        row.appendChild(label);
        if (def.description) {
          const desc = document.createElement('div');
          desc.style.cssText =
            'font-size:12px;color:var(--zmod-fg-dim,#888);font-weight:normal;line-height:1.4;';
          desc.textContent = def.description;
          row.appendChild(desc);
        }

        const value = activeSettings?.[key] ?? def.default;
        const inputStyle =
          'padding:6px 10px;background:var(--zmod-bg-input,rgba(128,128,128,.12));border:1px solid var(--zmod-border,rgba(128,128,128,.25));border-radius:6px;color:var(--zmod-fg,#eee);font-size:13px;outline:none;';

        if (def.type === 'switch') {
          const toggle = document.createElement('input');
          toggle.type = 'checkbox';
          toggle.style.cssText = 'cursor:pointer;accent-color:#3b82f6;width:18px;height:18px;';
          toggle.checked = Boolean(value);
          toggle.addEventListener('change', () => onChange(key, toggle.checked));
          label.appendChild(toggle);
        } else if (def.type === 'slider') {
          const wrap = document.createElement('div');
          wrap.style.cssText = 'display:flex;align-items:center;gap:12px;';
          const slider = document.createElement('input');
          slider.type = 'range';
          slider.min = def.min ?? 0;
          slider.max = def.max ?? 100;
          slider.step = def.step ?? 1;
          slider.value = value ?? 0;
          slider.style.cssText = 'flex:1;cursor:pointer;accent-color:#3b82f6;';
          const val = document.createElement('span');
          val.style.cssText =
            'font-size:12px;font-family:monospace;color:var(--zmod-fg-dim,#888);min-width:36px;text-align:right;';
          val.textContent = slider.value;
          slider.addEventListener('input', () => {
            val.textContent = slider.value;
            onChange(key, Number(slider.value));
          });
          wrap.appendChild(slider);
          wrap.appendChild(val);
          row.appendChild(wrap);
        } else if (def.type === 'text' || def.type === 'number' || def.type === 'secret') {
          const input = document.createElement('input');
          input.type = def.type === 'number' ? 'number' : def.type === 'secret' ? 'password' : 'text';
          input.placeholder = def.placeholder || '';
          input.value = value ?? '';
          input.style.cssText = inputStyle;
          input.addEventListener('change', () => {
            onChange(key, def.type === 'number' ? Number(input.value) : input.value);
          });
          row.appendChild(input);
        } else if (def.type === 'select') {
          const select = document.createElement('select');
          select.style.cssText = inputStyle + 'cursor:pointer;';
          for (const opt of def.options || []) {
            const optEl = document.createElement('option');
            optEl.value = opt.value;
            optEl.textContent = opt.label;
            if (opt.value === value) optEl.selected = true;
            select.appendChild(optEl);
          }
          select.addEventListener('change', () => onChange(key, select.value));
          row.appendChild(select);
        } else if (def.type === 'color') {
          const input = document.createElement('input');
          input.type = 'color';
          input.value = /^#[0-9a-fA-F]{6}$/.test(value ?? '') ? value : '#888888';
          input.style.cssText = 'width:42px;height:26px;cursor:pointer;background:none;border:none;';
          input.addEventListener('change', () => onChange(key, input.value));
          row.appendChild(input);
        }
        form.appendChild(row);
      }
      return form;
    }
  }

  /* ------------------------------------------------------------------ *
   * RPC — preload bridge first, fetch-over-protocol fallback
   * ------------------------------------------------------------------ */
  function makeFetchApi() {
    return {
      version: `${ZMOD_VERSION}-fetch`,
      transport: 'fetch',
      invoke: async (method, params = {}) => {
        // text/plain avoids the CORS preflight that application/json triggers
        const res = await fetch('zmod-local://rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ method, params })
        });
        let data = null;
        try {
          data = await res.json();
        } catch {}
        if (!res.ok) {
          throw new Error(data?.error || `[ZMod:RPC] ${method} failed (${res.status})`);
        }
        return data;
      },
      on: () => () => {}
    };
  }

  const api =
    window.zmodAPI && typeof window.zmodAPI.invoke === 'function'
      ? Object.assign({ transport: 'ipc' }, window.zmodAPI)
      : makeFetchApi();

  /* ------------------------------------------------------------------ *
   * Plugin registry
   * ------------------------------------------------------------------ */
  class PluginRegistry {
    constructor(events, ui) {
      this._events = events;
      this._ui = ui;
      this._plugins = new Map();
      this._active = new Map(); // id -> { def, ctx, patcher, cleanups, offs }
    }

    register(def) {
      if (!def || !def.id) return false;
      this._plugins.set(def.id, def);
      return true;
    }

    async enable(id, { persist = false } = {}) {
      const def = this._plugins.get(id);
      if (!def || this._active.has(id)) return false;

      let cfg = { enabled: true, settings: {} };
      try {
        cfg = (await api.invoke('config.getPluginConfig', { pluginId: id })) || cfg;
      } catch (err) {
        console.error(`[ZMod:Renderer] config fetch failed for "${id}":`, err?.message || err);
      }
      def._activeSettings = cfg.settings || {};

      const patcher = new Patcher();
      const cleanups = [];
      const offs = [];
      const events = this._events;
      const ui = this._ui;

      if (def.styles) ui.injectStyle(`${id}-plugin`, def.styles);

      const ctx = {
        id,
        invoke: (method, params) => api.invoke(method, params),
        ui,
        events,
        patcher,
        /** Register teardown logic; runs LIFO on disable. */
        cleanup(fn) {
          if (typeof fn === 'function') cleanups.push(fn);
        },
        settings: {
          get: (key, fallback) => def._activeSettings[key] ?? def.settings?.[key]?.default ?? fallback,
          set: async (key, val) => {
            def._activeSettings[key] = val;
            try {
              await api.invoke('config.setPluginSetting', { pluginId: id, key, value: val });
            } catch (err) {
              console.error(`[ZMod:Renderer] setting persist failed (${id}.${key}):`, err);
            }
            events.emit(`setting:${id}:${key}`, val);
          },
          /** Auto-collected; listeners are removed when the plugin is disabled. */
          onChange: (key, fn) => {
            const off = events.on(`setting:${id}:${key}`, fn);
            offs.push(off);
            return off;
          }
        }
      };

      try {
        if (typeof def.start === 'function') await def.start(ctx);
        this._active.set(id, { def, ctx, patcher, cleanups, offs });
        if (persist) {
          await api.invoke('config.setPluginEnabled', { pluginId: id, enabled: true }).catch(() => {});
        }
        this._events.emit('plugin:enabled', id);
        console.log(`[ZMod:Renderer] plugin "${id}" started`);
        return true;
      } catch (err) {
        console.error(`[ZMod:Renderer] failed to start plugin "${id}":`, err);
        this._teardown(this._active.get(id) || { def, ctx, patcher, cleanups, offs });
        return false;
      }
    }

    async disable(id, { persist = false } = {}) {
      const active = this._active.get(id);
      if (!active) return false;
      try {
        if (typeof active.def.stop === 'function') await active.def.stop(active.ctx);
      } catch (e) {
        console.error(`[ZMod:Renderer] error stopping "${id}":`, e);
      }
      this._teardown(active);
      if (persist) {
        await api.invoke('config.setPluginEnabled', { pluginId: id, enabled: false }).catch(() => {});
      }
      this._events.emit('plugin:disabled', id);
      console.log(`[ZMod:Renderer] plugin "${id}" stopped`);
      return true;
    }

    _teardown(active) {
      if (!active) return;
      while (active.cleanups.length) {
        try {
          active.cleanups.pop()();
        } catch (e) {
          console.error('[ZMod:Renderer] cleanup error:', e);
        }
      }
      for (const off of active.offs) {
        try {
          off();
        } catch {}
      }
      active.patcher.unpatchAll();
      this._ui.removeStyle(`${active.def.id}-plugin`);
      this._active.delete(active.def.id);
    }

    async loadAll() {
      let discovered = [];
      try {
        discovered = await api.invoke('plugins.discover', {});
      } catch (err) {
        console.error('[ZMod:Renderer] plugin discovery failed:', err?.message || err);
        return;
      }
      if (!Array.isArray(discovered)) {
        console.error('[ZMod:Renderer] unexpected discover result, skipping load');
        return;
      }
      let globalCfg = {};
      try {
        globalCfg = (await api.invoke('config.get', {})) || {};
      } catch {}

      for (const item of discovered) {
        try {
          const mod = await import(item.entryUrl);
          const def = mod.default || mod;
          this.register(def);
          const enabled = globalCfg.plugins?.[def.id]?.enabled ?? true;
          if (enabled) await this.enable(def.id);
        } catch (err) {
          console.error(`[ZMod:Renderer] failed to load plugin "${item?.id}":`, err);
        }
      }
    }

    getAll() {
      return [...this._plugins.values()];
    }
    isActive(id) {
      return this._active.has(id);
    }
    getActiveSettings(id) {
      return this._plugins.get(id)?._activeSettings || {};
    }
  }

  /* ------------------------------------------------------------------ *
   * Manager panel (Ctrl+Shift+M)
   * ------------------------------------------------------------------ */
  const PANEL_CSS = `
    #zmod-v2-manager { position:fixed; inset:0; z-index:2147483000; display:flex; align-items:center; justify-content:center;
      background:rgba(0,0,0,.42); backdrop-filter:blur(4px); font-family:inherit; }
    .zmod-mgr-card { width:min(600px,92vw); max-height:82vh; display:flex; flex-direction:column;
      background:var(--zmod-bg,#1d1d21); color:var(--zmod-fg,#e8e8ea); border-radius:14px;
      border:1px solid var(--zmod-border,rgba(128,128,128,.25)); box-shadow:0 24px 72px rgba(0,0,0,.5); font-size:13px; }
    .zmod-mgr-header { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid var(--zmod-border,rgba(128,128,128,.2)); }
    .zmod-mgr-title { font-size:15px; font-weight:600; }
    .zmod-mgr-title small { font-weight:normal; color:var(--zmod-fg-dim,#888); margin-left:8px; }
    .zmod-mgr-close { cursor:pointer; background:none; border:none; color:var(--zmod-fg-dim,#888); font-size:18px; line-height:1; padding:4px 8px; border-radius:6px; }
    .zmod-mgr-close:hover { background:var(--zmod-bg-hover,rgba(128,128,128,.15)); color:var(--zmod-fg,#eee); }
    .zmod-mgr-body { padding:14px 18px; overflow-y:auto; flex:1; }
    .zmod-mgr-row { display:flex; align-items:center; gap:12px; padding:11px 2px; border-bottom:1px solid var(--zmod-border,rgba(128,128,128,.14)); }
    .zmod-mgr-row:last-child { border-bottom:none; }
    .zmod-mgr-row-info { flex:1; min-width:0; }
    .zmod-mgr-row-name { font-weight:500; }
    .zmod-mgr-row-name .zmod-mgr-ver { font-weight:normal; color:var(--zmod-fg-dim,#888); font-size:12px; margin-left:6px; }
    .zmod-mgr-row-desc { color:var(--zmod-fg-dim,#888); font-size:12px; margin-top:2px; }
    .zmod-mgr-gear { cursor:pointer; background:none; border:1px solid var(--zmod-border,rgba(128,128,128,.25)); color:var(--zmod-fg-dim,#999);
      border-radius:6px; padding:3px 8px; font-size:12px; }
    .zmod-mgr-gear:hover { color:var(--zmod-fg,#eee); border-color:#3b82f6; }
    .zmod-mgr-footer { padding:10px 18px; border-top:1px solid var(--zmod-border,rgba(128,128,128,.2)); color:var(--zmod-fg-dim,#888); font-size:12px; display:flex; justify-content:space-between; }
    .zmod-mgr-back { cursor:pointer; background:none; border:none; color:#60a5fa; font-size:13px; padding:0 0 10px; }
    .zmod-mgr-empty { color:var(--zmod-fg-dim,#888); text-align:center; padding:24px 0; }
  `;

  class ManagerPanel {
    constructor(events, registry, ui) {
      this._events = events;
      this._registry = registry;
      this._ui = ui;
      this._root = null;
      this._settingsFor = null;
    }

    _isLightTheme() {
      const cls = document.documentElement.className || '';
      return /theme-zai-light|(^|\s)light(\s|$)/.test(cls);
    }

    toggle() {
      this._root?.style.display === 'flex' ? this.close() : this.open();
    }

    open() {
      if (!this._root) {
        this._ui.injectStyle('zmod-v2-manager', PANEL_CSS);
        this._root = document.createElement('div');
        this._root.id = 'zmod-v2-manager';
        this._root.style.display = 'none';
        this._root.addEventListener('click', (e) => {
          if (e.target === this._root) this.close();
        });
        document.body.appendChild(this._root);
      }
      // theme variables on the panel root so host theme changes just work on reopen
      const light = this._isLightTheme();
      this._root.style.setProperty('--zmod-bg', light ? '#f5f5f7' : '#1d1d21');
      this._root.style.setProperty('--zmod-fg', light ? '#242428' : '#e8e8ea');
      this._root.style.setProperty('--zmod-fg-dim', light ? '#77777d' : '#8f9096');
      this._root.style.setProperty('--zmod-border', light ? 'rgba(0,0,0,.14)' : 'rgba(128,128,128,.25)');
      this._root.style.setProperty('--zmod-bg-hover', light ? 'rgba(0,0,0,.06)' : 'rgba(128,128,128,.15)');
      this._root.style.setProperty('--zmod-bg-input', light ? 'rgba(0,0,0,.05)' : 'rgba(128,128,128,.12)');
      this._root.style.display = 'flex';
      this._render();
    }

    close() {
      if (this._root) this._root.style.display = 'none';
      this._settingsFor = null;
    }

    _render() {
      if (!this._root) return;
      this._root.innerHTML = '';
      const card = document.createElement('div');
      card.className = 'zmod-mgr-card';

      const header = document.createElement('div');
      header.className = 'zmod-mgr-header';
      header.innerHTML = `<div class="zmod-mgr-title">ZMod <small>v${ZMOD_VERSION} · ${api.transport}</small></div>`;
      const closeBtn = document.createElement('button');
      closeBtn.className = 'zmod-mgr-close';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', () => this.close());
      header.appendChild(closeBtn);
      card.appendChild(header);

      const body = document.createElement('div');
      body.className = 'zmod-mgr-body';
      if (this._settingsFor) this._renderSettings(body);
      else this._renderList(body);
      card.appendChild(body);

      const footer = document.createElement('div');
      footer.className = 'zmod-mgr-footer';
      const count = this._registry.getAll().length;
      footer.innerHTML = `<span>${count} 插件</span><span>Ctrl+Shift+M 开关 · Esc 关闭</span>`;
      card.appendChild(footer);

      this._root.appendChild(card);
    }

    _renderList(body) {
      const defs = this._registry.getAll();
      if (defs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'zmod-mgr-empty';
        empty.textContent = '未发现任何插件。请检查 %APPDATA%/ZMod/plugins 目录。';
        body.appendChild(empty);
        return;
      }
      for (const def of defs) {
        const row = document.createElement('div');
        row.className = 'zmod-mgr-row';

        const info = document.createElement('div');
        info.className = 'zmod-mgr-row-info';
        info.innerHTML = `<div class="zmod-mgr-row-name">${escapeHtml(def.name || def.id)}<span class="zmod-mgr-ver">v${escapeHtml(
          def.version || '1.0.0'
        )}</span></div>`;
        if (def.description) {
          const desc = document.createElement('div');
          desc.className = 'zmod-mgr-row-desc';
          desc.textContent = def.description;
          info.appendChild(desc);
        }
        row.appendChild(info);

        if (def.settings && Object.keys(def.settings).length > 0) {
          const gear = document.createElement('button');
          gear.className = 'zmod-mgr-gear';
          gear.textContent = '⚙ 设置';
          gear.addEventListener('click', () => {
            this._settingsFor = def.id;
            this._render();
          });
          row.appendChild(gear);
        }

        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.style.cssText = 'cursor:pointer;accent-color:#3b82f6;width:18px;height:18px;';
        toggle.checked = this._registry.isActive(def.id);
        toggle.addEventListener('change', async () => {
          if (toggle.checked) await this._registry.enable(def.id, { persist: true });
          else await this._registry.disable(def.id, { persist: true });
          this._render();
        });
        row.appendChild(toggle);
        body.appendChild(row);
      }
    }

    _renderSettings(body) {
      const id = this._settingsFor;
      const def = this._registry._plugins.get(id);
      if (!def) {
        this._settingsFor = null;
        this._renderList(body);
        return;
      }
      const back = document.createElement('button');
      back.className = 'zmod-mgr-back';
      back.textContent = '← 返回插件列表';
      back.addEventListener('click', () => {
        this._settingsFor = null;
        this._render();
      });
      body.appendChild(back);

      const title = document.createElement('div');
      title.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:12px;';
      title.textContent = `${def.name || id} · 设置`;
      body.appendChild(title);

      const form = this._ui.renderSettingsForm(
        def,
        this._registry.getActiveSettings(id),
        async (key, value) => {
          const active = this._registry._active.get(id);
          if (active) {
            // route through the registry ctx so plugin onChange listeners fire
            await active.ctx.settings.set(key, value);
          } else {
            await api.invoke('config.setPluginSetting', { pluginId: id, key, value });
          }
        }
      );
      body.appendChild(form);
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */
  const events = new EventBus();
  const ui = new UIManager();
  const plugins = new PluginRegistry(events, ui);

  const panel = new ManagerPanel(events, plugins, ui);

  window.ZMod = {
    version: ZMOD_VERSION,
    events,
    ui,
    plugins,
    api,
    openManager: () => panel.open()
  };

  const panelKeys = (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
      e.preventDefault();
      e.stopPropagation();
      panel.toggle();
    } else if (e.key === 'Escape' && panel._root?.style.display === 'flex') {
      panel.close();
    }
  };
  document.addEventListener('keydown', panelKeys, true);

  const boot = () => {
    console.log(`[ZMod:Renderer] microkernel v${ZMOD_VERSION} loaded (${api.transport})`);
    plugins.loadAll();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
