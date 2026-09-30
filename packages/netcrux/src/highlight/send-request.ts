/**
 * Sending one `request_highlight` to a NetCrux desktop peer and reading its
 * ack — the "CXP client" half of this extension.
 *
 * The dial-handshake-send-await-hang-up machinery moved into host-core
 * (`cxp/one-shot.ts`) when the desktop artifact handoff needed exactly the
 * same thing; its docs carry the reasoning this file used to — why a
 * one-shot dial rather than the connector, and why the first ack of the
 * expected kind is necessarily the answer to the one request a connection
 * carries. What stays here is NetCrux's mapping of that result onto the
 * three outcomes `what-drives-this.ts` renders.
 *
 * ### One mapping worth stating
 *
 * `error_response` — a peer that answered, but not with an ack — is
 * reported as [ack-timeout], "no usable answer arrived". It is a path a
 * NetCrux desktop should never take (it has understood `request_highlight`
 * since 1.0), and inventing a fourth user-facing outcome for it would add a
 * sentence nobody will read to cover a case that means the same thing to
 * the user: the highlight did not land. The code and message go to the
 * output channel, which is where the distinction is actionable.
 */
import { cxp } from '@crux-vscode/host-core';

/** How long to wait for `request_highlight_ack` before giving up. */
const DEFAULT_ACK_TIMEOUT_MS = 8_000;

/** What [sendHighlightToNetCrux] produced. */
export type SendHighlightResult =
  /** The peer acknowledged the request, honored or not. */
  | { readonly kind: 'acked'; readonly honored: boolean; readonly reason?: string }
  /** The socket connected but no usable answer arrived within the timeout. */
  | { readonly kind: 'ack-timeout' }
  /** The peer could not be reached at all — dead manifest, refused connection. */
  | { readonly kind: 'unreachable'; readonly error: unknown };

/** Injected environment for [sendHighlightToNetCrux]. */
export interface SendHighlightDeps {
  /** This window's identity for the handshake. Production: `createVscodePeerIdentity(...)`. */
  readonly selfIdentity: cxp.PeerIdentity;
  /** Milliseconds to wait for the ack. Defaults to [DEFAULT_ACK_TIMEOUT_MS]. */
  readonly ackTimeoutMs?: number;
  /** Client factory, injectable for tests. Defaults to a real `LocalCxpClient`. */
  readonly clientFactory?: (self: cxp.PeerIdentity) => cxp.LocalCxpClient;
}

/**
 * Dial [manifest], send [message], and resolve once its
 * `request_highlight_ack` arrives (or the attempt fails).
 *
 * Never throws: every failure — a refused connection, a dead process behind
 * a stale manifest, a peer that never answers — resolves to a
 * [SendHighlightResult] the caller turns into a message, because this runs
 * from a command handler where an unhandled rejection is invisible to the
 * user.
 */
export async function sendHighlightToNetCrux(
  manifest: cxp.CxpPeerManifest,
  message: cxp.RequestHighlight,
  deps: SendHighlightDeps,
): Promise<SendHighlightResult> {
  const result = await cxp.sendOneShotRequest(manifest, message, {
    selfIdentity: deps.selfIdentity,
    ackKind: cxp.CxpMessageKind.requestHighlightAck,
    ackTimeoutMs: deps.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS,
    ...(deps.clientFactory !== undefined ? { clientFactory: deps.clientFactory } : {}),
  });
  switch (result.kind) {
    case 'acked':
      return {
        kind: 'acked',
        honored: result.honored,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      };
    case 'error-response':
    case 'ack-timeout':
      return { kind: 'ack-timeout' };
    case 'unreachable':
      return { kind: 'unreachable', error: result.error };
  }
}
