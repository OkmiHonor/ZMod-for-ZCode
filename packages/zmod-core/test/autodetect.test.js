import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tempDir = path.join(os.tmpdir(), `zmod-autodetect-test-${Date.now()}`);
process.env.ZMOD_USER_DATA_DIR = tempDir;

const { configManager } = await import('../src/common/config.js');
const { autodetectDatasources } = await import('../src/common/autodetect.js');

function writeJSON(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
}

test('DataSource Autodetect Suite', async (t) => {
  const home = path.join(tempDir, 'home');

  await t.test('deepseek + antigravity ready, openai/mimo/bailian placeholder', () => {
    writeJSON(path.join(home, '.zcode', 'v2', 'provider_config.json'), {
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: 'ds', providerName: 'Deepseek',
              config: { api: { baseUrl: 'https://api.deepseek.com/anthropic' }, access: { apiKey: 'sk-ds123' } }
            },
            {
              providerId: 'ag', providerName: 'Google AI Pro',
              config: { api: { baseUrl: 'http://127.0.0.1:8045' }, access: { apiKey: 'sk-ag123' } }
            },
            {
              providerId: 'oa', providerName: 'OpenAI',
              config: { api: { baseUrl: 'https://api.openai.com/v1' }, access: { apiKey: 'sk-proj' } }
            },
            {
              providerId: 'xiaomi-mimo', providerName: 'Xiaomi MiMo',
              config: { access: { apiKey: 'sk-mimo' } }
            },
            {
              providerId: 'qwen-alibaba-model-studio-cn', providerName: '阿里云百炼（中国）',
              config: { access: { apiKey: 'sk-ws-xxx' } }
            }
          ]
        }
      }
    });
    writeJSON(path.join(home, '.antigravity_tools', 'accounts', 'a1.json'), {
      id: 'a1', email: 'x@x.com', disabled: false
    });
    writeJSON(path.join(home, '.antigravity_tools', 'accounts', 'a2.json'), {
      id: 'a2', email: 'y@y.com', disabled: true
    });
    writeJSON(path.join(home, '.bailian', 'config.json'), { api_key: 'sk-ws-xxx' });

    const proposals = autodetectDatasources({ homeDir: home, existingTypes: [] });
    const byType = Object.fromEntries(proposals.map((p) => [p.type, p]));

    assert.equal(byType.deepseek.status, 'ready');
    assert.equal(byType.deepseek.secrets.token, 'sk-ds123');

    assert.equal(byType.antigravity.status, 'ready');
    assert.equal(byType.antigravity.settings.accountId, 'a1'); // first enabled
    assert.equal(byType.antigravity.secrets.token, 'sk-ag123');

    assert.equal(byType['openai-compatible'].status, 'placeholder');
    assert.equal(byType['console-web'].status, 'placeholder'); // mimo
    assert.equal(byType['bailian-bss'].status, 'placeholder');
    assert.ok(byType['bailian-bss'].guide.url.startsWith('https://'));

    // already-configured types flip to configured
    const again = autodetectDatasources({
      homeDir: home,
      existingTypes: ['deepseek', 'bailian-bss']
    });
    const againBy = Object.fromEntries(again.map((p) => [p.type, p]));
    assert.equal(againBy.deepseek.status, 'configured');
    assert.equal(againBy['bailian-bss'].status, 'configured');
    assert.equal(againBy.antigravity.status, 'ready');
  });

  await t.test('empty home yields no proposals', () => {
    const empty = path.join(tempDir, 'empty-home');
    fs.mkdirSync(empty, { recursive: true });
    assert.deepEqual(autodetectDatasources({ homeDir: empty, existingTypes: [] }), []);
  });

  await t.test('config hot reload picks up external edits', async () => {
    ensureDirectoriesForTest();
    configManager.reset();
    configManager.get(); // prime cache + write default file
    configManager.startHotReload();

    let notified = 0;
    const off = configManager.subscribe(() => notified++);

    const cfgPath = path.join(tempDir, 'config.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    raw.datasources = [{ id: 'external-1', type: 'deepseek', name: '外部写入', settings: {} }];
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8');

    await new Promise((r) => setTimeout(r, 800));
    off();
    assert.ok(notified >= 1, 'listener should fire on external write');
    assert.equal(configManager.getDatasources()[0]?.id, 'external-1');
  });
});

function ensureDirectoriesForTest() {
  fs.mkdirSync(tempDir, { recursive: true });
}
