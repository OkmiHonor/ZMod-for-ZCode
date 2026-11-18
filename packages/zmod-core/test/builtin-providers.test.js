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

test('registerBuiltinProviders registers the 15 builtin provider types', () => {
  const fake = makeFakeRegistry();
  const n = registerBuiltinProviders(fake);
  assert.equal(n, 15);
  const types = fake.registered.map((d) => d.type);
  assert.deepEqual(
    types.sort(),
    [
      'antigravity',
      'bailian-bss',
      'console-web',
      'custom-http',
      'deepseek',
      'magpie',
      'mimo',
      'minimax',
      'moonshot',
      'newapi',
      'official-account',
      'openai-compatible',
      'openrouter',
      'siliconflow',
      'zhipu-coding-plan'
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
  assert.equal(byType.get('magpie').settings.token.type, 'secret');
  assert.equal(byType.get('newapi').settings.token.type, 'secret');
  assert.equal(byType.get('openrouter').settings.token.type, 'secret');
  assert.equal(byType.get('siliconflow').settings.token.type, 'secret');
  assert.equal(byType.get('moonshot').settings.token.type, 'secret');
  assert.equal(byType.get('zhipu-coding-plan').settings.token.type, 'secret');
  assert.equal(byType.get('minimax').settings.token.type, 'secret');
  // official-account is zero-credential: no secret settings
  for (const [key, def] of Object.entries(byType.get('official-account').settings)) {
    assert.notEqual(def.type, 'secret', `official-account.${key} 不应声明为 secret`);
  }
});

test('newapi, openrouter, siliconflow, moonshot, zhipu-coding-plan, minimax & offline fallbacks', async () => {
  const fake = makeFakeRegistry();
  registerBuiltinProviders(fake);
  const byType = new Map(fake.registered.map((d) => [d.type, d]));

  // 1. newapi via /api/usage/token (500,000 units = $1.00)
  const newapiRes = await byType.get('newapi').fetchStatus(
    { url: 'https://relay.example.com/v1', token: 'sk-test' },
    {
      net: {
        fetch: async (opts) => {
          if (opts.url.endsWith('/api/usage/token')) {
            return {
              ok: true,
              status: 200,
              text: JSON.stringify({
                code: true,
                data: {
                  name: 'DevKey',
                  total_available: 2500000, // $5.00
                  total_used: 1250000, // $2.50
                  total_granted: 3750000, // $7.50
                  unlimited_quota: false
                }
              })
            };
          }
          return { ok: false, status: 404, text: '{}' };
        }
      }
    }
  );
  assert.equal(newapiRes.ok, true);
  assert.equal(newapiRes.balance, '5.00');
  assert.equal(newapiRes.totalUsed, 2.5);
  assert.equal(newapiRes.totalGranted, 7.5);
  assert.equal(newapiRes.currency, '$');

  // 2. openrouter via /api/v1/credits
  const orRes = await byType.get('openrouter').fetchStatus(
    { token: 'sk-or-v1-test' },
    {
      net: {
        fetch: async (opts) => {
          if (opts.url.includes('/api/v1/credits')) {
            return {
              ok: true,
              status: 200,
              text: JSON.stringify({ data: { total_credits: 20, total_usage: 6.5 } })
            };
          }
          return { ok: false, status: 404, text: '{}' };
        }
      }
    }
  );
  assert.equal(orRes.ok, true);
  assert.equal(orRes.balance, '13.50');
  assert.equal(orRes.totalUsed, 6.5);
  assert.equal(orRes.totalGranted, 20);

  // 3. siliconflow via /v1/user/info
  const sfRes = await byType.get('siliconflow').fetchStatus(
    { token: 'sk-sf-test' },
    {
      net: {
        fetch: async () => ({
          ok: true,
          status: 200,
          text: JSON.stringify({
            code: 20000,
            status: true,
            data: { totalBalance: '42.80', chargeBalance: '30.00', balance: '12.80', name: 'sf_user' }
          })
        })
      }
    }
  );
  assert.equal(sfRes.ok, true);
  assert.equal(sfRes.balance, '42.8');
  assert.equal(sfRes.currency, '¥');

  // 4. moonshot via /v1/users/me/balance (available_balance is authoritative)
  const msRes = await byType.get('moonshot').fetchStatus(
    { token: 'sk-ms-test' },
    {
      net: {
        fetch: async () => ({
          ok: true,
          status: 200,
          text: JSON.stringify({
            code: 0,
            status: true,
            data: { available_balance: 88.5, voucher_balance: 50, cash_balance: 38.5 }
          })
        })
      }
    }
  );
  assert.equal(msRes.ok, true);
  assert.equal(msRes.balance, '88.5');
  assert.equal(msRes.currency, '¥');

  // 5. zhipu-coding-plan via /api/monitor/usage/quota/limit
  const zpRes = await byType.get('zhipu-coding-plan').fetchStatus(
    { token: 'zp-key-test' },
    {
      net: {
        fetch: async () => ({
          ok: true,
          status: 200,
          text: JSON.stringify({
            code: 200,
            success: true,
            data: {
              level: 'Pro',
              limits: [
                { type: 'TOKENS_LIMIT', percentage: 25, currentValue: 250000, usage: 1000000, nextResetTime: 1760000000000 }
              ]
            }
          })
        })
      }
    }
  );
  assert.equal(zpRes.ok, true);
  assert.equal(zpRes.groups.length, 1);
  assert.equal(zpRes.groups[0].buckets[0].frac, 0.75);

  // 6. minimax via coding_plan/remains
  const mmRes = await byType.get('minimax').fetchStatus(
    { token: 'mm-key-test' },
    {
      net: {
        fetch: async () => ({
          ok: true,
          status: 200,
          text: JSON.stringify({
            base_resp: { status_code: 0 },
            model_remains: [
              {
                model_name: 'MiniMax-M2.7',
                current_interval_total_count: 100,
                current_interval_usage_count: 20,
                remains_time: 3600000
              }
            ]
          })
        })
      }
    }
  );
  assert.equal(mmRes.ok, true);
  assert.equal(mmRes.groups.length, 1);
  assert.equal(mmRes.groups[0].buckets[0].frac, 0.8);

  // 7. antigravity & magpie offline snapshot fallback via ctx.invoke
  const agOffline = await byType.get('antigravity').fetchStatus(
    { url: 'http://127.0.0.1:8045' },
    {
      net: { fetch: async () => ({ ok: false, status: 0, error: 'ECONNREFUSED' }) },
      invoke: async (method) => {
        if (method === 'usage.getAntigravityQuota') {
          return {
            ok: true,
            accountId: 'offline_acc',
            tier: 'pro',
            groups: [{ name: 'Gemini Models', buckets: [{ window: '5h', frac: 0.9, reset: '' }] }]
          };
        }
        return null;
      }
    }
  );
  assert.equal(agOffline.ok, true);
  assert.equal(agOffline.source, 'local-file');

  const mpOffline = await byType.get('magpie').fetchStatus(
    { url: 'http://127.0.0.1:3425' },
    {
      net: { fetch: async () => ({ ok: false, status: 0, error: 'ECONNREFUSED' }) },
      invoke: async (method) => {
        if (method === 'usage.getMagpieQuota') {
          // 真实 getMagpieQuota 契约形状：bucket 带 at/accountAgent，验证消费方对新字段零破坏
          return {
            ok: true,
            source: 'local-file',
            plan: 'FREE',
            groups: [{ name: 'zcode', plan: 'FREE', buckets: [{ window: 'GLM-5.3-Flash', frac: 0.519, reset: '2026-11-09T16:00:00Z', display: '51.9%', at: '2026-11-09T15:22:47Z', accountAgent: 'zcode' }] }],
            models: [{ name: 'glm-5.3-flash', percentage: 48.1, remaining: 51.9, reset: '2026-11-09T16:00:00Z' }],
            usage: { period: '30d', calls: 3, errors: 1, input: 2268, output: 365, cacheRead: 17920, cost: null }
          };
        }
        return null;
      }
    }
  );
  assert.equal(mpOffline.ok, true);
  assert.equal(mpOffline.source, 'local-file');
  assert.equal(mpOffline.groups.length, 1);
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
