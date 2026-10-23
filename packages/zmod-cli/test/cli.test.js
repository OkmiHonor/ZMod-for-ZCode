import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

const tempDir = path.join(os.tmpdir(), `zmod-cli-test-${Date.now()}`);
process.env.ZMOD_USER_DATA_DIR = tempDir;

const { locateZCode } = await import('../src/locate.js');
const { configManager } = await import('../../zmod-core/src/common/config.js');

test('ZMod CLI Suite', async (t) => {
  await t.test('locateZCode detects valid directory or env override', () => {
    process.env.ZCODE_PATH = 'D:\\ZCode';
    const loc = locateZCode();
    assert.equal(loc, 'D:\\ZCode');
  });

  await t.test('cli toggle plugin configuration', () => {
    configManager.reset();
    configManager.setPluginEnabled('test-cli-mod', false);
    assert.equal(configManager.isPluginEnabled('test-cli-mod'), false);

    configManager.setPluginEnabled('test-cli-mod', true);
    assert.equal(configManager.isPluginEnabled('test-cli-mod'), true);
  });
});
