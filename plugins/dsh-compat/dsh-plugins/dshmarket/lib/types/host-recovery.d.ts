/**
 * What DSH's own fatal recovery leaves behind (#875).
 *
 * When a boot fails, the desktop shell offers a recovery prompt. Using it
 * runs `sanitizeProfile` in `@deepseek-ai/dsh-app-boot`, and that does not
 * edit the profile patch — it renames `cordis.patch.yml` to a
 * `<patch>.bak-<epoch ms>` sibling, writes a small default stub in its place,
 * and restores the bundle list it was handed. The app then comes up normally,
 * so from the outside there is no error at all: the stub looks exactly like a
 * patch that never had content, and the backup is an unlabelled file sitting
 * next to it with no timestamp a person would read. In the report that found
 * this, 22 KB of providers, models, model defaults and permission presets
 * vanished that way and nothing on screen said so.
 *
 * DSH core is the one destroying data, and the fix for that belongs upstream
 * (never overwrite a patch that has content; keep an unticked entry as a
 * disabled row instead of dropping it from `dsh.profile.bundles`). But the
 * promise the user was acting on is this page's — the market's own recovery
 * surface is the documented way back to a booting app — so the market carries
 * the detection and the way back.
 *
 * The shape this looks for is deliberately narrow: a sibling named exactly
 * `<patch name>.bak-<digits>`, holding rows, LARGER than the live patch, and
 * naming rows the live patch no longer has. A hand-edited file, the market's
 * own `.bak` shapes (`package.json.bak-asm` and friends), an older backup, or
 * a patch that simply lost a row are all outside this surface — the point is
 * to speak up only when the evidence is unambiguous, because a false alarm
 * here trains the user to ignore the one that matters.
 */
/** One `.bak-<epoch ms>` sibling of the profile patch. */
export interface HostRecoveryBackup {
    /** File name as it sits next to the patch. */
    name: string;
    /** Epoch ms parsed out of the name, or null when the name is not the host's shape. */
    stamp: number | null;
    bytes: number;
    /** Row ids the backup carries (insert titles and toggled rows). */
    rowIds: string[];
}
/** What the profile patch looks like now, next to what the backups still hold. */
export interface HostRecoveryView {
    /** The live patch's file name, for the wording. */
    patchName: string;
    currentBytes: number;
    currentRowIds: string[];
    /** Newest first, and only backups that carry rows — a stub is not a restore point. */
    backups: HostRecoveryBackup[];
    /** Row ids the newest backup carries and the live patch no longer does. */
    lostRowIds: string[];
    /**
     * True only for the wipe shape: a backup with rows exists, the live patch is
     * the smaller file, and rows it used to have are gone. Everything the UI
     * says hangs off this, so it stays conservative.
     */
    offerRestore: boolean;
}
/**
 * Read the profile's recovery state. Never throws: a profile the market
 * cannot read is a profile with nothing to offer, not a broken request.
 */
export declare function readHostRecoveryView(patchPath: string): HostRecoveryView;
/** The outcome of putting one backup back. */
export type HostRecoveryRestoreResult = {
    ok: true;
    /** The snapshot taken before the write, so this is undoable from the UI. */
    snapshot: string | null;
    restored: {
        name: string;
        bytes: number;
        rows: number;
    };
} | {
    ok: false;
    error: string;
};
/**
 * Put one backup back in place of the live patch.
 *
 * Three things happen in order, and each one is there for a reason:
 *
 * 1. a profile snapshot, so the restore is undoable the same way every other
 *    write on this page is (issue #98);
 * 2. the live patch is RENAMED, never deleted — it is what the app is running
 *    with right now, and a user who restores the wrong backup must still find
 *    it there;
 * 3. the backup's bytes are written to a temp file and renamed into place, so
 *    an interrupted write cannot leave a half patch behind, which is the one
 *    outcome that would not boot at all.
 *
 * The backup file itself is left where it is: it is the other copy of the
 * user's configuration, and this function has no business being the last
 * thing that ever held it.
 */
export declare function restoreHostRecoveryBackup(patchPath: string, profileDir: string, name: string, maxSnapshots?: number): HostRecoveryRestoreResult;
