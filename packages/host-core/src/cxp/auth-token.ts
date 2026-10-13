import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The CXP peer-authentication token (wire 1.2) and its proof (wire 1.3) —
 * `cxp_auth_token.dart` in crux_cxp.
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
 * - `token` on the `hello` payload, presented by [LocalCxpClient] to a peer
 *   whose manifest predates wire 1.3;
 * - since wire 1.3, never on the wire at all to a peer whose manifest
 *   announces 1.3 or later: the `hello` carries a nonce and a proof of it
 *   ([cxpAuthProof]) and the `hello_ack` carries the listener's proof back;
 * - required by [LocalCxpServer], which answers a `hello` that neither
 *   carries nor proves it `unauthorized` and closes before the dialler
 *   becomes a peer.
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

/**
 * A fresh nonce for one `hello` (wire 1.3, CXP §7.4): the same 128 bits from
 * the same source as a token, in the same 32-hex-digit shape.
 */
export function generateCxpAuthNonce(): string {
  return generateCxpAuthToken();
}

/** The label under which a dialler proves it holds the listener's token. */
export const CXP_HELLO_PROOF_LABEL = 'cxp-hello';

/** The label under which a listener proves it holds its own token. */
export const CXP_HELLO_ACK_PROOF_LABEL = 'cxp-hello-ack';

/**
 * Mutual authentication (wire 1.3, CXP §7.4): proof that a peer holds
 * [token] without the token itself crossing the wire — `cxpAuthProof` in
 * crux_cxp.
 *
 * Under 1.2 the dialler sent the listener's token verbatim, which handed it
 * to whatever had answered the port: a process that binds a peer's
 * well-known port after the peer exits, while its manifest still names it,
 * was dialled in the peer's place and given the secret. So in 1.3 neither
 * side sends it. The dialler sends a fresh nonce and
 * `HMAC-SHA256(key = token, message = "cxp-hello:" + nonce)`; the listener
 * answers with the same under `"cxp-hello-ack:"`, which the dialler checks
 * against the token it read from the manifest. The two labels keep one
 * side's proof from being replayed as the other's; the nonce keeps a proof
 * from one connection from being replayed on another.
 *
 * Key: the token's UTF-8 bytes. Message: the UTF-8 bytes of
 * `label + ':' + nonce`. Result: the digest as 64 lowercase hex digits.
 */
export function cxpAuthProof(token: string, nonce: string, label: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8'))
    .update(Buffer.from(`${label}:${nonce}`, 'utf8'))
    .digest('hex');
}

/**
 * Whether a peer whose manifest announces [cxpVersion] takes part in mutual
 * authentication (wire 1.3, CXP §7.4): major `1` with minor at least `3`, or
 * a major above `1` — `cxpVersionHasMutualAuth` in crux_cxp.
 *
 * A dialler decides from the manifest, never from what the port answers: the
 * manifest is a file another user's process cannot write, the port is what
 * it can bind. `undefined` (a pre-1.3 manifest carries no `cxp_version`) and
 * an unparseable value read as "no", and the dialler then presents the token
 * verbatim, as 1.2 did.
 */
export function cxpVersionHasMutualAuth(cxpVersion: string | undefined): boolean {
  if (cxpVersion === undefined) return false;
  const parts = cxpVersion.split('.');
  const major = parseDartInt(parts[0] ?? '');
  if (major === undefined) return false;
  if (major > 1) return true;
  if (major < 1) return false;
  const minor = parts.length > 1 ? parseDartInt(parts[1] ?? '') : 0;
  return minor !== undefined && minor >= 3;
}

/**
 * A decimal integer the way Dart's `int.tryParse` reads one for the inputs
 * that matter here: optional sign, digits, nothing else (surrounding white
 * space is tolerated, as Dart tolerates it).
 */
function parseDartInt(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 10);
}
