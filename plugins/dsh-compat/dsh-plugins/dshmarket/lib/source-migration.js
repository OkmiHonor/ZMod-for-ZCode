/**
 * Safe discovery for legacy Git -> verified npm source migrations (#461).
 *
 * This intentionally does less than the normal catalog matcher. A migration
 * changes package name/publisher and build provenance, so only repository
 * evidence carried by the installed Git spec may authorize it:
 *
 * - bare github:owner/repo matches only the catalog root for that repo;
 * - #path:/subdir matches only that exact catalog subpath;
 * - branch/tag/commit/semver selectors are not migrated in v1;
 * - more than one matching verified npm entry is ambiguous and fails closed.
 */
import { NPM_NAME_RE, isGitHostedSpec, isLocalSpec, parseSourceUrl, repoOfTarget } from './sources.js';
function migratableGitIdentity(spec) {
    if (!spec.startsWith('github:'))
        return null;
    const hash = spec.indexOf('#');
    if (hash !== -1) {
        const selector = spec.slice(hash + 1);
        // A path selector identifies which package inside a monorepo. Any
        // other selector expresses an explicit version/ref choice and is
        // deliberately preserved rather than silently discarded.
        if (!selector.startsWith('path:/') || selector.includes('&'))
            return null;
    }
    return repoOfTarget(spec);
}
export function findGitToNpmMigration(plugins, spec) {
    const identity = migratableGitIdentity(spec);
    if (identity === null)
        return null;
    const pathAt = identity.indexOf('#path:/');
    const wantedRepo = pathAt === -1 ? identity : identity.slice(0, pathAt);
    const wantedPath = pathAt === -1 ? null : identity.slice(pathAt + '#path:/'.length);
    const candidates = plugins.flatMap((plugin) => {
        if (typeof plugin.npm !== 'string' || !NPM_NAME_RE.test(plugin.npm))
            return [];
        const source = parseSourceUrl(plugin.url);
        if (source === null || source.repo.toLowerCase() !== wantedRepo)
            return [];
        if (wantedPath === null) {
            // A collection root must not guess which /tree/ child was meant.
            if (source.subpath !== null)
                return [];
        }
        else if (source.subpath?.toLowerCase() !== wantedPath) {
            return [];
        }
        return [plugin.npm];
    });
    if (candidates.length !== 1)
        return null;
    return { kind: 'git-to-npm', repo: identity, target: candidates[0] };
}
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
export function findNpmTargetEntry(plugins, to) {
    // Compare against the install target, not the display name: that is what the
    // route is about to `add`, and it is what the catalog rules (E10/E11) keep
    // unique. A listing whose npm target is another package cannot satisfy a
    // rename to its display name.
    const matches = plugins.filter(plugin => {
        const target = typeof plugin.npm === 'string' ? plugin.npm : plugin.name;
        return NPM_NAME_RE.test(target) && target === to;
    });
    return matches.length === 1 ? matches[0] : null;
}
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
export function findCatalogRename(plugins, from) {
    const wanted = from.toLowerCase();
    const candidates = [];
    for (const plugin of plugins) {
        const previous = Array.isArray(plugin.previousNpm) ? plugin.previousNpm : [];
        if (!previous.some(name => typeof name === 'string' && name.toLowerCase() === wanted))
            continue;
        const target = typeof plugin.npm === 'string' && NPM_NAME_RE.test(plugin.npm) ? plugin.npm : null;
        // An entry may never name itself as its own predecessor; the runtime
        // normalizer drops that, and this keeps a hand-built catalog honest too.
        if (target === null || target.toLowerCase() === wanted)
            continue;
        candidates.push({ entry: plugin, target });
    }
    return candidates.length === 1 ? candidates[0] : null;
}
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
export function declaredPredecessors(plugin, installed) {
    const previous = Array.isArray(plugin.previousNpm) ? plugin.previousNpm : [];
    const found = [];
    for (const value of previous) {
        if (typeof value !== 'string' || value === '')
            continue;
        const wanted = value.toLowerCase();
        for (const name of Object.keys(installed)) {
            if (name.toLowerCase() === wanted && !found.includes(name))
                found.push(name);
        }
    }
    return found;
}
/**
 * True when the two sides still register at least one of the same loader rows.
 *
 * This is the check that keeps a stale catalog from refusing an install it has
 * no business refusing: two packages that insert different rows can coexist in
 * a profile, so a `previousNpm` that points at one of them is a guess, not the
 * plugin coming back. Only readable, non-empty row sets can prove sameness —
 * a missing side proves nothing and the caller falls back to the declaration.
 */
export function sameLoaderRows(installed, incoming) {
    if (installed.length === 0 || incoming.length === 0)
        return false;
    const present = new Set(installed);
    return incoming.some(id => present.has(id));
}
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
export function isRegistryRangeSpec(spec) {
    if (spec === '')
        return false;
    if (isGitHostedSpec(spec) || isLocalSpec(spec))
        return false;
    return !/[:/\\]/.test(spec);
}
