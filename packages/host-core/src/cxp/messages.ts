import {
  decodeElementId,
  decodeElementIdList,
  encodeElementId,
  type ElementId,
  type ElementKind,
} from './element-id';
import { CxpFormatError } from './errors';
import { decodeIdentityField, encodePeerIdentity, type PeerIdentity } from './identity';
import {
  asInteger,
  asJsonArray,
  asJsonObject,
  asString,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from './json';
import {
  decodeStreamCoordinate,
  encodeStreamCoordinate,
  type CxpStreamCoordinate,
} from './stream-coordinate';

/**
 * The message kinds this build defines (CXP §9, plus the two added in wire
 * minor 1.1).
 *
 * A frozen object of string constants rather than a TypeScript `enum`: the
 * wire vocabulary is **open**, so a kind that is not in this list is not an
 * error, it is `unknown_kind` and a still-open connection (§6.1).
 */
export const CxpMessageKind = {
  /** Initial handshake — peer announces itself. */
  hello: 'hello',
  /** Acknowledgement of a `hello`. */
  helloAck: 'hello_ack',
  /** Peer announcing it is shutting down cleanly. */
  goodbye: 'goodbye',
  /** Subscribe to message kinds, with optional element filters. */
  subscribe: 'subscribe',
  /** Cancel every subscription. */
  unsubscribe: 'unsubscribe',
  /** Peer announces its current selection. */
  notifySelection: 'notify_selection',
  /** Peer asks another to focus a specific element. */
  requestHighlight: 'request_highlight',
  /** Acknowledgement of a `request_highlight`. */
  requestHighlightAck: 'request_highlight_ack',
  /** Peer asks another to open a source-code location. */
  requestOpenSource: 'request_open_source',
  /** Acknowledgement of a `request_open_source`. */
  requestOpenSourceAck: 'request_open_source_ack',
  /** Peer asks another to open a design artifact. Added in 1.1. */
  requestOpenArtifact: 'request_open_artifact',
  /** Acknowledgement of a `request_open_artifact`. Added in 1.1. */
  requestOpenArtifactAck: 'request_open_artifact_ack',
  /** Error returned for a malformed or unprocessable message. */
  errorResponse: 'error_response',
} as const;

/** One of the thirteen kinds this build defines. */
export type CxpMessageKindName = (typeof CxpMessageKind)[keyof typeof CxpMessageKind];

/**
 * Machine-readable error codes the protocol defines (CXP §9.8).
 *
 * The vocabulary is open: a receiver SHOULD treat a code it does not
 * recognise as it would [internalError] (§6.1) — see
 * [normaliseCxpErrorCode].
 */
export const CxpErrorCode = {
  /** The frame was not a valid envelope. */
  malformedEnvelope: 'malformed_envelope',
  /** The `kind` is not recognised. */
  unknownKind: 'unknown_kind',
  /** The payload did not match the shape required by its kind. */
  malformedPayload: 'malformed_payload',
  /** A non-`hello` message arrived before the handshake completed. */
  handshakeRequired: 'handshake_required',
  /** The sender's major version is incompatible. */
  unsupportedVersion: 'unsupported_version',
  /**
   * The `hello` did not carry the token the receiver published in its
   * manifest, and the receiver requires one. Sent in reply to the `hello`,
   * after which the receiver closes. Added in wire minor 1.2; a 1.0/1.1
   * dialler treats it as `internal_error` (§6.1) and fails its handshake,
   * which is the right outcome.
   */
  unauthorized: 'unauthorized',
  /** The referenced element is not present in the receiver's design. */
  elementNotFound: 'element_not_found',
  /** The message was understood but this peer cannot act on it. */
  unsupported: 'unsupported',
  /** The receiver failed for reasons of its own. */
  internalError: 'internal_error',
} as const;

/** One of the nine codes this build defines. */
export type CxpErrorCodeName = (typeof CxpErrorCode)[keyof typeof CxpErrorCode];

const KNOWN_ERROR_CODES: readonly string[] = Object.values(CxpErrorCode);

/**
 * [code] if this build knows it, otherwise `internal_error` — the §6.1
 * rule for unrecognised error codes.
 *
 * Use it when *acting* on a received code. The code as sent is still
 * available on the decoded message for logging; this is the value logic
 * should branch on.
 */
export function normaliseCxpErrorCode(code: string): CxpErrorCodeName {
  return KNOWN_ERROR_CODES.includes(code)
    ? (code as CxpErrorCodeName)
    : CxpErrorCode.internalError;
}

/**
 * Reserved namespaced `metadata` key carrying the opaque shared-design
 * identifier across the wire (wire minor 1.1).
 *
 * Senders SHOULD attach it to `notify_selection` and `request_highlight`
 * so a receiver that cannot satisfy the reference locally can look the
 * design up in its shared-workspace manifest. The value is opaque; this
 * library never computes it.
 */
export const CXP_DESIGN_ID_METADATA_KEY = 'crux.design_id';

/**
 * Initial handshake message. `identity` is required.
 *
 * Since wire 1.2 the payload MAY carry the [token] the recipient published in
 * its manifest; a recipient that requires one answers a `hello` without it
 * `unauthorized` and closes. See `auth-token.ts` for what the token is and is
 * not.
 */
export interface Hello {
  readonly kind: typeof CxpMessageKind.hello;
  readonly identity: PeerIdentity;
  /**
   * The recipient's authentication token, as read from the recipient's
   * manifest. Absent when the dialler has none to present — a pre-1.2
   * manifest, or a pre-1.2 dialler. An empty string on the wire decodes as
   * absent, as it does in crux_cxp. Never log a decoded `hello` whole.
   */
  readonly token?: string;
}

/** Reply to a [Hello] — the receiver echoes its own identity. */
export interface HelloAck {
  readonly kind: typeof CxpMessageKind.helloAck;
  readonly identity: PeerIdentity;
  /** The `message_id` of the `hello` this acknowledges. */
  readonly inReplyTo: string;
}

/**
 * Peer announces it is shutting down cleanly.
 *
 * A receiver SHOULD close the connection and SHOULD NOT immediately redial
 * that peer (CXP §7.3).
 */
export interface Goodbye {
  readonly kind: typeof CxpMessageKind.goodbye;
  readonly reason?: string;
}

/**
 * Subscription filter applied to one message kind (CXP §9.1).
 *
 * Both filters are existential over *all* referenced elements and
 * independent of each other: [elementKinds] is satisfied by at least one
 * element of a listed kind, [pathPrefix] by at least one element whose path
 * starts with it, and no single element need satisfy both. A message with no
 * referenced elements matches only subscriptions without element filters —
 * except a selection retraction, which §9.1.2 exempts. See
 * [subscriptionMatches].
 */
export interface CxpSubscription {
  readonly messageKind: string;
  readonly elementKinds: readonly ElementKind[];
  readonly pathPrefix?: string;
}

/** Subscribe to one or more message kinds. Replaces the previous set. */
export interface Subscribe {
  readonly kind: typeof CxpMessageKind.subscribe;
  readonly subscriptions: readonly CxpSubscription[];
}

/** Cancel every subscription. Empty payload. */
export interface Unsubscribe {
  readonly kind: typeof CxpMessageKind.unsubscribe;
}

/**
 * Peer announces its current selection — the protocol's primary message.
 * A statement, not a request; not acknowledged.
 */
export interface NotifySelection {
  readonly kind: typeof CxpMessageKind.notifySelection;
  readonly elements: readonly ElementId[];
  /** Human-friendly label. Recipients MAY use it when they cannot resolve. */
  readonly displayName?: string;
  /** Semantic stream coordinate (CXP §9.9). */
  readonly coordinate?: CxpStreamCoordinate;
  /** Product-local metadata. Recipients MUST ignore unknown keys. */
  readonly metadata: JsonObject;
}

/** Peer asks another to bring an element into view and highlight it. */
export interface RequestHighlight {
  readonly kind: typeof CxpMessageKind.requestHighlight;
  readonly element: ElementId;
  /** Where *within* the element to land (CXP §9.9). */
  readonly coordinate?: CxpStreamCoordinate;
  /** May carry [CXP_DESIGN_ID_METADATA_KEY]. */
  readonly metadata: JsonObject;
}

/** Acknowledgement of a [RequestHighlight]. */
export interface RequestHighlightAck {
  readonly kind: typeof CxpMessageKind.requestHighlightAck;
  readonly inReplyTo: string;
  readonly honored: boolean;
  readonly reason?: string;
}

/** Peer asks another to open a source location. */
export interface RequestOpenSource {
  readonly kind: typeof CxpMessageKind.requestOpenSource;
  readonly filePath: string;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column number. */
  readonly column?: number;
}

/** Acknowledgement of a [RequestOpenSource]. */
export interface RequestOpenSourceAck {
  readonly kind: typeof CxpMessageKind.requestOpenSourceAck;
  readonly inReplyTo: string;
  readonly honored: boolean;
  readonly reason?: string;
}

/**
 * Peer asks another to open a *design artifact* by kind, resolving the
 * concrete file through the shared-workspace manifest keyed on the design
 * id. Added in wire minor 1.1.
 *
 * Note the two levels of "kind": the envelope discriminator is always
 * `request_open_artifact`, while the payload's `kind` field is
 * [artifactKind].
 */
export interface RequestOpenArtifact {
  readonly kind: typeof CxpMessageKind.requestOpenArtifact;
  readonly designId: string;
  /** `waveform`, `netlist`, `source`, … — an open string set. */
  readonly artifactKind: string;
  /** Concrete-path hint. Receivers SHOULD prefer their own resolution. */
  readonly path?: string;
}

/** Acknowledgement of a [RequestOpenArtifact]. */
export interface RequestOpenArtifactAck {
  readonly kind: typeof CxpMessageKind.requestOpenArtifactAck;
  readonly inReplyTo: string;
  readonly honored: boolean;
  readonly reason?: string;
}

/**
 * Reports that a received message could not be processed (CXP §9.8).
 *
 * A peer MUST NOT send an `error_response` in reply to an
 * `error_response`.
 */
export interface ErrorResponse {
  readonly kind: typeof CxpMessageKind.errorResponse;
  readonly code: string;
  readonly message: string;
  /** Empty when the offending frame could not be decoded far enough. */
  readonly inReplyTo: string;
}

/** Every message body this build models, discriminated on `kind`. */
export type CxpMessage =
  | Hello
  | HelloAck
  | Goodbye
  | Subscribe
  | Unsubscribe
  | NotifySelection
  | RequestHighlight
  | RequestHighlightAck
  | RequestOpenSource
  | RequestOpenSourceAck
  | RequestOpenArtifact
  | RequestOpenArtifactAck
  | ErrorResponse;

/**
 * The "subscribe to everything" default a connector announces after each
 * handshake, so cross-product gossip flows without per-product wiring.
 *
 * Handshake and control kinds (`hello`, `hello_ack`, `goodbye`,
 * `subscribe`, `unsubscribe`) are transport-level and never
 * subscription-routed, so they are not listed. **The wire format has no
 * wildcard kind** — "all" is this explicit enumeration, and it must stay
 * identical to crux_cxp's `cxpSubscribeToAll` or the two implementations
 * gossip different subsets.
 */
export const CXP_SUBSCRIBE_TO_ALL: readonly CxpSubscription[] = [
  { messageKind: CxpMessageKind.notifySelection, elementKinds: [] },
  { messageKind: CxpMessageKind.requestHighlight, elementKinds: [] },
  { messageKind: CxpMessageKind.requestHighlightAck, elementKinds: [] },
  { messageKind: CxpMessageKind.requestOpenSource, elementKinds: [] },
  { messageKind: CxpMessageKind.requestOpenSourceAck, elementKinds: [] },
  { messageKind: CxpMessageKind.requestOpenArtifact, elementKinds: [] },
  { messageKind: CxpMessageKind.requestOpenArtifactAck, elementKinds: [] },
  { messageKind: CxpMessageKind.errorResponse, elementKinds: [] },
];

/**
 * The elements [message] refers to, in payload order.
 *
 * Subscription filters are evaluated against this list; messages that
 * carry no element references return empty.
 */
export function referencedElements(message: CxpMessage): readonly ElementId[] {
  switch (message.kind) {
    case CxpMessageKind.notifySelection:
      return message.elements;
    case CxpMessageKind.requestHighlight:
      return [message.element];
    default:
      return [];
  }
}

/**
 * Whether [message] is a **retraction** — a `notify_selection` whose
 * `elements` array is empty (CXP §9.1.2).
 *
 * The exemption below is deliberately narrow and this predicate is where
 * that narrowness lives: that kind, an empty array, nothing else. Any other
 * message carrying no element references is still undeliverable to an
 * element-filtered subscription.
 */
function isSelectionRetraction(message: CxpMessage): boolean {
  return message.kind === CxpMessageKind.notifySelection && message.elements.length === 0;
}

/**
 * Whether [message] satisfies [subscription] — the delivery predicate of
 * CXP §9.1.1, with §9.1.2's retraction exemption.
 *
 * Both element filters are **existential over all referenced elements**,
 * independent of each other and of position:
 *
 * - `element_kinds` is satisfied when *at least one* referenced element is
 *   of a listed kind;
 * - `path_prefix` is satisfied when *at least one* referenced element's
 *   path begins with it;
 * - no element has to satisfy both.
 *
 * ### What changed, and why it was worth a spec ruling
 *
 * This predicate used to prefix-test `elements[0]` alone, inherited from
 * `crux_cxp`, which read the §9.1 table more narrowly than it said.
 * `elements` is in *the sender's own order* — a presentation detail, usually
 * the order the user clicked — so a positional test makes routing depend on
 * click order: a multi-select spanning two scopes was delivered or dropped
 * according to which scope the user happened to click first. CXP §9.1.1
 * (added in the specification's rev. 4) rules that out as a conformance
 * failure, and §9.1.2 exempts a retraction from element filtering entirely,
 * closing the hole where a filtered subscriber could never be told that a
 * selection it *was* told about had been withdrawn.
 *
 * Both fixes land in `crux_cxp` and here together — the whole point of a
 * ruling is that the two implementations move at once.
 *
 * The predicate is a **floor, not a ceiling** (§9.1.1): a router MUST
 * deliver everything that satisfies it, and delivering more than that is
 * legal. Subscriptions reduce traffic; they are not access control (§11).
 */
export function subscriptionMatches(
  subscription: CxpSubscription,
  message: CxpMessage,
): boolean {
  if (message.kind !== subscription.messageKind) return false;
  if (subscription.elementKinds.length === 0 && subscription.pathPrefix === undefined) {
    return true;
  }
  // §9.1.2: a retraction reaches every subscriber of the kind, whatever
  // filters it carries. Checked before the filters rather than inside them,
  // because it is an exemption from both at once.
  if (isSelectionRetraction(message)) return true;

  const elements = referencedElements(message);
  if (
    subscription.elementKinds.length > 0 &&
    !elements.some((e) => subscription.elementKinds.includes(e.kind))
  ) {
    return false;
  }
  const prefix = subscription.pathPrefix;
  if (prefix !== undefined && !elements.some((e) => e.path.startsWith(prefix))) {
    return false;
  }
  return true;
}

function decodeMetadata(raw: JsonValue | undefined): JsonObject {
  return asJsonObject(raw) ?? {};
}

function decodeSubscription(json: JsonObject): CxpSubscription {
  const messageKind = asString(json['message_kind']);
  if (messageKind === undefined) {
    throw new CxpFormatError('CxpSubscription.fromJson: missing "message_kind"');
  }
  const elementKinds: ElementKind[] = [];
  for (const entry of asJsonArray(json['element_kinds']) ?? []) {
    // Kinds this build does not know are kept, not dropped: silently
    // discarding an unrecognised filter term would *widen* the
    // subscription rather than narrow it — in the all-unknown case turning
    // a filtered subscription into an unfiltered one.
    if (typeof entry === 'string' && entry.length > 0 && !elementKinds.includes(entry)) {
      elementKinds.push(entry);
    }
  }
  const pathPrefix = asString(json['path_prefix']);
  return {
    messageKind,
    elementKinds,
    ...(pathPrefix !== undefined ? { pathPrefix } : {}),
  };
}

function encodeSubscription(subscription: CxpSubscription): JsonObject {
  return {
    message_kind: subscription.messageKind,
    element_kinds: [...subscription.elementKinds],
    ...(subscription.pathPrefix !== undefined ? { path_prefix: subscription.pathPrefix } : {}),
  };
}

function decodeAck(json: JsonObject, context: string): {
  inReplyTo: string;
  honored: boolean;
  reason?: string;
} {
  const inReplyTo = asString(json['in_reply_to']);
  if (inReplyTo === undefined) {
    throw new CxpFormatError(`${context}: missing "in_reply_to"`);
  }
  const honored = json['honored'];
  if (typeof honored !== 'boolean') {
    throw new CxpFormatError(`${context}: missing "honored"`);
  }
  const reason = asString(json['reason']);
  return { inReplyTo, honored, ...(reason !== undefined ? { reason } : {}) };
}

function encodeAck(message: {
  inReplyTo: string;
  honored: boolean;
  reason?: string;
}): JsonObject {
  return {
    in_reply_to: message.inReplyTo,
    honored: message.honored,
    ...(message.reason !== undefined ? { reason: message.reason } : {}),
  };
}

/**
 * Decode a message body of the given [kind] from its [payload].
 *
 * Returns `undefined` when [kind] is not one this build models — callers
 * answer `unknown_kind` and **keep the connection open** (§6.1). Throws
 * for a known kind whose payload does not decode; callers answer
 * `malformed_payload` and also keep the connection open.
 *
 * Every decoder is tolerant of unknown payload fields, which is the other
 * half of the forward-compatibility rule.
 *
 * @throws {CxpFormatError}
 */
export function decodeCxpMessage(kind: string, payload: JsonObject): CxpMessage | undefined {
  switch (kind) {
    case CxpMessageKind.hello: {
      const identity = decodeIdentityField(payload['identity'], 'Hello.fromJson');
      // Optional (wire 1.2). Anything but a non-empty string is no token —
      // `token is String && token.isNotEmpty` in crux_cxp's Hello.fromJson —
      // so a mistyped token is refused as missing, not as malformed.
      const token = asString(payload['token']);
      return {
        kind: CxpMessageKind.hello,
        identity,
        ...(token !== undefined && token.length > 0 ? { token } : {}),
      };
    }
    case CxpMessageKind.helloAck: {
      const identityValue = payload['identity'];
      if (!isJsonObject(identityValue)) {
        throw new CxpFormatError('HelloAck.fromJson: missing "identity"');
      }
      const inReplyTo = asString(payload['in_reply_to']);
      if (inReplyTo === undefined) {
        throw new CxpFormatError('HelloAck.fromJson: missing "in_reply_to"');
      }
      return {
        kind: CxpMessageKind.helloAck,
        identity: decodeIdentityField(identityValue, 'HelloAck.fromJson'),
        inReplyTo,
      };
    }
    case CxpMessageKind.goodbye: {
      const reason = asString(payload['reason']);
      return { kind: CxpMessageKind.goodbye, ...(reason !== undefined ? { reason } : {}) };
    }
    case CxpMessageKind.subscribe: {
      const subscriptions: CxpSubscription[] = [];
      for (const entry of asJsonArray(payload['subscriptions']) ?? []) {
        if (isJsonObject(entry)) subscriptions.push(decodeSubscription(entry));
      }
      return { kind: CxpMessageKind.subscribe, subscriptions };
    }
    case CxpMessageKind.unsubscribe:
      return { kind: CxpMessageKind.unsubscribe };
    case CxpMessageKind.notifySelection: {
      // `elements` is REQUIRED to be present and to be an array (CXP §9.3),
      // but MAY be **empty** — an empty array is how a peer says "my
      // selection is now cleared". Both implementations rejected the empty
      // case until crux_cxp 0.4.4, which left "the user deselected
      // everything" with no legal wire representation and answered a
      // conforming peer `malformed_payload`. The Dart decoder was fixed
      // there; this is the matching fix, down to the message text, so the
      // two peers refuse and accept exactly the same frames.
      //
      // Missing, or present but not an array, is still `malformed_payload`.
      // Absence is not the same statement as emptiness: a sender that
      // forgot the key has told us nothing, and reading that as "cleared"
      // would silently blank a peer's selection on a malformed frame.
      const rawElements = payload['elements'];
      if (!Array.isArray(rawElements)) {
        throw new CxpFormatError(
          'NotifySelection.fromJson: missing or non-array "elements"',
        );
      }
      const elements = decodeElementIdList(rawElements);
      const displayName = asString(payload['display_name']);
      const coordinate = decodeStreamCoordinate(payload['coordinate']);
      return {
        kind: CxpMessageKind.notifySelection,
        elements,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(coordinate !== undefined ? { coordinate } : {}),
        metadata: decodeMetadata(payload['metadata']),
      };
    }
    case CxpMessageKind.requestHighlight: {
      const raw = payload['element'];
      if (!isJsonObject(raw)) {
        throw new CxpFormatError('RequestHighlight.fromJson: missing "element"');
      }
      const coordinate = decodeStreamCoordinate(payload['coordinate']);
      return {
        kind: CxpMessageKind.requestHighlight,
        element: decodeElementId(raw),
        ...(coordinate !== undefined ? { coordinate } : {}),
        metadata: decodeMetadata(payload['metadata']),
      };
    }
    case CxpMessageKind.requestHighlightAck:
      return {
        kind: CxpMessageKind.requestHighlightAck,
        ...decodeAck(payload, 'RequestHighlightAck.fromJson'),
      };
    case CxpMessageKind.requestOpenSource: {
      const filePath = asString(payload['file_path']);
      if (filePath === undefined) {
        throw new CxpFormatError('RequestOpenSource.fromJson: missing "file_path"');
      }
      const line = asInteger(payload['line']);
      if (line === undefined) {
        throw new CxpFormatError('RequestOpenSource.fromJson: missing "line"');
      }
      const column = asInteger(payload['column']);
      return {
        kind: CxpMessageKind.requestOpenSource,
        filePath,
        line,
        ...(column !== undefined ? { column } : {}),
      };
    }
    case CxpMessageKind.requestOpenSourceAck:
      return {
        kind: CxpMessageKind.requestOpenSourceAck,
        ...decodeAck(payload, 'RequestOpenSourceAck.fromJson'),
      };
    case CxpMessageKind.requestOpenArtifact: {
      const designId = asString(payload['design_id']);
      if (designId === undefined) {
        throw new CxpFormatError('RequestOpenArtifact.fromJson: missing "design_id"');
      }
      const artifactKind = asString(payload['kind']);
      if (artifactKind === undefined) {
        throw new CxpFormatError('RequestOpenArtifact.fromJson: missing "kind"');
      }
      const path = asString(payload['path']);
      return {
        kind: CxpMessageKind.requestOpenArtifact,
        designId,
        artifactKind,
        ...(path !== undefined ? { path } : {}),
      };
    }
    case CxpMessageKind.requestOpenArtifactAck:
      return {
        kind: CxpMessageKind.requestOpenArtifactAck,
        ...decodeAck(payload, 'RequestOpenArtifactAck.fromJson'),
      };
    case CxpMessageKind.errorResponse: {
      const code = asString(payload['code']);
      if (code === undefined) {
        throw new CxpFormatError('ErrorResponse.fromJson: missing "code"');
      }
      const message = asString(payload['message']);
      if (message === undefined) {
        throw new CxpFormatError('ErrorResponse.fromJson: missing "message"');
      }
      return {
        kind: CxpMessageKind.errorResponse,
        code,
        message,
        inReplyTo: asString(payload['in_reply_to']) ?? '',
      };
    }
    default:
      return undefined;
  }
}

/** Encode a message body as an envelope payload. */
export function encodeCxpMessage(message: CxpMessage): JsonObject {
  switch (message.kind) {
    case CxpMessageKind.hello:
      // No `token` key at all when there is none, so a tokenless hello is
      // the pre-1.2 frame byte for byte.
      return {
        identity: encodePeerIdentity(message.identity),
        ...(message.token !== undefined ? { token: message.token } : {}),
      };
    case CxpMessageKind.helloAck:
      return {
        identity: encodePeerIdentity(message.identity),
        in_reply_to: message.inReplyTo,
      };
    case CxpMessageKind.goodbye:
      return message.reason !== undefined ? { reason: message.reason } : {};
    case CxpMessageKind.subscribe:
      return { subscriptions: message.subscriptions.map(encodeSubscription) };
    case CxpMessageKind.unsubscribe:
      return {};
    case CxpMessageKind.notifySelection:
      return {
        elements: message.elements.map(encodeElementId),
        ...(message.displayName !== undefined ? { display_name: message.displayName } : {}),
        ...(message.coordinate !== undefined
          ? { coordinate: encodeStreamCoordinate(message.coordinate) }
          : {}),
        ...(Object.keys(message.metadata).length > 0 ? { metadata: message.metadata } : {}),
      };
    case CxpMessageKind.requestHighlight:
      return {
        element: encodeElementId(message.element),
        ...(message.coordinate !== undefined
          ? { coordinate: encodeStreamCoordinate(message.coordinate) }
          : {}),
        ...(Object.keys(message.metadata).length > 0 ? { metadata: message.metadata } : {}),
      };
    case CxpMessageKind.requestHighlightAck:
    case CxpMessageKind.requestOpenSourceAck:
    case CxpMessageKind.requestOpenArtifactAck:
      return encodeAck(message);
    case CxpMessageKind.requestOpenSource:
      return {
        file_path: message.filePath,
        line: message.line,
        ...(message.column !== undefined ? { column: message.column } : {}),
      };
    case CxpMessageKind.requestOpenArtifact:
      return {
        design_id: message.designId,
        // The payload's `kind` is the *artifact* kind, not the envelope
        // discriminator. Getting these two the wrong way round is the
        // trap this message shape sets.
        kind: message.artifactKind,
        ...(message.path !== undefined ? { path: message.path } : {}),
      };
    case CxpMessageKind.errorResponse:
      return {
        code: message.code,
        message: message.message,
        in_reply_to: message.inReplyTo,
      };
  }
}
