import type { Socket } from 'node:net';
import { cxpAuthTokensMatch } from './auth-token';
import {
  encodeEnvelopeLine,
  envelopeFor,
  newCxpMessageId,
  parseEnvelopeLine,
  type CxpEnvelope,
} from './envelope';
import { CxpFormatError, CxpHandshakeError } from './errors';
import {
  CappedLineSplitter,
  DEFAULT_CXP_MAX_LINE_LENGTH,
  DEFAULT_CXP_MAX_PENDING_WRITE_BYTES,
} from './framing';
import type { PeerIdentity } from './identity';
import {
  CxpErrorCode,
  CxpMessageKind,
  decodeCxpMessage,
  encodeCxpMessage,
  subscriptionMatches,
  type CxpMessage,
  type CxpSubscription,
} from './messages';
import { isCompatibleCxpVersion } from './version';

/**
 * Which end of the socket this connection is.
 *
 * The state machine is otherwise identical in both directions — a CXP
 * connection is full-duplex once it is up — but three rules are
 * asymmetric, and they are the whole reason the role is a parameter:
 *
 * - `inbound` (we accepted) sends `hello_ack` when it receives `hello`,
 *   and gates every other kind behind `handshake_required` until it has.
 * - `outbound` (we dialled) sends `hello` immediately and treats
 *   `hello_ack` as the handshake completing.
 */
export type CxpConnectionRole = 'inbound' | 'outbound';

/** Callbacks a [CxpConnection] reports through. */
export interface CxpConnectionHandlers {
  /** The remote identity is now known: `hello` in, or `hello_ack` in. */
  readonly onHandshake?: (identity: PeerIdentity) => void;
  /** A dispatchable message — everything the transport does not consume. */
  readonly onMessage?: (envelope: CxpEnvelope, message: CxpMessage) => void;
  /** The peer's subscription set changed (`subscribe` / `unsubscribe`). */
  readonly onSubscriptions?: (subscriptions: readonly CxpSubscription[]) => void;
  /** The peer said `goodbye`. Fires before [onClose]. */
  readonly onGoodbye?: (reason: string | undefined) => void;
  /** The connection is finished. [error] is set for a failure, not a clean end. */
  readonly onClose?: (error: Error | undefined) => void;
}

/** Construction options for a [CxpConnection]. */
export interface CxpConnectionOptions {
  readonly socket: Socket;
  readonly selfIdentity: PeerIdentity;
  readonly role: CxpConnectionRole;
  readonly handlers?: CxpConnectionHandlers;
  readonly maxLineLength?: number;
  readonly maxPendingWriteBytes?: number;
  /**
   * `outbound` only: the token to present in our `hello` — the remote
   * peer's manifest `token` (wire 1.2). Absent sends a `hello` with no
   * token field at all, which is the pre-1.2 frame.
   */
  readonly helloToken?: string | undefined;
  /**
   * `inbound` only: the token every `hello` must carry. A `hello` without
   * it is answered `unauthorized` and the connection closed before the
   * dialler becomes a peer. Absent accepts any `hello` — the pre-1.2
   * behaviour, and what `LocalCxpServerOptions.requireAuthToken: false`
   * selects.
   */
  readonly requiredToken?: string | undefined;
}

/**
 * One live CXP socket: framing, the envelope, the handshake, and the
 * dispatch rules of CXP §§4–9.
 *
 * Both halves of the transport share this class, which is the point. The
 * reference implementation keeps two copies of the read loop
 * (`LocalCxpServer._PeerConnection._onLine` and `LocalCxpClient._onLine`).
 *
 * **A frame that is not an envelope ends the connection, in both roles.**
 * Both Dart copies now agree on that: the server answers
 * `malformed_envelope` and closes, and the client fails its handshake (or
 * drops an established link) with a `FormatException`. It is what makes a
 * fixed, well-known port safe to leave listening — a browser `fetch()` to it
 * with a `text/plain` body needs no CORS preflight, and a receiver that
 * answered each bad frame and read on would dispatch that body as a
 * handshake and a stream of requests. See [rejectFrame].
 *
 * **They still drift on an unknown kind:** the Dart client silently drops
 * one where the Dart server answers `unknown_kind`. §6.1 and the §12
 * conformance list make answering it a MUST for a receiver, without
 * qualification by which side dialled, so this class applies the server's —
 * the specification's — behaviour in both roles, and for the same reason
 * answers `malformed_envelope` before closing on the outbound side too. The
 * extra frame is inert against a Dart peer: it dispatches an
 * `error_response` to its inbound stream and never answers it (§9.8 forbids
 * that), so there is no error ping-pong to be had.
 *
 * The dispatch order below is `_onLine`'s, and it is load-bearing. An
 * unknown *kind* sent before the handshake is answered `unknown_kind`, not
 * `handshake_required`, because the decode happens first; an implementation
 * that reorders those two gates disagrees with every shipping Crux peer. The
 * token check (wire 1.2) is last, inside the `hello` case, exactly where
 * crux_cxp makes it.
 */
export class CxpConnection {
  readonly role: CxpConnectionRole;
  readonly selfIdentity: PeerIdentity;

  private readonly socket: Socket;
  private readonly handlers: CxpConnectionHandlers;
  private readonly maxPendingWriteBytes: number;
  private readonly splitter: CappedLineSplitter;
  private readonly helloToken: string | undefined;
  private readonly requiredToken: string | undefined;

  private remote: PeerIdentity | undefined;
  private subs: readonly CxpSubscription[] = [];
  private pending = 0;
  private closed = false;
  private socketDead = false;

  constructor(options: CxpConnectionOptions) {
    this.socket = options.socket;
    this.selfIdentity = options.selfIdentity;
    this.role = options.role;
    this.handlers = options.handlers ?? {};
    this.maxPendingWriteBytes = options.maxPendingWriteBytes ?? DEFAULT_CXP_MAX_PENDING_WRITE_BYTES;
    this.helloToken = options.helloToken;
    this.requiredToken = options.requiredToken;
    this.splitter = new CappedLineSplitter(
      {
        onLine: (line) => {
          this.handleLine(line);
        },
        onError: (error) => {
          // CXP §4.2: exceeding the frame cap MUST close the connection.
          this.disconnect(error);
        },
        onEnd: () => {
          this.disconnect(undefined);
        },
      },
      options.maxLineLength ?? DEFAULT_CXP_MAX_LINE_LENGTH,
    );
  }

  /** The remote peer's identity, once the handshake has established it. */
  get remoteIdentity(): PeerIdentity | undefined {
    return this.remote;
  }

  /** The remote peer's current subscription filters. */
  get subscriptions(): readonly CxpSubscription[] {
    return this.subs;
  }

  /** Outbound frame bytes queued for the socket but not yet flushed. */
  get pendingWriteBytes(): number {
    return this.pending;
  }

  /** Whether this connection has been torn down. */
  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * Attach to the socket and, for the `outbound` role, send `hello`.
   *
   * CXP §7.1: the first message a peer sends on a new connection MUST be
   * `hello`, so it is sent here rather than left to the caller.
   */
  start(): void {
    this.socket.setNoDelay(true);
    this.socket.on('data', (chunk: Buffer) => {
      this.splitter.writeBytes(chunk);
    });
    this.socket.on('error', (error: Error) => {
      this.socketDead = true;
      this.disconnect(error);
    });
    this.socket.on('close', () => {
      this.socketDead = true;
      this.disconnect(undefined);
    });
    this.socket.on('end', () => {
      this.splitter.end();
    });
    if (this.role === 'outbound') {
      const token = this.helloToken;
      this.sendMessage({
        kind: CxpMessageKind.hello,
        identity: this.selfIdentity,
        ...(token !== undefined ? { token } : {}),
      });
    }
  }

  /** Whether [message] matches any of the peer's subscription filters. */
  accepts(message: CxpMessage): boolean {
    return this.subs.some((sub) => subscriptionMatches(sub, message));
  }

  /** Send a message body in a fresh envelope from this peer. */
  sendMessage(message: CxpMessage): void {
    this.sendEnvelope(
      envelopeFor({
        from: this.selfIdentity.peerId,
        kind: message.kind,
        payload: encodeCxpMessage(message),
      }),
    );
  }

  /** Send a pre-built envelope. */
  sendEnvelope(envelope: CxpEnvelope): void {
    this.write(encodeEnvelopeLine(envelope));
  }

  /**
   * Tear the connection down.
   *
   * `end()` rather than `destroy()`: the read loop queues a final frame —
   * an `error_response` for an unsupported version, a refused token or a
   * frame that is not an envelope — and then immediately disconnects, and
   * that frame must reach the peer before the FIN does.
   */
  disconnect(error: Error | undefined): void {
    if (this.closed) return;
    this.closed = true;
    this.splitter.stop();
    this.socket.removeAllListeners('data');
    try {
      if (this.socketDead) {
        this.socket.destroy();
      } else {
        this.socket.end();
      }
    } catch {
      // Already gone; nothing to flush.
    }
    this.handlers.onClose?.(error);
  }

  private write(line: string): void {
    if (this.closed || this.socketDead) return;
    // Counted in UTF-16 code units, as crux_cxp counts them, so the two
    // implementations reach the cap on the same traffic.
    const bytes = line.length;
    if (this.pending + bytes > this.maxPendingWriteBytes) {
      // The outbound mirror of the inbound frame cap: a peer that
      // handshakes and then stops draining gets dropped rather than
      // growing this process's heap without bound.
      this.disconnect(
        new Error(
          'Outbound CXP write buffer exceeded maxPendingWriteBytes; the peer is not reading.',
        ),
      );
      return;
    }
    this.pending += bytes;
    this.socket.write(line, () => {
      this.pending -= bytes;
    });
  }

  private handleLine(line: string): void {
    if (line.length === 0) return;

    let envelope: CxpEnvelope;
    try {
      envelope = parseEnvelopeLine(line);
    } catch (error) {
      this.rejectFrame(error instanceof CxpFormatError ? error.message : 'Malformed envelope.');
      return;
    }

    if (!isCompatibleCxpVersion(envelope.cxpVersion)) {
      // CXP §6: major mismatch is answered AND closed. A dialling peer
      // additionally fails its pending handshake, which is what the
      // CxpHandshakeError carried into disconnect() does.
      this.sendError(
        CxpErrorCode.unsupportedVersion,
        `Unsupported cxp_version "${envelope.cxpVersion}".`,
        envelope.messageId,
        envelope.kind,
      );
      this.disconnect(
        new CxpHandshakeError(
          CxpErrorCode.unsupportedVersion,
          `Peer speaks cxp_version "${envelope.cxpVersion}".`,
        ),
      );
      return;
    }

    let message: CxpMessage | undefined;
    try {
      message = decodeCxpMessage(envelope.kind, envelope.payload);
    } catch (error) {
      // Known kind, undecodable payload: report it rather than letting the
      // failure escape the read loop, and keep the connection.
      this.sendError(
        CxpErrorCode.malformedPayload,
        error instanceof CxpFormatError ? error.message : 'Malformed payload.',
        envelope.messageId,
        envelope.kind,
      );
      return;
    }
    if (message === undefined) {
      // CXP §6.1: answer and keep serving. Closing here would make every
      // additive protocol revision a breaking one.
      this.sendError(
        CxpErrorCode.unknownKind,
        `Unknown message kind "${envelope.kind}".`,
        envelope.messageId,
        envelope.kind,
      );
      return;
    }

    if (
      this.role === 'inbound' &&
      this.remote === undefined &&
      message.kind !== CxpMessageKind.hello
    ) {
      this.sendError(
        CxpErrorCode.handshakeRequired,
        'A Hello message is required before any other traffic.',
        envelope.messageId,
        envelope.kind,
      );
      return;
    }

    if (this.role === 'outbound' && message.kind === CxpMessageKind.errorResponse) {
      // A rejection while the handshake is pending must fail the dial —
      // otherwise the caller's connect() waits for a hello_ack that will
      // never come. After the handshake it is ordinary traffic.
      if (this.remote === undefined) {
        this.disconnect(new CxpHandshakeError(message.code, message.message));
        return;
      }
    }

    switch (message.kind) {
      case CxpMessageKind.hello:
        if (this.role === 'inbound') {
          const required = this.requiredToken;
          if (required !== undefined && !cxpAuthTokensMatch(message.token, required)) {
            // The dialler could reach the port but not the manifest that
            // names it — or read a stale one. Either way it has not shown
            // what this server requires, so it is told which requirement
            // failed (never what the token is) and dropped before it is a
            // peer: no identity is recorded, so no presence event and no
            // dispatch. crux_cxp's wording, verbatim, because it lands in
            // the other implementation's log.
            this.sendError(
              CxpErrorCode.unauthorized,
              'A hello to this peer must carry the token published in its manifest.',
              envelope.messageId,
              envelope.kind,
            );
            this.disconnect(
              new CxpHandshakeError(
                CxpErrorCode.unauthorized,
                'Refused a hello that did not carry the required token.',
              ),
            );
            return;
          }
          this.remote = message.identity;
          this.sendMessage({
            kind: CxpMessageKind.helloAck,
            identity: this.selfIdentity,
            inReplyTo: envelope.messageId,
          });
          this.handlers.onHandshake?.(message.identity);
          return;
        }
        break;
      case CxpMessageKind.helloAck:
        if (this.role === 'outbound') {
          this.remote = message.identity;
          this.handlers.onHandshake?.(message.identity);
          return;
        }
        break;
      case CxpMessageKind.subscribe:
        // CXP §9.1: a subscribe REPLACES the previous set, never adds.
        this.subs = [...message.subscriptions];
        this.handlers.onSubscriptions?.(this.subs);
        return;
      case CxpMessageKind.unsubscribe:
        this.subs = [];
        this.handlers.onSubscriptions?.(this.subs);
        return;
      case CxpMessageKind.goodbye:
        this.handlers.onGoodbye?.(message.reason);
        this.disconnect(undefined);
        return;
      default:
        break;
    }

    this.handlers.onMessage?.(envelope, message);
  }

  /**
   * Answer a frame that is not a CXP envelope with `malformed_envelope`, and
   * close the connection.
   *
   * Closing — rather than answering and reading on, which is what this path
   * used to do — is what makes a well-known port safe to leave listening.
   * Every product binds a fixed default (54322–54325), and a web page can
   * `fetch()` any of them: a `text/plain` POST needs no preflight, so the
   * browser writes the HTTP request straight onto the socket. Its request
   * line and headers are frames this decoder rejects; its body is whatever
   * the page chose, newline-delimited JSON included. A receiver that
   * answered each bad frame and kept going would then dispatch that body as
   * a handshake and a stream of requests — from any site the user had open,
   * blind, since the page cannot read the reply. An HTTP request cannot
   * begin with a JSON object, so dropping the connection on the first frame
   * that is not one ends the vector before the body is reached.
   *
   * The outbound side closes for the containment reason: the peer on the
   * other end of a link is whatever answered the port a manifest named, and
   * a link is a full-duplex channel into this process's dispatch stream. A
   * pending dial fails with the [CxpFormatError], as crux_cxp's client fails
   * with a `FormatException`.
   *
   * The same rule costs a conforming peer nothing: it never sends a frame
   * that is not an envelope. Frames that *are* envelopes but carry an
   * undecodable payload (`malformed_payload`) or an unknown kind
   * (`unknown_kind`) still leave the connection open, as §6.1 requires.
   */
  private rejectFrame(reason: string): void {
    this.sendError(CxpErrorCode.malformedEnvelope, reason, '', undefined);
    this.disconnect(new CxpFormatError(`Peer sent a frame that is not an envelope: ${reason}`));
  }

  private sendError(
    code: string,
    message: string,
    inReplyTo: string,
    offendingKind: string | undefined,
  ): void {
    // CXP §9.8: a peer MUST NOT send an error_response in reply to an
    // error_response. Without this, two implementations can ping-pong a
    // malformed error forever.
    //
    // DIVERGENCE: crux_cxp has no such guard — its read loop will answer
    // `malformed_payload` to an undecodable `error_response`, and
    // `handshake_required` to one that arrives before the handshake. We
    // apply the rule the specification states, because the alternative is
    // a loop that only stays terminated by luck.
    if (offendingKind === CxpMessageKind.errorResponse) return;
    this.sendEnvelope(
      envelopeFor({
        from: this.selfIdentity.peerId,
        kind: CxpMessageKind.errorResponse,
        payload: { code, message, in_reply_to: inReplyTo },
        messageId: newCxpMessageId(),
      }),
    );
  }
}
