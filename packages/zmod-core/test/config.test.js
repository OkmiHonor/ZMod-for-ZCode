import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Test with isolated temp dir
const tempDir = path.join(os.tmpdir(), `zmod-test-${Date.now()}`);
process.env.ZMOD_USER_DATA_DIR = tempDir;

const { getUserDataDir, getConfigPath, ensureDirectories } = await import('../src/common/paths.js');
const { configManager } = await import('../src/common/config.js');
const { secretVault } = await import('../src/main/vault.js');

test('ZMod Paths & Config & Vault Suite', async (t) => {
  await t.test('paths resolution', () => {
    assert.equal(getUserDataDir(), tempDir);
    assert.equal(getConfigPath(), path.join(tempDir, 'config.json'));
    ensureDirectories();
    assert.ok(fs.existsSync(tempDir));
    assert.ok(fs.existsSync(path.join(tempDir, 'plugins')));
  });

  await t.test('config default and mutation', () => {
    configManager.reset();
    const cfg = configManager.get();
    assert.equal(cfg.version, 2);
    assert.equal(cfg.enabled, true);

    configManager.setPluginEnabled('test-mod', false);
    assert.equal(configManager.isPluginEnabled('test-mod'), false);

    configManager.setPluginSetting('test-mod', 'opacity', 0.5);
    assert.equal(configManager.getPluginSetting('test-mod', 'opacity'), 0.5);
    assert.equal(configManager.getPluginSetting('test-mod', 'unknown', 'default-val'), 'default-val');

    // Persistence check
    configManager.reset();
    assert.equal(configManager.isPluginEnabled('test-mod'), false);
    assert.equal(configManager.getPluginSetting('test-mod', 'opacity'), 0.5);
  });

  await t.test('secret vault operations', () => {
    secretVault.reset();
    secretVault.set('test-secret', 'my-api-key-12345');
    assert.equal(secretVault.has('test-secret'), true);
    assert.equal(secretVault.get('test-secret'), 'my-api-key-12345');

    secretVault.delete('test-secret');
    assert.equal(secretVault.has('test-secret'), false);
    assert.equal(secretVault.get('test-secret'), null);
  });
});
