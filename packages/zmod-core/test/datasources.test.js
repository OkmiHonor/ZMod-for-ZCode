import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

// Isolated user data dir before any zmod-core module loads.
const tempDir = path.join(os.tmpdir(), `zmod-ds-test-${Date.now()}`);
process.env.ZMOD_USER_DATA_DIR = tempDir;

const { DataSourceRegistry } = await import('../src/renderer/datasources.js');
const { configManager } = await import('../src/common/config.js');
const { netFetch } = await import('../src/main/rpc.js');

/** Fake RPC: records calls, answers from a scripted map. */
function makeFakeApi() {
  const calls = [];
  const config = { datasources: [] };
  const vault = new Map();
  return {
    calls,
    async invoke(method, params) {
      calls.push({ method, params });
      switch (method) {
        case 'datasource.list':
          return config.datasources;
        case 'datasource.save':
          config.datasources = [...config.datasources.filter((d) => d.id !== params.instance.id), params.instance];
          return params.instance;
        case 'datasource.delete':
          config.datasources = config.datasources.filter((d) => d.id !== params.id);
          return { success: true };
        case 'vault.get':
          return vault.get(params.key) ?? null;
        case 'vault.set':
          vault.set(params.key, params.value);
          return { success: true };
        case 'vault.delete':
          vault.delete(params.key);
          return { success: true };
        default:
          throw new Error(`unexpected method ${method}`);
      }
    }
  };
}

function makeRegistry(fake) {
  return new DataSourceRegistry({
    invoke: fake.invoke,
    emit: () => {},
    on: () => () => {}
  });
}

const PROVIDER = {
  type: 'custom-http',
  label: 'Custom HTTP',
  settings: {
    url: { type: 'text', title: 'URL' },
    token: { type: 'secret', title: 'Token' }
  },
  fetchStatus: async (settings, ctx) => {
    if (!settings.url) return { ok: false, message: 'no url' };
    return { ok: true, rows: [{ label: '余额', value: `val-for-${settings.token || 'none'}` }] };
  }
};

test('DataSource Registry Suite', async (t) => {
  await t.test('provider registration validates shape', () => {
    const reg = makeRegistry(makeFakeApi());
    assert.equal(reg.registerProvider(PROVIDER), true);
    assert.equal(reg.registerProvider({ type: 'x' }), false); // no fetchStatus
    assert.equal(reg.registerProvider(null), false);
    assert.equal(reg.getProviders().length, 1);
    assert.equal(reg.getProviders()[0].label, 'Custom HTTP');
    // providers facade strips functions (safe for UI serialization)
    assert.equal(reg.getProviders()[0].fetchStatus, undefined);
  });

  await t.test('saveInstance splits secrets into the vault', async () => {
    const fake = makeFakeApi();
    const reg = makeRegistry(fake);
    reg.registerProvider(PROVIDER);
    const saved = await reg.saveInstance({
      type: 'custom-http',
      name: '我的网关',
      settings: { url: 'https://example.com/api', token: 'sk-super-secret' }
    });
    assert.equal(saved.id, '我的网关');
    assert.equal(saved.settings.url, 'https://example.com/api');
    assert.equal('token' in saved.settings, false, 'secret must not reach config');
    const vaultSet = fake.calls.find((c) => c.method === 'vault.set');
    assert.equal(vaultSet.params.key, 'ds:我的网关:token');
    assert.equal(vaultSet.params.value, 'sk-super-secret');
    assert.equal(reg.getInstances().length, 1);
  });

  await t.test('getStatus merges vault secrets and caches by TTL', async () => {
    const fake = makeFakeApi();
    const reg = makeRegistry(fake);
    reg.registerProvider(PROVIDER);
    await reg.load();
    await reg.saveInstance({
      type: 'custom-http',
      name: 'A',
      settings: { url: 'https://a.example.com', token: 't0' }
    });

    const s1 = await reg.getStatus('a');
    assert.equal(s1.ok, true);
    assert.equal(s1.rows[0].value, 'val-for-t0');

    // Second call within TTL: no vault.get, no new fetch (served from cache).
    const vaultCallsBefore = fake.calls.filter((c) => c.method === 'vault.get').length;
    const s2 = await reg.getStatus('a');
    assert.equal(s2.rows[0].value, 'val-for-t0');
    assert.equal(fake.calls.filter((c) => c.method === 'vault.get').length, vaultCallsBefore);

    // Force bypasses cache.
    const s3 = await reg.getStatus('a', { force: true });
    assert.equal(s3.ok, true);

    // Unknown instance degrades gracefully.
    const s4 = await reg.getStatus('missing');
    assert.equal(s4.ok, false);
  });

  await t.test('fetchStatus throwing normalizes into ok:false', async () => {
    const fake = makeFakeApi();
    const reg = makeRegistry(fake);
    reg.registerProvider({
      ...PROVIDER,
      fetchStatus: async () => {
        throw new Error('boom');
      }
    });
    await reg.load();
    await reg.saveInstance({ type: 'custom-http', name: 'B', settings: {} });
    const s = await reg.getStatus('b', { force: true });
    assert.equal(s.ok, false);
    assert.match(s.message, /boom/);
  });

  await t.test('deleteInstance sweeps vault entries', async () => {
    const fake = makeFakeApi();
    const reg = makeRegistry(fake);
    reg.registerProvider(PROVIDER);
    await reg.load();
    await reg.saveInstance({
      type: 'custom-http',
      name: 'C',
      settings: { url: 'https://c.example.com', token: 'secret-c' }
    });
    assert.equal(reg.getInstances().length, 1);
    await reg.deleteInstance('c');
    assert.equal(reg.getInstances().length, 0);
    const del = fake.calls.find((c) => c.method === 'vault.delete');
    assert.equal(del.params.key, 'ds:c:token');
  });
});

test('Config datasource accessors', () => {
  configManager.reset();
  assert.deepEqual(configManager.getDatasources(), []);
  const saved = configManager.saveDatasource({ type: 'custom-http', name: 'Test 源', settings: { url: 'u' } });
  assert.equal(saved.id, 'test-源');
  assert.equal(configManager.getDatasources().length, 1);
  // id collision gets a suffix
  const saved2 = configManager.saveDatasource({ type: 'custom-http', name: 'Test 源', settings: {} });
  assert.equal(saved2.id, 'test-源-2');
  // upsert keeps single entry
  configManager.saveDatasource({ id: 'test-源', type: 'custom-http', name: '改名', settings: {} });
  assert.equal(configManager.getDatasources().length, 2);
  assert.equal(configManager.getDatasources().find((d) => d.id === 'test-源').name, '改名');
  assert.equal(configManager.deleteDatasource('test-源'), true);
  assert.equal(configManager.deleteDatasource('nope'), false);
  assert.throws(() => configManager.saveDatasource({ name: 'no type' }));
  configManager.reset();
});

test('net.fetch guards', async () => {
  const bad1 = await netFetch({ url: 'file:///C:/Windows/system.ini' });
  assert.equal(bad1.ok, false);
  assert.match(bad1.error, /http\/https/);

  const bad2 = await netFetch({ url: 'https://example.com', method: 'TRACE' });
  assert.equal(bad2.ok, false);
  assert.match(bad2.error, /Method not allowed/);

  const bad3 = await netFetch({ url: 'not a url' });
  assert.equal(bad3.ok, false);
  assert.match(bad3.error, /Invalid URL/);
});
