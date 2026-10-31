/**
 * Minimal HTTP helpers shared by every market route: JSON serialization,
 * same-origin enforcement for mutating endpoints, and a size-capped JSON
 * body reader.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Write a JSON payload with no-store caching. */
export declare function sendJson(response: ServerResponse, status: number, payload: unknown): void;
/**
 * The host's own request gate, when it publishes one (#603).
 *
 * DSH's Host Connection service exposes `requestRejection(request)`: its
 * Host/Origin fence, then its browser login — 403, 401, or `undefined` for a
 * request it would admit to its own API. The market's routes never passed
 * through it: they are exact registrations on the bare webServer (see the
 * trusted-hosts note below), so with the login on, a client holding no session
 * could still read the market's state and install or remove plugins — which on
 * a deployment behind a proxy or a tunnel is code execution on that machine for
 * anyone who can reach the port. The fix is not a second login: it is asking
 * the one the host already runs.
 *
 * `undefined` source (a host older than this service, 0.1.0-rc.8) leaves every
 * route exactly as it was.
 */
export type HostRequestGate = (request: IncomingMessage) => number | undefined;
/** Point the market at the host's request gate. Returns the previous source. */
export declare function setRequestGateSource(source: () => HostRequestGate | undefined): () => HostRequestGate | undefined;
/**
 * Answer the request with the host's rejection, if it has one.
 * @returns true when the request was refused and answered here.
 */
export declare function refuseUnadmitted(request: IncomingMessage, response: ServerResponse): boolean;
/** Point the fence at the host's declared authorities. Returns the previous source. */
export declare function setTrustedHostsSource(source: () => readonly string[]): () => readonly string[];
/**
 * The authorities this deployment declared, as the fence reads them right now.
 *
 * `sameOrigin` consults them through the private source above. The privileged
 * routes (the backup export, the self-uninstall, the one-click restart) need
 * the same list, and a second private copy of it would be a second thing to
 * keep in step — the fence that guards the market's ordinary routes and the
 * fence that guards its privileged ones have to agree about what this
 * deployment serves.
 *
 * Read per request, exactly as the source itself is: a deployment that
 * declares an authority later is honoured from that request on.
 */
export declare function declaredTrustedHosts(): readonly string[];
/**
 * Whether a request authority is one of the declared ones.
 *
 * Mirrors @deepseek-ai/dsh-client-connection's rule, because the two fences
 * have to agree: an entry with an explicit port matches that exact authority,
 * a port-less entry matches the hostname on any port (the shape the CLI
 * derives for IP-literal LAN serving, where the bound port may be assigned by
 * the OS). Both sides compare through WHATWG normalization, so case and a
 * redundant `:80` never decide trust.
 */
export declare function trustedAuthority(host: string, trustedHosts: readonly string[]): boolean;
/**
 * True when the request's Origin, IF IT HAS ONE, matches its Host — required
 * on every POST route.
 *
 * An absent Origin is allowed (#648). The check exists to stop another web
 * page from driving this loopback API, and the Fetch spec has browsers send
 * `Origin` on every POST — including same-origin and cross-origin form
 * submissions. A request that arrives WITHOUT it therefore did not come from
 * a page at all, and a non-browser client can set any Origin it likes, so
 * refusing the header's absence bought nothing while breaking a whole
 * supported host: the Desktop app's own proxy strips `origin`, `host`,
 * `cookie` and `sec-fetch-site` before forwarding to the in-process host and
 * injects a cookie only that host can sign. Every mutating request from the
 * Desktop build was answered 403 `untrusted origin`.
 *
 * What still holds after the change, and is the part worth keeping:
 *
 * - a cross-site page is refused — its Origin is present and different;
 * - `Origin: null` (a sandboxed iframe, a `data:` document) is refused, because
 *   `null` is a present-but-unparseable origin, not an absent one;
 * - a same-host-but-different-port request is refused, except that a loopback
 *   Host accepts a port-less same-hostname Origin (#1031: Chrome 151+ omits
 *   the port on loopback Origins, and the dsh core fence follows the same
 *   rule);
 * - an EMPTY Origin is refused too: the header being present and unparseable
 *   is not the same statement as its being absent, and only absence is what
 *   a stripping proxy produces.
 *
 * The header's absence is a statement about the client, not about intent, and
 * the intent is the only thing this can judge.
 *
 * @param request - the incoming request.
 * @returns whether the request may mutate market state.
 */
/**
 * Whether a `Host` header names a loopback authority (#678).
 *
 * `Origin === Host` alone does not stop a DNS-rebinding page: the attacker
 * serves their page from `evil.com`, resolves that name to 127.0.0.1, and
 * the browser then connects to the loopback listener while sending
 * `Origin: http://evil.com` AND `Host: evil.com` — an equality that holds
 * for the attacker. `Host` is the one header the attack cannot forge, so it
 * is what has to name a loopback authority.
 *
 * `localhost` is included because browsers and RFC 6761 pin it to loopback;
 * a subdomain like `localhost.evil.com` does not match, and the port is
 * dropped before comparing.
 *
 * @param host - the request's `Host` header.
 * @returns whether it names a loopback authority.
 */
export declare function loopbackAuthority(host: string | undefined): boolean;
export declare function sameOrigin(request: IncomingMessage): boolean;
/** Read and parse a JSON request body, rejecting anything over 4 KiB. */
export declare function readJsonBody(request: IncomingMessage, maxBytes?: number): Promise<unknown>;
