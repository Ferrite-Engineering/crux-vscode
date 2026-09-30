import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The CXP peer-authentication token (wire 1.2) — `cxp_auth_token.dart` in
 * crux_cxp.
 *
 * ### What it defends against, and what it does not
 *
 * CXP servers bind loopback, and every Crux product binds a **fixed default
 * port** (54322–54325). Loopback is reachable by every process on the
 * machine — including ones the specification's trust model (§11) never meant
 * to include: another user on a shared workstation, a sandboxed app with a
 * network-client entitlement and no file access, a container with host
 * networking. The model assumes every process running as the user is equally
 * trusted; the fixed port made the real boundary wider than that.
 *
 * The token restores the model's boundary. A peer learns it from the target's
 * manifest, which lives in the user's private application-data directory
 * (`sharedCxpManifestDirectory`) — so presenting it proves exactly what the
 * model already assumes: the dialler can read the user's files. Every
 * legitimate peer reads that file anyway to learn the port, so carrying one
 * more field costs nothing.
 *
 * It does **not** authenticate a process running as the user: such a process
 * reads the manifest and presents the token like any peer. That is the trust
 * model, not a gap in the mechanism, and it is why the token is not called a
 * password.
 *
 * ### Where it travels
 *
 * - `token` on the peer manifest, published by [CxpManifestWriter];
 * - `token` on the `hello` payload, presented by [LocalCxpClient];
 * - required by [LocalCxpServer], which answers a `hello` without it
 *   `unauthorized` and closes before the dialler becomes a peer.
 *
 * It is never logged, never put in an error message, and never echoed on the
 * wire by the receiver.
 */

/** Bytes of entropy in a token: 128 bits, as crux_cxp mints them. */
const CXP_AUTH_TOKEN_BYTES = 16;

/**
 * A fresh 128-bit token from the operating system's CSPRNG, as 32 lowercase
 * hex digits — filename-safe and JSON-safe, since it travels in both.
 *
 * `crypto.randomBytes`, never `Math.random`: the token is the only thing
 * standing between a fixed loopback port and every other local process.
 */
export function generateCxpAuthToken(): string {
  return randomBytes(CXP_AUTH_TOKEN_BYTES).toString('hex');
}

let processToken: string | undefined;

/**
 * The token this process publishes in its manifest and requires of every
 * peer that dials its server — minted once, on first use.
 *
 * `LocalCxpServer` requires it and `CxpManifestWriter` publishes it by
 * default, so the two agree without being wired together — and a caller that
 * forgets the wiring does not end up with a server that silently refuses
 * every peer. Both accept an explicit token for tests and for a host running
 * several peers in one process with distinct secrets; a caller that gives the
 * server one must give the writer the same one (`CxpPeerHost` does).
 *
 * Note that each extension bundles its own copy of this module, so "process"
 * here means "this bundle's module instance". That is why `CxpPeerHost`
 * passes one token explicitly to both halves rather than relying on the
 * shared default.
 */
export function cxpProcessAuthToken(): string {
  processToken ??= generateCxpAuthToken();
  return processToken;
}

/**
 * Whether [presented] is [expected], compared in time that does not depend on
 * where the two first differ.
 *
 * A missing token (`undefined`) never matches. Lengths are compared first —
 * `timingSafeEqual` requires equal lengths — which reveals only the length,
 * and every real token is 32 characters. The strings are compared as UTF-16
 * code units, as crux_cxp's `cxpAuthTokensMatch` compares them: a UTF-8
 * encoding would map two different lone surrogates to the same replacement
 * bytes and call them equal.
 */
export function cxpAuthTokensMatch(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf16le');
  const b = Buffer.from(expected, 'utf16le');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
