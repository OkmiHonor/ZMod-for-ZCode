import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getUserDataDir, getPluginsDir } from '../common/paths.js';

const MIME = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.apng': 'image/apng',
  '.webp': 'image/webp'
};

const MAX_IMAGE_SIZE = 4 * 1024 * 1024; // 4MB per image

/**
 * Scan a single skins container directory (e.g. whale-skins/ or plugins/whale-widget/skins/).
 *
 * Each skin is a folder <dir>/<skinId>/ containing image.(png|gif|apng|webp),
 * optionally accompanied by meta.json: { name: string, pinned: boolean }.
 *
 * @param {string} baseDir Base directory containing skin subfolders
 * @param {string} source Source tag ('user' | 'builtin')
 * @returns {Array<object>} Array of skin descriptors
 */
export function scanSkinsDir(baseDir, source = 'user') {
  const out = [];
  if (!fs.existsSync(baseDir)) return out;

  let entries = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }

  for (const ent of entries) {
    try {
      const skinId = ent.name;
      // Sanitize skinId to prevent directory traversal
      if (!/^[a-zA-Z0-9_-]+$/.test(skinId)) continue;

      const sdir = path.join(baseDir, skinId);
      let imgPath = '';
      let ext = '';
      for (const e of ['.png', '.gif', '.apng', '.webp']) {
        const cand = path.join(sdir, `image${e}`);
        if (fs.existsSync(cand)) {
          imgPath = cand;
          ext = e;
          break;
        }
      }
      if (!imgPath) continue; // Empty placeholder folder (e.g. glm-fox waiting for art)

      const st = fs.statSync(imgPath);
      if (st.size > MAX_IMAGE_SIZE) continue;

      let name = skinId;
      let pinned = false;
      const metaPath = path.join(sdir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          if (meta && typeof meta.name === 'string' && meta.name.trim()) {
            name = meta.name.trim().slice(0, 30);
          }
          if (meta && meta.pinned === true) pinned = true;
        } catch {}
      }

      const mimeType = MIME[ext] || 'image/png';
      const buf = fs.readFileSync(imgPath);
      out.push({
        id: skinId,
        name,
        format: ext.replace('.', ''),
        ver: `${st.size}-${Math.round(st.mtimeMs)}`,
        pinned,
        source,
        data: `data:${mimeType};base64,${buf.toString('base64')}`
      });
    } catch {}
  }

  return out;
}

/**
 * Load all whale skins, merging builtin plugin skins with user skins from <dataDir>/whale-skins.
 * User custom skins take priority over builtin skins with identical ids.
 */
export async function loadWhaleSkins(options = {}) {
  const dataDir = options.dataDir || getUserDataDir();
  const pluginsDir = options.pluginsDir || getPluginsDir();
  const userSkinsDir = path.join(dataDir, 'whale-skins');
  const builtinSkinsDir = path.join(pluginsDir, 'whale-widget', 'skins');

  // Auto-create user skins directory so users have a ready location to drop images into
  try {
    if (!fs.existsSync(userSkinsDir)) {
      fs.mkdirSync(userSkinsDir, { recursive: true });
    }
  } catch {}

  const builtinSkins = scanSkinsDir(builtinSkinsDir, 'builtin');
  const userSkins = scanSkinsDir(userSkinsDir, 'user');

  // Map by id: user skins override builtin
  const skinMap = new Map();
  for (const s of builtinSkins) skinMap.set(s.id, s);
  for (const s of userSkins) skinMap.set(s.id, s);

  const skins = [...skinMap.values()];
  return {
    ok: true,
    dir: 'whale-skins',
    userDir: userSkinsDir,
    skins
  };
}

/**
 * Query current conversation model from ~/.zcode/v2/tasks-index.sqlite.
 * Level 3 model detection for the whale widget.
 */
export async function getWhaleModel(params = {}, options = {}) {
  const taskId = String(params.taskId || '');
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(taskId)) {
    return { ok: false, error: 'Invalid taskId' };
  }

  const dbPath =
    options.dbPath || path.join(os.homedir(), '.zcode', 'v2', 'tasks-index.sqlite');
  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: 'Database not found' };
  }

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const stmt = db.prepare('SELECT provider, model FROM tasks WHERE task_id = ? LIMIT 1');
      const row = stmt.get(taskId);
      if (row) {
        return {
          ok: true,
          provider: String(row.provider || ''),
          model: String(row.model || '')
        };
      }
      return { ok: false, error: 'Task not found' };
    } finally {
      try {
        db.close();
      } catch {}
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Query authoritative session token usage from ~/.zcode/cli/db/db.sqlite.
 * Filters completed main_turn requests so subagent/background/cancelled queries
 * and cross-session telemetry leaks are excluded.
 */
export async function getSessionUsage(params = {}, options = {}) {
  const sessionId = String(params.sessionId || '').trim();
  if (!sessionId || sessionId === 'draft' || !/^[A-Za-z0-9_.:-]{4,160}$/.test(sessionId)) {
    return { ok: false, error: 'Invalid sessionId' };
  }

  const dbPath =
    options.cliDbPath || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: 'Database not found' };
  }

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      let rows;
      try {
        rows = db.prepare(`
          SELECT id, logical_request_id, turn_id, provider_id, model_id, started_at,
                 input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens
          FROM model_usage
          WHERE session_id = ? AND status = 'completed' AND query_source = 'main_turn'
          ORDER BY started_at ASC, rowid ASC
        `).all(sessionId);
      } catch {
        rows = db.prepare(`
          SELECT id, turn_id, provider_id, model_id, started_at,
                 input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens
          FROM model_usage
          WHERE session_id = ? AND status = 'completed' AND query_source = 'main_turn'
          ORDER BY started_at ASC, rowid ASC
        `).all(sessionId);
      }
      return {
        ok: true,
        sessionId,
        requests: rows.map((r) => ({
          id: String(r.id || ''),
          logicalRequestId: String(r.logical_request_id || ''),
          turnId: String(r.turn_id || ''),
          providerId: String(r.provider_id || ''),
          modelId: String(r.model_id || ''),
          startedAt: Number(r.started_at) || 0,
          input: Number(r.input_tokens) || 0,
          output: Number(r.output_tokens) || 0,
          reasoning: Number(r.reasoning_tokens) || 0,
          cached: Number(r.cache_read_input_tokens) || 0
        }))
      };
    } finally {
      try {
        db.close();
      } catch {}
    }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Register whale RPC methods with the main RpcGateway.
 */
export function registerWhaleService(gateway) {
  gateway.register('whale.loadSkins', async (params) => loadWhaleSkins(params));
  gateway.register('whale.getModel', async (params) => getWhaleModel(params));
  gateway.register('usage.getSessionStats', async (params) => getSessionUsage(params));
}
