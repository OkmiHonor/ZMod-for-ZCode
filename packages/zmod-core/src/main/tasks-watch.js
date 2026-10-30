import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

let electron = null;
try {
  electron = await import('electron');
} catch {
  // Not in Electron (unit tests)
}

const electronBrowserWindow = electron?.BrowserWindow ?? electron?.default?.BrowserWindow;

/**
 * Query recent tasks directly from local SQLite database in read-only mode.
 */
export function queryRecentTasks({ limit = 20, workspacePath, dbPath } = {}) {
  const resolvedDbPath = dbPath || path.join(os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
  if (!fs.existsSync(resolvedDbPath)) {
    return { ok: false, error: 'Database not found', tasks: [] };
  }

  const lim = Math.max(1, Math.min(Number(limit) || 20, 500));
  const wsPath = typeof workspacePath === 'string' && workspacePath.trim() ? workspacePath.trim() : null;

  let db = null;
  try {
    db = new DatabaseSync(resolvedDbPath, { readOnly: true });
    const query = `
      SELECT workspace_key, workspace_path, task_id, title, task_status, provider, mode, model, created_at, updated_at, pinned, archived
      FROM tasks
      WHERE deleted = 0 AND (? IS NULL OR workspace_path = ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    const stmt = db.prepare(query);
    const rows = stmt.all(wsPath, wsPath, lim);
    const tasks = rows.map((r) => ({
      workspaceKey: r.workspace_key,
      workspacePath: r.workspace_path,
      taskId: r.task_id,
      title: r.title || '',
      status: r.task_status || '',
      provider: r.provider || '',
      mode: r.mode || '',
      model: r.model || '',
      createdAt: r.created_at || 0,
      updatedAt: r.updated_at || 0,
      pinned: Boolean(r.pinned),
      archived: Boolean(r.archived)
    }));
    return { ok: true, tasks };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), tasks: [] };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

/**
 * Create a debounced demand-driven tasks watcher.
 */
export function createTasksWatcher({ dbPath, debounceMs = 600, onChanged } = {}) {
  const resolvedDbPath = dbPath || path.join(os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
  const dir = path.dirname(resolvedDbPath);
  const baseName = path.basename(resolvedDbPath);
  const walName = `${baseName}-wal`;
  const shmName = `${baseName}-shm`;

  const subscribers = new Set();
  let fsWatcher = null;
  let debounceTimer = null;
  let lastSignature = null;
  let isClosed = false;

  const emitCheck = () => {
    if (isClosed || subscribers.size === 0) return;
    try {
      const res = queryRecentTasks({ limit: 20, dbPath: resolvedDbPath });
      if (!res.ok || !Array.isArray(res.tasks)) return;
      const signature = res.tasks
        .map((t) => `${t.taskId}:${t.updatedAt}:${t.status}:${t.model}`)
        .join('|');
      if (signature !== lastSignature) {
        lastSignature = signature;
        if (typeof onChanged === 'function') {
          onChanged({ tasks: res.tasks, ts: Date.now() });
        }
      }
    } catch {
      // ignore transient file lock errors
    }
  };

  const scheduleDebounce = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      emitCheck();
    }, debounceMs);
    debounceTimer.unref?.();
  };

  const startWatching = () => {
    if (fsWatcher || isClosed) return;
    try {
      if (!fs.existsSync(dir)) return;
      fsWatcher = fs.watch(dir, (eventType, filename) => {
        if (!filename) {
          scheduleDebounce();
          return;
        }
        const fn = String(filename);
        if (fn === baseName || fn === walName || fn === shmName) {
          scheduleDebounce();
        }
      });
      fsWatcher.on?.('error', () => {
        // Watcher error ignored
      });
    } catch {
      // directory might not exist yet
    }
  };

  const stopWatching = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (fsWatcher) {
      try {
        fsWatcher.close();
      } catch {}
      fsWatcher = null;
    }
  };

  return {
    subscribe(subscriberId = 'default') {
      if (isClosed) return { ok: false, error: 'Watcher is closed' };
      subscribers.add(subscriberId);
      if (subscribers.size === 1) {
        startWatching();
      }
      return { ok: true, subscribers: subscribers.size };
    },
    unsubscribe(subscriberId = 'default') {
      subscribers.delete(subscriberId);
      if (subscribers.size === 0) {
        stopWatching();
      }
      return { ok: true, subscribers: subscribers.size };
    },
    getSubscriberCount() {
      return subscribers.size;
    },
    close() {
      isClosed = true;
      subscribers.clear();
      stopWatching();
    }
  };
}

let mainWatcher = null;

function getMainWatcher() {
  if (!mainWatcher) {
    mainWatcher = createTasksWatcher({
      onChanged: (payload) => {
        if (!electronBrowserWindow?.getAllWindows) return;
        for (const win of electronBrowserWindow.getAllWindows()) {
          try {
            if (!win.isDestroyed?.()) {
              win.webContents?.send?.('zmod:tasks-changed', payload);
            }
          } catch {}
        }
      }
    });
  }
  return mainWatcher;
}

export function registerTasksWatchService(gateway) {
  gateway.register('tasks.listRecent', async (params) => queryRecentTasks(params));
  gateway.register('tasks.subscribe', async ({ subscriberId = 'default' } = {}) => {
    return getMainWatcher().subscribe(subscriberId);
  });
  gateway.register('tasks.unsubscribe', async ({ subscriberId = 'default' } = {}) => {
    return getMainWatcher().unsubscribe(subscriberId);
  });
  gateway.register('tasks.watchStatus', async () => {
    const watcher = getMainWatcher();
    const count = watcher.getSubscriberCount();
    return { ok: true, active: count > 0, subscribers: count };
  });
}
