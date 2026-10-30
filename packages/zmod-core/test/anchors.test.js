import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import {
  classifyWindow,
  describeWindow,
  setSharedWindowStyle,
  removeSharedWindowStyle,
  sharedStyles,
  listWindows,
  installWindowLifecycleHook
} from '../src/main/windows.js';

import {
  registerContextMenuItem,
  unregisterContextMenuItem,
  matchContextMenuItems,
  buildContextPayload,
  installContextMenuHook,
  menuItems
} from '../src/main/context-menu.js';

import {
  queryRecentTasks,
  createTasksWatcher
} from '../src/main/tasks-watch.js';

test('Anchor #2: classifyWindow and describeWindow', () => {
  // Destroyed or null window
  assert.equal(classifyWindow(null), 'destroyed');
  assert.equal(classifyWindow({ isDestroyed: () => true }), 'destroyed');
  assert.equal(describeWindow(null).kind, 'destroyed');

  // Helper window (flag or data url with alwaysOnTop)
  const helperWin1 = {
    id: 1,
    __zmodHelperWindow: true,
    isDestroyed: () => false,
    webContents: { getURL: () => 'http://localhost' },
    getTitle: () => 'Helper 1'
  };
  assert.equal(classifyWindow(helperWin1), 'helper');

  const helperWin2 = {
    id: 2,
    isDestroyed: () => false,
    webContents: { getURL: () => 'data:text/html,<div></div>' },
    isAlwaysOnTop: () => true,
    getTitle: () => 'Helper 2'
  };
  assert.equal(classifyWindow(helperWin2), 'helper');

  // Main window
  const mainWin = {
    id: 3,
    isDestroyed: () => false,
    webContents: { getURL: () => 'file:///app/out/renderer/index.html' },
    getTitle: () => 'Main Window',
    isVisible: () => true,
    isFocused: () => true
  };
  assert.equal(classifyWindow(mainWin), 'main');
  const desc = describeWindow(mainWin);
  assert.equal(desc.id, 3);
  assert.equal(desc.kind, 'main');
  assert.equal(desc.title, 'Main Window');
  assert.equal(desc.isVisible, true);
  assert.equal(desc.isFocused, true);

  // Child window
  const childWin = {
    id: 4,
    isDestroyed: () => false,
    webContents: { getURL: () => 'file:///app/out/renderer/index.html?windowKind=child' },
    getTitle: () => 'Child Window'
  };
  assert.equal(classifyWindow(childWin), 'child');
});

test('Anchor #2: setSharedWindowStyle, removeSharedWindowStyle, and window lifecycle', () => {
  sharedStyles.clear();
  const executedScripts = [];

  const mockWindow = {
    id: 10,
    isDestroyed: () => false,
    webContents: {
      getURL: () => 'file:///app/out/renderer/index.html',
      executeJavaScript: async (code) => {
        executedScripts.push(code);
      },
      send: (ch, payload) => sentEvents.push({ ch, payload })
    },
    getTitle: () => 'Main'
  };

  const sentEvents = [];
  const mockBW = {
    getAllWindows: () => [mockWindow]
  };

  // Validation
  assert.equal(setSharedWindowStyle({ id: '' }, { BrowserWindow: mockBW }).ok, false);
  assert.equal(removeSharedWindowStyle({ id: '' }, { BrowserWindow: mockBW }).ok, false);

  // Set shared style
  const setRes = setSharedWindowStyle(
    { id: 'dark-theme', css: 'body { background: black; }', targetKinds: ['main'] },
    { BrowserWindow: mockBW }
  );
  assert.equal(setRes.ok, true);
  assert.equal(sharedStyles.has('dark-theme'), true);
  assert.equal(executedScripts.length, 1);
  assert.equal(executedScripts[0].includes('zmod-shared-style-dark-theme'), true);

  // List windows
  const listRes = listWindows({ BrowserWindow: mockBW });
  assert.equal(listRes.ok, true);
  assert.equal(listRes.windows.length, 1);
  assert.equal(listRes.windows[0].id, 10);

  // Remove shared style
  const remRes = removeSharedWindowStyle({ id: 'dark-theme' }, { BrowserWindow: mockBW });
  assert.equal(remRes.ok, true);
  assert.equal(sharedStyles.has('dark-theme'), false);
  assert.equal(executedScripts.length, 2);
  assert.equal(executedScripts[1].includes('zmod-shared-style-dark-theme'), true);

  // Test lifecycle hook
  let finishLoadCb = null;
  let closedCb = null;
  const lifecycleWin = {
    id: 20,
    isDestroyed: () => false,
    webContents: {
      getURL: () => 'file:///app/out/renderer/index.html',
      executeJavaScript: async () => {},
      on: (ev, cb) => {
        if (ev === 'did-finish-load') finishLoadCb = cb;
      },
      send: (ch, payload) => sentEvents.push({ ch, payload })
    },
    once: (ev, cb) => {
      if (ev === 'closed') closedCb = cb;
    },
    getTitle: () => 'Test Win'
  };

  let createdHook = null;
  const mockApp = {
    on: (ev, cb) => {
      if (ev === 'browser-window-created') createdHook = cb;
    }
  };

  const openWindows = [lifecycleWin];
  installWindowLifecycleHook({ app: mockApp, BrowserWindow: { getAllWindows: () => openWindows } });
  assert.ok(createdHook, 'created hook registered');
  createdHook(null, lifecycleWin);

  assert.ok(finishLoadCb, 'did-finish-load registered');
  finishLoadCb();

  const createdEv = sentEvents.find((e) => e.payload?.event === 'created');
  assert.ok(createdEv);
  assert.equal(createdEv.payload.window.id, 20);

  assert.ok(closedCb, 'closed registered');
  closedCb();
  const closedEv = sentEvents.find((e) => e.payload?.event === 'closed');
  assert.ok(closedEv);
  assert.equal(closedEv.payload.windowId, 20);
});

test('Anchor #4: context-menu registration, unregistration, and matching', () => {
  menuItems.clear();

  // Validation
  assert.equal(registerContextMenuItem({}).ok, false);
  assert.equal(registerContextMenuItem({ pluginId: 'p1' }).ok, false);
  assert.equal(registerContextMenuItem({ pluginId: 'p1', id: 'm1' }).ok, false);

  // Registration
  const r1 = registerContextMenuItem({ pluginId: 'p1', id: 'm1', label: 'Item 1', when: 'always', order: 20 });
  const r2 = registerContextMenuItem({ pluginId: 'p1', id: 'm2', label: 'Item 2', when: 'selection', order: 10 });
  const r3 = registerContextMenuItem({ pluginId: 'p2', id: 'm3', label: 'Item 3', when: 'editable', order: 15 });
  const r4 = registerContextMenuItem({ pluginId: 'p2', id: 'm4', label: 'Item 4', when: 'link', order: 5 });

  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(r3.ok, true);
  assert.equal(r4.ok, true);
  assert.equal(menuItems.size, 4);

  // Match: Empty context
  const emptyMatched = matchContextMenuItems({});
  assert.equal(emptyMatched.length, 1);
  assert.equal(emptyMatched[0].id, 'm1');

  // Match: Selection context
  const selMatched = matchContextMenuItems({ selectionText: 'hello world' });
  assert.equal(selMatched.length, 2);
  // Order: m2 has order 10, m1 has order 20
  assert.equal(selMatched[0].id, 'm2');
  assert.equal(selMatched[1].id, 'm1');

  // Match: Editable context
  const editMatched = matchContextMenuItems({ isEditable: true });
  assert.equal(editMatched.length, 2);
  // Order: m3 has order 15, m1 has order 20
  assert.equal(editMatched[0].id, 'm3');
  assert.equal(editMatched[1].id, 'm1');

  // Match: Link context
  const linkMatched = matchContextMenuItems({ linkURL: 'https://example.com' });
  assert.equal(linkMatched.length, 2);
  // Order: m4 has order 5, m1 has order 20
  assert.equal(linkMatched[0].id, 'm4');
  assert.equal(linkMatched[1].id, 'm1');

  // buildContextPayload
  const payload = buildContextPayload({
    x: 12.5,
    y: 34.2,
    selectionText: 'selected',
    isEditable: 1,
    linkURL: 'https://foo.com',
    srcURL: null
  });
  assert.equal(payload.x, 12.5);
  assert.equal(payload.y, 34.2);
  assert.equal(payload.selectionText, 'selected');
  assert.equal(payload.isEditable, true);
  assert.equal(payload.linkURL, 'https://foo.com');
  assert.equal(payload.srcURL, '');

  // Unregister single
  unregisterContextMenuItem({ pluginId: 'p1', id: 'm2' });
  assert.equal(menuItems.has('p1:m2'), false);
  assert.equal(menuItems.has('p1:m1'), true);

  // Unregister all for plugin
  unregisterContextMenuItem({ pluginId: 'p2' });
  assert.equal(menuItems.has('p2:m3'), false);
  assert.equal(menuItems.has('p2:m4'), false);
  assert.equal(menuItems.size, 1);
});

test('Anchor #4: installContextMenuHook and popup behavior', () => {
  menuItems.clear();
  registerContextMenuItem({ pluginId: 'test-plugin', id: 'copy-custom', label: 'Custom Action', when: 'selection' });

  let contextMenuCb = null;
  const sentIPC = [];
  const mockWin = {
    id: 42,
    isDestroyed: () => false,
    webContents: {
      on: (ev, cb) => {
        if (ev === 'context-menu') contextMenuCb = cb;
      },
      send: (ch, p) => sentIPC.push({ ch, p })
    }
  };

  let builtTemplate = null;
  let popupCalled = false;
  const mockMenu = {
    buildFromTemplate: (template) => {
      builtTemplate = template;
      return {
        popup: () => {
          popupCalled = true;
        }
      };
    }
  };

  installContextMenuHook({
    Menu: mockMenu,
    BrowserWindow: { getAllWindows: () => [mockWin] }
  });

  assert.ok(contextMenuCb, 'context-menu listener registered');

  // Non-matching context -> no popup
  contextMenuCb(null, { selectionText: '' });
  assert.equal(popupCalled, false);

  // Matching context -> popup built with standard clipboard actions
  contextMenuCb(null, { selectionText: 'hello', isEditable: true, x: 100, y: 200 });
  assert.equal(popupCalled, true);
  assert.ok(builtTemplate);
  assert.equal(builtTemplate[0].label, 'Custom Action');

  // Check clipboard roles appended
  const roles = builtTemplate.map((t) => t.role).filter(Boolean);
  assert.ok(roles.includes('cut'));
  assert.ok(roles.includes('copy'));
  assert.ok(roles.includes('paste'));

  // Test click
  builtTemplate[0].click();
  assert.equal(sentIPC.length, 1);
  assert.equal(sentIPC[0].ch, 'zmod:context-menu-click');
  assert.equal(sentIPC[0].p.key, 'test-plugin:copy-custom');
  assert.equal(sentIPC[0].p.context.selectionText, 'hello');
});

test('Anchor #5: queryRecentTasks with SQLite DatabaseSync', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-anchor5-'));
  const dbPath = path.join(tmpDir, 'tasks-index.sqlite');

  try {
    // Non-existent db
    const notFound = queryRecentTasks({ dbPath: path.join(tmpDir, 'does-not-exist.sqlite') });
    assert.equal(notFound.ok, false);
    assert.equal(notFound.tasks.length, 0);

    // Create sqlite DB with test data
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE tasks (
        workspace_key TEXT,
        workspace_path TEXT,
        task_id TEXT PRIMARY KEY,
        title TEXT,
        task_status TEXT,
        provider TEXT,
        mode TEXT,
        model TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        pinned INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        deleted INTEGER DEFAULT 0
      );
      INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, provider, mode, model, created_at, updated_at, deleted)
      VALUES
        ('ws1', '/ws/1', 't1', 'Task One', 'completed', 'glm', 'build', 'gemini-pro', 1000, 2000, 0),
        ('ws1', '/ws/1', 't2', 'Task Two', 'in_progress', 'anthropic', 'chat', 'claude-3-5-sonnet', 1100, 3000, 0),
        ('ws2', '/ws/2', 't3', 'Task Three', 'error', 'openai', 'build', 'gpt-4o', 1200, 2500, 0),
        ('ws1', '/ws/1', 't4', 'Deleted Task', 'cancelled', 'glm', 'build', 'glm-flash', 1300, 4000, 1);
    `);
    db.close();

    // Query all non-deleted tasks
    const res = queryRecentTasks({ limit: 10, dbPath });
    assert.equal(res.ok, true);
    assert.equal(res.tasks.length, 3);
    // Ordered by updated_at DESC: t2 (3000) -> t3 (2500) -> t1 (2000)
    assert.equal(res.tasks[0].taskId, 't2');
    assert.equal(res.tasks[0].workspacePath, '/ws/1');
    assert.equal(res.tasks[0].status, 'in_progress');
    assert.equal(res.tasks[1].taskId, 't3');
    assert.equal(res.tasks[2].taskId, 't1');

    // Query with workspace filter
    const wsRes = queryRecentTasks({ limit: 10, workspacePath: '/ws/2', dbPath });
    assert.equal(wsRes.ok, true);
    assert.equal(wsRes.tasks.length, 1);
    assert.equal(wsRes.tasks[0].taskId, 't3');

    // Query limit
    const limRes = queryRecentTasks({ limit: 1, dbPath });
    assert.equal(limRes.ok, true);
    assert.equal(limRes.tasks.length, 1);
    assert.equal(limRes.tasks[0].taskId, 't2');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Anchor #5: createTasksWatcher demand-driven watcher and debounce', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmod-watcher-'));
  const dbPath = path.join(tmpDir, 'tasks-index.sqlite');

  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE tasks (
        workspace_key TEXT,
        workspace_path TEXT,
        task_id TEXT PRIMARY KEY,
        title TEXT,
        task_status TEXT,
        provider TEXT,
        mode TEXT,
        model TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        pinned INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        deleted INTEGER DEFAULT 0
      );
      INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, provider, mode, model, created_at, updated_at, deleted)
      VALUES ('ws', '/ws', 'task-1', 'Initial', 'pending', 'glm', 'chat', 'model-a', 100, 100, 0);
    `);
    db.close();

    const changes = [];
    const watcher = createTasksWatcher({
      dbPath,
      debounceMs: 50,
      onChanged: (data) => changes.push(data)
    });

    // Before subscribe: subscriberCount = 0
    assert.equal(watcher.getSubscriberCount(), 0);

    // Subscribe subscriber-1
    watcher.subscribe('sub-1');
    assert.equal(watcher.getSubscriberCount(), 1);

    // Subscribe subscriber-2
    watcher.subscribe('sub-2');
    assert.equal(watcher.getSubscriberCount(), 2);

    // Modify database to trigger change
    const updateDb = new DatabaseSync(dbPath);
    updateDb.exec(`
      UPDATE tasks SET task_status = 'completed', updated_at = 200 WHERE task_id = 'task-1';
    `);
    updateDb.close();

    // Trigger file change on the db directory
    fs.utimesSync(dbPath, new Date(), new Date());

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.ok(changes.length >= 1, 'onChanged fired on db update');
    const lastChange = changes[changes.length - 1];
    assert.equal(lastChange.tasks[0].taskId, 'task-1');
    assert.equal(lastChange.tasks[0].status, 'completed');

    const changeCountBefore = changes.length;

    // Trigger file event WITHOUT changing data -> signature matches, no duplicate emission
    fs.utimesSync(dbPath, new Date(), new Date());
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(changes.length, changeCountBefore, 'Duplicate data should not emit onChanged');

    // Unsubscribe
    watcher.unsubscribe('sub-1');
    assert.equal(watcher.getSubscriberCount(), 1);
    watcher.unsubscribe('sub-2');
    assert.equal(watcher.getSubscriberCount(), 0);

    watcher.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Anchor RPC Gateway Integration', async () => {
  const handlers = new Map();
  const mockGateway = {
    register: (method, fn) => handlers.set(method, fn)
  };

  const { registerWindowLifecycleService } = await import('../src/main/windows.js');
  const { registerContextMenuService } = await import('../src/main/context-menu.js');
  const { registerTasksWatchService } = await import('../src/main/tasks-watch.js');

  registerWindowLifecycleService(mockGateway);
  registerContextMenuService(mockGateway);
  registerTasksWatchService(mockGateway);

  // Check window RPC methods
  assert.ok(handlers.has('window.list'));
  assert.ok(handlers.has('window.setSharedStyle'));
  assert.ok(handlers.has('window.removeSharedStyle'));

  const wList = await handlers.get('window.list')({ BrowserWindow: { getAllWindows: () => [] } });
  assert.equal(wList.ok, true);

  // Check contextMenu RPC methods
  assert.ok(handlers.has('contextMenu.register'));
  assert.ok(handlers.has('contextMenu.unregister'));
  assert.ok(handlers.has('contextMenu.list'));

  const cmReg = await handlers.get('contextMenu.register')({
    pluginId: 'rpc-test',
    id: 'act1',
    label: 'Action 1'
  });
  assert.equal(cmReg.ok, true);
  const cmList = await handlers.get('contextMenu.list')();
  assert.ok(cmList.items.some((i) => i.id === 'act1'));
  await handlers.get('contextMenu.unregister')({ pluginId: 'rpc-test', id: 'act1' });

  // Check tasks RPC methods
  assert.ok(handlers.has('tasks.listRecent'));
  assert.ok(handlers.has('tasks.subscribe'));
  assert.ok(handlers.has('tasks.unsubscribe'));
  assert.ok(handlers.has('tasks.watchStatus'));

  const status = await handlers.get('tasks.watchStatus')();
  assert.equal(status.ok, true);
});

