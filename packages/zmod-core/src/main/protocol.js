import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getPluginsDir, getRuntimeDir } from '../common/paths.js';
import { rpcGateway } from './rpc.js';

export const SCHEME = 'zmod-local';

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
};

const SDK_IMPORT_RE = /(['"])@zmod\/sdk(?:\/([a-zA-Z0-9_-]+))?\1/g;

let electron = null;
try {
  electron = await import('electron');
} catch {
  // Not in Electron (unit tests)
}
const electronProtocol = electron?.protocol ?? electron?.default?.protocol;

export function registerPrivileges() {
  if (!electronProtocol) return false;
  if (globalThis.__ZMOD_V2_PRIV__) return true;
  try {
    electronProtocol.registerSchemesAsPrivileged([
      {
        scheme: SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true
        }
      }
    ]);
    globalThis.__ZMOD_V2_PRIV__ = true;
    return true;
  } catch (err) {
    console.error('[ZMod:Protocol] registerSchemesAsPrivileged failed:', err?.message || err);
    return false;
  }
}

/**
 * Map "zmod-local://<host>/<path>" to a real file.
 * String parsing instead of new URL() so routing still works even if the
 * scheme could not be registered as standard/privileged.
 */
export function resolveHostFile(urlStr) {
  if (!urlStr || !urlStr.startsWith(SCHEME + '://')) return null;
  const rest = urlStr.slice(SCHEME.length + 3);
  const slash = rest.indexOf('/');
  const host = slash < 0 ? rest : rest.slice(0, slash);
  let pathname = slash < 0 ? '' : rest.slice(slash + 1);
  pathname = pathname.split('?')[0].split('#')[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  pathname = pathname.replace(/^\/+/, '');

  let root;
  if (host === 'core') {
    root = path.join(getRuntimeDir(), 'core');
  } else if (host === 'sdk') {
    root = path.join(getRuntimeDir(), 'sdk');
  } else if (host === 'plugins') {
    const parts = pathname.split('/');
    const pluginId = parts.shift();
    if (!pluginId || !/^[a-zA-Z0-9_-]+$/.test(pluginId)) return null;
    root = path.join(getPluginsDir(), pluginId);
    pathname = parts.join('/');
  } else {
    return null;
  }

  if (!pathname) pathname = 'index.js';
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, pathname);
  // traversal guard: resolved path must stay inside the host root
  if (target !== absRoot && !target.startsWith(absRoot + path.sep)) return null;
  return { host, file: target };
}

/** Rewrite bare "@zmod/sdk" specifiers to absolute zmod-local URLs (browsers cannot resolve bare specifiers). */
export function rewriteSdkSpecifiers(code) {
  return String(code).replace(SDK_IMPORT_RE, (_m, q, sub) => {
    const file = sub ? `${sub}.js` : 'index.js';
    return `${q}${SCHEME}://sdk/${file}${q}`;
  });
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    ...extra
  };
}

function notFound(urlStr) {
  return new Response(`[ZMod:Protocol] File not found: ${urlStr}`, {
    status: 404,
    headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' })
  });
}

async function handleRpcRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== 'POST') {
    return new Response('[ZMod:RPC] POST only', {
      status: 405,
      headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' })
    });
  }
  try {
    const body = await request.text();
    const { method, params } = JSON.parse(body || '{}');
    const result = await rpcGateway.dispatch(method, params);
    return new Response(JSON.stringify(result ?? null), {
      headers: corsHeaders({ 'Content-Type': 'application/json' })
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err?.message || err) }), {
      status: 500,
      headers: corsHeaders({ 'Content-Type': 'application/json' })
    });
  }
}

export function registerProtocolHandler() {
  if (!electronProtocol) return false;
  try {
    electronProtocol.handle(SCHEME, async (request) => {
      const urlStr = request.url;
      if (urlStr.startsWith(`${SCHEME}://rpc`)) {
        return handleRpcRequest(request);
      }
      try {
        const resolved = resolveHostFile(urlStr);
        if (!resolved) return notFound(urlStr);
        const { host, file } = resolved;
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return notFound(urlStr);

        const ext = path.extname(file).toLowerCase();
        const mime = MIME[ext] || 'application/octet-stream';
        const headers = corsHeaders({ 'Content-Type': mime, 'Cache-Control': 'no-cache' });

        // Plugin sources are user-authored: rewrite the SDK bare specifier.
        // core/sdk runtime files are dependency-free and served as-is.
        if (host === 'plugins' && (ext === '.js' || ext === '.mjs')) {
          const code = rewriteSdkSpecifiers(fs.readFileSync(file, 'utf8'));
          return new Response(code, { headers });
        }
        return new Response(fs.readFileSync(file), { headers });
      } catch (err) {
        console.error('[ZMod:Protocol] handler error:', err);
        return new Response(`[ZMod:Protocol] Internal error: ${err?.message || err}`, {
          status: 500,
          headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' })
        });
      }
    });
    return true;
  } catch (err) {
    console.error('[ZMod:Protocol] register handler failed:', err?.message || err);
    return false;
  }
}

export { pathToFileURL };
