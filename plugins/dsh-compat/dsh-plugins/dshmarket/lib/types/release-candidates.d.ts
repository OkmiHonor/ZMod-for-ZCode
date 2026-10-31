/** Issue #991: pure, fail-closed selector for official Desktop npm stable updates. */
export interface NpmPackument {
    versions?: Record<string, unknown>;
    time?: Record<string, unknown>;
    'dist-tags'?: Record<string, unknown>;
}
export interface MatureUpdatePolicy {
    minimumReleaseAgeMs: number;
    exemptPackage?: boolean;
    exemptVersions?: ReadonlySet<string>;
    latestFromEndpoint?: string | null;
    /** Existing compatibility dialog may request a lower stable release. */
    maxVersion?: string;
}
export interface MatureUpdateSelection {
    candidate: string | null;
    latest: string | null;
    held: string | null;
    reason: 'eligible' | 'current' | 'held' | 'unknown-age' | 'inconsistent' | 'invalid-installed' | 'policy-unknown';
    nextMaturityAt: number | null;
    latestMaturityAt: number | null;
}
/** Accept stable SemVer, including build metadata, at both API boundaries. */
export declare function isStableReleaseVersion(value: unknown): value is string;
export declare function strictPublishTime(value: unknown): number | null;
export declare function selectMatureUpdate(packument: NpmPackument, installed: string | null, now: number, policy: MatureUpdatePolicy): MatureUpdateSelection;
