/**
 * The journal for the desktop manager's only update shape: remove, then add.
 *
 * dsh 0.2.1's plugin manager has no in-place update (#896): `add` on a package
 * the profile already declares is refused before pnpm runs. Every update on
 * that host is therefore two operations — `removeBundle` and `installBundle` —
 * and the first one writes the profile. When the host's own reload never
 * returns (its reconciliation awaits plugin lifecycles with no deadline), the
 * removal is already on disk and the replacement never runs: after the next
 * restart the plugin is simply gone (#928).
 *
 * This journal is written BEFORE the removal and cleared only once the install
 * settles. The next start reads it and puts back whatever is missing, so an
 * interrupted update ends as "installed, one restart later" instead of as a
 * plugin the user has to notice is gone.
 *
 * The file lives beside the market's other per-profile state
 * (`<profile>/.dsh-market/`), not in the market's memory and not in DSH home:
 * a profile copied or reset elsewhere must not inherit another profile's
 * unfinished update, and a test that builds a throwaway profile must not touch
 * the real one.
 */
/** One removal that has not been answered by a settled install. */
export interface PendingUpdate {
    id: string;
    profile: string;
    name: string;
    /** Version present before the removal; empty when the manifest could not tell. */
    from: string;
    /** Exact version being installed; empty when the spec was a range or tag. */
    to: string;
    /** The spec the user's update targeted, used when `to` is not exact. */
    spec: string;
    step: 'removing' | 'installing';
    attempts: number;
    startedAt: string;
}
export interface PendingUpdateInput {
    profile: string;
    name: string;
    from: string;
    to: string;
    spec: string;
}
/**
 * The per-profile journal file.
 *
 * The market's other durable per-profile state (`state.json`, `log.ndjson`)
 * already lives in this directory, so this needs no new location, no DSH home
 * resolution, and no path handed down from the host.
 */
export declare function pendingUpdatesFile(profileDirectory: string): string;
export declare class PendingUpdateJournal {
    readonly file: string;
    constructor(file: string);
    static forProfile(profileDirectory: string): PendingUpdateJournal;
    list(): PendingUpdate[];
    /**
     * Record an update that is about to unload its plugin. Upserts by
     * profile+name: a retry of the same update replaces the earlier record
     * instead of leaving a second one to repair on the next start.
     */
    begin(input: PendingUpdateInput): PendingUpdate;
    mark(id: string, step: PendingUpdate['step']): void;
    /** The install settled: there is nothing left to repair for this package. */
    finish(id: string): void;
    /**
     * Drop any record for one package. An explicit uninstall supersedes an
     * interrupted update; repairing afterwards would resurrect a plugin the
     * user just removed on purpose.
     */
    forget(profile: string, name: string): void;
    /** Count a start that could not settle it, without forgetting the record. */
    bump(id: string): void;
    private read;
    /** Same-directory replace: a crash mid-write leaves the previous journal, not half a record. */
    private write;
}
/** A desktop-manager call that did not settle within its deadline. */
export declare class DeadlineExceeded extends Error {
    readonly label: string;
    readonly ms: number;
    constructor(label: string, ms: number);
}
/**
 * Bound a manager call that the host should answer but may never do.
 *
 * The host's reconciliation has no deadline of its own, so a plugin whose
 * lifecycle never settles takes the promise with it: the route waits forever
 * and the UI keeps saying "updating". A deadline cannot cancel the host, but
 * it ends the market's wait, and the journal makes the next start finish the
 * job.
 */
export declare function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T>;
/** The subset of the desktop manager repair needs; structural on purpose. */
export interface RepairManager {
    installBundle(spec: string, options?: {
        requestId?: string;
    }): Promise<{
        application: string;
        error?: unknown;
        packageResult?: {
            exitCode: number | null;
        };
    }>;
}
export interface RepairOptions {
    profile: string;
    profileDirectory: string;
    manager: RepairManager;
    journal?: PendingUpdateJournal;
    timeoutMs?: number;
}
export interface RepairReport {
    /** Packages a previous start removed and this one put back. */
    reinstalled: string[];
    /** Records that needed no work: the profile already held a settled version. */
    finished: string[];
    failed: Array<{
        name: string;
        reason: string;
    }>;
}
export declare const REPAIR_INSTALL_TIMEOUT_MS = 300000;
/**
 * Drop a profile write lock whose owner is gone.
 *
 * A host killed mid-update leaves `<profile>/package.json.lock` naming a PID
 * that no longer exists; the repair's reinstall then waits out the full lock
 * timeout and fails, every start (#914's premise, applied to this path). A
 * live PID — including this very process — is never touched.
 */
export declare function clearStaleProfileLock(profileDirectory: string): boolean;
/**
 * Finish or forget every update an earlier run left half-applied.
 *
 * Called once the composition has settled. A record is resolved by looking at
 * what is actually on disk, never by what the interrupted call intended:
 *
 * - the requested version, or the version from before, is installed: the
 *   profile is coherent, drop the record;
 * - nothing is installed: the removal won, put the package back;
 * - some other version is installed: the user may have chosen it, so leave it
 *   alone and keep the record for the log instead of fighting them.
 */
export declare function repairInterruptedUpdates(options: RepairOptions): Promise<RepairReport>;
