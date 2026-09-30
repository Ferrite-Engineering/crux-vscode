/**
 * Errors the CXP transport raises.
 *
 * crux_cxp signals every decode failure with Dart's `FormatException` and
 * every handshake rejection with `CxpHandshakeException`. These are the
 * TypeScript counterparts, kept one-to-one so the fault paths line up when
 * the two implementations are read side by side.
 */

/**
 * A frame, envelope or payload could not be decoded.
 *
 * The counterpart of Dart's `FormatException`. Its [message] is what the
 * peer is told in the `error_response` payload, so it must stay free of
 * anything sensitive — it is diagnostic text for another process's log.
 */
export class CxpFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CxpFormatError';
  }
}

/**
 * A frame exceeded the inbound length cap.
 *
 * A subtype rather than a flag because the connection response differs: a
 * malformed envelope is answered `malformed_envelope` and then closed, a cap
 * breach is closed without an answer (CXP §4.2 — the receiver MUST close the
 * connection).
 */
export class CxpFrameTooLongError extends CxpFormatError {
  constructor(message: string) {
    super(message);
    this.name = 'CxpFrameTooLongError';
  }
}

/**
 * The remote peer rejected the handshake with an `error_response` instead
 * of a `hello_ack` — `unauthorized` when the `hello` did not carry the token
 * the peer published in its manifest — or answered with an incompatible
 * major version.
 *
 * The counterpart of Dart's `CxpHandshakeException`.
 */
export class CxpHandshakeError extends Error {
  /** Machine-readable error code — one of `CxpErrorCode`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CxpHandshakeError';
    this.code = code;
  }
}

/**
 * A dial was refused outright — no socket opened — as opposed to attempted
 * and failed. Today the one reason is a manifest whose `host` is not loopback
 * (see `isCxpLoopbackHost`).
 *
 * The counterpart of Dart's `CxpDialRefusedException`. Recorded as a dial
 * failure like any other, so an unreachable-peer row can say why and the
 * retry backs off; it is not counted as a dial attempt.
 */
export class CxpDialRefusedError extends Error {
  /** Host from the peer's manifest, as written there. */
  readonly host: string;
  /** Port from the peer's manifest. */
  readonly port: number;
  /** Why the dial was refused, written for a log or a diagnostics row. */
  readonly reason: string;

  constructor(host: string, port: number, reason: string) {
    // The message is the reason alone: the host travels in its own field, and
    // a string a manifest file chose is not repeated into prose.
    super(reason);
    this.name = 'CxpDialRefusedError';
    this.host = host;
    this.port = port;
    this.reason = reason;
  }
}

/**
 * A connect or handshake attempt exceeded its deadline.
 *
 * The counterpart of Dart's `TimeoutException` on
 * `handshake.future.timeout(handshakeTimeout)`: a peer that accepts the
 * socket and then never answers must not leave the dialler wedged
 * half-open.
 */
export class CxpTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CxpTimeoutError';
  }
}
