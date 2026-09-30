/**
 * Protocol version this implementation speaks on the wire — `1.2`, matching
 * `cxpProtocolVersion` in crux_cxp, the reference implementation and the peer
 * on the other end of every real link.
 *
 * What each minor added:
 *
 * - **1.1** — the `request_open_artifact` / `request_open_artifact_ack`
 *   message kinds and the reserved `crux.design_id` metadata key.
 * - **1.2** — peer authentication: an optional `token` on the peer manifest
 *   and on the `hello` payload, and the `unauthorized` error code
 *   (`auth-token.ts`).
 *
 * Compatibility policy (CXP §6):
 *
 * - **Major mismatch** (or an unparseable version): the receiver answers
 *   `unsupported_version` and closes; a dialling peer fails its pending
 *   handshake.
 * - **Minor mismatch**: accepted. Minor revisions are additive and unknown
 *   payload fields are ignored (§6.1), so a 1.x peer can always talk to a
 *   1.y peer — **with one deliberate exception.** A 1.2 server requires the
 *   token by default, so a pre-1.2 dialler, which sends none, is refused
 *   `unauthorized`. A 1.2 dialler still reaches a pre-1.2 server, which
 *   ignores the token. Over CXP's symmetric topology a mixed pair therefore
 *   keeps one working route instead of two. crux_cxp made that trade and
 *   this implementation mirrors it; `requireAuthToken: false` on
 *   `LocalCxpServer` is the opt-out.
 */
export const CXP_PROTOCOL_VERSION = '1.2';

/**
 * Whether [version]'s major component matches ours — the acceptance test
 * of the policy documented on [CXP_PROTOCOL_VERSION].
 *
 * A version string with no `.` separator is compared whole, so `"1"` is
 * compatible with `"1.0"` and `"2"` is not. `"garbage"` and `""` are
 * incompatible, because neither has `1` as its first dot-separated
 * segment. This is `isCompatibleCxpVersion` in crux_cxp, character for
 * character.
 */
export function isCompatibleCxpVersion(version: string): boolean {
  return majorOf(version) === majorOf(CXP_PROTOCOL_VERSION);
}

function majorOf(version: string): string {
  // `split('.')` on a non-empty string always yields at least one element,
  // but `noUncheckedIndexedAccess` cannot know that.
  return version.split('.')[0] ?? version;
}
