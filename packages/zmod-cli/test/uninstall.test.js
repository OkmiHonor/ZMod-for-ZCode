import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planUninstall } from '../src/commands/uninstall.js';
import { resolveBaselineCandidate, backfillBaseSnapshot } from '../src/lib/baseline.js';

const manifest = {
  version: '2.3.0',
  files: [
    'run-install.cmd',
    'Uninstall.exe',
    'package.json',
    'install-manifest.json',
    'packages/zmod-cli/bin/zmod.js',
    'node_modules/@electron/asar/lib/asar.js'
  ],
  dirs: ['packages', 'packages/zmod-cli', 'packages/zmod-cli/bin', 'node_modules', 'node_modules/@electron/asar']
};

test('planUninstall keeps data tree and NSIS-owned files stay out of the plan', () => {
  const plan = planUninstall(manifest, { keepData: true });
  assert.equal(plan.wipeData, false);
  assert.ok(!plan.files.includes('run-install.cmd'), 'run-install.cmd belongs to the NSIS shell');
  assert.ok(!plan.files.includes('Uninstall.exe'), 'uninstaller deletes itself');
  assert.deepEqual(
    plan.files.slice().sort(),
    ['package.json', 'install-manifest.json', 'packages/zmod-cli/bin/zmod.js', 'node_modules/@electron/asar/lib/asar.js'].sort()
  );
});

test('planUninstall wipe mode deletes everything shipped', () => {
  const plan = planUninstall(manifest, { keepData: false });
  assert.equal(plan.wipeData, true);
  assert.equal(plan.files.length, manifest.files.length - 2); // still excludes NSIS-owned pair
});

test('planUninstall orders dirs shallow-first so rmdir can cascade', () => {
  const plan = planUninstall(manifest, { keepData: true });
  const depths = plan.dirs.map((d) => d.split('/').length);
  assert.deepEqual(depths, [...depths].sort((a, b) => a - b));
});

test('resolveBaselineCandidate prefers snapshot, falls back to legacy/explicit, null when none', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-baseline-'));
  const asar = path.join(tmp, 'app.asar');
  fs.writeFileSync(asar, 'patched');
  const snapshot = path.join(tmp, 'data', 'base', 'app.asar');
  const legacy = path.join(tmp, 'app.asar.backup1');
  const explicit = path.join(tmp, 'official.asar');

  assert.equal(resolveBaselineCandidate({ baseSnapshot: snapshot, asarPath: asar, explicit }), null, 'nothing exists → null');

  fs.writeFileSync(explicit, 'official');
  let hit = resolveBaselineCandidate({ baseSnapshot: snapshot, asarPath: asar, explicit });
  assert.equal(hit.path, explicit, 'explicit is the only survivor');

  fs.writeFileSync(legacy, 'official-legacy');
  hit = resolveBaselineCandidate({ baseSnapshot: snapshot, asarPath: asar, explicit });
  assert.equal(hit.path, legacy, 'legacy backup outranks explicit');

  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, 'official-snap');
  hit = resolveBaselineCandidate({ baseSnapshot: snapshot, asarPath: asar, explicit });
  assert.equal(hit.path, snapshot, 'canonical snapshot wins');
});

test('backfillBaseSnapshot copies only when source differs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-backfill-'));
  const snapshot = path.join(tmp, 'data', 'base', 'app.asar');
  const source = path.join(tmp, 'official.asar');
  fs.writeFileSync(source, 'official-bytes');

  assert.equal(backfillBaseSnapshot(snapshot, snapshot), false, 'same file → no-op');
  assert.equal(backfillBaseSnapshot(snapshot, source), true);
  assert.equal(fs.readFileSync(snapshot, 'utf8'), 'official-bytes');
  assert.ok(!fs.existsSync(`${snapshot}.tmp`), 'temp file renamed away');
});
