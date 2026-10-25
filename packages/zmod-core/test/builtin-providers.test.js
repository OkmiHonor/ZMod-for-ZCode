import test from 'node:test';
import assert from 'node:assert/strict';

import { registerBuiltinProviders } from '../src/renderer/builtin-providers.js';
import { DataSourceRegistry } from '../src/renderer/datasources.js';

/** Minimal fake registry: capture registered provider defs. */
function makeFakeRegistry() {
  const registered = [];
  return {
    registered,
    registerProvider(def) {
      registered.push(def);
      return true;
    }
  };
}

test('registerBuiltinProviders registers the 8 builtin provider types', () => {
  const fake = makeFakeRegistry();
  const n = registerBuiltinProviders(fake);
  assert.equal(n, 8);
  const types = fake.registered.map((d) => d.type);
  assert.deepEqual(
    types.sort(),
    [
      'antigravity',
      'bailian-bss',
      'console-web',
      'custom-http',
      'deepseek',
      'mimo',
      'official-account',
      'openai-compatible'
    ].sort()
  );
});

test('every def has the registry contract shape (type/label/settings/fetchStatus)', () => {
  const fake = makeFakeRegistry();
  registerBuiltinProviders(fake);
  for (const def of fake.registered) {
    assert.equal(typeof def.type, 'string');
    assert.ok(def.type.length > 0);
    assert.equal(typeof def.label, 'string');
    assert.ok(def.label.length > 0);
    assert.equal(typeof def.description, 'string');
    assert.equal(typeof def.settings, 'object');
    assert.equal(typeof def.fetchStatus, 'function');
  }
});

test('secret-typed settings are declared where credentials apply', () => {
  const fake = makeFakeRegistry();
  registerBuiltinProviders(fake);
  const byType = new Map(fake.registered.map((d) => [d.type, d]));
  assert.equal(byType.get('custom-http').settings.token.type, 'secret');
  assert.equal(byType.get('deepseek').settings.token.type, 'secret');
  assert.equal(byType.get('bailian-bss').settings.accessKeyId.type, 'secret');
  assert.equal(byType.get('bailian-bss').settings.accessKeySecret.type, 'secret');
  assert.equal(byType.get('mimo').settings.cookie.type, 'secret');
  assert.equal(byType.get('antigravity').settings.token.type, 'secret');
  // official-account is zero-credential: no secret settings
  for (const [key, def] of Object.entries(byType.get('official-account').settings)) {
    assert.notEqual(def.type, 'secret', `official-account.${key} 不应声明为 secret`);
  }
});

test('official-account fetchStatus reports no-data cleanly without collection', async () => {
  const fake = makeFakeRegistry();
  registerBuiltinProviders(fake);
  const def = fake.registered.find((d) => d.type === 'official-account');
  // No window / no snapshot in node: must return a actionable message, not throw
  const status = await def.fetchStatus({});
  assert.equal(status.ok, false);
  assert.match(status.message, /暂无采集数据/);
  const probe = await def.test({});
  assert.equal(probe.ok, false);
});

test('official-account fetchStatus passes captured snapshot rows through', async () => {
  const fake = makeFakeRegistry();
  registerBuiltinProviders(fake);
  const def = fake.registered.find((d) => d.type === 'official-account');
  const rows = [{ label: 'GLM-4.6', value: '63% 剩余 · 10月26日' }];
  globalThis.window = { __zmod_account_quota__: { rows, source: 'official-popover', observedAt: 1234 } };
  try {
    const status = await def.fetchStatus({});
    assert.equal(status.ok, true);
    assert.deepEqual(status.rows, rows);
    assert.equal(status.ts, 1234);
  } finally {
    delete globalThis.window;
  }
});

test('registers cleanly on a real DataSourceRegistry (provider queryable)', () => {
  const registry = new DataSourceRegistry({
    invoke: async () => null,
    emit: () => {}
  });
  registerBuiltinProviders(registry);
  const types = registry.getProviders().map((p) => p.type);
  assert.ok(types.includes('custom-http'));
  assert.ok(types.includes('official-account'));
  assert.equal(registry.getProvider('custom-http').type, 'custom-http');
  assert.equal(typeof registry.getProvider('custom-http').fetchStatus, 'function');
  // getProviders must not leak the raw fetchStatus implementation
  for (const p of registry.getProviders()) {
    assert.equal(p.fetchStatus, undefined);
  }
});
