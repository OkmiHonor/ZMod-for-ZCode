/**
 * Host patch templates. All patches are marker-guarded and idempotent:
 * re-running install on an already-patched tree is a no-op per patch.
 *
 * Markers (also used for asar binary scanning):
 *   __ZMOD_V2_HEAD__      out/main/index.js prepend  (scheme privileges, sync before ready)
 *   __ZMOD_V2_TAIL__      out/main/index.js append   (dynamic import of the external runtime)
 *   __ZMOD_V2_PRELOAD__   out/preload/index.cjs append (CJS contextBridge → zmodAPI)
 *   __ZMOD_V2_RENDERER__  out/renderer/index.html    (one module script tag)
 *
 * Production scar tissue honored here:
 *   - No static imports in the TAIL (imports get hoisted above host code) — the
 *     head patch is the only static import, and it is intentionally placed
 *     before every host statement so privileges register before app ready.
 *   - Preload runs sandboxed: CommonJS only, no top-level await.
 *   - The renderer boot is a single script tag; everything else loads through
 *     the zmod-local:// protocol from the user data dir.
 */

export const MARKERS = {
  head: '__ZMOD_V2_HEAD__',
  tail: '__ZMOD_V2_TAIL__',
  preload: '__ZMOD_V2_PRELOAD__',
  renderer: '__ZMOD_V2_RENDERER__'
};

/** V1 (legacy inline-monolith ZMod) detection markers — install must refuse these hosts. */
export const V1_MARKERS = ['__ZMOD_INITIALIZED__', '__ZMOD_TELEMETRY_TAP__', '__zmodAcrylic'];

export const MAIN_HEAD = (version) => `/*${MARKERS.head} v${version} */
import { protocol as __ZMOD_PROTOCOL__ } from "electron";
try {
  if (!globalThis.__ZMOD_V2_PRIV__) {
    __ZMOD_PROTOCOL__.registerSchemesAsPrivileged([{
      scheme: "zmod-local",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }]);
    globalThis.__ZMOD_V2_PRIV__ = true;
  }
} catch (__zmodErr) {
  console.error("[ZMod] scheme privilege registration failed:", __zmodErr);
}
`;

export const MAIN_TAIL = (version, userDataDir) => `
;/*${MARKERS.tail} v${version} */
;(async () => {
  try {
    const zpath = await import("node:path");
    const zos = await import("node:os");
    const zurl = await import("node:url");
    // userDataDir 在安装时由 CLI 烧入（数据目录跟随 ZMod 程序目录）；
    // 环境变量始终可覆盖；烧入值为空时兜底旧版 %APPDATA%/ZMod。
    const ud = process.env.ZMOD_USER_DATA_DIR
      ? zpath.resolve(process.env.ZMOD_USER_DATA_DIR)
      : ${userDataDir ? JSON.stringify(userDataDir) : 'null'}
        || (process.platform === "win32"
          ? zpath.join(process.env.APPDATA || zpath.join(zos.homedir(), "AppData", "Roaming"), "ZMod")
          : process.platform === "darwin"
            ? zpath.join(zos.homedir(), "Library", "Application Support", "ZMod")
            : zpath.join(process.env.XDG_CONFIG_HOME || zpath.join(zos.homedir(), ".config"), "zmod"));
    const bootUrl = zurl.pathToFileURL(zpath.join(ud, "runtime", "main", "index.js")).href;
    await import(bootUrl);
  } catch (err) {
    console.error("[ZMod] runtime bootstrap failed:", err);
  }
})();
`;

export const PRELOAD_TAIL = (version) => `
;/*${MARKERS.preload} v${version} */
;(function () {
  try {
    var __zmodE = require("electron");
    __zmodE.contextBridge.exposeInMainWorld("zmodAPI", {
      version: "${version}",
      invoke: function (method, params) {
        try {
          return __zmodE.ipcRenderer.invoke("zmod:rpc:invoke", { method: method, params: params || {} });
        } catch (err) {
          return Promise.reject(err);
        }
      },
      on: function (channel, listener) {
        var wrapped = function (event) {
          var args = [].slice.call(arguments, 1);
          listener.apply(null, args);
        };
        __zmodE.ipcRenderer.on(channel, wrapped);
        return function () { __zmodE.ipcRenderer.removeListener(channel, wrapped); };
      }
    });
  } catch (err) {
    console.error("[ZMod:Preload] bridge failed:", err);
  }
})();
`;

export const RENDERER_TAG = (version) =>
  `<script type="module" src="zmod-local://core/index.js"></script><!--${MARKERS.renderer} v${version} -->`;

export function patchMainSource(src, version, userDataDir) {
  let out = src;
  let changed = false;
  if (!out.includes(MARKERS.head)) {
    out = MAIN_HEAD(version) + out;
    changed = true;
  }
  if (!out.includes(MARKERS.tail)) {
    out = out.replace(/\s*$/, '\n') + MAIN_TAIL(version, userDataDir);
    changed = true;
  }
  return { code: out, changed };
}

export function patchPreloadSource(src, version) {
  if (src.includes(MARKERS.preload)) return { code: src, changed: false };
  return { code: src.replace(/\s*$/, '\n') + PRELOAD_TAIL(version), changed: true };
}

export function patchIndexHtmlSource(src, version) {
  if (src.includes(MARKERS.renderer)) return { code: src, changed: false };
  const tag = RENDERER_TAG(version);
  const matches = [...src.matchAll(/<\/body\s*>/gi)];
  if (matches.length > 0) {
    const last = matches[matches.length - 1];
    const idx = last.index;
    return { code: src.slice(0, idx) + tag + '\n  ' + src.slice(idx), changed: true };
  }
  // No </body> anchor (should not happen for a Vite build): append safely.
  return { code: src + '\n' + tag + '\n', changed: true };
}
