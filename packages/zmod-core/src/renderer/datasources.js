/**
 * ZMod DataSource Registry (renderer side, DOM-free).
 *
 * Providers are contributed by the base kernel (see builtin-providers.js) and
 * by plugins via the forPlugin() facade; instances
 * are user configuration stored in config.json with secrets split into the
 * vault. Consumers (balance cards, whale widget, ...) share one cache layer
 * so a single upstream request fans out to every view.
 *
 * Normalized status shape returned by provider.fetchStatus:
 *   { ok: boolean, message?: string, balance?: string, currency?: string,
 *     rows?: Array<{ label: string, value: string, hint?: string }>, ts: number }
 */

export const DEFAULT_TTL_MS = 60_000;

export class DataSourceRegistry {
  /**
   * @param {{ invoke: (method: string, params?: object) => Promise<any>, emit: (event: string, payload?: any) => void }} deps
   */
  constructor(deps) {
    this._invoke = deps.invoke;
    this._emit = deps.emit;
    this._busOn = typeof deps.on === 'function' ? deps.on : null;
    this._providers = new Map(); // type -> provider def
    this._instances = [];
    this._cache = new Map(); // instanceId -> { status, ts, inflight }
    this._loaded = false;
    this._subscribers = new Set();
  }

  /* ---------------- providers ---------------- */

  registerProvider(def) {
    if (!def || typeof def.type !== 'string' || !def.type) return false;
    if (typeof def.fetchStatus !== 'function') return false;
    this._providers.set(def.type, {
      type: def.type,
      label: def.label || def.type,
      description: def.description || '',
      settings: def.settings && typeof def.settings === 'object' ? def.settings : {},
      test: typeof def.test === 'function' ? def.test : null,
      fetchStatus: def.fetchStatus
    });
    this._notify();
    return true;
  }

  getProviders() {
    return [...this._providers.values()].map(({ fetchStatus, ...rest }) => rest);
  }

  getProvider(type) {
    return this._providers.get(type) || null;
  }

  /* ---------------- instances ---------------- */

  async load({ force = false } = {}) {
    if (this._loaded && !force) return this._instances;
    try {
      const list = await this._invoke('datasource.list', {});
      this._instances = Array.isArray(list) ? list : [];
    } catch (err) {
      console.error('[ZMod:DataSources] load failed:', err?.message || err);
      this._instances = [];
    }
    this._loaded = true;
    return this._instances;
  }

  /**
   * Hot path for "zmod:config-changed": refetch instances and fan the change
   * out to subscribers (settings page, balance cards) without a reload.
   */
  async reload() {
    const before = JSON.stringify(this.getInstances());
    await this.load({ force: true });
    if (JSON.stringify(this.getInstances()) !== before) this._notify();
    this._emit('datasource:changed');
    return this._instances;
  }

  getInstances() {
    return [...this._instances];
  }

  getInstance(id) {
    return this._instances.find((d) => d.id === id) || null;
  }

  /**
   * Persist an instance. Secret-typed settings (per the provider schema) are
   * stripped here and written to the vault under `ds:<id>:<key>`; config.json
   * only ever keeps the non-sensitive remainder.
   */
  async saveInstance(input) {
    const type = input?.type;
    const provider = this.getProvider(type);
    if (!provider) throw new Error(`Unknown data source type "${type}"`);
    const secrets = [];
    const plainSettings = {};
    for (const [key, value] of Object.entries(input.settings || {})) {
      if (provider.settings[key]?.type === 'secret') {
        if (typeof value === 'string' && value) secrets.push([key, value]);
      } else {
        plainSettings[key] = value;
      }
    }
    const existingId = typeof input.id === 'string' && input.id ? input.id : null;
    // Resolve the id before vault writes so secrets land under the final key.
    const id =
      existingId ||
      this._nextId(typeof input.name === 'string' && input.name ? input.name : type);
    for (const [key, value] of secrets) {
      await this._invoke('vault.set', { key: `ds:${id}:${key}`, value });
    }
    const saved = await this._invoke('datasource.save', {
      instance: { id, type, name: input.name, settings: plainSettings }
    });
    const idx = this._instances.findIndex((d) => d.id === saved.id);
    if (idx >= 0) this._instances[idx] = saved;
    else this._instances.push(saved);
    this._cache.delete(saved.id);
    this._notify();
    return saved;
  }

  async deleteInstance(id) {
    const inst = this.getInstance(id);
    await this._invoke('datasource.delete', { id });
    // Sweep vault entries this instance owned (ds:<id>:<secret key>).
    const provider = inst ? this.getProvider(inst.type) : null;
    if (provider) {
      for (const [key, def] of Object.entries(provider.settings)) {
        if (def.type === 'secret') {
          await this._invoke('vault.delete', { key: `ds:${id}:${key}` }).catch(() => {});
        }
      }
    }
    this._instances = this._instances.filter((d) => d.id !== id);
    this._cache.delete(id);
    this._notify();
    return true;
  }

  _nextId(name) {
    const base =
      String(name || '')
        .trim()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'ds';
    let candidate = base;
    let n = 2;
    while (this._instances.some((d) => d.id === candidate)) candidate = `${base}-${n++}`;
    return candidate;
  }

  /* ---------------- status (shared cache) ---------------- */

  /**
   * Fetch normalized status for an instance. Cached per instance with TTL;
   * concurrent callers share one in-flight request.
   */
  async getStatus(id, { ttl = DEFAULT_TTL_MS, force = false } = {}) {
    const inst = this.getInstance(id);
    if (!inst) return { ok: false, message: '数据源不存在', ts: Date.now() };
    const provider = this.getProvider(inst.type);
    if (!provider) return { ok: false, message: `未知类型 ${inst.type}`, ts: Date.now() };

    const hit = this._cache.get(id);
    const now = Date.now();
    if (!force && hit && hit.status && now - hit.ts < ttl) return hit.status;
    if (hit?.inflight) return hit.inflight;

    const inflight = (async () => {
      const settings = { ...inst.settings };
      for (const [key, def] of Object.entries(provider.settings)) {
        if (def.type === 'secret') {
          const v = await this._invoke('vault.get', { key: `ds:${id}:${key}` }).catch(() => null);
          if (typeof v === 'string' && v) settings[key] = v;
        }
      }
      let status;
      try {
        status = await provider.fetchStatus(settings, this._providerCtx());
      } catch (err) {
        status = { ok: false, message: String(err?.message || err) };
      }
      const normalized = {
        // pass structured extras (e.g. antigravity models/groups) through —
        // consumers render from them; the explicit keys below stay canonical
        ...(status && typeof status === 'object' ? status : {}),
        ok: Boolean(status?.ok),
        message: status?.message || '',
        balance: status?.balance,
        currency: status?.currency,
        rows: Array.isArray(status?.rows) ? status.rows : [],
        ts: Date.now()
      };
      const slot = this._cache.get(id) || {};
      slot.status = normalized;
      slot.ts = Date.now();
      slot.inflight = null;
      this._cache.set(id, slot);
      this._emit('datasource:status:' + id, normalized);
      return normalized;
    })();

    const slot = this._cache.get(id) || {};
    slot.inflight = inflight;
    this._cache.set(id, slot);
    try {
      return await inflight;
    } catch (err) {
      return { ok: false, message: String(err?.message || err), rows: [], ts: Date.now() };
    }
  }

  /** Test connectivity/credentials without persisting anything. */
  async testInstance(input) {
    const provider = this.getProvider(input?.type);
    if (!provider) return { ok: false, message: `未知类型 ${input?.type}` };
    const settings = { ...input.settings };
    const probeId = input.id || '__test__';
    for (const [key, def] of Object.entries(provider.settings)) {
      if (def.type === 'secret' && !(key in settings)) {
        const v = await this._invoke('vault.get', { key: `ds:${probeId}:${key}` }).catch(() => null);
        if (typeof v === 'string' && v) settings[key] = v;
      }
    }
    const tester = provider.test || provider.fetchStatus;
    try {
      const res = await tester(settings, this._providerCtx());
      return res?.ok !== undefined ? res : { ok: true, message: '连接成功' };
    } catch (err) {
      return { ok: false, message: String(err?.message || err) };
    }
  }

  _providerCtx() {
    return {
      net: {
        fetch: (params) => this._invoke('net.fetch', params)
      },
      secrets: {
        get: (key) => this._invoke('vault.get', { key })
      }
    };
  }

  /* ---------------- per-plugin facade ---------------- */

  /** Scoped API handed to plugins as ctx.datasources. */
  forPlugin() {
    return {
      registerProvider: (def) => this.registerProvider(def),
      getProviders: () => this.getProviders(),
      getInstances: () => this.getInstances(),
      getInstance: (id) => this.getInstance(id),
      getStatus: (id, opts) => this.getStatus(id, opts),
      subscribe: (fn) => this.subscribe(fn),
      onStatus: (id, fn) => this._eventsOn('datasource:status:' + id, fn)
    };
  }

  /** Injected at construction time by the kernel (EventBus.on). */
  _eventsOn(event, fn) {
    if (!this._busOn) return () => {};
    return this._busOn(event, fn);
  }

  /* ---------------- subscriptions ---------------- */

  subscribe(fn) {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  _notify() {
    for (const fn of [...this._subscribers]) {
      try {
        fn(this.getInstances());
      } catch (e) {
        console.error('[ZMod:DataSources] subscriber error:', e);
      }
    }
    this._emit('datasource:changed');
  }
}
