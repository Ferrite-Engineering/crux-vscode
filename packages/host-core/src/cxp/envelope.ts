import { randomUUID } from 'node:crypto';
import { CxpFormatError } from './errors';
import { encodeFrame } from './framing';
import { asString, isJsonObject, type JsonObject } from './json';
import { CXP_PROTOCOL_VERSION } from './version';

/**
 * Wire envelope wrapping a message payload with routing metadata
 * (CXP §5). Every frame on a CXP socket is one of these.
 */
export interface CxpEnvelope {
  /** Protocol version the sender speaks (CXP §6). */
  readonly cxpVersion: string;
  /**
   * Identifier the sender assigned to this message, used to correlate
   * acknowledgements and errors. Unique within one connection.
   */
  readonly messageId: string;
  /** Sender's `peer_id` (CXP §8). */
  readonly from: string;
  /** Message-kind discriminator (CXP §9). */
  readonly kind: string;
  /** Kind-specific content. MAY be empty. */
  readonly payload: JsonObject;
}

/**
 * Mint a `message_id`.
 *
 * CXP §5 says it SHOULD be "a UUID or another value with negligible
 * collision probability", and `docs/implementation-map.md` §4.3 settles it
 * as a UUID. crux_cxp instead mints `m-<microseconds>-<counter>` on the
 * server and `c-<microseconds>-<counter>` on the client — a difference in
 * *format* only. Nothing in crux_cxp ever parses a `message_id`; it is
 * echoed verbatim in `in_reply_to` and otherwise opaque. Taking the
 * specification's form here is therefore not a wire divergence, and it
 * removes the one hazard the Dart scheme carries: two peers on one
 * connection minting the same counter-based id.
 */
export function newCxpMessageId(): string {
  return randomUUID();
}

/**
 * Decode an envelope from its JSON form (CXP §5).
 *
 * All five fields are required and type-checked; a missing or mistyped one
 * is `malformed_envelope`. Unrecognised envelope-level fields are ignored
 * — that is what makes minor revisions additive.
 *
 * The error messages are crux_cxp's, verbatim, because they travel to the
 * peer in the `error_response` payload and turn up in another
 * implementation's logs.
 *
 * @throws {CxpFormatError}
 */
export function decodeEnvelope(json: JsonObject): CxpEnvelope {
  const cxpVersion = asString(json['cxp_version']);
  if (cxpVersion === undefined) {
    throw new CxpFormatError('CxpEnvelope.fromJson: missing "cxp_version"');
  }
  const messageId = asString(json['message_id']);
  if (messageId === undefined) {
    throw new CxpFormatError('CxpEnvelope.fromJson: missing "message_id"');
  }
  const from = asString(json['from']);
  if (from === undefined) {
    throw new CxpFormatError('CxpEnvelope.fromJson: missing "from"');
  }
  const kind = asString(json['kind']);
  if (kind === undefined) {
    throw new CxpFormatError('CxpEnvelope.fromJson: missing "kind"');
  }
  const payload = json['payload'];
  if (!isJsonObject(payload)) {
    throw new CxpFormatError('CxpEnvelope.fromJson: missing "payload"');
  }
  return { cxpVersion, messageId, from, kind, payload };
}

/**
 * Parse one received frame into an envelope.
 *
 * Two failure shapes, both `malformed_envelope` on the wire: the text is
 * not JSON at all, and the top-level JSON value is not an object (crux_cxp
 * reports the latter as "Top-level JSON value is not an object.", which is
 * the string this reproduces).
 *
 * @throws {CxpFormatError}
 */
export function parseEnvelopeLine(line: string): CxpEnvelope {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch (error) {
    throw new CxpFormatError(error instanceof Error ? error.message : 'Invalid JSON.');
  }
  if (!isJsonObject(decoded)) {
    throw new CxpFormatError('Top-level JSON value is not an object.');
  }
  return decodeEnvelope(decoded);
}

/** Encode an envelope as JSON. */
export function encodeEnvelope(envelope: CxpEnvelope): JsonObject {
  return {
    cxp_version: envelope.cxpVersion,
    message_id: envelope.messageId,
    from: envelope.from,
    kind: envelope.kind,
    payload: envelope.payload,
  };
}

/**
 * Encode an envelope as a single frame: one line of JSON terminated by
 * `\n`. This is the v1 wire format on TCP sockets.
 */
export function encodeEnvelopeLine(envelope: CxpEnvelope): string {
  return encodeFrame(JSON.stringify(encodeEnvelope(envelope)));
}

/** Build an envelope from this peer, defaulting the version we speak. */
export function envelopeFor(options: {
  readonly from: string;
  readonly kind: string;
  readonly payload: JsonObject;
  readonly messageId?: string;
  readonly cxpVersion?: string;
}): CxpEnvelope {
  return {
    cxpVersion: options.cxpVersion ?? CXP_PROTOCOL_VERSION,
    messageId: options.messageId ?? newCxpMessageId(),
    from: options.from,
    kind: options.kind,
    payload: options.payload,
  };
}
