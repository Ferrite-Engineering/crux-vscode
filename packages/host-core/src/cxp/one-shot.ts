/**
 * One dial, one acknowledged request, one disconnect.
 *
 * ### Why this shape rather than the connector
 *
 * [CxpPeerConnector] dials *every* peer discovery surfaces and keeps the
 * links open — the right shape for the window's peer host, and the wrong
 * shape for a command. A user clicking "Open in WaveCrux Desktop" should not
 * cause this window to open links to LintCrux and SimCrux as a side effect;
 * and in a window that is *already* the peer host, sending through the host's
 * existing link would be better still — except that the link exists only if
 * the tie-break made this side the dialler, so a command that depended on it
 * would work for some peer-id orderings and not others.
 *
 * So: connect, send, wait for the answer, hang up. Every call starts clean
 * and leaves nothing running.
 *
 * ### Correlation
 *
 * One acknowledged message per connection, so the first frame of the
 * expected ack kind can only be the answer to this request — no
 * `in_reply_to` matching is needed, and none is possible: `LocalCxpClient.send`
 * mints the envelope internally and does not hand back its `message_id`. A
 * multiplexed connection would need both; this one deliberately is not.
 *
 * Extracted from NetCrux's `sendHighlightToNetCrux`, which was the first
 * caller and is now one of two — the second being the desktop artifact
 * handoff. A second copy of "dial, handshake, send, await, hang up" is
 * exactly the duplication host-core exists to hold.
 */
import { LocalCxpClient } from './client';
import { CxpDialRefusedError } from './errors';
import type { PeerIdentity } from './identity';
import { CXP_NON_LOOPBACK_REFUSAL_REASON, cxpLoopbackDialAddress } from './loopback';
import type { CxpPeerManifest } from './manifest';
import {
  CxpMessageKind,
  normaliseCxpErrorCode,
  type CxpErrorCodeName,
  type CxpMessage,
} from './messages';

/** Default wait for the acknowledgement before giving up. */
export const CXP_DEFAULT_ONE_SHOT_ACK_TIMEOUT_MS = 8_000;

/** What [sendOneShotRequest] produced. */
export type OneShotRequestResult =
  /** The peer acknowledged the request, honored or not. */
  | { readonly kind: 'acked'; readonly honored: boolean; readonly reason?: string }
  /**
   * The peer answered `error_response` instead of an ack.
   *
   * The case that matters is `unknown_kind` from a peer older than the wire
   * minor this message was added in: the request was not refused, it was not
   * understood, and a caller with a non-protocol fallback should take it.
   */
  | {
      readonly kind: 'error-response';
      readonly code: CxpErrorCodeName;
      readonly rawCode: string;
      readonly message: string;
    }
  /** The socket connected and handshook but nothing came back in time. */
  | { readonly kind: 'ack-timeout' }
  /**
   * The peer could not be reached at all — stale manifest, refused socket,
   * a handshake refused `unauthorized` because the manifest's token is not
   * the one the peer's server holds, or a [CxpDialRefusedError] because the
   * manifest names a host that is not loopback (no socket was opened).
   */
  | { readonly kind: 'unreachable'; readonly error: unknown };

/** Injected environment for [sendOneShotRequest]. */
export interface OneShotRequestOptions {
  /** This window's identity for the handshake. */
  readonly selfIdentity: PeerIdentity;
  /** The ack kind to wait for — `request_highlight_ack`, … */
  readonly ackKind: string;
  /** Milliseconds to wait. Defaults to [CXP_DEFAULT_ONE_SHOT_ACK_TIMEOUT_MS]. */
  readonly ackTimeoutMs?: number;
  /** Client factory, injectable for tests. */
  readonly clientFactory?: (self: PeerIdentity) => LocalCxpClient;
}

/**
 * Dial [manifest], send [message], and resolve once its acknowledgement
 * arrives (or the attempt fails).
 *
 * Never throws: a refused connection, a dead process behind a stale
 * manifest, and a peer that never answers all resolve to a
 * [OneShotRequestResult], because every caller runs from a command handler
 * where an unhandled rejection is invisible to the user.
 */
export async function sendOneShotRequest(
  manifest: CxpPeerManifest,
  message: CxpMessage,
  options: OneShotRequestOptions,
): Promise<OneShotRequestResult> {
  // The same host rule the connector holds every dial to, applied before a
  // client exists. This path is fed by `discoverDesktopPeer`, which reads the
  // same user-writable directory: a planted manifest would otherwise receive
  // the request — file paths included — at whatever address it named.
  const address = cxpLoopbackDialAddress(manifest.host);
  if (address === undefined) {
    return {
      kind: 'unreachable',
      error: new CxpDialRefusedError(manifest.host, manifest.port, CXP_NON_LOOPBACK_REFUSAL_REASON),
    };
  }

  const clientFactory =
    options.clientFactory ?? ((self) => new LocalCxpClient({ selfIdentity: self }));
  const client = clientFactory(options.selfIdentity);

  try {
    // The peer's token, from its manifest (wire 1.2). A 1.2 peer refuses a
    // hello without it, and that refusal lands in `unreachable` below.
    await client.connect({ host: address, port: manifest.port, token: manifest.token });
  } catch (error) {
    await client.dispose();
    return { kind: 'unreachable', error };
  }

  try {
    // The listener must be armed *before* the send: an answer that arrived
    // between sending and subscribing would otherwise be lost. `waitForAnswer`
    // subscribes synchronously inside its `Promise` executor, so calling it
    // without awaiting arms the listener immediately; only the `await` waits.
    const answer = waitForAnswer(
      client,
      options.ackKind,
      options.ackTimeoutMs ?? CXP_DEFAULT_ONE_SHOT_ACK_TIMEOUT_MS,
    );
    client.send(message);
    return await answer;
  } finally {
    await client.dispose();
  }
}

function waitForAnswer(
  client: LocalCxpClient,
  ackKind: string,
  timeoutMs: number,
): Promise<OneShotRequestResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: OneShotRequestResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription.dispose();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ kind: 'ack-timeout' });
    }, timeoutMs);
    const subscription = client.onInbound.listen(({ message }) => {
      if (message.kind === ackKind && 'honored' in message) {
        finish({
          kind: 'acked',
          honored: message.honored,
          ...(message.reason !== undefined ? { reason: message.reason } : {}),
        });
        return;
      }
      if (message.kind === CxpMessageKind.errorResponse) {
        finish({
          kind: 'error-response',
          code: normaliseCxpErrorCode(message.code),
          rawCode: message.code,
          message: message.message,
        });
      }
    });
  });
}
