/**
 * ZMod Renderer Microkernel
 *
 * Loaded by the host via `<script type="module" src="zmod-local://core/index.js">`.
 * Everything (plugins, SDK) is fetched through the zmod-local:// custom protocol,
 * so no code is embedded in the host asar beyond this one-line script tag.
 */

import { DataSourceRegistry } from './datasources.js';
import { registerBuiltinProviders } from './builtin-providers.js';
import { createSettingsPageIntegration, makeSwitch } from './settings-page.js';
import { applyPluginChange } from './plugin-bridge.js';
import { mergeMarketView, normalizeInstallUrl } from './market-view.js';

const ZMOD_VERSION = '1.6.0';

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
      // error/warn 需要更长的阅读窗口，避免被截图或切窗错过
      const duration = type === 'error' || type === 'warn' ? 6000 : 2600;
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
      }, duration);
    }

    /**
     * Declarative settings form renderer, styled with the host's own Tailwind
     * token classes so forms look first-party inside the official settings
     * page and the fallback panel alike.
     *
     * Control types: switch / slider / text / number / secret / select /
     * color / group (heading) / action (button invoking `onAction(key)`).
     * `secret` never echoes the stored value: the input starts empty and an
     * empty submit keeps the vault entry untouched.
     *
     * Custom section: when the plugin def carries a `renderSettings(el, helpers)`
     * function, it is invoked after all declarative controls with a plain
     * container <div> and helpers = { onChange, onAction, toast } — the plugin
     * paints its own settings UI inside the same form flow. A throwing
     * renderer is logged and dropped; the declarative controls stay intact.
     */
    renderSettingsForm(plugin, activeSettings, onChange, onAction) {
      const form = document.createElement('div');
      form.className = 'flex flex-col';
      const defs = plugin.settings || {};
      const keys = Object.keys(defs);
      const hasCustom = typeof plugin?.renderSettings === 'function';
      if (keys.length === 0 && !hasCustom) {
        const empty = document.createElement('div');
        empty.className = 'py-2 text-ui-sm text-foreground-subtle';
        empty.textContent = '此插件无需额外设置。';
        form.appendChild(empty);
        return form;
      }
      const INPUT_CLS =
        'h-8 w-full rounded-lg border border-border bg-surface px-2.5 text-ui-base text-foreground outline-none transition-colors placeholder:text-foreground-subtle/60 focus-visible:ring-1 focus-visible:ring-input-border-focused';

      for (const key of keys) {
        const def = defs[key];

        if (def.type === 'group') {
          const head = document.createElement('div');
          head.className = 'pt-2 text-ui-sm font-medium text-foreground-subtle';
          head.textContent = def.title || key;
          form.appendChild(head);
          continue;
        }

        if (def.type === 'action') {
          if (typeof onAction !== 'function') continue;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className =
            'mt-1 inline-flex h-8 w-fit cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-ui-base text-foreground transition-colors hover:bg-surface-hover';
          btn.textContent = def.title || key;
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              await onAction(def.action || key);
            } finally {
              btn.disabled = false;
            }
          });
          form.appendChild(btn);
          if (def.description) {
            const desc = document.createElement('div');
            desc.className = 'pb-1 text-ui-xs text-foreground-subtle';
            desc.textContent = def.description;
            form.appendChild(desc);
          }
          continue;
        }

        const isInline = def.type === 'switch' || def.type === 'color';
        const row = document.createElement('div');
        row.className = isInline
          ? 'flex items-center justify-between gap-4 border-b border-border py-3 last:border-b-0'
          : 'flex flex-col gap-1.5 border-b border-border py-3 last:border-b-0';

        const labelBox = document.createElement('div');
        labelBox.className = 'flex min-w-0 flex-col gap-0.5';
        const label = document.createElement('span');
        label.className = 'text-ui-base font-medium text-foreground';
        label.textContent = def.title || key;
        labelBox.appendChild(label);
        if (def.description) {
          const desc = document.createElement('span');
          desc.className = 'text-ui-sm text-foreground-subtle';
          desc.textContent = def.description;
          labelBox.appendChild(desc);
        }
        row.appendChild(labelBox);

        const value = activeSettings?.[key] ?? def.default;

        if (def.type === 'switch') {
          row.appendChild(makeSwitch(Boolean(value), (next) => onChange(key, next), (m, l) => this.showToast(m, l)));
        } else if (def.type === 'slider') {
          const wrap = document.createElement('div');
          wrap.className = 'mt-1 flex items-center gap-3';
          const slider = document.createElement('input');
          slider.type = 'range';
          slider.min = def.min ?? 0;
          slider.max = def.max ?? 100;
          slider.step = def.step ?? 1;
          slider.value = value ?? 0;
          slider.className = 'h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-surface-hover accent-foreground';
          const val = document.createElement('span');
          val.className = 'min-w-10 text-right text-ui-sm tabular-nums text-foreground-subtle';
          val.textContent = slider.value;
          slider.addEventListener('input', () => {
            val.textContent = slider.value;
            onChange(key, Number(slider.value));
          });
          wrap.appendChild(slider);
          wrap.appendChild(val);
          row.appendChild(wrap);
        } else if (def.type === 'secret') {
          const input = document.createElement('input');
          input.type = 'password';
          input.autocomplete = 'off';
          input.placeholder =
            typeof value === 'string' && value ? '已加密保存 — 留空保持不变' : def.placeholder || '';
          input.className = INPUT_CLS;
          input.addEventListener('change', () => {
            if (input.value) onChange(key, input.value);
          });
          row.appendChild(input);
        } else if (def.type === 'text' || def.type === 'number') {
          const input = document.createElement('input');
          input.type = def.type === 'number' ? 'number' : 'text';
          input.placeholder = def.placeholder || '';
          input.value = value ?? '';
          input.className = INPUT_CLS;
          input.addEventListener('change', () => {
            onChange(key, def.type === 'number' ? Number(input.value) : input.value);
          });
          row.appendChild(input);
        } else if (def.type === 'select') {
          const select = document.createElement('select');
          select.className = INPUT_CLS + ' cursor-pointer';
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
          input.className = 'size-7 cursor-pointer border-none bg-transparent p-0';
          input.addEventListener('change', () => onChange(key, input.value));
          row.appendChild(input);
        }
        form.appendChild(row);
      }

      // Plugin-provided custom settings section: sits inside the same form
      // flow below the declarative controls, no extra chrome of our own.
      if (hasCustom) {
        const container = document.createElement('div');
        container.className = 'flex flex-col gap-3';
        form.appendChild(container);
        try {
          plugin.renderSettings(container, {
            onChange,
            onAction,
            toast: (msg, type) => this.showToast(msg, type)
          });
        } catch (err) {
          console.error(`[ZMod:Renderer] renderSettings failed for "${plugin?.id || '?'}":`, err);
          container.remove();
        }
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
      // Secret-typed settings live in the encrypted vault, never config.json.
      for (const [key, schema] of Object.entries(def.settings || {})) {
        if (schema?.type !== 'secret') continue;
        try {
          const v = await api.invoke('vault.get', { key: `secret:${id}:${key}` });
          if (typeof v === 'string' && v) def._activeSettings[key] = v;
        } catch {}
      }

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
            const isSecret = def.settings?.[key]?.type === 'secret';
            try {
              if (isSecret) {
                await api.invoke('vault.set', { key: `secret:${id}:${key}`, value: val });
              } else {
                await api.invoke('config.setPluginSetting', { pluginId: id, key, value: val });
              }
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
        },
        /** Shared data source registry (providers, instances, cached status). */
        datasources: dataSourceRegistry ? dataSourceRegistry.forPlugin(id) : null
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

    /** 移除注册表项；仍在运行（active）时拒绝，调用方须先 disable。 */
    unregister(id) {
      if (this._active.has(id)) return false;
      return this._plugins.delete(id);
    }

    /** 单插件装载：import → register → 按 config enabled 决定是否 enable。失败抛给调用方。 */
    async loadOne(item, globalCfg) {
      const mod = await import(item.entryUrl);
      const def = mod.default || mod;
      // 主进程 discover 注入的安装账本记录 {source,installedAt}|null，面板按
      // source==='builtin' 显示「随基座」标记；热装载广播路径无账本信息，为 null
      def._installed = item?.installed ?? null;
      this.register(def);
      const enabled = globalCfg?.plugins?.[def.id]?.enabled ?? true;
      if (enabled) await this.enable(def.id);
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
          await this.loadOne(item, globalCfg);
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
    .zmod-mgr-tabs { display:flex; gap:2px; padding:0 12px; border-bottom:1px solid var(--zmod-border,rgba(128,128,128,.2)); }
    .zmod-mgr-tab { cursor:pointer; background:none; border:none; color:var(--zmod-fg-dim,#888); font-size:13px;
      padding:9px 12px 7px; border-bottom:2px solid transparent; margin-bottom:-1px; }
    .zmod-mgr-tab:hover { color:var(--zmod-fg,#eee); }
    .zmod-mgr-tab-active { color:var(--zmod-fg,#eee); border-bottom-color:#3b82f6; }
    .zmod-mgr-remove { cursor:pointer; background:none; border:1px solid var(--zmod-border,rgba(128,128,128,.25)); color:var(--zmod-fg-dim,#999);
      border-radius:6px; padding:3px 8px; font-size:12px; }
    .zmod-mgr-remove:hover { color:#ef4444; border-color:#ef4444; }
    .zmod-mgr-confirm { display:flex; align-items:center; gap:10px; padding:9px 2px;
      border-bottom:1px solid var(--zmod-border,rgba(128,128,128,.14)); font-size:12px; color:var(--zmod-fg-dim,#888); }
    .zmod-mgr-confirm-text { flex:1; min-width:0; }
    .zmod-mgr-btn { cursor:pointer; background:none; border:1px solid var(--zmod-border,rgba(128,128,128,.25));
      color:var(--zmod-fg,#eee); border-radius:6px; padding:3px 10px; font-size:12px; }
    .zmod-mgr-btn:hover { border-color:#3b82f6; }
    .zmod-mgr-btn-danger { color:#ef4444; border-color:rgba(239,68,68,.55); }
    .zmod-mgr-btn-danger:hover { border-color:#ef4444; }
    .zmod-mgr-tag { display:inline-block; margin:5px 6px 0 0; padding:1px 7px; border-radius:999px;
      border:1px solid var(--zmod-border,rgba(128,128,128,.25)); color:var(--zmod-fg-dim,#888); font-size:11px; }
    .zmod-mgr-engine { color:#ef4444; font-size:12px; margin-top:3px; }
    .zmod-mgr-toolbar { display:flex; align-items:center; justify-content:space-between; padding:2px 0 8px;
      color:var(--zmod-fg-dim,#888); font-size:12px; min-height:28px; }
    .zmod-mgr-input { flex:1; min-width:0; height:30px; border-radius:8px; border:1px solid var(--zmod-border,rgba(128,128,128,.25));
      background:var(--zmod-bg-input,rgba(128,128,128,.12)); color:var(--zmod-fg,#eee); padding:0 10px; font-size:12px; outline:none; }
    .zmod-mgr-input:focus { border-color:#3b82f6; }
    .zmod-mgr-urlbox { margin-top:14px; padding-top:12px; border-top:1px solid var(--zmod-border,rgba(128,128,128,.2));
      display:flex; flex-direction:column; gap:8px; }
    .zmod-mgr-urlrow { display:flex; gap:8px; }
  `;

  class ManagerPanel {
    constructor(events, registry, ui) {
      this._events = events;
      this._registry = registry;
      this._ui = ui;
      this._root = null;
      this._settingsFor = null;
      // 插件中心状态：已装/市场双 tab
      this._tab = 'installed'; // 'installed' | 'market'
      this._marketData = null; // plugin.listRemote 的成功结果 { ok,plugins,stale,error? }
      this._marketLoading = false;
      this._marketError = null;
      // 行内二次确认（不用 window.confirm）：记录目标插件 id
      this._confirmRemoveFor = null;
      this._confirmInstallFor = null;
    }

    _isLightTheme() {
      const cls = document.documentElement.className || '';
      return /theme-zai-light|(^|\s)light(\s|$)/.test(cls);
    }

    toggle() {
      this._root?.style.display === 'flex' ? this.close() : this.open();
    }

    open(tab) {
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
      // tab 直达（如设置页「添加插件」→ market）：进市场且无数据时顺带拉取
      if (tab === 'market' && this._tab !== 'market') {
        this._tab = 'market';
        this._settingsFor = null;
        if (!this._marketData && !this._marketLoading && !this._marketError) this._loadMarket();
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

    /** 打开状态下重绘；关闭状态跳过（下次 open 自会渲染最新状态）。 */
    refresh() {
      if (this._root && this._root.style.display === 'flex') this._render();
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
      if (this._settingsFor) {
        this._renderSettings(body);
      } else {
        card.appendChild(this._buildTabs());
        if (this._tab === 'market') this._renderMarket(body);
        else this._renderList(body);
      }
      card.appendChild(body);

      const footer = document.createElement('div');
      footer.className = 'zmod-mgr-footer';
      const count = this._registry.getAll().length;
      footer.innerHTML = `<span>${count} 插件</span><span>Ctrl+Shift+M 开关 · Esc 关闭</span>`;
      card.appendChild(footer);

      this._root.appendChild(card);
    }

    _buildTabs() {
      const tabs = document.createElement('div');
      tabs.className = 'zmod-mgr-tabs';
      for (const [key, label] of [
        ['installed', '已装'],
        ['market', '市场']
      ]) {
        const b = document.createElement('button');
        b.className = 'zmod-mgr-tab' + (this._tab === key ? ' zmod-mgr-tab-active' : '');
        b.textContent = label;
        b.addEventListener('click', () => {
          if (this._tab === key) return;
          this._tab = key;
          this._confirmRemoveFor = null;
          this._confirmInstallFor = null;
          this._settingsFor = null;
          // 首次进市场拉数据；已有数据/错误态则直接渲染（错误态提供重试按钮）
          if (key === 'market' && !this._marketData && !this._marketLoading && !this._marketError) {
            this._loadMarket();
          }
          this._render();
        });
        tabs.appendChild(b);
      }
      return tabs;
    }

    _renderList(body) {
      const defs = this._registry.getAll();
      if (defs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'zmod-mgr-empty';
        empty.textContent = '未发现任何插件。可切换到「市场」tab 安装，或检查 ZMod 数据目录下的 plugins 子目录。';
        body.appendChild(empty);
        return;
      }
      for (const def of defs) {
        const isBuiltin = def._installed?.source === 'builtin';
        const row = document.createElement('div');
        row.className = 'zmod-mgr-row';

        const info = document.createElement('div');
        info.className = 'zmod-mgr-row-info';
        info.innerHTML = `<div class="zmod-mgr-row-name">${escapeHtml(def.name || def.id)}<span class="zmod-mgr-ver">v${escapeHtml(
          def.version || '1.0.0'
        )}</span>${isBuiltin ? '<span class="zmod-mgr-ver">随基座</span>' : ''}</div>`;
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

        const removeBtn = document.createElement('button');
        removeBtn.className = 'zmod-mgr-remove';
        removeBtn.textContent = '移除';
        removeBtn.addEventListener('click', () => {
          this._confirmRemoveFor = this._confirmRemoveFor === def.id ? null : def.id;
          this._render();
        });
        row.appendChild(removeBtn);

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

        if (this._confirmRemoveFor === def.id) {
          body.appendChild(this._buildRemoveConfirm(def, isBuiltin));
        }
      }
    }

    /** 移除二次确认条：行下方内联展开，不走 window.confirm。 */
    _buildRemoveConfirm(def, isBuiltin) {
      const bar = document.createElement('div');
      bar.className = 'zmod-mgr-confirm';
      const text = document.createElement('span');
      text.className = 'zmod-mgr-confirm-text';
      text.textContent =
        `确认移除 ${def.name || def.id}？配置将保留` +
        (isBuiltin ? '（随基座发布，重跑安装器会重新部署）' : '');
      bar.appendChild(text);
      const cancel = document.createElement('button');
      cancel.className = 'zmod-mgr-btn';
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => {
        this._confirmRemoveFor = null;
        this._render();
      });
      bar.appendChild(cancel);
      const ok = document.createElement('button');
      ok.className = 'zmod-mgr-btn zmod-mgr-btn-danger';
      ok.textContent = '确认';
      ok.addEventListener('click', async () => {
        ok.disabled = true;
        await this._removePlugin(def.id);
      });
      bar.appendChild(ok);
      return bar;
    }

    async _removePlugin(id) {
      try {
        const res = await api.invoke('plugin.remove', { id });
        this._confirmRemoveFor = null;
        if (res && res.ok) this._ui.showToast('已移除', 'success');
        else this._ui.showToast((res && res.error) || '移除失败', 'error');
      } catch (err) {
        this._confirmRemoveFor = null;
        this._ui.showToast(`移除失败：${err?.message || err}`, 'error');
      }
      this._render();
    }

    // ---- 市场 tab ---------------------------------------------------------

    async _loadMarket() {
      this._marketLoading = true;
      this._marketError = null;
      if (this._tab === 'market') this._render();
      try {
        const res = await api.invoke('plugin.listRemote', {});
        if (res && res.ok) this._marketData = res;
        else this._marketError = (res && res.error) || '获取市场数据失败';
      } catch (err) {
        this._marketError = String(err?.message || err);
      } finally {
        this._marketLoading = false;
        if (this._tab === 'market') this._render();
      }
    }

    _renderMarket(body) {
      if (this._marketLoading) {
        const loading = document.createElement('div');
        loading.className = 'zmod-mgr-empty';
        loading.textContent = '加载中…';
        body.appendChild(loading);
        return;
      }
      if (this._marketError) {
        const box = document.createElement('div');
        box.className = 'zmod-mgr-empty';
        box.textContent = `市场获取失败：${this._marketError}`;
        const retry = document.createElement('button');
        retry.className = 'zmod-mgr-gear';
        retry.style.cssText = 'margin-top:10px;';
        retry.textContent = '重试';
        retry.addEventListener('click', () => this._loadMarket());
        body.appendChild(box);
        body.appendChild(retry);
        return;
      }
      if (!this._marketData) {
        // 直接以市场 tab 打开（如热装载广播触发）时兜底拉一次
        this._loadMarket();
        const loading = document.createElement('div');
        loading.className = 'zmod-mgr-empty';
        loading.textContent = '加载中…';
        body.appendChild(loading);
        return;
      }

      const toolbar = document.createElement('div');
      toolbar.className = 'zmod-mgr-toolbar';
      const staleHint = document.createElement('span');
      staleHint.textContent = this._marketData.stale ? '（缓存数据）' : '';
      toolbar.appendChild(staleHint);
      const refresh = document.createElement('button');
      refresh.className = 'zmod-mgr-gear';
      refresh.textContent = '↻ 刷新';
      refresh.addEventListener('click', () => this._loadMarket());
      toolbar.appendChild(refresh);
      body.appendChild(toolbar);

      const { rows } = mergeMarketView(this._registry.getAll(), this._marketData.plugins || [], {
        zmodVersion: ZMOD_VERSION
      });
      if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'zmod-mgr-empty';
        empty.textContent = '市场暂无插件。可稍后点「刷新」重试，或从下方 URL 安装。';
        body.appendChild(empty);
      }
      for (const r of rows) {
        body.appendChild(this._buildMarketRow(r));
        if (this._confirmInstallFor === r.id && r.state === 'not-installed' && r.permissions.length) {
          body.appendChild(this._buildInstallConfirm(r));
        }
      }
      body.appendChild(this._buildUrlInstallBox());
    }

    _buildMarketRow(r) {
      const row = document.createElement('div');
      row.className = 'zmod-mgr-row';

      const info = document.createElement('div');
      info.className = 'zmod-mgr-row-info';
      info.innerHTML = `<div class="zmod-mgr-row-name">${escapeHtml(r.name)}<span class="zmod-mgr-ver">v${escapeHtml(
        r.version || '?'
      )}</span>${r.category ? `<span class="zmod-mgr-ver">${escapeHtml(r.category)}</span>` : ''}</div>`;
      if (r.description) {
        const desc = document.createElement('div');
        desc.className = 'zmod-mgr-row-desc';
        desc.textContent = r.description;
        info.appendChild(desc);
      }
      for (const p of r.permissions) {
        const tag = document.createElement('span');
        tag.className = 'zmod-mgr-tag';
        tag.textContent = p;
        info.appendChild(tag);
      }
      if (!r.engineOk) {
        const warn = document.createElement('div');
        warn.className = 'zmod-mgr-engine';
        warn.textContent = r.engineReason || '引擎不兼容';
        info.appendChild(warn);
      }
      row.appendChild(info);

      if (r.state === 'installed') {
        const ver = document.createElement('span');
        ver.className = 'zmod-mgr-ver';
        ver.textContent = `已装 v${r.installedVersion || '?'}`;
        row.appendChild(ver);
      } else {
        const btn = document.createElement('button');
        btn.className = 'zmod-mgr-gear';
        btn.textContent =
          r.state === 'update-available'
            ? `更新 v${r.installedVersion || '?'}→v${r.version || '?'}`
            : '安装';
        if (!r.engineOk) {
          // 引擎不兼容：禁用并悬浮说明，主进程侧仍有硬校验兜底
          btn.disabled = true;
          btn.title = r.engineReason || '引擎不兼容';
          btn.style.cssText = 'opacity:.45;cursor:not-allowed;';
        } else {
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
              if (r.state === 'update-available') await this._updateFromMarket(r);
              else if (r.permissions.length) {
                // 声明了权限：先内联确认再安装
                this._confirmInstallFor = this._confirmInstallFor === r.id ? null : r.id;
                this._render();
              } else {
                await this._installRegistry(r);
              }
            } finally {
              btn.disabled = false;
            }
          });
        }
        row.appendChild(btn);
      }
      return row;
    }

    /** 权限声明确认条（安装前）。 */
    _buildInstallConfirm(r) {
      const bar = document.createElement('div');
      bar.className = 'zmod-mgr-confirm';
      const text = document.createElement('span');
      text.className = 'zmod-mgr-confirm-text';
      text.textContent = `该插件声明权限：${r.permissions.join('、')}`;
      bar.appendChild(text);
      const cancel = document.createElement('button');
      cancel.className = 'zmod-mgr-btn';
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => {
        this._confirmInstallFor = null;
        this._render();
      });
      bar.appendChild(cancel);
      const go = document.createElement('button');
      go.className = 'zmod-mgr-btn';
      go.textContent = '继续安装';
      go.addEventListener('click', async () => {
        go.disabled = true;
        this._confirmInstallFor = null;
        await this._installRegistry(r);
      });
      bar.appendChild(go);
      return bar;
    }

    async _installRegistry(r) {
      try {
        const res = await api.invoke('plugin.install', { source: 'registry:' + r.id });
        if (res && res.ok) {
          this._ui.showToast(`已安装 ${r.name}${res.version ? ` v${res.version}` : ''}`, 'success');
        } else {
          this._ui.showToast((res && res.error) || '安装失败', 'error');
        }
      } catch (err) {
        this._ui.showToast(`安装失败：${err?.message || err}`, 'error');
      }
      // 安装/更新成功走 plugin-changed 广播自动刷新；失败也要重绘回按钮态
      if (this._tab === 'market') this._loadMarket();
      else this._render();
    }

    async _updateFromMarket(r) {
      try {
        const res = await api.invoke('plugin.update', { id: r.id });
        if (res && res.ok) {
          this._ui.showToast(
            res.updated ? `已更新 ${r.name} 到 v${res.version || r.version}` : '已是最新版本',
            'success'
          );
        } else {
          this._ui.showToast((res && res.error) || '更新失败', 'error');
        }
      } catch (err) {
        this._ui.showToast(`更新失败：${err?.message || err}`, 'error');
      }
      if (this._tab === 'market') this._loadMarket();
      else this._render();
    }

    /**
     * URL 安装输入解析：委托给 market-view.js 的 normalizeInstallUrl。
     */
    _normalizeSourceUrl(raw) {
      return normalizeInstallUrl(raw);
    }

    _buildUrlInstallBox() {
      const box = document.createElement('div');
      box.className = 'zmod-mgr-urlbox';

      const rowEl = document.createElement('div');
      rowEl.className = 'zmod-mgr-urlrow';
      const input = document.createElement('input');
      input.className = 'zmod-mgr-input';
      input.placeholder = 'https://github.com/user/repo 或 https://…/plugin.zip';
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') installBtn.click();
      });
      const installBtn = document.createElement('button');
      installBtn.className = 'zmod-mgr-btn';
      installBtn.textContent = '安装';
      installBtn.addEventListener('click', async () => {
        const norm = this._normalizeSourceUrl(input.value);
        if (norm.error) {
          this._ui.showToast(norm.error, 'warn');
          return;
        }
        installBtn.disabled = true;
        try {
          const res = await api.invoke('plugin.install', { source: norm.source });
          if (res && res.ok) {
            this._ui.showToast(`已安装 ${res.id}${res.version ? ` v${res.version}` : ''}`, 'success');
            input.value = '';
          } else {
            this._ui.showToast((res && res.error) || '安装失败', 'error');
          }
        } catch (err) {
          this._ui.showToast(`安装失败：${err?.message || err}`, 'error');
        } finally {
          installBtn.disabled = false;
        }
      });
      rowEl.appendChild(input);
      rowEl.appendChild(installBtn);
      box.appendChild(rowEl);

      const warn = document.createElement('div');
      warn.className = 'zmod-mgr-row-desc';
      warn.textContent = '第三方来源，请仅安装你信任的插件';
      box.appendChild(warn);
      return box;
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
        },
        async (actionKey) => {
          const action = def.actions?.[actionKey];
          const active = this._registry._active.get(id);
          if (!action) return;
          if (!active) {
            ui.showToast('请先启用该插件再执行操作', 'warn');
            return;
          }
          try {
            const res = await action.run(active.ctx);
            if (res && res.message) ui.showToast(res.message, res.ok === false ? 'warn' : 'success');
            else if (res?.ok) ui.showToast('完成', 'success');
          } catch (err) {
            ui.showToast(`执行失败：${err?.message || err}`, 'error');
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
  const dataSourceRegistry = new DataSourceRegistry({
    invoke: (method, params) => api.invoke(method, params),
    emit: (event, payload) => events.emit(event, payload),
    on: (event, fn) => events.on(event, fn)
  });
  // Datasource providers ship with the base kernel (former official-providers
  // and account-quota plugins); register them before any plugin loads.
  registerBuiltinProviders(dataSourceRegistry);
  // Config/vault hot reload pushed by the main process: refresh datasource
  // instances and let the settings page re-render if it is open.
  if (typeof api.on === 'function') {
    api.on('zmod:config-changed', () => {
      dataSourceRegistry.reload().catch(() => {});
      events.emit('zmod:config-changed');
    });
  }

  // Main-process plugin install/remove/update broadcast → hot load/unload/reload
  // in the running client, no restart needed. Each broadcast carries a fresh
  // entryUrl (?v=version-mtime) so dynamic import() bypasses the module cache.
  if (typeof api.on === 'function') {
    api.on('zmod:plugin-changed', (payload) => {
      applyPluginChange(payload, {
        registry: plugins,
        invoke: (method, params) => api.invoke(method, params),
        importModule: (url) => import(url),
        getConfig: () => api.invoke('config.get', {}),
        onError: (err) => {
          console.error('[ZMod:Renderer] plugin change apply failed:', err);
          ui.showToast('插件装载失败,详见控制台', 'error');
        }
      }).then((r) => {
        if (!r.applied) return;
        // 已装 tab 直接重绘；市场 tab 需重拉 listRemote 才能反映行状态
        // （update-available → installed），_loadMarket 幂等且自带 loading 态
        if (panel._tab === 'market') panel._loadMarket();
        else panel.refresh();
        // 设置页是插件管理主入口：已装插件管理区同样跟随广播存活刷新
        settingsPage.refresh();
      });
    });
  }

  const plugins = new PluginRegistry(events, ui);
  const settingsPage = createSettingsPageIntegration({
    api,
    events,
    registry: plugins,
    datasources: dataSourceRegistry,
    ui,
    zmodVersion: ZMOD_VERSION
  });

  const panel = new ManagerPanel(events, plugins, ui);

  window.ZMod = {
    version: ZMOD_VERSION,
    events,
    ui,
    plugins,
    api,
    datasources: dataSourceRegistry,
    settingsPage,
    openManager: (tab) => panel.open(tab)
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

  const reloadKeys = (e) => {
    const isCtrl = e.ctrlKey || e.metaKey;
    const isR = e.key === 'r' || e.key === 'R';
    const isF5 = e.key === 'F5';
    if ((isCtrl && isR) || isF5) {
      e.preventDefault();
      e.stopPropagation();
      api.invoke('window.reload', {}).catch(() => {
        try { location.reload(); } catch {}
      });
    }
  };
  document.addEventListener('keydown', reloadKeys, true);

  const boot = () => {
    console.log(`[ZMod:Renderer] microkernel v${ZMOD_VERSION} loaded (${api.transport})`);
    dataSourceRegistry.load().catch(() => {});
    settingsPage.start();
    plugins.loadAll();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
