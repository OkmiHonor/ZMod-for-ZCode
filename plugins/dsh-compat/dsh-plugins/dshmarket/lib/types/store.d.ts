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
import type { PluginRunner } from './dsh-cli.ts';
/**
 * Remove every orphaned staging directory under a pnpm store's `tmp/` whose
 * owning pid is no longer alive. Directories that do not match the pnpm
 * staging shape, and any that are locked or in use, are left alone.
 * @param storePath - the pnpm store root (as printed by `pnpm store path`).
 * @returns the removed directory names.
 */
export declare function cleanOrphanedStoreTmp(storePath: string): string[];
/**
 * Resolve the active profile's pnpm store root through the same runner the
 * market uses for installs (so both the web and Desktop pnpm paths agree)
 * and reclaim its orphaned staging directories.
 * @returns the removed directory names, empty when the store cannot be resolved.
 */
export declare function cleanOrphanedStore(run: PluginRunner, profile: string): Promise<string[]>;
/**
 * Remove quarantined copies under the profile's `node_modules/.ignored`,
 * except `.bak` leftovers. Scoped directories are walked one level so a
 * leftover `@jimp/png` is reclaimed without deleting `@scope/foo.bak-*`.
 * Locked entries are left for a later run.
 */
export declare function cleanOrphanedIgnored(profileDirectory: string): string[];
