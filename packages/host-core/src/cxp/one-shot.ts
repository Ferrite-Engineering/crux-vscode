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
 * ### A refused handshake is not an unreachable peer
 *
 * A handshake answered `unauthorized` (or, under wire 1.3, a `hello_ack`
 * whose proof did not verify) means the socket was reached and something
 * answered: the usual cause is a stale manifest, read just before its peer
 * restarted with a new token. So the manifest is read again once and, if it
 * now names different credentials, the dial is retried before anything is
 * reported. A refusal that survives the retry is reported as
 * `unauthorized`, never folded into `unreachable`, so the user is not sent
 * to check whether a running app is running.
 *
 * Extracted from NetCrux's `sendHighlightToNetCrux`, which was the first
 * caller and is now one of two — the second being the desktop artifact
 * handoff. A second copy of "dial, handshake, send, await, hang up" is
 * exactly the duplication host-core exists to hold.
 */
import { cxpVersionHasMutualAuth } from './auth-token';
import { readFile } from 'node:fs/promises';
import { LocalCxpClient } from './client';
import { CxpDialRefusedError, CxpHandshakeError } from './errors';
import type { PeerIdentity } from './identity';
import { CXP_NON_LOOPBACK_REFUSAL_REASON, cxpLoopbackDialAddress } from './loopback';
import { isJsonObject } from './json';
import { decodeCxpPeerManifest, type CxpPeerManifest } from './manifest';
import {
  CxpErrorCode,
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
   * The peer answered the dial and refused the handshake: `unauthorized`,
   * because the manifest's token is not the one the peer's server holds, or
   * because the process on the port did not prove it holds it (wire 1.3).
   * Reported only after one re-read of the manifest and one retry.
   */
  | { readonly kind: 'unauthorized'; readonly error: unknown }
  /**
   * The peer could not be reached at all — stale manifest, refused socket,
   * a handshake that failed for any reason other than `unauthorized`, or a
   * [CxpDialRefusedError] because the manifest names a host that is not
   * loopback (no socket was opened).
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
  /**
   * Find the peer's current manifest after a handshake refused
   * `unauthorized`. A restarted peer usually writes a new file under a new
   * peer id, so a caller that found the manifest by scanning should pass the
   * same scan. Defaults to re-reading the refused manifest's own file.
   */
  readonly rediscover?: () => Promise<CxpPeerManifest | undefined>;
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
  const first = await attemptOneShot(manifest, message, options);
  if (first.kind !== 'unauthorized') return first;

  // The peer was reached and refused the credentials this manifest carried.
  // The usual cause is a manifest read just before its peer restarted with
  // a new token, so read it once more and retry once if it changed.
  const rediscover = options.rediscover ?? ((): Promise<CxpPeerManifest | undefined> =>
    rereadManifest(manifest.manifestPath));
  const fresh = await rediscover().catch(() => undefined);
  if (fresh === undefined || !credentialsDiffer(manifest, fresh)) return first;
  return await attemptOneShot(fresh, message, options);
}

/** Whether [b] would be dialled differently from [a]. Never compares in a log. */
function credentialsDiffer(a: CxpPeerManifest, b: CxpPeerManifest): boolean {
  return (
    a.host !== b.host ||
    a.port !== b.port ||
    a.token !== b.token ||
    a.cxpVersion !== b.cxpVersion
  );
}

async function rereadManifest(manifestPath: string): Promise<CxpPeerManifest | undefined> {
  const json: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  return isJsonObject(json) ? decodeCxpPeerManifest(json, manifestPath) : undefined;
}

function isUnauthorizedRefusal(error: unknown): boolean {
  return (
    error instanceof CxpHandshakeError && error.code === CxpErrorCode.unauthorized
  );
}

async function attemptOneShot(
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
    // The peer's token, from its manifest (wire 1.2), proved rather than
    // sent when the manifest announces 1.3 or later (CXP §7.4). A 1.2 peer
    // refuses a hello without it, and that refusal lands in `unreachable`
    // below.
    await client.connect({
      host: address,
      port: manifest.port,
      token: manifest.token,
      mutualAuth: cxpVersionHasMutualAuth(manifest.cxpVersion),
    });
  } catch (error) {
    await client.dispose();
    return isUnauthorizedRefusal(error)
      ? { kind: 'unauthorized', error }
      : { kind: 'unreachable', error };
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
