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
    const first = patchMainSource(mainSrc, '1.0.0-beta');
    assert.ok(first.changed);
    assert.ok(first.code.startsWith(`/*${MARKERS.head}`));
    assert.ok(first.code.trimEnd().endsWith('})();'));
    const second = patchMainSource(first.code, '1.0.0-beta');
    assert.equal(second.changed, false);
    assert.equal(second.code, first.code);

    const html = '<html><head><script type="module" crossorigin src="./assets/index.js"></script></head><body><div id="root"></div></body></html>';
    const patchedHtml = patchIndexHtmlSource(html, '1.0.0-beta');
    assert.ok(patchedHtml.changed);
    // script tag must land inside <body>, after the app's own module script
    assert.ok(patchedHtml.code.indexOf('zmod-local://core/index.js') > html.indexOf('<body>'));
    assert.ok(patchIndexHtmlSource(patchedHtml.code, '1.0.0-beta').changed === false);
  });

  await t.test('buildUnpackGlob and packAndVerify preserve exact reference unpacked set (including @img/sharp)', async () => {
    const { buildUnpackGlob, packAndVerify, getUnpackedSet, loadAsar, UNPACK_GLOB } = await import(
      '../src/lib/asar.js'
    );

    assert.equal(buildUnpackGlob([]), undefined);
    assert.equal(buildUnpackGlob(null), undefined);
    assert.equal(
      buildUnpackGlob(['node_modules/node-pty/prebuilds/win32-x64/pty.node']),
      '**/node_modules/node-pty/prebuilds/win32-x64/pty.node'
    );
    assert.equal(
      buildUnpackGlob(['a/b.node', 'c/d.dll']),
      '**/{a/b.node,c/d.dll}'
    );

    const asar = await loadAsar();
    const asarWork = path.join(tempDir, 'asar-pack-test');
    const refSrc = path.join(asarWork, 'ref-src');
    const outSrc = path.join(asarWork, 'out-src');
    const refArchive = path.join(asarWork, 'ref.asar');
    const outArchive = path.join(asarWork, 'out.asar');

    const files = [
      'package.json',
      'dist-electron/main/index.js',
      'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
      'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
      'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    ];
    for (const root of [refSrc, outSrc]) {
      for (const rel of files) {
        const full = path.join(root, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, rel === 'package.json' ? '{"version":"3.17.1"}' : `content:${rel}`);
      }
    }

    await asar.createPackageWithOptions(refSrc, refArchive, { unpack: UNPACK_GLOB });
    const count = await packAndVerify(outSrc, outArchive, refArchive);
    assert.equal(count, 3);
    const expected = await getUnpackedSet(refArchive);
    const got = await getUnpackedSet(outArchive);
    assert.deepEqual(got, expected);
    assert.deepEqual(got, [
      'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
      'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
      'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    ]);
  });
});
