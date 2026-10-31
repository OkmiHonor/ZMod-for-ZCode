import test from 'node:test';
import assert from 'node:assert/strict';

const { magpieStatus } = await import('../src/renderer/builtin-providers.js');

/* Fixtures mirror the live magpie gateway (magpie.exe ≥0.1.2305):
   GET /v1/magpie/quotas → data[].windows[] (per-model quota windows,
   used/remaining in percent, resetsAt ISO) · GET /v1/magpie/usage?period=30d. */

const QUOTAS = {
  data: [
    {
      provider: 'zcode',
      name: 'ZCode',
      kind: 'subscription',
      plan: 'ZCODE WEEKEND BUILD',
      user: 'okmihonor@gmail.com',
      windows: [
        {
          name: 'GLM-5.3-Flash',
          used: 0.1116268,
          remaining: 99.8883732,
          resetsAt: '2026-11-02T01:00:00Z',
          display: '558134 / 500000000',
          amount: 558134,
          limit: 500000000,
          holdsWhy: 'low'
        }
      ],
      readAt: '2026-10-31T10:39:15.3225664+08:00',
      until: '2026-11-02T01:00:00Z',
      renew: 'off'
    }
  ],
  object: 'list'
};

const USAGE = {
  period: '30d',
  since: '2026-10-02T00:00:00+08:00',
  calls: 376,
  errors: 9,
  retried: 1,
  input: 1245153,
  output: 358657,
  cache_read: 78054272,
  cache_write: 0,
  reasoning: 0,
  cost: 3.0535,
  unpriced: 0,
  bucket: 'day',
  series: []
};

/** Fake provider ctx: scripted per-URL responses; unscripted URLs throw. */
function makeCtx(responses) {
  return {
    net: {
      fetch: async ({ url }) => {
        const hit = responses[url];
        if (!hit) throw new Error('unexpected fetch: ' + url);
        if (hit instanceof Error) throw hit;
        return { ok: (hit.status ?? 200) === 200, status: hit.status ?? 200, text: hit.text ?? '', error: hit.error };
      }
    }
  };
}

const BASE = 'http://127.0.0.1:3425';
const settings = { url: BASE + '/' }; // trailing slash must be stripped

test('magpie: happy path — rows, plan pill, structured groups/models/usage', async () => {
  const ctx = makeCtx({
    [`${BASE}/v1/magpie/quotas`]: { text: JSON.stringify(QUOTAS) },
    [`${BASE}/v1/magpie/usage?period=30d`]: { text: JSON.stringify(USAGE) }
  });
  const r = await magpieStatus(settings, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows[0], { label: '订阅档位', value: 'ZCODE WEEKEND BUILD' });
  const quotaRow = r.rows.find((x) => x.label === 'ZCode · GLM-5.3-Flash');
  assert.ok(quotaRow, 'quota window row missing');
  assert.match(quotaRow.value, /^99\.9% 剩余 · 11月2日重置$/);
  assert.match(r.rows.find((x) => x.label === '30天调用').value, /^376 次 · 失败 9$/);
  assert.match(r.rows.find((x) => x.label === '30天 Tokens').value, /^入 124\.5万 · 出 35\.9万 · 缓存 7805\.4万$/);
  assert.equal(r.rows.find((x) => x.label === '30天费用').value, '$3.05');
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].plan, 'ZCODE WEEKEND BUILD');
  assert.equal(r.groups[0].buckets[0].window, 'GLM-5.3-Flash');
  assert.ok(Math.abs(r.groups[0].buckets[0].frac - 0.998883732) < 1e-9);
  assert.equal(r.groups[0].buckets[0].reset, '2026-11-02T01:00:00Z');
  assert.equal(r.usage.calls, 376);
  assert.ok(Math.abs(r.usage.cost - 3.0535) < 1e-9);
  // popover model matching: lowercase name, used-percentage preserved
  assert.deepEqual(r.models, [{ name: 'glm-5.3-flash', percentage: 0.1116268, reset: '2026-11-02T01:00:00Z' }]);
});

test('magpie: gateway down → explicit 未启动 hint', async () => {
  const ctx = makeCtx({
    [`${BASE}/v1/magpie/quotas`]: { status: 0, error: 'ECONNREFUSED' }
  });
  const r = await magpieStatus(settings, ctx);
  assert.equal(r.ok, false);
  assert.match(r.message, /magpie 网关未启动/);
});

test('magpie: usage endpoint failing is non-fatal', async () => {
  const ctx = makeCtx({
    [`${BASE}/v1/magpie/quotas`]: { text: JSON.stringify(QUOTAS) },
    [`${BASE}/v1/magpie/usage?period=30d`]: new Error('boom')
  });
  const r = await magpieStatus(settings, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.rows.find((x) => x.label === '30天调用'), undefined);
  assert.equal(r.usage, null);
  assert.ok(r.groups[0].buckets.length > 0);
});

test('magpie: HTTP error surfaces the API error message', async () => {
  const ctx = makeCtx({
    [`${BASE}/v1/magpie/quotas`]: {
      status: 500,
      text: JSON.stringify({ error: { message: 'quota store unavailable', type: 'internal_error' } })
    }
  });
  const r = await magpieStatus(settings, ctx);
  assert.equal(r.ok, false);
  assert.match(r.message, /HTTP 500/);
  assert.match(r.message, /quota store unavailable/);
});

test('magpie: no windows → actionable failure', async () => {
  const ctx = makeCtx({
    [`${BASE}/v1/magpie/quotas`]: { text: JSON.stringify({ data: [], object: 'list' }) }
  });
  const r = await magpieStatus(settings, ctx);
  assert.equal(r.ok, false);
  assert.match(r.message, /无配额窗口/);
});
