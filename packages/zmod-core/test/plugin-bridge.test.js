import test from 'node:test';
import assert from 'node:assert/strict';

// 纯决策模块，不依赖 window / renderer/index.js，可全离线单测。
const { decideLoadAction, applyPluginChange } = await import('../src/renderer/plugin-bridge.js');

// ---------------------------------------------------------------------------
// decideLoadAction —— 全部 action × 注册/激活组合；enabled 不影响 op
// ---------------------------------------------------------------------------

test('decideLoadAction: installed + 未注册 → load', () => {
  assert.deepEqual(decideLoadAction('installed', { registered: false, active: false, enabled: true }), {
    op: 'load'
  });
});

test('decideLoadAction: installed + 已注册 → noop(already-registered)', () => {
  assert.deepEqual(
    decideLoadAction('installed', { registered: true, active: false, enabled: true }),
    { op: 'noop', reason: 'already-registered' }
  );
  assert.deepEqual(
    decideLoadAction('installed', { registered: true, active: true, enabled: true }),
    { op: 'noop', reason: 'already-registered' }
  );
});

test('decideLoadAction: updated + 已注册 → reload（active 与否都 reload）', () => {
  assert.deepEqual(decideLoadAction('updated', { registered: true, active: true, enabled: true }), {
    op: 'reload'
  });
  assert.deepEqual(decideLoadAction('updated', { registered: true, active: false, enabled: true }), {
    op: 'reload'
  });
});

test('decideLoadAction: updated + 未注册 → load', () => {
  assert.deepEqual(decideLoadAction('updated', { registered: false, active: false, enabled: true }), {
    op: 'load'
  });
});

test('decideLoadAction: removed + 已注册 → unload（active 与否都 unload）', () => {
  assert.deepEqual(decideLoadAction('removed', { registered: true, active: true, enabled: true }), {
    op: 'unload'
  });
  assert.deepEqual(decideLoadAction('removed', { registered: true, active: false, enabled: true }), {
    op: 'unload'
  });
});

test('decideLoadAction: removed + 未注册 → noop(not-registered)', () => {
  assert.deepEqual(decideLoadAction('removed', { registered: false, active: false, enabled: true }), {
    op: 'noop',
    reason: 'not-registered'
  });
});

test('decideLoadAction: enabled 不影响 op，只可能影响 load 后是否 enable', () => {
  for (const action of ['installed', 'updated', 'removed']) {
    for (const registered of [false, true]) {
      for (const active of [false, true]) {
        const withOn = decideLoadAction(action, { registered, active, enabled: true });
        const withOff = decideLoadAction(action, { registered, active, enabled: false });
        assert.deepEqual(withOff, withOn);
      }
    }
  }
});

test('decideLoadAction: 未知 action → noop', () => {
  assert.deepEqual(decideLoadAction('bogus', { registered: false, active: false, enabled: true }), {
    op: 'noop',
    reason: 'unknown-action'
  });
});

// ---------------------------------------------------------------------------
// applyPluginChange —— mock deps 断言副作用调用序
// ---------------------------------------------------------------------------

/** fake registry：记录调用序，行为对齐 PluginRegistry（active 时拒绝 unregister）。 */
function makeFakeRegistry({ ids = [], activeIds = [] } = {}) {
  const calls = [];
  const plugins = new Map(ids.map((id) => [id, { id }]));
  const active = new Map(activeIds.map((id) => [id, { id }]));
  return {
    calls,
    plugins,
    active,
    getAll() {
      return [...plugins.values()];
    },
    isActive(id) {
      return active.has(id);
    },
    register(def) {
      calls.push(['register', def.id]);
      plugins.set(def.id, def);
      return true;
    },
    async enable(id) {
      calls.push(['enable', id]);
      active.set(id, { id });
      return true;
    },
    async disable(id) {
      calls.push(['disable', id]);
      active.delete(id);
      return true;
    },
    unregister(id) {
      if (active.has(id)) return false;
      calls.push(['unregister', id]);
      return plugins.delete(id);
    }
  };
}

function makeDeps(registry, overrides = {}) {
  const imported = [];
  return {
    registry,
    invoke: async () => ({}),
    importModule: async (url) => {
      imported.push(url);
      return { default: { id: 'a', name: 'Plugin A' } };
    },
    getConfig: async () => ({ plugins: { a: { enabled: true } } }),
    onError: () => {},
    imported,
    ...overrides
  };
}

test('applyPluginChange: installed → load 链路 import→register→enable', async () => {
  const registry = makeFakeRegistry();
  const deps = makeDeps(registry);
  const r = await applyPluginChange(
    { action: 'installed', id: 'a', entryUrl: 'zmod-local://plugins/a/index.js?v=1', manifest: {} },
    deps
  );
  assert.deepEqual(r, { applied: true, op: 'load' });
  assert.deepEqual(deps.imported, ['zmod-local://plugins/a/index.js?v=1']);
  assert.deepEqual(registry.calls, [
    ['register', 'a'],
    ['enable', 'a']
  ]);
});

test('applyPluginChange: installed + enabled:false → register 但不 enable', async () => {
  const registry = makeFakeRegistry();
  const deps = makeDeps(registry, {
    getConfig: async () => ({ plugins: { a: { enabled: false } } })
  });
  const r = await applyPluginChange(
    { action: 'installed', id: 'a', entryUrl: 'u', manifest: {} },
    deps
  );
  assert.deepEqual(r, { applied: true, op: 'load' });
  assert.deepEqual(registry.calls, [['register', 'a']]);
  assert.equal(registry.active.has('a'), false);
});

test('applyPluginChange: installed + 已注册 → noop，registry 不被触碰', async () => {
  const registry = makeFakeRegistry({ ids: ['a'], activeIds: ['a'] });
  const deps = makeDeps(registry);
  const r = await applyPluginChange({ action: 'installed', id: 'a', entryUrl: 'u' }, deps);
  assert.deepEqual(r, { applied: true, op: 'noop', reason: 'already-registered' });
  assert.deepEqual(registry.calls, []);
  assert.deepEqual(deps.imported, []);
});

test('applyPluginChange: updated + active → 先 disable 再 register 再 enable（覆盖旧实例）', async () => {
  const registry = makeFakeRegistry({ ids: ['a'], activeIds: ['a'] });
  const deps = makeDeps(registry);
  const r = await applyPluginChange(
    { action: 'updated', id: 'a', entryUrl: 'u?v=2', manifest: {} },
    deps
  );
  assert.deepEqual(r, { applied: true, op: 'reload' });
  assert.deepEqual(deps.imported, ['u?v=2']);
  assert.deepEqual(registry.calls, [
    ['disable', 'a'],
    ['register', 'a'],
    ['enable', 'a']
  ]);
});

test('applyPluginChange: updated + 注册但未激活 → 直接 register + enable，无 disable', async () => {
  const registry = makeFakeRegistry({ ids: ['a'], activeIds: [] });
  const deps = makeDeps(registry);
  const r = await applyPluginChange({ action: 'updated', id: 'a', entryUrl: 'u?v=2' }, deps);
  assert.deepEqual(r, { applied: true, op: 'reload' });
  assert.deepEqual(registry.calls, [
    ['register', 'a'],
    ['enable', 'a']
  ]);
});

test('applyPluginChange: removed + active → disable 后 unregister，注册表项清掉', async () => {
  const registry = makeFakeRegistry({ ids: ['a'], activeIds: ['a'] });
  const deps = makeDeps(registry);
  const r = await applyPluginChange(
    { action: 'removed', id: 'a', entryUrl: null, manifest: null },
    deps
  );
  assert.deepEqual(r, { applied: true, op: 'unload' });
  assert.deepEqual(registry.calls, [
    ['disable', 'a'],
    ['unregister', 'a']
  ]);
  assert.equal(registry.plugins.has('a'), false);
  assert.equal(registry.active.has('a'), false);
});

test('applyPluginChange: removed + 注册但未激活 → 只 unregister，无 disable', async () => {
  const registry = makeFakeRegistry({ ids: ['a'], activeIds: [] });
  const deps = makeDeps(registry);
  const r = await applyPluginChange({ action: 'removed', id: 'a', entryUrl: null }, deps);
  assert.deepEqual(r, { applied: true, op: 'unload' });
  assert.deepEqual(registry.calls, [['unregister', 'a']]);
});

test('applyPluginChange: removed + 未注册 → noop，不触碰 registry、不 import', async () => {
  const registry = makeFakeRegistry();
  const deps = makeDeps(registry);
  const r = await applyPluginChange({ action: 'removed', id: 'a', entryUrl: null }, deps);
  assert.deepEqual(r, { applied: true, op: 'noop', reason: 'not-registered' });
  assert.deepEqual(registry.calls, []);
  assert.deepEqual(deps.imported, []);
});

test('applyPluginChange: importModule 抛错 → {applied:false}，onError 收到错误且不 register', async () => {
  const registry = makeFakeRegistry();
  const errors = [];
  const deps = makeDeps(registry, {
    importModule: async () => {
      throw new Error('module load failed');
    },
    onError: (e) => errors.push(e)
  });
  const r = await applyPluginChange(
    { action: 'installed', id: 'a', entryUrl: 'u', manifest: {} },
    deps
  );
  assert.equal(r.applied, false);
  assert.equal(r.error?.message, 'module load failed');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'module load failed');
  assert.deepEqual(registry.calls, []);
});

test('applyPluginChange: enable 抛错 → {applied:false}，onError 旁路上报', async () => {
  const registry = makeFakeRegistry();
  const errors = [];
  const deps = makeDeps(registry, {
    onError: (e) => errors.push(e)
  });
  registry.enable = async () => {
    throw new Error('start exploded');
  };
  const r = await applyPluginChange({ action: 'installed', id: 'a', entryUrl: 'u' }, deps);
  assert.equal(r.applied, false);
  assert.equal(r.error?.message, 'start exploded');
  assert.equal(errors.length, 1);
  // register 已发生但 enable 失败：残留注册项是可接受的（下次 updated 会覆盖），
  // 关键是不抛出且错误被上报。
  assert.deepEqual(registry.calls, [['register', 'a']]);
});
