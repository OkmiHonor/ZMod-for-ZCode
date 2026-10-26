import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInputEvent, attachWindowShortcuts, installWindowShortcuts } from '../src/main/shortcuts.js';

test('handleInputEvent: ignores non-keyDown events', () => {
  const win = { webContents: { reloadIgnoringCache() {}, toggleDevTools() {} } };
  assert.equal(handleInputEvent({ type: 'keyUp', key: 'F5' }, win), null);
  assert.equal(handleInputEvent({ type: 'char', key: 'r' }, win), null);
});

test('handleInputEvent: Ctrl+R / Cmd+R / F5 triggers reload', () => {
  let reloaded = 0;
  const win = {
    webContents: {
      reloadIgnoringCache: () => {
        reloaded++;
      }
    }
  };

  assert.equal(handleInputEvent({ type: 'keyDown', key: 'r', control: true }, win), 'reload');
  assert.equal(handleInputEvent({ type: 'keyDown', key: 'R', control: true }, win), 'reload');
  assert.equal(handleInputEvent({ type: 'keyDown', key: 'r', meta: true }, win), 'reload');
  assert.equal(handleInputEvent({ type: 'keyDown', key: 'F5' }, win), 'reload');
  assert.equal(reloaded, 4);

  // Fallback to reload() if reloadIgnoringCache is not present
  let simpleReloaded = 0;
  const win2 = {
    webContents: {
      reload: () => {
        simpleReloaded++;
      }
    }
  };
  assert.equal(handleInputEvent({ type: 'keyDown', key: 'F5' }, win2), 'reload');
  assert.equal(simpleReloaded, 1);
});

test('handleInputEvent: F12 and Ctrl+Shift+I toggle devtools', () => {
  let toggled = 0;
  const win = {
    webContents: {
      toggleDevTools: () => {
        toggled++;
      }
    }
  };

  assert.equal(handleInputEvent({ type: 'keyDown', key: 'F12' }, win), 'devtools');
  assert.equal(handleInputEvent({ type: 'keyDown', key: 'i', control: true, shift: true }, win), 'devtools');
  assert.equal(handleInputEvent({ type: 'keyDown', key: 'I', meta: true, shift: true }, win), 'devtools');
  assert.equal(handleInputEvent({ type: 'keyDown', key: 'i', control: true, alt: true }, win), 'devtools');
  assert.equal(toggled, 4);
});

test('handleInputEvent: normal keys return null', () => {
  const win = { webContents: { reloadIgnoringCache() {}, toggleDevTools() {} } };
  assert.equal(handleInputEvent({ type: 'keyDown', key: 'r' }, win), null);
  assert.equal(handleInputEvent({ type: 'keyDown', key: 'c', control: true }, win), null);
  assert.equal(handleInputEvent({ type: 'keyDown', key: 'F4' }, win), null);
});

test('attachWindowShortcuts: hooks window once and sets preventDefault on match', () => {
  let preventCount = 0;
  let listener = null;
  const win = {
    __zmodShortcutsHooked: false,
    webContents: {
      on: (ev, fn) => {
        if (ev === 'before-input-event') listener = fn;
      },
      reloadIgnoringCache: () => {}
    }
  };

  assert.equal(attachWindowShortcuts(win), true);
  assert.equal(attachWindowShortcuts(win), false); // idempotent
  assert.ok(listener);

  const mockEvent = {
    preventDefault: () => {
      preventCount++;
    }
  };
  listener(mockEvent, { type: 'keyDown', key: 'F5' });
  assert.equal(preventCount, 1);

  listener(mockEvent, { type: 'keyDown', key: 'a' });
  assert.equal(preventCount, 1); // not prevented
});

test('installWindowShortcuts: registers across app and existing windows', () => {
  const listeners = [];
  const mockApp = {
    on: (ev, fn) => listeners.push({ ev, fn }),
    isReady: () => true
  };
  const hookedWins = [];
  const mockWin = {
    webContents: {
      on: () => {},
      reloadIgnoringCache: () => {}
    }
  };
  const mockBrowserWindow = {
    getAllWindows: () => [mockWin]
  };

  const installed = installWindowShortcuts({ app: mockApp, BrowserWindow: mockBrowserWindow });
  assert.equal(installed, true);
  assert.equal(mockWin.__zmodShortcutsHooked, true);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].ev, 'browser-window-created');
});
