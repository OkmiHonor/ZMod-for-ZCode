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

  await t.test('deletePluginEnabled: 只删 enabled 键, settings 保留, 空对象顺带删插件键', () => {
    // enabled + settings 并存：删 enabled 后 settings 保留，重装默认启用
    configManager.setPluginEnabled('gone-mod', false);
    configManager.setPluginSetting('gone-mod', 'opacity', 0.7);
    assert.equal(configManager.deletePluginEnabled('gone-mod'), true);
    assert.equal(configManager.get().plugins['gone-mod']?.enabled, undefined, 'enabled 键已被删除');
    assert.equal(configManager.isPluginEnabled('gone-mod'), true, '重装默认启用');
    assert.equal(configManager.getPluginSetting('gone-mod', 'opacity'), 0.7, 'settings 数据保留');

    // 只有 enabled 时：插件键顺带删除
    configManager.setPluginEnabled('bare-mod', false);
    assert.equal(configManager.deletePluginEnabled('bare-mod'), true);
    assert.equal(configManager.get().plugins['bare-mod'], undefined, '空对象顺带删除');

    // 无 enabled 键：返回 false 且不动配置
    assert.equal(configManager.deletePluginEnabled('never-mod'), false);
    assert.equal(configManager.deletePluginEnabled('gone-mod'), false, '已删过返回 false');

    // 持久化检查
    configManager.reset();
    assert.equal(configManager.isPluginEnabled('gone-mod'), true);
    assert.equal(configManager.getPluginSetting('gone-mod', 'opacity'), 0.7);
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
