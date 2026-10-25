import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { teeConsoleTo, cleanStaleTmp } from '../src/commands/install.js';

test('teeConsoleTo mirrors console output to the log file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-tee-'));
  const logPath = path.join(dir, 'install-latest.log');
  const origLog = console.log;
  const origErr = console.error;
  try {
    teeConsoleTo(logPath);
    console.log('line-one', 42);
    console.error('boom');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.deepEqual(lines, ['line-one 42', 'boom']);
  } finally {
    console.log = origLog;
    console.error = origErr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanStaleTmp removes only install-* leftovers', { env: {} }, async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-tmp-'));
  process.env.ZMOD_USER_DATA_DIR = sandbox;
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

  const tmpDir = path.join(sandbox, 'tmp');
  fs.mkdirSync(path.join(tmpDir, 'install-123'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'install-456'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'keep-me'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'readme'), 'x');

  cleanStaleTmp();
  // fire-and-forget async rm — give the event loop a moment to run callbacks
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(fs.existsSync(path.join(tmpDir, 'install-123')), false);
  assert.equal(fs.existsSync(path.join(tmpDir, 'install-456')), false);
  assert.equal(fs.existsSync(path.join(tmpDir, 'keep-me')), true);
  assert.equal(fs.existsSync(path.join(tmpDir, 'readme')), true);
});
