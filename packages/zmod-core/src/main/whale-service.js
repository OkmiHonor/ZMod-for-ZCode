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
 * Includes completed requests from the session itself AND any child subagent
 * sessions (session.parent_id = sessionId) unless includeSubagents === false.
 */
export async function getSessionUsage(params = {}, options = {}) {
  const sessionId = String(params.sessionId || '').trim();
  if (!sessionId || sessionId === 'draft' || !/^[A-Za-z0-9_.:-]{4,160}$/.test(sessionId)) {
    return { ok: false, error: 'Invalid sessionId' };
  }
  const includeSubagents = params.includeSubagents !== false;

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
      if (includeSubagents) {
        try {
          rows = db.prepare(`
            SELECT id, logical_request_id, turn_id, session_id, query_source, provider_id, model_id, started_at,
                   input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens
            FROM model_usage
            WHERE status = 'completed'
              AND (
                session_id = ?
                OR session_id IN (SELECT id FROM session WHERE parent_id = ?)
              )
            ORDER BY started_at ASC, rowid ASC
          `).all(sessionId, sessionId);
        } catch {
          try {
            rows = db.prepare(`
              SELECT id, logical_request_id, turn_id, session_id, query_source, provider_id, model_id, started_at,
                     input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens
              FROM model_usage
              WHERE session_id = ? AND status = 'completed'
              ORDER BY started_at ASC, rowid ASC
            `).all(sessionId);
          } catch {
            rows = db.prepare(`
              SELECT id, turn_id, provider_id, model_id, started_at,
                     input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens
              FROM model_usage
              WHERE session_id = ? AND status = 'completed'
              ORDER BY started_at ASC, rowid ASC
            `).all(sessionId);
          }
        }
      } else {
        try {
          rows = db.prepare(`
            SELECT id, logical_request_id, turn_id, session_id, query_source, provider_id, model_id, started_at,
                   input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens
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
      }
      return {
        ok: true,
        sessionId,
        requests: rows.map((r) => ({
          id: String(r.id || ''),
          logicalRequestId: String(r.logical_request_id || ''),
          turnId: String(r.turn_id || ''),
          sessionId: String(r.session_id || sessionId),
          querySource: String(r.query_source || 'main_turn'),
          providerId: String(r.provider_id || ''),
          modelId: String(r.model_id || ''),
          startedAt: Number(r.started_at) || 0,
          input: Number(r.input_tokens) || 0,
          output: Number(r.output_tokens) || 0,
          reasoning: Number(r.reasoning_tokens) || 0,
          cached: Number(r.cache_read_input_tokens) || 0,
          cacheWrite: Number(r.cache_creation_input_tokens) || 0
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

const WINDOW_STATS_CACHE_TTL = 5000;
let windowStatsCache = { key: '', at: 0, data: null };

/**
 * Query account-wide completed model_usage rows across ALL sessions within a
 * rolling time window (default 7 days). Used by usage-stats so 5h/daily/weekly
 * quota and spend do not reset to 0 when the user opens a new chat session.
 */
export async function getGlobalWindowStats(params = {}, options = {}) {
  const now = Number(options.now) || Date.now();
  const rawWin = Number(params.windowMs);
  const windowMs = Number.isFinite(rawWin) && rawWin > 0
    ? Math.min(Math.max(rawWin, 60_000), 31 * 24 * 3600_000)
    : 7 * 24 * 3600_000;
  const since = Number.isFinite(Number(params.since)) && Number(params.since) > 0
    ? Number(params.since)
    : now - windowMs;

  const dbPath =
    options.cliDbPath || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: 'Database not found' };
  }

  const cacheKey = `${dbPath}:${Math.floor(since / 5000)}`;
  const cacheTtl = Number.isFinite(Number(options.cacheTtl)) ? Number(options.cacheTtl) : WINDOW_STATS_CACHE_TTL;
  if (cacheTtl > 0 && windowStatsCache.data && windowStatsCache.key === cacheKey && now - windowStatsCache.at < cacheTtl) {
    return windowStatsCache.data;
  }

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      let rows;
      try {
        rows = db.prepare(`
          SELECT id, logical_request_id, turn_id, session_id, query_source, provider_id, model_id, started_at,
                 input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens
          FROM model_usage
          WHERE status = 'completed' AND started_at >= ?
          ORDER BY started_at ASC, rowid ASC
          LIMIT 10000
        `).all(since);
      } catch {
        rows = db.prepare(`
          SELECT id, turn_id, session_id, provider_id, model_id, started_at,
                 input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens
          FROM model_usage
          WHERE status = 'completed' AND started_at >= ?
          ORDER BY started_at ASC, rowid ASC
          LIMIT 10000
        `).all(since);
      }
      const result = {
        ok: true,
        since,
        requests: rows.map((r) => ({
          id: String(r.id || ''),
          logicalRequestId: String(r.logical_request_id || ''),
          turnId: String(r.turn_id || ''),
          sessionId: String(r.session_id || ''),
          querySource: String(r.query_source || 'main_turn'),
          providerId: String(r.provider_id || ''),
          modelId: String(r.model_id || ''),
          startedAt: Number(r.started_at) || 0,
          input: Number(r.input_tokens) || 0,
          output: Number(r.output_tokens) || 0,
          reasoning: Number(r.reasoning_tokens) || 0,
          cached: Number(r.cache_read_input_tokens) || 0,
          cacheWrite: Number(r.cache_creation_input_tokens) || 0
        }))
      };
      windowStatsCache = { key: cacheKey, at: now, data: result };
      return result;
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
  gateway.register('usage.getWindowStats', async (params) => getGlobalWindowStats(params));
  gateway.register('usage.getAntigravityQuota', async (params) => getAntigravityQuota(params));
  gateway.register('usage.getMagpieQuota', async (params) => getMagpieQuota(params));
  gateway.register('usage.getProviderCatalog', async (params) => getProviderCatalog(params));
}

/* ---- Antigravity Tools 配额文件快照（usage-stats 与 builtin-providers 消费） ----
 * 渲染层无文件权限，此处代读 ~/.antigravity_tools/{accounts.json, accounts/<id>.json}。
 * 网关未运行时快照仍有效（文件由网关每次配额变动时落盘），15s 内存缓存防止
 * 浮窗高频渲染反复读盘；任何读取/解析失败都返回 { ok: false } 由调用方静默降级。
 */

const AG_QUOTA_CACHE_TTL = 15000;
let agQuotaCache = { key: '', at: 0, data: null };

export async function getAntigravityQuota(params = {}, options = {}) {
  const ttl = Number(options.cacheTtl);
  const cacheTtl = Number.isFinite(ttl) ? ttl : AG_QUOTA_CACHE_TTL;
  const reqAccountId = String(params?.accountId || '').trim();
  const cacheKey = `${options.homeDir || ''}:${reqAccountId || '__default__'}`;
  const now = Date.now();
  if (cacheTtl > 0 && agQuotaCache.data && agQuotaCache.key === cacheKey && now - agQuotaCache.at < cacheTtl) {
    return agQuotaCache.data;
  }
  const result = readAntigravityQuota(options, params);
  agQuotaCache = { key: cacheKey, at: now, data: result };
  return result;
}

function readAntigravityQuota(options = {}, params = {}) {
  const home = options.homeDir || os.homedir();
  const dir = path.join(home, '.antigravity_tools');
  try {
    // 1. 优先使用入参 accountId，其次 accounts.json → current_account_id，最后取 accounts/ 最新未禁用文件
    let accountId = String(params?.accountId || '').trim();
    if (!accountId) {
      try {
        const acc = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
        accountId = String(acc.current_account_id || '').trim();
      } catch {}
    }
    const accountsDir = path.join(dir, 'accounts');
    let file = '';
    if (accountId && /^[A-Za-z0-9_.-]+$/.test(accountId)) {
      const candidate = path.join(accountsDir, `${accountId}.json`);
      if (fs.existsSync(candidate)) file = candidate;
    }
    if (!file) {
      if (!fs.existsSync(accountsDir)) return { ok: false, error: 'no accounts dir' };
      const candidates = fs
        .readdirSync(accountsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const full = path.join(accountsDir, f);
          let disabled = false;
          try {
            const j = JSON.parse(fs.readFileSync(full, 'utf8'));
            disabled = j?.disabled === true;
          } catch {}
          return { f, m: fs.statSync(full).mtimeMs, disabled };
        })
        .sort((a, b) => (a.disabled === b.disabled ? b.m - a.m : a.disabled ? 1 : -1));
      if (!candidates.length) return { ok: false, error: 'no account files' };
      file = path.join(accountsDir, candidates[0].f);
    }
    if (!fs.existsSync(file)) return { ok: false, error: 'account file not found' };

    // 2. 账号文件 → quota 段（quota_groups 分组桶 + models 逐模型百分比 + 订阅档位）
    const accJson = JSON.parse(fs.readFileSync(file, 'utf8'));
    const q = accJson && accJson.quota;
    if (!q || typeof q !== 'object') return { ok: false, error: 'no quota section' };
    const groups = (Array.isArray(q.quota_groups) ? q.quota_groups : [])
      .map((g) => ({
        name: String(g.display_name || g.name || ''),
        description: String(g.description || ''),
        buckets: (Array.isArray(g.buckets) ? g.buckets : [])
          .filter((b) => b && Number.isFinite(Number(b.remaining_fraction)))
          .map((b) => ({
            window: String(b.window || ''),
            frac: Number(b.remaining_fraction),
            reset: String(b.reset_time || '')
          }))
      }))
      .filter((g) => g.buckets.length > 0);
    const models = (Array.isArray(q.models) ? q.models : [])
      .filter((m) => m && m.name && Number.isFinite(Number(m.percentage)))
      .map((m) => ({ name: String(m.name).toLowerCase(), percentage: Number(m.percentage), reset: String(m.reset_time || '') }));
    if (groups.length === 0 && models.length === 0) {
      return { ok: false, error: 'quota section empty' };
    }
    return {
      ok: true,
      accountId: String(accJson.id || path.basename(file, '.json')),
      tier: String(q.subscription_tier || ''),
      lastUpdated: Number(q.last_updated) || 0,
      groups,
      models
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

/* ---- Magpie 本地网关文件快照（网关未启动时的离线兜底 + usage-stats 消费） ----
 * 读取 ~/.config/magpie/{quota-history.json, logins.json, usage.jsonl}、
 * ~/.cache/magpie/providers-state.json 与 ~/.config/magpie/quotas.json，
 * 还原每个上游账号/模型的最新剩余百分比、重置时间与 30 天用量。
 */

// 账户元数据索引：以 'agent|user' 全键对齐（真实数据同时存在 'antigravity|user1' 与
// 'zcode|user1'，只用竖线后 user 会让两个 agent 互相覆盖档位）。logins.json 为主源、
// providers-state.json 的 account.logins[] 为辅；任一缺失都静默降级为空映射。
function loadMagpieAccountMeta(configDir, cacheDir) {
  const meta = new Map();
  const statePath = path.join(cacheDir, 'providers-state.json');
  if (fs.existsSync(statePath)) {
    try {
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const providers = Array.isArray(st?.providers?.providers) ? st.providers.providers : [];
      for (const p of providers) {
        const acc = p && typeof p.account === 'object' ? p.account : null;
        if (!acc) continue;
        const logins = Array.isArray(acc.logins) ? acc.logins : [];
        for (const l of logins) {
          if (!l || !l.agent || !l.user) continue;
          meta.set(`${l.agent}|${l.user}`, {
            name: String(l.user),
            plan: String(l.plan || '')
          });
        }
        if (acc.agent && acc.user) {
          meta.set(`${acc.agent}|${acc.user}`, {
            name: String(acc.user),
            plan: String(acc.plan || '')
          });
        }
      }
    } catch {}
  }
  const loginsPath = path.join(configDir, 'logins.json');
  if (fs.existsSync(loginsPath)) {
    try {
      const logins = JSON.parse(fs.readFileSync(loginsPath, 'utf8'));
      for (const l of Array.isArray(logins) ? logins : []) {
        if (!l || !l.agent || !l.user) continue;
        meta.set(`${l.agent}|${l.user}`, {
          name: String(l.user),
          plan: String(l.plan || '')
        });
      }
    } catch {}
  }
  return meta;
}

function readMagpieQuota(options = {}) {
  const home = options.homeDir || os.homedir();
  const configDir = path.join(home, '.config', 'magpie');
  const cacheDir = path.join(home, '.cache', 'magpie');
  const historyPath = path.join(configDir, 'quota-history.json');
  if (!fs.existsSync(historyPath)) {
    return { ok: false, error: 'magpie quota-history.json not found' };
  }
  try {
    // 真实结构是 { 'agent|user': { '模型/窗口标签': [{at,left,start,resetsAt},...] } } 双层嵌套
    const hist = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (!hist || typeof hist !== 'object' || Array.isArray(hist)) {
      return { ok: false, error: 'magpie quota-history empty' };
    }

    const accountMeta = loadMagpieAccountMeta(configDir, cacheDir);

    // 每个 (账户, 标签) 取 at 最大的一条快照；at 是唯一可靠的新鲜度信号
    const latestByKey = new Map();
    for (const [acc, labels] of Object.entries(hist)) {
      if (!labels || typeof labels !== 'object') continue;
      for (const [label, snaps] of Object.entries(labels)) {
        if (!label || !Array.isArray(snaps)) continue;
        for (const s of snaps) {
          if (!s || typeof s !== 'object') continue;
          const left = Number(s.left);
          const atStr = String(s.at || '');
          const atMs = Date.parse(atStr);
          if (!Number.isFinite(left) || !Number.isFinite(atMs)) continue;
          const k = `${acc}::${label}`;
          const prev = latestByKey.get(k);
          if (!prev || atMs > prev.atMs) {
            latestByKey.set(k, { acc, label, left, atMs, at: atStr, resetsAt: s.resetsAt });
          }
        }
      }
    }
    if (latestByKey.size === 0) {
      return { ok: false, error: 'no valid quota entries' };
    }

    const groupsMap = new Map();
    const models = [];
    for (const item of latestByKey.values()) {
      // 元数据缺失时保守降级：展示名用账户键原文，档位留空
      const meta = accountMeta.get(item.acc) || { name: item.acc, plan: '' };
      if (!groupsMap.has(item.acc)) {
        groupsMap.set(item.acc, {
          name: meta.name || item.acc,
          plan: meta.plan || '',
          buckets: []
        });
      }
      const remainingPct = Math.max(0, Math.min(100, item.left));
      groupsMap.get(item.acc).buckets.push({
        window: item.label,
        frac: remainingPct / 100,
        reset: item.resetsAt != null ? String(item.resetsAt) : '',
        display: `${remainingPct.toFixed(1)}%`,
        // 新增字段：前端按 at 最新选桶；accountAgent 供按 agent 前缀匹配
        at: item.at,
        accountAgent: item.acc.split('|')[0] || ''
      });
      models.push({
        name: item.label.toLowerCase(),
        percentage: Math.max(0, 100 - remainingPct),
        remaining: remainingPct,
        reset: item.resetsAt != null ? String(item.resetsAt) : ''
      });
    }

    // antigravity 账户追加 quotas.json 的池化窗口（pool 汇总比 per-model 标签更适合浮窗）
    const quotasPath = path.join(configDir, 'quotas.json');
    if (fs.existsSync(quotasPath)) {
      try {
        const qj = JSON.parse(fs.readFileSync(quotasPath, 'utf8'));
        for (const [acc, info] of Object.entries(qj || {})) {
          const group = groupsMap.get(acc);
          if (!group || !acc.startsWith('antigravity|')) continue;
          const windows = Array.isArray(info?.quota?.windows) ? info.quota.windows : [];
          // 同 pool 取 used 最大的一条（保守估计）
          const byPool = new Map();
          for (const w of windows) {
            const pool = String(w?.pool || w?.name || '').trim();
            const used = Number(w?.used);
            if (!pool || !Number.isFinite(used)) continue;
            const prev = byPool.get(pool);
            if (!prev || used > prev.used) {
              byPool.set(pool, { used, name: String(w.name || ''), resetsAt: w.resetsAt });
            }
          }
          for (const [pool, p] of byPool) {
            const frac = Math.max(0, Math.min(1, 1 - p.used / 100));
            group.buckets.push({
              window: pool,
              frac,
              reset: p.resetsAt != null ? String(p.resetsAt) : '',
              display: `${(frac * 100).toFixed(1)}%`,
              at: String(info?.at || ''),
              accountAgent: acc.split('|')[0] || ''
            });
          }
        }
      } catch {}
    }

    // 读取近 30 天 usage.jsonl（真实字段为 t/in/out/cache_read/status）
    let usage = null;
    const usagePath = path.join(configDir, 'usage.jsonl');
    if (fs.existsSync(usagePath)) {
      try {
        const raw = fs.readFileSync(usagePath, 'utf8');
        const cutoffMs = Date.now() - 30 * 86400 * 1000;
        let calls = 0, errors = 0, input = 0, output = 0, cacheRead = 0;
        for (const line of raw.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const u = JSON.parse(line);
            const tsMs = Date.parse(String(u.t || ''));
            if (Number.isFinite(tsMs) && tsMs < cutoffMs) continue;
            calls++;
            if (Number(u.status) >= 400) errors++;
            // t 无法解析的行无法判龄，只计调用不计 tokens
            if (!Number.isFinite(tsMs)) continue;
            input += Number(u.in) || 0;
            output += Number(u.out) || 0;
            cacheRead += Number(u.cache_read) || 0;
          } catch {}
        }
        if (calls > 0) {
          usage = { period: '30d', calls, errors, input, output, cacheRead, cost: null };
        }
      } catch {}
    }

    const groups = [...groupsMap.values()];
    const plan = groups.map((g) => g.plan).find(Boolean) || '';
    return {
      ok: true,
      source: 'local-file',
      plan,
      groups,
      models,
      usage
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
const MAGPIE_CACHE_TTL = 15000;
let magpieQuotaCache = { key: '', at: 0, data: null };

export async function getMagpieQuota(params = {}, options = {}) {
  const ttl = Number(options.cacheTtl);
  const cacheTtl = Number.isFinite(ttl) ? ttl : MAGPIE_CACHE_TTL;
  const cacheKey = String(options.homeDir || '');
  const now = Date.now();
  if (cacheTtl > 0 && magpieQuotaCache.data && magpieQuotaCache.key === cacheKey && now - magpieQuotaCache.at < cacheTtl) {
    return magpieQuotaCache.data;
  }
  const result = readMagpieQuota(options);
  magpieQuotaCache = { key: cacheKey, at: now, data: result };
  return result;
}

/* ---- ZCode 供应商目录（不含任何密钥，供 quota-popover 与 usage-stats 桥接匹配） ---- */
const CATALOG_CACHE_TTL = 15000;
let catalogCache = { key: '', at: 0, data: null };

export async function getProviderCatalog(params = {}, options = {}) {
  const home = options.homeDir || os.homedir();
  const cfgPath = options.providerConfigPath || path.join(home, '.zcode', 'v2', 'provider_config.json');
  const now = Date.now();
  const cacheTtl = Number.isFinite(Number(options.cacheTtl)) ? Number(options.cacheTtl) : CATALOG_CACHE_TTL;
  if (cacheTtl > 0 && catalogCache.data && catalogCache.key === cfgPath && now - catalogCache.at < cacheTtl) {
    return catalogCache.data;
  }
  if (!fs.existsSync(cfgPath)) {
    return { ok: false, error: 'provider_config.json not found', providers: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const rules =
      raw?.config?.providerConfigRules?.providerRules ||
      raw?.providerConfigRules?.providerRules ||
      [];
    const providers = (Array.isArray(rules) ? rules : [])
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({
        id: String(r.providerId || ''),
        name: String(r.providerName || ''),
        templateId: String(r.templateId || ''),
        enabled: r.enabled !== false,
        apiType: String(r.config?.api?.type || ''),
        baseUrl: String(r.config?.api?.baseUrl || ''),
        models: (Array.isArray(r.models) ? r.models : [])
          .map((m) => String(typeof m === 'string' ? m : m?.id || m?.modelId || m?.name || ''))
          .filter(Boolean)
      }));
    const result = { ok: true, providers };
    catalogCache = { key: cfgPath, at: now, data: result };
    return result;
  } catch (err) {
    return { ok: false, error: String(err?.message || err), providers: [] };
  }
}
