/** The official Electron profile is owned by DSH's in-process plugin manager. */
import { type DesktopPluginRuntime, type HostPackageManager } from './dsh-cli.ts';
import { type RepairReport } from './pending-updates.ts';
interface ManagedResult {
    application: string;
    error?: unknown;
    packageResult?: {
        exitCode: number | null;
        output?: string;
    };
    /**
     * The install never settled and the profile may be half-updated: the route
     * must not try to "restore" it through the same stuck manager.
     */
    repairOnRestart?: boolean;
}
export interface OfficialPluginManagerLike {
    installBundle(spec: string, options?: {
        requestId?: string;
        registry?: string;
    }): Promise<ManagedResult>;
    removeBundle(name: string): Promise<ManagedResult>;
    cancelInstall(requestId: string): Promise<unknown>;
}
/**
 * What a user can actually do when the market cannot perform an operation on
 * the official Desktop profile: the app's own Plugins page runs the same
 * managed pipeline. Bilingual, because it is read in the operations panel.
 */
export declare const OFFICIAL_PAGE_HINT = "\u5B98\u65B9\u684C\u9762\u5BA2\u6237\u7AEF\u7684\u8FD9\u4E2A\u63D2\u4EF6\u64CD\u4F5C\u9700\u8981\u5728\u300C\u8BBE\u7F6E \u2192 \u63D2\u4EF6\u300D\u91CC\u5B8C\u6210\uFF1B\u5E02\u573A\u65E0\u6CD5\u901A\u8FC7\u547D\u4EE4\u884C\u4FEE\u6539\u684C\u9762\u7AEF\u7684 profile\u3002 / On the official desktop app, do this from Settings \u2192 Plugins; the market cannot change the desktop profile through the command line.";
/** `dshmarket@1.66.32` → `dshmarket`; anything that is not a registry name stays unparsed. */
export declare function registryNameOf(spec: string): string | undefined;
/** The official runtime's own surface, plus the repair a later start owes the profile. */
export interface OfficialDesktopRuntime extends DesktopPluginRuntime {
    /**
     * Finish or undo an update an earlier start left half-applied (#928).
     * Returns after every record settled or was found unrepairable; never throws.
     */
    repairPendingUpdates(): Promise<RepairReport>;
}
/**
 * Never fall back to `dsh plugin --profile desktop`.
 *
 * Up to dsh 0.2.0-rc.1 the CLI refused that profile outright. From rc.2 it
 * accepts it only when Desktop's own carrier invokes it, with Desktop fully
 * quit — it takes a 120 s lock on the profile's package.json and says "fully
 * quit it before running". The market only ever runs inside a live Desktop, so
 * for the market the answer is the same on every version: the app's own
 * plugin manager is the only door.
 */
export declare function createOfficialDesktopRuntime(managerLookup: () => OfficialPluginManagerLike | undefined, profileName: string, _profileDirectory?: string, packageManager?: HostPackageManager | null): OfficialDesktopRuntime;
export {};
