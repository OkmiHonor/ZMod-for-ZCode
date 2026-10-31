export interface GitToNpmMigration {
    kind: 'git-to-npm';
    /** Normalized owner/repo or owner/repo#path:/subdir identity. */
    repo: string;
    /** Verified npm package declared by the same catalog entry. */
    target: string;
}
/**
 * The other direction: an npm install whose package was renamed (#1012).
 *
 * Unlike the Git case there is no local evidence to discover the target from —
 * the old spec names only the old package, and the registry answers 404 for
 * it. The fact has to come from the update failure that noticed it, and the
 * transaction below is shared instead of duplicated.
 */
export interface NpmRenameMigration {
    kind: 'npm-rename';
    /** npm package name the profile currently depends on. */
    from: string;
    /** Catalog npm package name the install is offered as a target. */
    target: string;
}
export declare function findGitToNpmMigration<T extends {
    url: string;
    npm?: unknown;
}>(plugins: readonly T[], spec: string): GitToNpmMigration | null;
/**
 * The catalog entry that publishes `to` on npm, or null when no single entry
 * does.
 *
 * The rename target arrives from an update failure's own artifact, but the
 * `migrate-source` body is user-reachable all the same: this keeps the route
 * from pointing a profile at a package name the catalog does not publish on
 * npm. Two entries claiming one npm name is ambiguous and fails closed, the
 * same rule {@link findGitToNpmMigration} follows.
 */
export declare function findNpmTargetEntry<T extends {
    name: string;
    npm?: unknown;
}>(plugins: readonly T[], to: string): T | null;
/**
 * The catalog entry that declares `from` as a package it used to be (#1012).
 *
 * This is the discovery the update failure cannot provide: a user whose old
 * version range no longer resolves never installs anything, so no
 * "came back under another name" evidence is produced. The catalog states the
 * rename up front instead — but it is external input, so two entries claiming
 * one former name is ambiguity, and ambiguity fails closed exactly like
 * {@link findGitToNpmMigration}.
 *
 * Only entries that can actually be installed from npm qualify: an entry whose
 * own target is not a valid npm name has no successor this transaction could
 * install.
 */
export declare function findCatalogRename<T extends {
    name: string;
    npm?: unknown;
    previousNpm?: unknown;
}>(plugins: readonly T[], from: string): {
    entry: T;
    target: string;
} | null;
/**
 * Installed packages that answer to one of this entry's former names (#1012).
 *
 * A renamed package usually re-registers the very same bundle ids, so two
 * package names that were one plugin cannot coexist in a profile: the trial
 * boot rejects duplicate loader ids while the two sit side by side. That makes
 * "install the new name as well" the one obvious move that bricks the next
 * start, which is why the install route refuses it before pnpm runs.
 *
 * A name on this list is a claim, not proof: the caller still compares the
 * rows both sides declare before it refuses anything, so a stale catalog
 * field can cost a click at worst and never a wrong refusal.
 */
export declare function declaredPredecessors<T extends {
    name: string;
    previousNpm?: unknown;
}>(plugin: T, installed: Record<string, unknown>): string[];
/**
 * True when the two sides still register at least one of the same loader rows.
 *
 * This is the check that keeps a stale catalog from refusing an install it has
 * no business refusing: two packages that insert different rows can coexist in
 * a profile, so a `previousNpm` that points at one of them is a guess, not the
 * plugin coming back. Only readable, non-empty row sets can prove sameness —
 * a missing side proves nothing and the caller falls back to the declaration.
 */
export declare function sameLoaderRows(installed: readonly string[], incoming: readonly string[]): boolean;
/**
 * True when a dependency spec is a plain registry version range — the only
 * shape the rename transaction can replace.
 *
 * The route refuses anything carrying a protocol, a path prefix or an alias
 * (`github:`, `file:`, `workspace:`, `npm:` …), because those describe a
 * source this transaction cannot reproduce for the new name. Discovery is
 * kept to the exact same test so the market never offers a migration the
 * route would answer with 400.
 */
export declare function isRegistryRangeSpec(spec: string): boolean;
