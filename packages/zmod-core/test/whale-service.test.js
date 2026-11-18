import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  scanSkinsDir,
  loadWhaleSkins,
  getWhaleModel,
  getMagpieQuota,
  getProviderCatalog
} from '../src/main/whale-service.js';

test('scanSkinsDir: extracts skin images and meta.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-skins-test-'));
  try {
    const skinA = path.join(tmp, 'skin-a');
    fs.mkdirSync(skinA);
    fs.writeFileSync(path.join(skinA, 'image.png'), Buffer.from('fake-png-data'));
    fs.writeFileSync(path.join(skinA, 'meta.json'), JSON.stringify({ name: 'Alpha', pinned: true }));

    const skinB = path.join(tmp, 'skin-b');
    fs.mkdirSync(skinB);
    fs.writeFileSync(path.join(skinB, 'image.gif'), Buffer.from('fake-gif-data'));

    const list = scanSkinsDir(tmp, 'user');
    assert.equal(list.length, 2);

    const a = list.find((s) => s.id === 'skin-a');
    assert.ok(a);
    assert.equal(a.name, 'Alpha');
    assert.equal(a.pinned, true);
    assert.equal(a.format, 'png');
    assert.ok(a.data.startsWith('data:image/png;base64,'));

    const b = list.find((s) => s.id === 'skin-b');
    assert.ok(b);
    assert.equal(b.name, 'skin-b');
    assert.equal(b.pinned, false);
    assert.equal(b.format, 'gif');
    assert.ok(b.data.startsWith('data:image/gif;base64,'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadWhaleSkins: merges builtin and user skins with user overriding', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-whale-merge-'));
  try {
    const dataDir = path.join(tmp, 'data');
    const pluginsDir = path.join(tmp, 'plugins');
    const userSkinsDir = path.join(dataDir, 'whale-skins');
    const builtinSkinsDir = path.join(pluginsDir, 'whale-widget', 'skins');

    fs.mkdirSync(path.join(builtinSkinsDir, 'common-skin'), { recursive: true });
    fs.writeFileSync(path.join(builtinSkinsDir, 'common-skin', 'image.png'), Buffer.from('builtin-common'));
    fs.writeFileSync(
      path.join(builtinSkinsDir, 'common-skin', 'meta.json'),
      JSON.stringify({ name: 'Builtin Version' })
    );

    fs.mkdirSync(path.join(builtinSkinsDir, 'only-builtin'), { recursive: true });
    fs.writeFileSync(path.join(builtinSkinsDir, 'only-builtin', 'image.png'), Buffer.from('only-builtin'));

    fs.mkdirSync(path.join(userSkinsDir, 'common-skin'), { recursive: true });
    fs.writeFileSync(path.join(userSkinsDir, 'common-skin', 'image.png'), Buffer.from('user-override'));
    fs.writeFileSync(
      path.join(userSkinsDir, 'common-skin', 'meta.json'),
      JSON.stringify({ name: 'User Version' })
    );

    fs.mkdirSync(path.join(userSkinsDir, 'custom-hero'), { recursive: true });
    fs.writeFileSync(path.join(userSkinsDir, 'custom-hero', 'image.png'), Buffer.from('custom-hero'));

    const res = await loadWhaleSkins({ dataDir, pluginsDir });
    assert.equal(res.ok, true);
    assert.equal(res.skins.length, 3);

    const common = res.skins.find((s) => s.id === 'common-skin');
    assert.equal(common.name, 'User Version'); // Overridden by user
    assert.equal(common.source, 'user');

    const hero = res.skins.find((s) => s.id === 'custom-hero');
    assert.ok(hero);
    assert.equal(hero.source, 'user');

    const b = res.skins.find((s) => s.id === 'only-builtin');
    assert.ok(b);
    assert.equal(b.source, 'builtin');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getWhaleModel: validates taskId and queries sqlite', async () => {
  // 1. Invalid taskId
  const bad = await getWhaleModel({ taskId: 'invalid space id!' });
  assert.equal(bad.ok, false);

  // 2. Real tasks-index.sqlite (if present on user machine)
  const defaultDb = path.join(os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
  if (fs.existsSync(defaultDb)) {
    const res = await getWhaleModel({ taskId: 'session_3d1d6817fc2a9ff194ace8a1abbb58c6' });
    assert.equal(res.ok, true);
    assert.ok(typeof res.model === 'string');
    assert.ok(typeof res.provider === 'string');
  }
});

test('getMagpieQuota & getProviderCatalog: reads offline snapshots and strips secrets', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-magpie-test-'));
  try {
    const cfgDir = path.join(tmp, '.config', 'magpie');
    const cacheDir = path.join(tmp, '.cache', 'magpie');
    const zcodeDir = path.join(tmp, '.zcode', 'v2');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(zcodeDir, { recursive: true });

    // 真实 quota-history.json 双层嵌套：{ 'agent|user': { '标签': [{at,left,start,resetsAt}] } }
    // 4 个 zcode 账户同标签 GLM-5.3-Flash、同 (账户,标签) 陈旧+最新快照、双 agent 同 user 并存
    fs.writeFileSync(
      path.join(cfgDir, 'quota-history.json'),
      JSON.stringify({
        'zcode|user1@example.com': {
          'GLM-5.3-Flash': [
            { at: '2026-11-08T00:59:26Z', left: 7.45, start: '2026-11-07T16:00:00Z', resetsAt: '2026-11-08T01:00:00Z' },
            { at: '2026-11-09T00:59:26Z', left: 7.45, start: '2026-11-08T16:00:00Z', resetsAt: '2026-11-09T01:00:00Z' }
          ],
          'GLM-5.3': [
            { at: '2026-11-09T01:48:32Z', left: 95.19, start: '2026-11-08T16:00:00Z', resetsAt: '2026-11-09T01:00:00Z' },
            { at: '2026-11-09T09:12:05Z', left: 61.4, start: '2026-11-08T16:00:00Z', resetsAt: '2026-11-09T16:00:00Z' }
          ]
        },
        'zcode|bfrlcep1': {
          'GLM-5.3-Flash': [
            { at: '2026-11-09T01:48:32Z', left: 100, start: '2026-11-08T16:00:00Z', resetsAt: '2026-11-09T16:00:00Z' },
            { at: '2026-11-09T15:22:47Z', left: 51.9, start: '2026-11-08T16:00:00Z', resetsAt: '2026-11-09T16:00:00Z' }
          ]
        },
        'zcode|vsmqr802': {
          'GLM-5.3-Flash': [
            { at: '2026-11-09T00:59:00Z', left: 9.8, start: '2026-11-08T16:00:00Z', resetsAt: '2026-11-09T01:00:00Z' }
          ]
        },
        'zcode|zcode': {
          'GLM-5.3-Flash': [
            { at: '2026-11-05T23:37:39Z', left: 97.67, start: '2026-11-05T16:00:00Z', resetsAt: '2026-11-06T01:00:00Z' }
          ]
        },
        'antigravity|user1@example.com': {
          'Claude & GPT · 5 hours': [
            { at: '2026-11-06T05:06:28Z', left: 100, start: '2026-11-06T05:06:28Z', resetsAt: '2026-11-06T10:00:00Z' },
            { at: '2026-11-09T15:11:51Z', left: 23.5, start: '2026-11-09T14:27:23Z', resetsAt: '2026-11-09T19:27:23Z' }
          ],
          'Gemini 3 Flash · 5 hours': [
            { at: '2026-11-09T15:11:51Z', left: 94.96, start: '2026-11-09T14:27:23Z', resetsAt: '2026-11-09T19:27:23Z' }
          ]
        }
      })
    );
    // providers-state.json：providers.providers[].account.logins[] 以 (agent,user) 对齐
    fs.writeFileSync(
      path.join(cacheDir, 'providers-state.json'),
      JSON.stringify({
        version: 1,
        providers: {
          providers: [
            {
              id: 'zcode',
              name: 'ZCode',
              account: {
                user: 'bfrlcep1',
                agent: 'zcode',
                plan: 'STALE-STATE-PLAN',
                logins: [
                  { agent: 'zcode', user: 'bfrlcep1', plan: 'ZCODE WEEKEND BUILD' },
                  { agent: 'zcode', user: 'user1@example.com', plan: 'STATE-FREE' }
                ]
              }
            }
          ]
        }
      })
    );
    // logins.json 为主源，覆盖 providers-state 的同名 (agent,user) 条目
    fs.writeFileSync(
      path.join(cfgDir, 'logins.json'),
      JSON.stringify([
        { id: 'l1', agent: 'zcode', user: 'user1@example.com', plan: 'ZCODE WEEKEND BUILD', on: true },
        { id: 'l2', agent: 'antigravity', user: 'user1@example.com', plan: 'Google AI Pro', on: true },
        { id: 'l3', agent: 'zcode', user: 'bfrlcep1', plan: 'ZCODE WEEKEND BUILD', on: true }
      ])
    );
    // usage.jsonl 真实字段 t/in/out/cache_read/status；一行超 30 天、一行 t 非法
    const dayMs = 86400 * 1000;
    const iso = (ms) => new Date(ms).toISOString();
    const now = Date.now();
    fs.writeFileSync(
      path.join(cfgDir, 'usage.jsonl'),
      [
        JSON.stringify({ t: iso(now - dayMs), model: 'zcode/GLM-5.3-Flash', in: 1500, out: 300, cache_read: 500, status: 200 }),
        JSON.stringify({ t: iso(now - 2 * dayMs), model: 'zcode/GLM-5.3-Flash', in: 768, out: 65, cache_read: 17420, status: 200 }),
        JSON.stringify({ t: iso(now - 40 * dayMs), model: 'zcode/GLM-5.3-Flash', in: 999999, out: 999999, cache_read: 999999, status: 200 }),
        JSON.stringify({ t: 'not-a-date', model: 'zcode/GLM-5.3-Flash', in: 1, out: 1, cache_read: 1, status: 500 })
      ].join('\n') + '\n'
    );

    const mp = await getMagpieQuota({}, { homeDir: tmp, cacheTtl: 0 });
    assert.equal(mp.ok, true);
    assert.equal(mp.source, 'local-file');

    // 每账户每标签只留 at 最新快照：bfrlcep1 取 51.9% 而非陈旧 100%
    const trc = mp.groups.find((g) => g.name === 'bfrlcep1');
    assert.ok(trc, 'bfrlcep1 group exists');
    const trcFlash = trc.buckets.find((b) => b.window === 'GLM-5.3-Flash');
    assert.equal(trcFlash.frac, 0.519);
    assert.equal(trcFlash.at, '2026-11-09T15:22:47Z');
    assert.equal(trcFlash.accountAgent, 'zcode');
    assert.equal(trcFlash.reset, '2026-11-09T16:00:00Z');
    // models[] 每账户一条同名记录，bfrlcep1 的那条应为最新快照剩余
    assert.ok(mp.models.filter((m) => m.name === 'glm-5.3-flash').some((m) => m.remaining === 51.9));

    // user1@example.com 双 agent 并存：两组档位各取各的，不互相覆盖
    const zcUser = mp.groups.find((g) => g.name === 'user1@example.com' && g.buckets.some((b) => b.window === 'GLM-5.3-Flash'));
    const agUser = mp.groups.find((g) => g.name === 'user1@example.com' && g.buckets.some((b) => b.window.startsWith('Claude')));
    assert.equal(zcUser.plan, 'ZCODE WEEKEND BUILD');
    assert.equal(agUser.plan, 'Google AI Pro');
    // logins.json 为主源：zcode 侧不被 providers-state 的 STATE-FREE 覆盖
    assert.equal(zcUser.buckets.length, 2); // GLM-5.3-Flash + GLM-5.3

    // usage：30 天截断生效，t 非法行只计 calls 不计 tokens
    assert.equal(mp.usage.calls, 3);
    assert.equal(mp.usage.errors, 1);
    assert.equal(mp.usage.input, 2268);
    assert.equal(mp.usage.output, 365);
    assert.equal(mp.usage.cacheRead, 17920);

    // 本测试未写 quotas.json：antigravity 池化 bucket 不出现且整体 ok:true
    assert.equal(agUser.buckets.some((b) => b.window === '5 hours'), false);

    const cfgPath = path.join(zcodeDir, 'provider_config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: 'p1',
                providerName: 'TestRelay',
                templateId: 'custom',
                enabled: true,
                config: {
                  api: { baseUrl: 'https://relay.example.com/v1' },
                  access: { ['api' + 'Key']: 'mock-cred-999' },
                  models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }]
                }
              }
            ]
          }
        }
      })
    );
    const cat = await getProviderCatalog({}, { providerConfigPath: cfgPath, cacheTtl: 0 });
    assert.equal(cat.ok, true);
    assert.equal(cat.providers.length, 1);
    assert.equal(cat.providers[0].name, 'TestRelay');
    assert.equal(cat.providers[0].baseUrl, 'https://relay.example.com/v1');
    assert.equal(JSON.stringify(cat).includes('mock-cred-999'), false, 'must never leak apiKey');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getMagpieQuota: appends antigravity pooled windows from quotas.json', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-magpie-pool-'));
  try {
    const cfgDir = path.join(tmp, '.config', 'magpie');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(cfgDir, 'quota-history.json'),
      JSON.stringify({
        'antigravity|user1@example.com': {
          'Claude & GPT · 5 hours': [
            { at: '2026-11-09T15:11:51Z', left: 23.5, start: '2026-11-09T14:27:23Z', resetsAt: '2026-11-09T19:27:23Z' }
          ]
        }
      })
    );
    fs.writeFileSync(
      path.join(cfgDir, 'quotas.json'),
      JSON.stringify({
        'antigravity|user1@example.com': {
          at: '2026-11-09T23:20:33+08:00',
          quota: {
            windows: [
              { name: 'Claude Sonnet 4.5', pool: '5 hours', used: 76.5, resetsAt: '2026-11-09T19:27:23Z', resetSecs: 15000, family: 'claude' },
              { name: 'GPT-OSS 120B', pool: '5 hours', used: 50, resetsAt: '2026-11-09T19:27:23Z', resetSecs: 15000, family: 'gpt' },
              { name: 'Gemini 3 Flash', pool: '7 days', used: 10, resetsAt: '2026-11-16T00:00:00Z', resetSecs: 600000, family: 'gemini' }
            ]
          }
        }
      })
    );

    const mp = await getMagpieQuota({}, { homeDir: tmp, cacheTtl: 0 });
    assert.equal(mp.ok, true);
    const g = mp.groups.find((x) => x.name === 'antigravity|user1@example.com');
    assert.ok(g);
    // 同 pool 取 used 最大（保守）：5 hours → frac=1-0.765；7 days → frac=0.9
    const five = g.buckets.find((b) => b.window === '5 hours');
    const seven = g.buckets.find((b) => b.window === '7 days');
    assert.ok(five, 'pooled 5 hours bucket appended');
    assert.ok(Math.abs(five.frac - 0.235) < 1e-9);
    assert.equal(five.at, '2026-11-09T23:20:33+08:00');
    assert.equal(five.accountAgent, 'antigravity');
    assert.ok(seven);
    assert.ok(Math.abs(seven.frac - 0.9) < 1e-9);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getMagpieQuota: tolerates missing, empty and corrupt files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-magpie-bad-'));
  try {
    // 1. quota-history.json 缺失
    const miss = await getMagpieQuota({}, { homeDir: tmp, cacheTtl: 0 });
    assert.equal(miss.ok, false);
    assert.ok(miss.error);

    const cfgDir = path.join(tmp, '.config', 'magpie');
    fs.mkdirSync(cfgDir, { recursive: true });

    // 2. 空对象
    fs.writeFileSync(path.join(cfgDir, 'quota-history.json'), '{}');
    const empty = await getMagpieQuota({}, { homeDir: tmp, cacheTtl: 0 });
    assert.equal(empty.ok, false);

    // 3. 坏 JSON
    fs.writeFileSync(path.join(cfgDir, 'quota-history.json'), '{not json');
    const bad = await getMagpieQuota({}, { homeDir: tmp, cacheTtl: 0 });
    assert.equal(bad.ok, false);

    // 4. 数组顶层（结构不符）
    fs.writeFileSync(path.join(cfgDir, 'quota-history.json'), '[]');
    const arr = await getMagpieQuota({}, { homeDir: tmp, cacheTtl: 0 });
    assert.equal(arr.ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
