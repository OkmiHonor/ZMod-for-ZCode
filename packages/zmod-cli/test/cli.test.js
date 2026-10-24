import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const tempDir = path.join(os.tmpdir(), `zmod-cli-test-${Date.now()}`);
process.env.ZMOD_USER_DATA_DIR = tempDir;

const { locateZCode, findAsarInHost } = await import('../src/locate.js');
const { configManager } = await import('../../zmod-core/src/common/config.js');

test('ZMod CLI Suite', async (t) => {
  await t.test('locateZCode resolves via ZCODE_PATH env with a synthetic host', () => {
    const fakeHost = path.join(tempDir, 'fake-host', 'resources');
    fs.mkdirSync(fakeHost, { recursive: true });
    fs.writeFileSync(path.join(fakeHost, 'app.asar'), '');
    const hostRoot = path.dirname(fakeHost);
    process.env.ZCODE_PATH = hostRoot;
    const loc = locateZCode();
    assert.equal(loc, hostRoot);
    assert.equal(findAsarInHost(loc), path.join(fakeHost, 'app.asar'));
  });

  await t.test('locateZCode without env/config either resolves a real host or null', () => {
    delete process.env.ZCODE_PATH;
    configManager.reset();
    const loc = locateZCode();
    // machine-dependent: only assert that a hit is always validated
    if (loc) assert.ok(findAsarInHost(loc));
  });

  await t.test('saved installPath takes priority over env-less discovery', () => {
    const fakeHost = path.join(tempDir, 'saved-host');
    fs.mkdirSync(path.join(fakeHost, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(fakeHost, 'resources', 'app.asar'), '');
    configManager.reset();
    configManager.set('installPath', fakeHost);
    assert.equal(locateZCode(), fakeHost);
  });

  await t.test('cli toggle plugin configuration', () => {
    configManager.reset();
    configManager.setPluginEnabled('test-cli-mod', false);
    assert.equal(configManager.isPluginEnabled('test-cli-mod'), false);

    configManager.setPluginEnabled('test-cli-mod', true);
    assert.equal(configManager.isPluginEnabled('test-cli-mod'), true);
  });

  await t.test('patch templates are idempotent and marker-guarded', async () => {
    const { patchMainSource, patchPreloadSource, patchIndexHtmlSource, MARKERS } = await import(
      '../src/patches/index.js'
    );
    const mainSrc = 'import{a}from"./chunk.js";console.log(a);';
    const first = patchMainSource(mainSrc, '2.0.0');
    assert.ok(first.changed);
    assert.ok(first.code.startsWith(`/*${MARKERS.head}`));
    assert.ok(first.code.trimEnd().endsWith('})();'));
    const second = patchMainSource(first.code, '2.0.0');
    assert.equal(second.changed, false);
    assert.equal(second.code, first.code);

    const html = '<html><head><script type="module" crossorigin src="./assets/index.js"></script></head><body><div id="root"></div></body></html>';
    const patchedHtml = patchIndexHtmlSource(html, '2.0.0');
    assert.ok(patchedHtml.changed);
    // script tag must land inside <body>, after the app's own module script
    assert.ok(patchedHtml.code.indexOf('zmod-local://core/index.js') > html.indexOf('<body>'));
    assert.ok(patchIndexHtmlSource(patchedHtml.code, '2.0.0').changed === false);
  });
});
