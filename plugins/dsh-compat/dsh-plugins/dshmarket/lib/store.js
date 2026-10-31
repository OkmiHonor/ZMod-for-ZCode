/**
 * pnpm store hygiene: reclaim staging directories orphaned by aborted runs,
 * and the profile-side quarantine pnpm never empties (`node_modules/.ignored`).
 *
 * pnpm extracts every fetched tarball under the store's `tmp/` directory as
 * `tmp/_tmp_<pid>_<hex>/`. A run that is killed, cancelled, or timed out —
 * or one that hard-fails mid-fetch — never finishes that staging step, so
 * the directory survives. For `github:` sources the staged payload is the
 * WHOLE repository tarball, so a single aborted install can leave hundreds
 * of megabytes behind (e.g. an OpenViking monorepo install killed at ~88MB).
 *
 * The directory name carries the owning pnpm process id, which makes
 * reclamation safe by construction: when that pid is gone, no live download
 * can be using the directory. Live pnpm tmp dirs are never touched.
 *
 * Separately, under `nodeLinker: hoisted` pnpm moves alien / interrupted
 * package directories into `node_modules/.ignored` and never reclaims them
 * (#974; pnpm #13720). Those copies are already out of the tree — Node does
 * not resolve through `.ignored` — so they are safe to delete once our pnpm
 * process has exited. The pid in a `_tmp_<pid>_` name is historical there
 * and is not consulted (Windows reuses pids; a live match would skip a
 * dead quarantine). `.bak` leftovers stay: they are someone else's wreckage,
 * not pnpm staging (#205, #974).
 */
import { readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { logEvent } from './log.js';
/** pnpm store tmp staging prefix: `_tmp_<pid>_<random-hex>/`. */
const ORPHAN_TMP_RE = /^_tmp_(\d+)_/;
/** True when the process with this pid is still running (EPERM = exists). */
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
/**
 * Remove every orphaned staging directory under a pnpm store's `tmp/` whose
 * owning pid is no longer alive. Directories that do not match the pnpm
 * staging shape, and any that are locked or in use, are left alone.
 * @param storePath - the pnpm store root (as printed by `pnpm store path`).
 * @returns the removed directory names.
 */
export function cleanOrphanedStoreTmp(storePath) {
    const tmp = join(storePath, 'tmp');
    let entries;
    try {
        entries = readdirSync(tmp, { withFileTypes: true });
    }
    catch {
        return []; // no store tmp dir — nothing to reclaim
    }
    const removed = [];
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const m = ORPHAN_TMP_RE.exec(entry.name);
        if (m === null)
            continue;
        const pid = Number(m[1]);
        if (pid > 0 && pidAlive(pid))
            continue;
        try {
            rmSync(join(tmp, entry.name), { recursive: true, force: true });
            removed.push(entry.name);
        }
        catch {
            // Locked or still being written — leave it for a later run.
        }
    }
    return removed;
}
/**
 * Resolve the active profile's pnpm store root through the same runner the
 * market uses for installs (so both the web and Desktop pnpm paths agree)
 * and reclaim its orphaned staging directories.
 * @returns the removed directory names, empty when the store cannot be resolved.
 */
export async function cleanOrphanedStore(run, profile) {
    let result;
    try {
        result = await run(profile, ['store', 'path']);
    }
    catch {
        return [];
    }
    if (result.exitCode !== 0 || result.cancelled)
        return [];
    const lines = result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '');
    const storePath = lines[lines.length - 1] ?? '';
    if (storePath === '' || !isAbsolute(storePath))
        return [];
    const removed = cleanOrphanedStoreTmp(storePath);
    if (removed.length > 0) {
        logEvent('info', 'install', `removed ${removed.length} orphaned pnpm store tmp dir(s) under ${storePath}: ${removed.slice(0, 3).join(', ')}${removed.length > 3 ? ', …' : ''}`);
    }
    return removed;
}
/** Same `.bak` shapes backup.ts refuses to re-export (#205). */
const BAK_NAME = /\.bak\b/;
/**
 * Remove quarantined copies under the profile's `node_modules/.ignored`,
 * except `.bak` leftovers. Scoped directories are walked one level so a
 * leftover `@jimp/png` is reclaimed without deleting `@scope/foo.bak-*`.
 * Locked entries are left for a later run.
 */
export function cleanOrphanedIgnored(profileDirectory) {
    const ignored = join(profileDirectory, 'node_modules', '.ignored');
    let entries;
    try {
        entries = readdirSync(ignored, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const removed = [];
    for (const entry of entries) {
        if (BAK_NAME.test(entry.name))
            continue;
        const path = join(ignored, entry.name);
        if (entry.isDirectory() && entry.name.startsWith('@')) {
            let children;
            try {
                children = readdirSync(path, { withFileTypes: true });
            }
            catch {
                continue;
            }
            let kept = 0;
            for (const child of children) {
                if (BAK_NAME.test(child.name)) {
                    kept += 1;
                    continue;
                }
                try {
                    rmSync(join(path, child.name), { recursive: true, force: true });
                    removed.push(`${entry.name}/${child.name}`);
                }
                catch {
                    kept += 1;
                }
            }
            if (kept === 0) {
                try {
                    rmSync(path, { recursive: true, force: true });
                }
                catch { /* leave the empty scope */ }
            }
            continue;
        }
        try {
            rmSync(path, { recursive: true, force: true });
            removed.push(entry.name);
        }
        catch {
            // Locked or still being written — leave it for a later run.
        }
    }
    return removed;
}
