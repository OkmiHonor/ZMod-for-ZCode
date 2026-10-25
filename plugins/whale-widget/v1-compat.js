/**
 * v1 plugin compatibility shim for the whale widget port.
 *
 * Provides the exact surface the v1 whale-widget block consumes:
 *   ZMod.Plugin          — base class: after / injectCSS / registerDOM /
 *                          getSettings / saveSettings / _disposables
 *   ZMod.ui.getPortal    — the global #zmod-mount-portal container
 *   ZMod.ui.subscribeDOMChanges — singleton MutationObserver fan-out
 *   ZMod.registerPlugin  — collector
 *   window.__zmod_whale_skins__ — preload-bridge stand-in (degraded: skins
 *                          dir listing via zmod-local://, no sqlite model probe)
 *
 * Telemetry bridge: v1 hooked window.zcode.reportTelemetryEvent, which is a
 * frozen contextBridge object on v2 hosts. The shim's after() special-cases
 * that method and routes events from the main-process telemetry tap instead,
 * preserving the v1 callback signature fn(thisArg, args).
 */

const PLUGIN_ID = 'whale-widget';
const SETTINGS_KEY = 'zmod_plugins_settings';

export function installV1Compat(ctx) {
  const disposables = [];

  class V1Plugin {
    constructor() {
      this._disposables = [];
    }
    after(obj, method, fn) {
      if (obj === window.zcode && method === 'reportTelemetryEvent') {
        if (!window.zmodAPI?.on) return () => {};
        const off = window.zmodAPI.on('zmod:telemetry-event', (payload) => {
          try {
            fn.call(null, null, [payload]);
          } catch (e) {
            console.error('[whale-v1compat] telemetry callback error:', e);
          }
        });
        this._disposables.push(off);
        return off;
      }
      const orig = obj[method];
      if (typeof orig !== 'function') return () => {};
      obj[method] = function (...args) {
        const res = orig.apply(this, args);
        try {
          fn.call(null, this, args, res);
        } catch (e) {
          console.error('[whale-v1compat] after() callback error:', e);
        }
        return res;
      };
      const un = () => {
        obj[method] = orig;
      };
      this._disposables.push(un);
      return un;
    }
    injectCSS(css) {
      // v1 GM_addStyle semantics: every call ADDS a style element. The kernel's
      // injectStyle replaces by id, which let a later partial stylesheet (the
      // model-map panel's MODELMAP_CSS) wipe the widget's entire main CSS —
      // root sizing/position rules vanished and the widget blew up to content
      // size. Key by content hash: identical css reuses its element, distinct
      // css appends; all elements die with the instance.
      if (!this._styleEls) this._styleEls = new Map();
      let hash = 0;
      for (let i = 0; i < css.length; i++) hash = (hash * 31 + css.charCodeAt(i)) | 0;
      const id = `${PLUGIN_ID}-v1-${(hash >>> 0).toString(36)}`;
      const el = ctx.ui.injectStyle(id, css);
      if (!this._styleEls.has(id)) {
        this._styleEls.set(id, el);
        this._disposables.push(() => {
          try { el.remove(); } catch {}
        });
      }
      return el;
    }
    registerDOM(el) {
      getPortal().appendChild(el);
      this._disposables.push(() => {
        try {
          el.remove();
        } catch {}
      });
    }
    getSettings() {
      try {
        const all = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        return all[PLUGIN_ID] || {};
      } catch {
        return {};
      }
    }
    saveSettings(partial) {
      try {
        const all = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        all[PLUGIN_ID] = Object.assign({}, all[PLUGIN_ID], partial);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(all));
      } catch (e) {
        console.error('[whale-v1compat] saveSettings failed:', e);
      }
    }
  }

  /* ---- ZMod.ui surface ---- */
  const portalId = 'zmod-mount-portal';
  function getPortal() {
    let p = document.getElementById(portalId);
    if (!p) {
      p = document.createElement('div');
      p.id = portalId;
      p.style.cssText = 'position:fixed;left:0;top:0;z-index:999990;pointer-events:none;';
      document.body.appendChild(p);
      disposables.push(() => p.remove());
    }
    return p;
  }

  let domObserver = null;
  const domCallbacks = new Set();
  function subscribeDOMChanges(cb) {
    domCallbacks.add(cb);
    if (!domObserver) {
      domObserver = new MutationObserver((muts) => {
        for (const fn of [...domCallbacks]) {
          try {
            fn(muts);
          } catch (e) {
            console.error('[whale-v1compat] DOM callback error:', e);
          }
        }
      });
      domObserver.observe(document.body, { childList: true, subtree: true });
    }
    return () => {
      domCallbacks.delete(cb);
      if (domCallbacks.size === 0 && domObserver) {
        domObserver.disconnect();
        domObserver = null;
      }
    };
  }

  /* ---- registerPlugin collector ---- */
  const registered = [];
  function registerPlugin(meta, cls) {
    registered.push({ meta, cls });
  }

  /* ---- skins preload-bridge stand-in (degraded) ---- */
  // v1's preload bridge enumerated a local whale-skins directory and probed
  // tasks-index.sqlite for per-session models. On v2, skins ship inside the
  // plugin dir; report them via a generated manifest when present. The model
  // probe degrades to null (whale falls back to telemetry-based detection).
  async function skinsLoad() {
    try {
      // Renderer fetch() cannot load zmod-local:// URLs (Fetch API scheme
      // restriction) — read assets through the main-process RPC instead.
      const idx = await ctx.invoke('plugin.readAsset', {
        pluginId: PLUGIN_ID,
        relPath: 'skins/index.json'
      });
      if (!idx?.ok) return { ok: false, reason: idx?.error || 'no skins manifest' };
      const json = atob(idx.base64);
      const manifest = JSON.parse(json);
      const skins = [];
      for (const sk of manifest.skins || []) {
        const img = await ctx.invoke('plugin.readAsset', {
          pluginId: PLUGIN_ID,
          relPath: `skins/${sk.id}/image.${sk.format}`
        });
        if (!img?.ok) continue;
        skins.push({
          id: sk.id,
          name: sk.name,
          format: sk.format,
          ver: sk.ver,
          pinned: sk.pinned,
          data: `data:image/${sk.format === 'gif' ? 'gif' : 'png'};base64,${img.base64}`
        });
      }
      return { ok: true, dir: 'plugins/whale-widget/skins', skins };
    } catch (e) {
      return { ok: false, reason: String(e?.message || e) };
    }
  }
  window.__zmod_whale_skins__ = {
    load: skinsLoad,
    getModel: async () => null,
    probeTalkModel: async () => null
  };
  disposables.push(() => {
    try {
      delete window.__zmod_whale_skins__;
    } catch {}
  });

  /* ---- mount onto the v2 kernel global (additive keys only) ---- */
  const zmod = window.ZMod;
  const prev = { Plugin: zmod.Plugin, ui: zmod.ui, registerPlugin: zmod.registerPlugin };
  zmod.Plugin = V1Plugin;
  zmod.registerPlugin = registerPlugin;
  zmod.ui = zmod.ui || {};
  const prevPortal = zmod.ui.getPortal;
  const prevSubscribe = zmod.ui.subscribeDOMChanges;
  zmod.ui.getPortal = getPortal;
  zmod.ui.subscribeDOMChanges = subscribeDOMChanges;

  function uninstallV1Compat() {
    zmod.Plugin = prev.Plugin;
    zmod.registerPlugin = prev.registerPlugin;
    if (prevPortal) zmod.ui.getPortal = prevPortal;
    else delete zmod.ui.getPortal;
    if (prevSubscribe) zmod.ui.subscribeDOMChanges = prevSubscribe;
    else delete zmod.ui.subscribeDOMChanges;
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    domCallbacks.clear();
    for (const d of disposables.splice(0)) {
      try {
        d();
      } catch {}
    }
  }

  return { registered, uninstall: uninstallV1Compat };
}
