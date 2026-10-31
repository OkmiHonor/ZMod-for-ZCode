/**
 * Patch rows an uninstall was going to orphan, recorded before the remove.
 *
 * Why this exists (#987): an uninstall removes the package first and clears the
 * rows its bundle patch declares second — `rowIdsForPackage` has to be asked
 * BEFORE the remove, because the remove deletes the patch it reads (#799). On
 * a host that unloads this plugin in the middle of the operation (the official
 * Desktop replays its plugin set after a profile change, #962), the second half
 * never runs and the rows outlive their package. A `- id: pet` insert for a
 * package that is no longer installed is not cosmetic: DSH's boot is
 * all-or-nothing, so one row naming a missing module can keep the whole host
 * from starting, and the way out was editing cordis.patch.yml by hand.
 *
 * So the intent is written down before the destructive step, exactly like the
 * interrupted-update journal next door, and the next start settles it against
 * disk truth: rows whose package is gone are removed, and a record whose
 * package is still installed is dropped untouched (the remove never happened,
 * or the user put it back — either way the rows are exactly as configuration
 * should be).
 *
 * The rows this settles are the ones the market writes and `removeRowBlocks`
 * understands — `- id: X` + `disabled:` blocks. Rows that declare a package's
 * own config live in that package's patch; a copy of one in the profile patch
 * is the host's (the manager's install dialog writes those) and is not this
 * module's to interpret.
 *
 * What this cannot do is run when the host never starts: the repair happens
 * inside the host, after composition. It covers the case that produced the
 * report — a host that stayed up while this plugin was unloaded — and the next
 * ordinary start after a restart.
 */
export interface PendingRowCleanup {
    id: string;
    profile: string;
    /** The package being removed; also what decides whether the rows are orphans. */
    name: string;
    /** The profile patch layer the rows live in, absolute. */
    patchPath: string;
    /** Loader row ids the package's own bundle patch declares. */
    rows: string[];
    startedAt: string;
}
export interface PendingRowInput {
    profile: string;
    name: string;
    patchPath: string;
    rows: readonly string[];
}
/** Same directory as the other durable per-profile state (see pending-updates.ts). */
export declare function pendingRowsFile(profileDirectory: string): string;
export declare class PendingRowJournal {
    readonly file: string;
    constructor(file: string);
    static forProfile(profileDirectory: string): PendingRowJournal;
    list(): PendingRowCleanup[];
    /** Record what a remove is about to orphan. Upserts by profile+name. */
    begin(input: PendingRowInput): void;
    /** The rows were cleaned (or the remove never happened): nothing left to settle. */
    finish(profile: string, name: string): void;
    private read;
    private write;
}
export interface OrphanRowReport {
    /** Packages whose rows were removed this start. */
    removed: string[];
    /** Records dropped because the package is still installed. */
    kept: string[];
    /** Records whose rows could not be removed; they are retried next start. */
    failed: string[];
}
/**
 * Settle every recorded remove against what the profile actually holds now.
 *
 * @param options.profile - Profile name, for reading the installed map.
 * @param options.profileDirectory - Its directory, when the host named one.
 * @returns what happened, per record.
 */
export declare function repairOrphanedRows(options: {
    profile: string;
    profileDirectory?: string;
}): OrphanRowReport;
