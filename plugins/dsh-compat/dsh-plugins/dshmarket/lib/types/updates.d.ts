/**
 * Update detection: per-plugin comparison of what the profile has against
 * the source of truth — git HEAD for github installs, the npm latest
 * dist-tag for registry installs — with a TTL cache.
 */
import { type Channel } from './channels.ts';
import type { GitToNpmMigration, NpmRenameMigration } from './source-migration.ts';
export interface UpdateStatus {
    /**
     * `generation` is a `link:` the desktop host wrote (#497): the host
     * installs it and reconciles it at startup, so the market names a newer
     * release under `latest` and never offers to apply it. For that kind
     * `latest` is null when the installed build is current or nothing newer
     * can be confirmed.
     */
    kind: 'github' | 'npm' | 'linked' | 'generation';
    version: string | null;
    current: string | null;
    latest: string | null;
    /**
     * A NEWER version exists. Forwards only, always — every caller reads it
     * as "there is an upgrade" and labels a button accordingly.
     */
    updateAvailable: boolean;
    /** Exact mature npm stable target for Desktop; `latest` remains the registry tag. */
    eligibleVersion?: string;
    /**
     * HEAD of the chosen line for a floating git install whose repository has
     * moved without publishing: newer commits exist (current ≠ latest) but the
     * version did not advance, so #824's rule answers `updateAvailable: false`
     * — the update channel installs releases, not arbitrary branch heads.
     *
     * This field keeps the fact visible instead of collapsing it into "up to
     * date": the market shows "有新提交（未发版）<short sha>" so a user who
     * DOES want the unreleased bits knows a rebuild-installed row is behind,
     * while everyone else is not nagged by a permanent update button.
     */
    unreleasedCommit?: string;
    /**
     * This package is a plain dependency, not a plugin: no `dsh` field, not in
     * `dsh.profile.bundles`, and no row of the user's own patch loads it
     * (#793). A newer release can exist and is reported as `latest`, but it is
     * never `updateAvailable` — the update channel installs a BUNDLE, and
     * handing it a package with no bundle patch is refused by the host as
     * `not-bundle` after the run, with a rollback message that reads as though
     * the profile were damaged when nothing was touched.
     */
    notAPlugin?: true;
    /**
     * A newer build exists on a tag other than `latest` (#867).
     *
     * Some packages leave `latest` pointing at an older line than the one they
     * actually publish on: `@deepseek-ai/dsh-experimental-agent-team-profile`
     * answers `latest` with 0.1.5-alpha.2 while `alpha` is 0.2.1-alpha.4, so a
     * user who installed 0.2.1-alpha.2 reads "up to date" while the line they
     * are following has moved. Named, and never `updateAvailable`: the market's
     * channels are the market's own, and this is the fact, not an upgrade the
     * market decided to offer.
     */
    newerPrerelease?: string;
    /** Taking this update replaces a local package source with its matched online release. */
    restoreRequired?: boolean;
    /**
     * Independent, explicit source switch offered for an installed profile: a
     * verified legacy Git install (#461), or an npm install whose package was
     * renamed and no longer resolves (#1012).
     */
    sourceMigration?: GitToNpmMigration | NpmRenameMigration;
    /**
     * A newer release exists but this profile's `minimumReleaseAge` will not let
     * pnpm install it yet (#945). The official Desktop takes no one-shot bypass,
     * so offering the update there means offering a button that is guaranteed
     * to fail; the market names the wait instead. `updateAvailable` can still
     * be true if `eligibleVersion` names a different, already mature upgrade.
     * `until` is when the newer held release should become installable.
     */
    heldUpdate?: {
        latest: string;
        until: string;
        estimated?: true;
    };
    /**
     * The version this package's channel points at, when it differs from what
     * is installed and is NOT newer.
     *
     * A separate field rather than a second meaning for `updateAvailable`,
     * which was tried and leaked immediately: the market page has three
     * consumers of that flag (the header banner, "update all", the row
     * button) and all three announced a DOWNGRADE as "a new version is
     * available". One field, one meaning; a caller that has not been taught
     * about channel switches simply does not offer one.
     *
     * Only a channel-following package can be in this state, and it is the
     * state that used to be unreachable: picking "stable" while a prerelease
     * was installed compared 1.13.1 against 1.14.0-beta.1, found nothing
     * newer, and answered "up to date" — so there was no way back off a
     * channel the user had just left.
     */
    channelSwitch?: string;
}
/**
 * Whether a direct dependency is a plugin the update channel can apply (#793).
 *
 * The update path installs a BUNDLE: it re-adds the package and lets the host
 * compose its patch. A direct dependency that is only a library or a CLI
 * (`@mnemon-dev/mnemon` — a `bin` and no `dsh` field) is listed because it is
 * in `package.json`, and nothing before this asked what it was, so a newer
 * release made it "updatable" and the click ended in the host's `not-bundle`.
 *
 * Three independent facts each count as "this is a plugin", and a package
 * must have none of them to be left out:
 *
 *  - its own manifest declares a `dsh` field;
 *  - the profile lists it in `dsh.profile.bundles`;
 *  - a row of the user's own `cordis.patch.yml` loads it by name — a package
 *    can be a real, working plugin while declaring nothing itself (the
 *    official `@deepseek-ai/dsh-tools` has no `dsh` field and is loaded by the
 *    base patch), and treating that as a library would silently stop
 *    offering its updates.
 *
 * Every uncertainty resolves toward "is a plugin": an unreadable patch, an
 * unreadable manifest, a package that is not installed yet. This only ever
 * REMOVES an offer, so being unsure has to leave the offer standing — the
 * old behaviour — rather than hide an update the user wanted.
 */
export declare function isUpdatablePlugin(activeProfileDir: string, name: string, bundles: ReadonlySet<string>): boolean;
/**
 * HEAD for an arbitrary smart-HTTP git remote (Gitea, GitLab, …). Same
 * advertisement format as GitHub's info/refs; kept here so accelerate.ts
 * does not need to import sources.ts.
 */
export declare function resolveGitRemoteHead(spec: string, ref?: string): Promise<string | null>;
/**
 * Semver precedence: negative / 0 / positive like a comparator, or null when
 * either side isn't a plain semver version. Build metadata is ignored, a
 * release outranks any prerelease of the same core, and prerelease
 * identifiers compare numerically when both are numeric (so `rc.10` > `rc.9`).
 */
export declare function compareVersions(a: string, b: string): number | null;
/**
 * True only when the registry's `latest` is semantically HIGHER than what the
 * profile has (#64 by @ZeroOrigin64). A plain `!==` also fires when a
 * package's `latest` dist-tag is left pointing at an OLDER release than the
 * pinned install — clicking "update" then rewrote the exact pin to `@latest`
 * and downgraded the profile until it no longer booted.
 *
 * Undecidable inputs (missing or non-semver versions) report no update:
 * without a direction we cannot promise the "update" isn't a downgrade.
 */
export declare function isUpgrade(installed: string | null, latest: string | null): boolean;
/** Drop the cached listing (after a successful install/update/uninstall). */
export declare function invalidateUpdates(): void;
/**
 * Point update checks at a registry. Called when the download region
 * resolves and whenever it changes.
 *
 * Dropping the cache is the load-bearing half. A mirror can lag the official
 * registry by minutes, so answers gathered from one are not answers from the
 * other — keeping them across a switch would report a version this registry
 * cannot yet serve.
 */
export declare function setUpdateRegistry(base: string): void;
export interface DesktopMatureResult {
    candidate: string | null;
    latest: string | null;
    heldUpdate?: {
        latest: string;
        until: string;
        estimated?: true;
    };
    nextMaturityAt: number | null;
    reason: string;
}
/** Shared fresh registry/policy verification for listing and locked execution. */
export declare function resolveDesktopMatureUpdate(name: string, installed: string | null, profile: string, activeProfileDir: string, endpointLatest: string | null, maxVersion?: string): Promise<DesktopMatureResult>;
/**
 * Evidence check behind the "wait a day" stale diagnosis (#45): whether the
 * package's CURRENT latest release was published recently enough to sit
 * inside pnpm's default fresh-release window. pnpm's silent hold leaves no
 * trace in its output, so the publish time is the only verifiable signal.
 * @returns true/false when the npm time metadata answers, null when it
 *   can't be determined (offline, unpublished, non-npm) — callers must NOT
 *   claim the safety wait on null.
 */
export declare function latestPublishedRecently(name: string, windowMs?: number): Promise<boolean | null>;
/** The registry's current `latest` version for a package, or null when it can't be read. */
/**
 * The version a channel subscriber should be offered: the newest build in
 * the set that channel is willing to receive.
 *
 * A channel is a SET, not a tag. Someone on beta has not stopped accepting
 * releases — they accept releases and prereleases — so beta means
 * {latest, beta} and dev means {latest, beta, dev}. Reading it as one tag
 * gets a real case wrong: once 1.14.0 ships, `beta` still points at
 * 1.14.0-beta.1 until the next prerelease is cut, and following that tag
 * literally would walk a subscriber BACKWARDS onto a build their channel
 * has already moved past.
 *
 * The nesting is also what makes a channel leavable. Going backwards is
 * only ever offered when the user narrows the set — picking stable while a
 * prerelease is installed drops `beta` out of it, so the answer becomes
 * `latest` and the market can finally offer the way back. That case used to
 * be unreachable: comparing 1.13.1 against an installed 1.14.0-beta.1 found
 * nothing newer and answered "up to date", so the control the user had just
 * used appeared to do nothing.
 *
 * @param stable - the `latest` version, already fetched by the caller.
 */
export declare function versionOnChannel(name: string, channel: Channel, stable: string | null): Promise<string | null>;
export declare function fetchNpmLatest(name: string): Promise<string | null>;
/**
 * The newest build above `installed` that some tag other than `latest`
 * points at, or null (#867).
 *
 * A fact about the registry, not a channel decision: this is what makes the
 * difference visible to someone whose installed pin is ahead of `latest`
 * without the market volunteering anyone's prerelease as an update.
 */
export declare function newerPrereleaseFor(name: string, installed: string | null): Promise<string | null>;
/** Per-plugin update checks; a failed check reports no update rather than failing the listing. */
export declare function checkUpdates(profile: string, force?: boolean, explicitDir?: string, 
/**
 * Packages that follow a release channel instead of plain `latest`. Only
 * ever the market itself: opting into early builds is volunteering to try
 * THIS plugin early, not a licence to pull every other author's
 * unreleased work.
 */
channelFor?: ReadonlyMap<string, Channel>, 
/**
 * Curated npm sources for the installs that carry no registry spec of
 * their own: `file:` packages matched to the market catalog (#429) and
 * the generations the desktop host links in (#497). Any other `link:` is
 * a development workspace and is never opted into online updates.
 */
onlineSourceFor?: ReadonlyMap<string, string>, 
/**
 * Registry names an archive-URL install may be checked against, keyed by
 * the GitHub repo (`owner/repo`) the archive came from (#768). Without an
 * entry that owns both the repo and the name, the npm fallback would
 * compare the install with whatever package merely shares its name.
 */
catalogNpmByRepo?: ReadonlyMap<string, string>, 
/**
 * Hold back releases that this profile's `minimumReleaseAge` will refuse
 * (#945). Only true where the install path has no bypass: the official
 * Desktop's manager takes no pnpm options, while the CLI path retries once
 * with `--config.minimum-release-age=0` and CAN install a young release.
 * Hiding those on the CLI would suppress updates that work.
 */
options?: {
    holdYoungReleases?: boolean;
}): Promise<Record<string, UpdateStatus>>;
