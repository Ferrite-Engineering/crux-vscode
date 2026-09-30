import { CxpFormatError } from './errors';
import { asJsonArray, asString, isJsonObject, type JsonObject, type JsonValue } from './json';

/**
 * Self-description a CXP peer announces during the handshake (CXP §8.1).
 *
 * Every `hello` and `hello_ack` embeds one, and every published manifest
 * carries one, so the peer on the other end of the socket knows who it is
 * talking to.
 */
export interface PeerIdentity {
  /**
   * Globally unique identifier for this running peer process. MUST be
   * usable as a filename (CXP §10.2).
   *
   * **Not two segments.** The suite convention is
   * `<product>-<pid>-<startedAtMillis>`, and crux_cxp's `pidFromPeerId`
   * reads the pid from the *second-to-last* hyphen segment — see
   * [pidFromPeerId]. Anything that parses or constructs a peer id must
   * treat it as an arbitrary number of hyphen-separated segments.
   */
  readonly peerId: string;
  /** The product short name (`wavecrux`, `netcrux`, a third-party name). */
  readonly productName: string;
  /** The product's version string. */
  readonly productVersion: string;
  /**
   * Capability strings the peer advertises. **Advisory only**: a sender
   * MAY consult it to avoid a message the receiver will refuse, but a
   * receiver MUST still answer every message correctly — with
   * `unsupported` when it cannot act — regardless of what it advertised
   * (CXP §8.1).
   */
  readonly capabilities: readonly string[];
}

/**
 * Decode a [PeerIdentity] from its JSON form.
 *
 * The three string fields are required and type-checked; `capabilities`
 * is tolerant — a missing list, a non-list, and non-string entries all
 * degrade to "no capabilities" rather than failing the handshake, matching
 * `PeerIdentity.fromJson`. Duplicate entries collapse (Dart decodes into a
 * `Set`), first occurrence winning.
 *
 * @throws {CxpFormatError} when a required field is missing or mistyped.
 */
export function decodePeerIdentity(json: JsonObject): PeerIdentity {
  const peerId = asString(json['peer_id']);
  if (peerId === undefined) {
    throw new CxpFormatError('PeerIdentity.fromJson: missing "peer_id"');
  }
  const productName = asString(json['product_name']);
  if (productName === undefined) {
    throw new CxpFormatError('PeerIdentity.fromJson: missing "product_name"');
  }
  const productVersion = asString(json['product_version']);
  if (productVersion === undefined) {
    throw new CxpFormatError('PeerIdentity.fromJson: missing "product_version"');
  }
  const capabilities: string[] = [];
  for (const entry of asJsonArray(json['capabilities']) ?? []) {
    if (typeof entry === 'string' && !capabilities.includes(entry)) capabilities.push(entry);
  }
  return { peerId, productName, productVersion, capabilities };
}

/** Encode a [PeerIdentity] for a `hello`, `hello_ack` or manifest. */
export function encodePeerIdentity(identity: PeerIdentity): JsonObject {
  return {
    peer_id: identity.peerId,
    product_name: identity.productName,
    product_version: identity.productVersion,
    capabilities: [...identity.capabilities],
  };
}

/** Value equality for two identities, capabilities compared as sets. */
export function peerIdentityEquals(a: PeerIdentity, b: PeerIdentity): boolean {
  return (
    a.peerId === b.peerId &&
    a.productName === b.productName &&
    a.productVersion === b.productVersion &&
    a.capabilities.length === b.capabilities.length &&
    a.capabilities.every((c) => b.capabilities.includes(c))
  );
}

/**
 * The process id encoded in [peerId], or `undefined` when the id does not
 * carry one — the exact rule crux_cxp's `pidFromPeerId` applies.
 *
 * The pid is the **second-to-last** hyphen segment of the conventional
 * `<product>-<pid>-<startedAtMillis>` form, and an id with fewer than
 * three segments yields nothing. Discovery uses this to reap a crashed
 * peer's manifest immediately instead of waiting out the 24 h TTL, so a
 * peer id shaped without a pid in that position is not a cosmetic choice:
 * it costs every other peer in the suite its fast crash detection.
 */
export function pidFromPeerId(peerId: string): number | undefined {
  const segments = peerId.split('-');
  if (segments.length < 3) return undefined;
  const pidText = segments[segments.length - 2];
  if (pidText === undefined || !/^\d+$/.test(pidText)) return undefined;
  const pid = Number.parseInt(pidText, 10);
  return pid > 0 ? pid : undefined;
}

/**
 * Decode an `identity` field that may have come off the wire as anything.
 *
 * @throws {CxpFormatError} with [context] naming the enclosing message,
 * matching the Dart messages (`Hello.fromJson: missing "identity"`).
 */
export function decodeIdentityField(value: JsonValue | undefined, context: string): PeerIdentity {
  if (!isJsonObject(value)) {
    throw new CxpFormatError(`${context}: missing "identity"`);
  }
  return decodePeerIdentity(value);
}
