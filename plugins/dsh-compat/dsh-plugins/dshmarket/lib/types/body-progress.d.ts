/**
 * Reading a response body under a stall watchdog instead of a total budget.
 *
 * Lives on its own because two downloads need exactly this rule and they are
 * not the same file: the catalog served from its origin (#750/#766) and the
 * catalog carried by a published package (#1049). The npm source had kept a
 * fixed 20s ceiling, which is fine for a metadata answer and wrong for a
 * multi-megabyte tarball: at 3.2 MB it needs 158 KB/s sustained, and a China
 * mirror jittering to 17–40 KB/s cannot make that, so both attempts died at
 * the ceiling while the link was still delivering bytes.
 */
/**
 * How long to wait for the response to START answering.
 *
 * Headers arrive in one burst or not at all, so a fixed budget still fits
 * them. It fits nothing else: the body of a catalog download keeps trickling
 * long after any honest total budget, and a total timer cuts off a download
 * that was still moving — measured: killed at 15s on both attempts, 89.9s
 * end-to-end when allowed to run.
 */
export declare const HEADERS_TIMEOUT_MS = 15000;
/**
 * How long the body may stay SILENT before we give up on it.
 *
 * Deliberately not a total budget. As long as bytes keep arriving, however
 * slowly, the read continues; the watchdog only fires on a download that has
 * actually stopped, which is the one failure a slow link cannot fake.
 */
export declare const BODY_STALL_TIMEOUT_MS = 15000;
/**
 * How long the whole body may take, however much progress it keeps making.
 *
 * The stall watchdog can only act on a pause, so a mirror that sends one
 * byte inside every 15s window would hold the read open forever. 10 minutes
 * is ~7x the slowest measured full download (89.9s); a body still going
 * after that is broken, not slow, and the byte count in the message says
 * which of the two it was.
 */
export declare const BODY_TOTAL_CEILING_MS = 600000;
/**
 * The most body bytes to accept before declaring the response not a catalog.
 *
 * The catalog passed 5 MB in September 2026 (9.5 MB unpacked by October);
 * 256 MB is decades of headroom — and still a hard bound on memory, because
 * the whole body is buffered before parsing and a mirror streaming garbage
 * at line speed would otherwise grow that buffer until the process dies.
 * backup.ts and gist.ts cap their downloads for the same reason.
 */
export declare const MAX_BODY_BYTES: number;
/**
 * Read a body under a stall watchdog instead of a total budget.
 *
 * One timer for the whole fetch was the mistake both before and after #188:
 * at 4s it hid slowness behind a stale snapshot, at 15s it kills downloads
 * that are still moving. On a lossy proxied link the catalog body trickles
 * for far longer than 15s while never once going silent — measured 89.9s
 * end-to-end for a body the 15s cutoff had declared dead twice. This reader
 * lets a moving body run as long as it keeps moving, in either direction's
 * sense of "slow", and ends one that goes quiet for `stallMs` with a message
 * that says what actually happened and how much had arrived.
 *
 * The rejection comes from here, not from an abort: undici's abort message
 * ("This operation was aborted") cannot tell a user anything actionable, and
 * a bug report containing this string will contain the byte count too.
 *
 * Two backstops keep "still moving" from meaning "forever", because the
 * watchdog can only see pauses: a total ceiling for a body that trickles
 * without ever pausing, and a size cap for one that outruns any catalog.
 *
 * @param res - the response whose body to read.
 * @param stallMs - silence that ends the read, in milliseconds.
 * @param what - the download, for the rejection message ("the catalog").
 */
export declare function readBodyWhileProgressing(res: Response, stallMs: number, what?: string): Promise<Uint8Array>;
/**
 * Fetch with a headers-only deadline, then hand the body to the watchdog.
 *
 * Two clocks, because they measure different things: how long the origin
 * takes to start answering, and how long it keeps answering. The abort signal
 * covers only the first — once headers are in, the watchdog owns the read,
 * which is what lets a slow-but-moving tarball finish.
 *
 * @param fetchImpl - the project's fetch (proxy-aware), injected for tests.
 * @param url - what to fetch.
 * @param what - the download, for messages.
 * @param init - extra request options.
 * @returns the body bytes.
 */
export declare function fetchBodyWhileProgressing(fetchImpl: (url: string, init?: {
    signal?: AbortSignal;
    headers?: Record<string, string>;
}) => Promise<Response>, url: string, what: string, init?: {
    headers?: Record<string, string>;
}): Promise<Uint8Array>;
