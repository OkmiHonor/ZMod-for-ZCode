import test from 'node:test';
import assert from 'node:assert/strict';

const {
  jsx,
  jsxs,
  jsxDEV,
  Fragment,
  makeJsxShim,
  filterLoadablePackages,
  buildRequireTable,
  createDshContext,
  createLayoutService,
  createLocaleService,
  createThemeService,
  sortSlots,
  parsePackageSpec,
  resolvePackageMeta,
  DEFAULT_REGISTRIES,
  remapDshResourceUrl,
  DEFAULT_PET_CONFIG,
  fetchMarketRegistry,
  createPetStateManager,
  PRIMARY_MARKET_REGISTRY_URL,
  FALLBACK_MARKET_REGISTRY_URL,
  FALLBACK_CATALOG
} = await import('../../../plugins/dsh-compat/lib.js');

const REACT_ELEMENT = Symbol.for('react.element');

// ---- jsx 垫片 ----

test('jsx: key/ref extraction and props shallow copy incl. children', () => {
  const fn = () => {};
  const children = { $$typeof: REACT_ELEMENT, type: 'span', props: {} };
  const el = jsx('div', { className: 'x', onClick: fn, children }, 'k1');
  assert.equal(el.$$typeof, REACT_ELEMENT);
  assert.equal(el.type, 'div');
  assert.equal(el.key, 'k1', 'maybeKey wins');
  assert.equal(el.ref, null, 'ref defaults to null');
  // 浅拷贝含 children，但不把 key/ref 混进 props
  assert.deepEqual(el.props, { className: 'x', onClick: fn, children });
  assert.equal(el._owner, null);
});

test('jsx: key falls back to config.key, ref picked from config', () => {
  const refObj = { current: null };
  const el = jsx('div', { key: 'ck', ref: refObj, id: 'a' });
  assert.equal(el.key, 'ck');
  assert.equal(el.ref, refObj);
  assert.deepEqual(el.props, { id: 'a' }, 'key/ref never leak into props');

  const el2 = jsx('div', { key: 'ck' }, 'mk');
  assert.equal(el2.key, 'mk', 'explicit maybeKey overrides config.key');

  const el3 = jsx('div', null);
  assert.equal(el3.key, null);
  assert.deepEqual(el3.props, {});
});

test('jsx exports: jsxs/jsxDEV same impl, Fragment = react.fragment symbol', () => {
  assert.equal(jsxs, jsx);
  assert.equal(jsxDEV, jsx);
  assert.equal(Fragment, Symbol.for('react.fragment'));
  const shim = makeJsxShim();
  assert.deepEqual(Object.keys(shim).sort(), ['Fragment', 'jsx', 'jsxDEV', 'jsxs']);
  assert.equal(shim.jsx('i', { a: 1 }).$$typeof, REACT_ELEMENT);
});

// ---- filterLoadablePackages ----

const ENTRY = (name) => ({ name, type: 'dir', size: 0, mtimeMs: 0 });

test('filterLoadablePackages: client-bearing packages kept with resolved clientPath', () => {
  const entries = [ENTRY('dsh-pet'), ENTRY('dsh-whale-widget'), { name: 'readme.txt', type: 'file' }];
  const manifests = {
    'dsh-pet': {
      name: 'dsh-pet',
      version: '0.3.8',
      exports: { './client': { types: './lib/types/client/index.d.ts', default: './lib/client.js' } }
    },
    // exports['./client'] 为字符串的简单形态
    'dsh-whale-widget': {
      name: 'dsh-whale-widget',
      version: '1.0.0',
      exports: { './client': './client/index.js' },
      'dsh': { client: { platform: 'web' } }
    }
  };
  const out = filterLoadablePackages(entries, manifests);
  assert.equal(out.length, 2, '非目录条目不参与');
  const pet = out.find((p) => p.name === 'dsh-pet');
  assert.equal(pet.loadable, true);
  assert.equal(pet.clientPath, 'lib/client.js');
  assert.equal(pet.version, '0.3.8');
  assert.equal(pet.displayName, 'dsh-pet');
  const whale = out.find((p) => p.name === 'dsh-whale-widget');
  assert.equal(whale.loadable, true);
  assert.equal(whale.clientPath, 'client/index.js', '字符串形态直接取');
});

test('filterLoadablePackages: host-only packages skipped with reason', () => {
  const entries = [ENTRY('host-only-pkg'), ENTRY('no-manifest'), ENTRY('dsh-flag-only')];
  const manifests = {
    // 纯宿主半侧：无 exports['./client'] 也无 dsh.client
    'host-only-pkg': { name: 'host-only-pkg', version: '1.0.0', main: 'lib/index.js' },
    // package.json 读取失败 → null
    'no-manifest': null,
    // 仅有 dsh.client 字段：可装载但无脚本路径，由装载阶段跳过
    'dsh-flag-only': { name: 'dsh-flag-only', version: '0.2.0', dsh: { client: { platform: 'web' } } }
  };
  const out = filterLoadablePackages(entries, manifests);
  assert.equal(out.find((p) => p.name === 'host-only-pkg').loadable, false);
  assert.equal(out.find((p) => p.name === 'host-only-pkg').reason, 'no-client-entry');
  assert.equal(out.find((p) => p.name === 'no-manifest').reason, 'no-package-json');
  const flagOnly = out.find((p) => p.name === 'dsh-flag-only');
  assert.equal(flagOnly.loadable, true);
  assert.equal(flagOnly.clientPath, null);
});

test('filterLoadablePackages: empty/missing inputs yield empty result', () => {
  assert.deepEqual(filterLoadablePackages([], {}), []);
  assert.deepEqual(filterLoadablePackages(undefined, null), []);
  assert.deepEqual(filterLoadablePackages([ENTRY('x')], {}), [
    { name: 'x', loadable: false, reason: 'no-package-json' }
  ]);
});

// ---- buildRequireTable ----

test('buildRequireTable: react seed modules resolve, unknown throws', () => {
  const React = { useState() {} };
  const ReactDOM = { createRoot() {}, hydrateRoot() {} };
  const stubs = { '@deepseek-ai/dsh-client-ui-primitives': { IconFoo: 'icon' } };
  const require = buildRequireTable(React, ReactDOM, stubs);

  assert.equal(require('react'), React);
  assert.equal(require('react-dom'), ReactDOM);
  const client = require('react-dom/client');
  assert.equal(client.createRoot, ReactDOM.createRoot);
  assert.equal(client.hydrateRoot, ReactDOM.hydrateRoot);

  // jsx 垫片挂在 runtime 与 dev-runtime 两个说明符上
  const shim = require('react/jsx-runtime');
  assert.equal(shim.jsx('div', {}).type, 'div');
  assert.equal(require('react/jsx-dev-runtime').jsx, shim.jsx);

  assert.equal(require('@deepseek-ai/dsh-client-ui-primitives').IconFoo, 'icon', 'stubs 命中');

  assert.throws(() => require('@deepseek-ai/cordis'), {
    name: 'Error',
    message: '[dsh-compat] 未提供的模块: @deepseek-ai/cordis'
  });
  assert.throws(() => require('react-dom/server'), {
    message: '[dsh-compat] 未提供的模块: react-dom/server'
  });
});

// ---- createDshContext ----

test('createDshContext: effect runs immediately and registers LIFO cleanups', () => {
  const calls = [];
  const cleanups = [];
  const ctx = createDshContext({}, cleanups);

  ctx.effect(() => {
    calls.push('first');
    return () => calls.push('cleanup:first');
  }, 'first');
  ctx.effect(() => calls.push('second'), 'second'); // 返回 undefined → 不登记清理
  ctx.effect(() => {
    calls.push('third');
    return () => calls.push('cleanup:third');
  });

  assert.deepEqual(calls, ['first', 'second', 'third'], 'effect 立即执行');
  assert.equal(cleanups.length, 2);

  // LIFO：调用方从尾部 pop
  cleanups.pop()();
  cleanups.pop()();
  assert.deepEqual(calls, ['first', 'second', 'third', 'cleanup:third', 'cleanup:first']);
});

test('createDshContext: provide writes into services bag, get reads it', () => {
  const services = {};
  const ctx = createDshContext(services, []);
  ctx.provide('petApi7340', { pose: () => 'pose' });
  assert.equal(services.petApi7340.pose(), 'pose');
  assert.equal(ctx.get('petApi7340').pose(), 'pose');
  assert.equal(ctx.get('missing'), undefined);
  // 服务注入由调用方负责：ctx 构造本身不挂任何同名属性
  assert.equal(ctx.slots, undefined);
  assert.equal(ctx.locale, undefined);
});

// ---- sortSlots ----

test('sortSlots: ascending by meta.order, stable, missing order = 0', () => {
  const mk = (id, order) => ({ meta: { id, ...(order === undefined ? {} : { order }) }, render: () => null });
  const a = mk('a', 30);
  const b = mk('b', 1000);
  const c = mk('c'); // 缺省 0
  const d = mk('d', 0);
  const e = mk('e', -5);
  const out = sortSlots([b, a, c, d, e]);
  assert.deepEqual(
    out.map((r) => r.meta.id),
    ['e', 'c', 'd', 'a', 'b'],
    'order 升序，同序值保持原相对顺序（c 在 d 前）'
  );
  // 稳定性：相同 order 不打乱输入顺序
  const x1 = mk('x1', 100);
  const x2 = mk('x2', 100);
  const x3 = mk('x3', 100);
  assert.deepEqual(
    sortSlots([x3, x1, x2]).map((r) => r.meta.id),
    ['x3', 'x1', 'x2']
  );
  // 空输入与缺省
  assert.deepEqual(sortSlots([]), []);
  assert.deepEqual(sortSlots(undefined), []);
});

// ---- parsePackageSpec ----

test('parsePackageSpec: parses bare name, version tag, scoped package, and tarball url', () => {
  assert.deepEqual(parsePackageSpec('dsh-pet'), {
    isUrl: false,
    name: 'dsh-pet',
    version: 'latest'
  });

  assert.deepEqual(parsePackageSpec('dsh-whale-widget@0.3.18'), {
    isUrl: false,
    name: 'dsh-whale-widget',
    version: '0.3.18'
  });

  assert.deepEqual(parsePackageSpec('@deepseek-ai/dsh-pet@^0.3.0'), {
    isUrl: false,
    name: '@deepseek-ai/dsh-pet',
    version: '^0.3.0'
  });

  assert.deepEqual(
    parsePackageSpec('https://registry.npmmirror.com/dsh-pet/-/dsh-pet-0.3.8.tgz'),
    {
      isUrl: true,
      name: 'dsh-pet',
      version: '',
      url: 'https://registry.npmmirror.com/dsh-pet/-/dsh-pet-0.3.8.tgz'
    }
  );

  assert.equal(parsePackageSpec(''), null);
  assert.equal(parsePackageSpec('   '), null);
  assert.equal(parsePackageSpec(null), null);
});

// ---- resolvePackageMeta ----

test('resolvePackageMeta: fetches registry json and resolves latest/exact tarball and client flag', async () => {
  const fakeRegistry = {
    name: 'dsh-test-plugin',
    description: 'A test dsh plugin',
    'dist-tags': { latest: '1.2.0' },
    versions: {
      '1.0.0': {
        name: 'dsh-test-plugin',
        version: '1.0.0',
        dist: { tarball: 'https://registry.npmjs.org/dsh-test-plugin/-/dsh-test-plugin-1.0.0.tgz' },
        exports: { './client': './lib/client.js' }
      },
      '1.2.0': {
        name: 'dsh-test-plugin',
        version: '1.2.0',
        dist: { tarball: 'https://registry.npmjs.org/dsh-test-plugin/-/dsh-test-plugin-1.2.0.tgz' },
        dsh: { client: { platform: 'web' } }
      }
    }
  };

  const mockFetch = async (url) => {
    if (url.includes('missing-pkg')) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      json: async () => fakeRegistry
    };
  };

  // latest
  const metaLatest = await resolvePackageMeta(
    { isUrl: false, name: 'dsh-test-plugin', version: 'latest' },
    DEFAULT_REGISTRIES.npmmirror.url,
    mockFetch
  );
  assert.equal(metaLatest.name, 'dsh-test-plugin');
  assert.equal(metaLatest.version, '1.2.0');
  assert.equal(metaLatest.tarballUrl, 'https://registry.npmjs.org/dsh-test-plugin/-/dsh-test-plugin-1.2.0.tgz');
  assert.equal(metaLatest.hasClient, true);

  // exact version 1.0.0
  const metaExact = await resolvePackageMeta(
    { isUrl: false, name: 'dsh-test-plugin', version: '1.0.0' },
    DEFAULT_REGISTRIES.npmmirror.url,
    mockFetch
  );
  assert.equal(metaExact.version, '1.0.0');

  // direct url
  const metaUrl = await resolvePackageMeta(
    { isUrl: true, name: 'direct-pkg', version: '', url: 'https://example.com/direct-pkg.tgz' },
    DEFAULT_REGISTRIES.npmmirror.url,
    mockFetch
  );
  assert.equal(metaUrl.name, 'direct-pkg');
  assert.equal(metaUrl.tarballUrl, 'https://example.com/direct-pkg.tgz');

  // missing package throws
  await assert.rejects(
    () =>
      resolvePackageMeta(
        { isUrl: false, name: 'missing-pkg', version: 'latest' },
        DEFAULT_REGISTRIES.npmmirror.url,
        mockFetch
      ),
    /未能找到包 missing-pkg/
  );
});

// ---- remapDshResourceUrl & DEFAULT_PET_CONFIG ----

test('remapDshResourceUrl: correctly remaps thumb, pic, font and leaves other urls untouched', () => {
  const thumb = '/dsh-pet-7340/thumb/main/%E5%8E%9F%E5%9C%B0%E4%B8%93%E5%BF%83%E7%8E%A9%E9%AD%94%E6%96%B9.webm';
  assert.equal(
    remapDshResourceUrl(thumb),
    'zmod-local://plugins/dsh-compat/dsh-plugins/dsh-pet/assets/webm/%E5%8E%9F%E5%9C%B0%E4%B8%93%E5%BF%83%E7%8E%A9%E9%AD%94%E6%96%B9.webm'
  );

  const pic = '/dsh-pet-7340/pic/cursor-grab.png';
  assert.equal(
    remapDshResourceUrl(pic),
    'zmod-local://plugins/dsh-compat/dsh-plugins/dsh-pet/assets/pic/cursor-grab.png'
  );

  const font = '/dsh-pet-7340/font/candy.ttf';
  assert.equal(
    remapDshResourceUrl(font),
    'zmod-local://plugins/dsh-compat/dsh-plugins/dsh-pet/assets/fonts/candy.ttf'
  );

  const other = 'https://registry.npmjs.org/dsh-pet';
  assert.equal(remapDshResourceUrl(other), other);
  assert.equal(remapDshResourceUrl(null), null);

  assert.equal(DEFAULT_PET_CONFIG.pets.length, 1);
  assert.equal(DEFAULT_PET_CONFIG.pets[0].id, 'main');
});

test('PluginRegistry contract: getPlugin and getActive return registered/active instances', () => {
  class MockPluginRegistry {
    constructor() {
      this._plugins = new Map();
      this._active = new Map();
    }
    register(def) {
      this._plugins.set(def.id, def);
    }
    getAll() {
      return [...this._plugins.values()];
    }
    getPlugin(id) {
      return this._plugins.get(id) || null;
    }
    isActive(id) {
      return this._active.has(id);
    }
    getActive(id) {
      return this._active.get(id) || null;
    }
  }

  const reg = new MockPluginRegistry();
  const dshDef = { id: 'dsh-compat', name: 'DSH 插件兼容层', renderSettings: () => {} };
  reg.register(dshDef);

  assert.equal(reg.getPlugin('dsh-compat'), dshDef);
  assert.equal(reg.getPlugin('non-existent'), null);
  assert.equal(reg.isActive('dsh-compat'), false);
  assert.equal(reg.getActive('dsh-compat'), null);

  reg._active.set('dsh-compat', { def: dshDef, ctx: { id: 'dsh-compat' } });
  assert.equal(reg.isActive('dsh-compat'), true);
  assert.deepEqual(reg.getActive('dsh-compat'), { def: dshDef, ctx: { id: 'dsh-compat' } });
});

// ---- createLayoutService, createLocaleService, createThemeService ----

test('createLayoutService: manages activePanelId and notifies subscribers', () => {
  const layout = createLayoutService(null);
  assert.equal(layout.panelInfo.getSnapshot().activePanelId, null);
  assert.equal(layout.getActivePanelId(), null);

  let notified = 0;
  const unsub = layout.panelInfo.subscribe(() => {
    notified++;
  });

  layout.selectPanel('dsh-market');
  assert.equal(layout.panelInfo.getSnapshot().activePanelId, 'dsh-market');
  assert.equal(layout.getActivePanelId(), 'dsh-market');
  assert.equal(notified, 1);

  layout.selectPanel(null);
  assert.equal(layout.panelInfo.getSnapshot().activePanelId, null);
  assert.equal(notified, 2);

  unsub();
  layout.selectPanel('another-panel');
  assert.equal(notified, 2, 'unsubscribed listener does not get called');
});

test('createLocaleService: provides reactive snapshot and dictionary binding', () => {
  const locale = createLocaleService('zh');
  assert.deepEqual(locale.getSnapshot(), { active: 'zh' });

  locale.register('dsh-market', {
    zh: { nav: '插件市场', count: '共 {num} 个插件' },
    en: { nav: 'Market', count: '{num} plugins total' }
  });

  const t = locale.bind('dsh-market');
  assert.equal(t('nav'), '插件市场');
  assert.equal(t('count', { num: 42 }), '共 42 个插件');
  assert.equal(t('unknown.key'), 'unknown.key');

  let notified = 0;
  locale.subscribe(() => notified++);

  locale.setLanguage('en');
  assert.deepEqual(locale.getSnapshot(), { active: 'en' });
  assert.equal(notified, 1);
  assert.equal(t('nav'), 'Market');
  assert.equal(t('count', { num: 42 }), '42 plugins total');
});

test('createThemeService: manages theme and dispatches events', () => {
  const theme = createThemeService('dark');
  // 契约：getTheme/getSnapshot 返回宿主主题注册表快照对象；ZMod 无注册表 → null 诚实降级
  // （dshmarket 以 themeSnap !== null 门控「主题」页签；返回字符串会让 themeSnap.themes
  //  为 undefined → .filter 崩溃）
  assert.equal(theme.getTheme(), null);
  assert.equal(theme.getSnapshot(), null);

  let onCalls = 0;
  let subCalls = 0;
  const offOn = theme.on('theme/change', () => onCalls++);
  const offSub = theme.subscribe(() => subCalls++);

  theme.setTheme('light');
  assert.equal(onCalls, 1);
  assert.equal(subCalls, 1);

  // 快照稳定性：null 恒定引用（useSyncExternalStore Object.is 契约）
  assert.equal(theme.getTheme(), theme.getTheme());

  offOn();
  offSub();
  theme.setTheme('dark');
  assert.equal(onCalls, 1);
  assert.equal(subCalls, 1);
});

// ---- createPetStateManager (long-polling 挂起与状态变更) ----

test('createPetStateManager: 初始无 since 时立即返回 counter 与空分区', async () => {
  const mgr = createPetStateManager(1);
  const start = Date.now();
  const res = await mgr.handleStateRequest('/dsh-pet-7340/state');
  const elapsed = Date.now() - start;

  assert.equal(res.counter, 1);
  assert.deepEqual(res.sections, {});
  assert.deepEqual(res.pets, {});
  assert.ok(elapsed < 100, `无 since 应在 100ms 内同步返回，耗时 ${elapsed}ms`);
  mgr.destroy();
});

test('createPetStateManager: 带 since 且当前无更新时挂起，notifyChange 立即唤醒并递增 counter', async () => {
  const mgr = createPetStateManager(1);
  let resolved = false;

  const reqPromise = mgr.handleStateRequest('/dsh-pet-7340/state?since=1&timeout=2000').then((data) => {
    resolved = true;
    return data;
  });

  // 短暂等待，确保请求已挂起且未返回
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolved, false, '带 since=1 的请求应处于挂起等待状态，绝不能 0ms 同步返回');

  // 触发状态变更通知
  mgr.notifyChange();

  const res = await reqPromise;
  assert.equal(resolved, true);
  assert.equal(res.counter, 2, '唤醒后 counter 应递增至 2');
  assert.equal(mgr.getCounter(), 2);
  mgr.destroy();
});

test('createPetStateManager: since 小于当前 counter 时（客户端落后）立即返回最新 counter', async () => {
  const mgr = createPetStateManager(5);
  const start = Date.now();
  const res = await mgr.handleStateRequest('/dsh-pet-7340/state?since=3&timeout=2000');
  const elapsed = Date.now() - start;

  assert.equal(res.counter, 5);
  assert.ok(elapsed < 100, `客户端落后应立即返回，耗时 ${elapsed}ms`);
  mgr.destroy();
});

test('createPetStateManager: timeout 超时自动返回当前 counter', async () => {
  const mgr = createPetStateManager(1);
  const start = Date.now();
  // 设置 1000ms（合法的最小有效 timeout）
  const res = await mgr.handleStateRequest('/dsh-pet-7340/state?since=1&timeout=1000');
  const elapsed = Date.now() - start;

  assert.equal(res.counter, 1);
  assert.ok(elapsed >= 950, `应至少挂起 ~1000ms，实际耗时 ${elapsed}ms`);
  mgr.destroy();
});

test('createPetStateManager: AbortSignal 取消时立即结束挂起', async () => {
  const mgr = createPetStateManager(1);
  const ac = new AbortController();
  const start = Date.now();

  setTimeout(() => ac.abort(), 60);

  const res = await mgr.handleStateRequest('/dsh-pet-7340/state?since=1&timeout=5000', { signal: ac.signal });
  const elapsed = Date.now() - start;

  assert.equal(res.counter, 1);
  assert.ok(elapsed < 500, `abort 后应快速返回，实际耗时 ${elapsed}ms`);
  mgr.destroy();
});

// ---- fetchMarketRegistry (远端拉取、缓存 TTL、304 与容灾降级) ----

test('fetchMarketRegistry: 首次成功拉取远端数据并建立内存缓存', async () => {
  const mockRemoteData = {
    name: 'awesome-dsh-plugin',
    updated: '2026-10-30',
    count: 2,
    categories: { test: { zh: '测试' } },
    plugins: [{ name: 'test-plugin', version: '1.0.0' }, { name: 'test-plugin-2', version: '2.0.0' }]
  };

  const cache = { memoryCache: null, etag: null, lastModified: null, fetchTime: 0 };
  let fetchCalls = 0;

  const mockFetch = async (url) => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      headers: {
        get: (h) => (h === 'etag' ? '"etag-123"' : h === 'last-modified' ? 'Fri, 30 Oct 2026 00:00:00 GMT' : null)
      },
      json: async () => mockRemoteData
    };
  };

  const res = await fetchMarketRegistry({
    fetchImpl: mockFetch,
    cacheState: cache,
    urls: ['https://mock.primary.com/plugins.json']
  });

  assert.equal(res.hostVersion, '1.0.0');
  assert.equal(res.registry.count, 2);
  assert.equal(res.registry.plugins.length, 2);
  assert.equal(cache.etag, '"etag-123"');
  assert.equal(cache.lastModified, 'Fri, 30 Oct 2026 00:00:00 GMT');
  assert.equal(fetchCalls, 1);

  // 10 分钟内再次拉取（非 force）：直接走缓存，不发起任何网络请求
  const cachedRes = await fetchMarketRegistry({
    fetchImpl: mockFetch,
    cacheState: cache,
    urls: ['https://mock.primary.com/plugins.json']
  });
  assert.equal(cachedRes.fromCache, true);
  assert.equal(fetchCalls, 1, '命中缓存时不应发起网络请求');
});

test('fetchMarketRegistry: force=true 时发起条件请求，304 时复用已有缓存', async () => {
  const cachedData = {
    name: 'awesome-dsh-plugin',
    count: 1,
    plugins: [{ name: 'cached-p', version: '1.0.0' }]
  };
  const cache = {
    memoryCache: cachedData,
    etag: '"etag-aaa"',
    lastModified: 'Thu, 29 Oct 2026 00:00:00 GMT',
    fetchTime: Date.now()
  };

  let receivedHeaders = null;
  const mockFetch = async (url, opts) => {
    receivedHeaders = opts.headers;
    return {
      ok: false,
      status: 304,
      headers: { get: () => null }
    };
  };

  const res = await fetchMarketRegistry({
    force: true,
    fetchImpl: mockFetch,
    cacheState: cache,
    urls: ['https://mock.primary.com/plugins.json']
  });

  assert.equal(receivedHeaders['If-None-Match'], '"etag-aaa"');
  assert.equal(receivedHeaders['If-Modified-Since'], 'Thu, 29 Oct 2026 00:00:00 GMT');
  assert.equal(res.notModified, true);
  assert.equal(res.registry.plugins[0].name, 'cached-p');
});

test('fetchMarketRegistry: 首选源失败时自动尝试备用源', async () => {
  const fallbackData = {
    name: 'awesome-dsh-plugin',
    count: 3,
    plugins: [{ name: 'from-fallback', version: '1.0.0' }]
  };

  const calledUrls = [];
  const mockFetch = async (url) => {
    calledUrls.push(url);
    if (url.includes('primary')) {
      throw new Error('Primary connection timeout');
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => fallbackData
    };
  };

  const res = await fetchMarketRegistry({
    force: true,
    fetchImpl: mockFetch,
    urls: ['https://mock.primary.com/plugins.json', 'https://mock.fallback.com/plugins.json']
  });

  assert.equal(calledUrls.length, 2);
  assert.equal(res.registry.plugins[0].name, 'from-fallback');
});

test('fetchMarketRegistry: 全部网络失败时优雅降级（已有缓存 > 内置兜底）', async () => {
  const failingFetch = async () => {
    throw new Error('Network offline');
  };

  // 1. 已有缓存时降级返回缓存
  const oldCache = {
    memoryCache: { name: 'cached-offline', count: 1, plugins: [{ name: 'old-plugin' }] },
    etag: null,
    lastModified: null,
    fetchTime: 0
  };
  const res1 = await fetchMarketRegistry({
    force: true,
    fetchImpl: failingFetch,
    cacheState: oldCache,
    urls: ['https://mock.fail.com/plugins.json']
  });
  assert.equal(res1.degraded, true);
  assert.equal(res1.registry.name, 'cached-offline');

  // 2. 首次完全离线且无缓存时，降级使用内置兜底列表
  const emptyCache = { memoryCache: null, etag: null, lastModified: null, fetchTime: 0 };
  const res2 = await fetchMarketRegistry({
    force: true,
    fetchImpl: failingFetch,
    cacheState: emptyCache,
    urls: ['https://mock.fail.com/plugins.json']
  });
  assert.equal(res2.fallback, true);
  assert.equal(res2.registry.count, 6);
  assert.ok(res2.registry.plugins.some((p) => p.name === 'dsh-pet'));
});

test('fetchMarketRegistry: 持久化水合的真实缓存在远端全失败时不会被兜底覆盖', async () => {
  const failingFetch = async () => {
    throw new Error('Network offline');
  };

  // 模拟 index.js 启动时从 marketCatalogPersist 水合出的 cacheState
  const persistedReal = {
    name: 'awesome-dsh-plugin',
    updated: '2026-10-30',
    count: 7924,
    plugins: Array.from({ length: 7924 }, (_, i) => ({ name: `plugin-${i}`, version: '1.0.0' }))
  };
  const hydratedCache = {
    memoryCache: persistedReal,
    etag: 'W/"abc"',
    lastModified: 'Fri, 30 Oct 2026 04:29:48 GMT',
    fetchTime: 1000
  };

  const res = await fetchMarketRegistry({
    force: true,
    fetchImpl: failingFetch,
    cacheState: hydratedCache,
    urls: ['https://mock.fail.com/plugins.json']
  });
  assert.equal(res.degraded, true);
  assert.notEqual(res.fallback, true);
  assert.equal(res.registry.count, 7924);
  assert.equal(res.registry.plugins.length, 7924);
});

test('fetchMarketRegistry: 响应头到达但正文停滞时看门狗介入，不再永久挂起', async () => {
  // 模拟经典病态：头秒到（ok、headers），正文只发一块就永久停滞
  const stallingFetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"name":"partial"'));
        // 不 close、不再 enqueue —— 正文停滞
      }
    })
  });

  const t0 = Date.now();
  const res = await fetchMarketRegistry({
    force: true,
    fetchImpl: stallingFetch,
    stallMs: 120,
    bodyTotalMs: 5000,
    urls: ['https://mock.stall.com/plugins.json']
  });
  const elapsed = Date.now() - t0;

  // 停滞看门狗（120ms）介入：整个调用快速返回，绝不挂到 bodyTotalMs/超时上限
  assert.ok(elapsed < 3000, `should resolve quickly, took ${elapsed}ms`);
  assert.equal(res.fallback, true);
  assert.equal(res.registry.count, 6);
});

test('fetchMarketRegistry: fallback 标志经 TTL/降级路径透传，成功拉取后清除', async () => {
  // 1. TTL 命中一个 fallback 缓存 → 必须带 fallback 标志（防"兜底伪装成功"）
  const cache = {
    memoryCache: { name: 'fb', count: 6, plugins: [{ name: 'dsh-pet', category: ['pet'] }] },
    etag: null,
    lastModified: null,
    fetchTime: Date.now(),
    isFallback: true
  };
  const res1 = await fetchMarketRegistry({
    force: false,
    fetchImpl: async () => {
      throw new Error('should-not-be-called');
    },
    cacheState: cache
  });
  assert.equal(res1.fromCache, true);
  assert.equal(res1.fallback, true);

  // 2. 降级路径同样透传
  cache.fetchTime = 0; // 过期，强制走网络
  const res2 = await fetchMarketRegistry({
    force: true,
    fetchImpl: async () => {
      throw new Error('offline');
    },
    cacheState: cache
  });
  assert.equal(res2.degraded, true);
  assert.equal(res2.fallback, true);

  // 3. 成功拉取真实数据后 isFallback 清除
  const real = { name: 'awesome-dsh-plugin', updated: '2026-10-31', plugins: [{ name: 'x', category: ['tool'] }] };
  const res3 = await fetchMarketRegistry({
    force: true,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => real
    }),
    cacheState: cache
  });
  assert.equal(res3.updated, true);
  assert.equal(res3.fallback, false);

  // 4. 再次 TTL 命中真实缓存 → 不再带 fallback 标志
  const res4 = await fetchMarketRegistry({
    force: false,
    fetchImpl: async () => {
      throw new Error('should-not-be-called');
    },
    cacheState: cache
  });
  assert.equal(res4.fromCache, true);
  assert.equal(res4.fallback, false);
});



