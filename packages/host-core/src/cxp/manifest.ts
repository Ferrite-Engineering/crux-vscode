import { CxpFormatError } from './errors';
import { decodePeerIdentity, encodePeerIdentity, type PeerIdentity } from './identity';
import { asInteger, asString, isJsonObject, type JsonObject } from './json';

/**
 * A CXP peer recovered from — or about to be written to — its manifest
 * file on disk (CXP §10.2).
 *
 * ```json
 * {
 *   "identity": { "peer_id": "...", "product_name": "...", ... },
 *   "host": "127.0.0.1",
 *   "port": 51734,
 *   "started_at": 1784742061000,
 *   "token": "<32 lowercase hex digits>"
 * }
 * ```
 *
 * `token` is wire 1.2 and optional: a pre-1.2 peer publishes none. **Never
 * log or render a manifest whole** — it carries the secret a dialler needs to
 * be accepted. Surface `identity`, `host` and `port` instead.
 */
export interface CxpPeerManifest {
  /** The peer's identity (peer id, product, version, capabilities). */
  readonly identity: PeerIdentity;
  /** Address the peer is listening on — loopback in every real peer. */
  readonly host: string;
  /** Port the peer's CXP server is bound to. */
  readonly port: number;
  /**
   * Epoch milliseconds at which the peer last (re)wrote the manifest.
   *
   * Named `started_at` on the wire but it is a **heartbeat** stamp: §10.3
   * requires a listening peer to rewrite it every ~30 s, and staleness is
   * measured against it.
   */
  readonly startedAt: number;
  /** Path the manifest was read from. Used when reaping the file. */
  readonly manifestPath: string;
  /**
   * The token a dialler must present in its `hello` to be accepted by this
   * peer (wire 1.2), or absent when the manifest carries none — a pre-1.2
   * peer. See `auth-token.ts`.
   */
  readonly token?: string;
}

/**
 * Decode a manifest read from [manifestPath].
 *
 * @throws {CxpFormatError} when a required field is missing or mistyped —
 * a half-written or foreign file in the directory must not take the
 * scanner down.
 */
export function decodeCxpPeerManifest(json: JsonObject, manifestPath: string): CxpPeerManifest {
  const identity = json['identity'];
  if (!isJsonObject(identity)) {
    throw new CxpFormatError('CxpPeerManifest: missing "identity"');
  }
  const host = asString(json['host']);
  if (host === undefined) {
    throw new CxpFormatError('CxpPeerManifest: missing "host"');
  }
  const port = asInteger(json['port']);
  if (port === undefined) {
    throw new CxpFormatError('CxpPeerManifest: missing "port"');
  }
  const startedAt = asInteger(json['started_at']);
  if (startedAt === undefined) {
    throw new CxpFormatError('CxpPeerManifest: missing "started_at"');
  }
  // Optional (wire 1.2): a pre-1.2 peer publishes none, and a dialler then
  // presents none, which a receiver that requires one refuses. Anything but
  // a non-empty string is no token, as in crux_cxp's fromJson.
  const token = asString(json['token']);
  return {
    identity: decodePeerIdentity(identity),
    host,
    port,
    startedAt,
    manifestPath,
    ...(token !== undefined && token.length > 0 ? { token } : {}),
  };
}

/** Encode a manifest for publication. `manifestPath` is not on the wire. */
export function encodeCxpPeerManifest(manifest: CxpPeerManifest): JsonObject {
  return {
    identity: encodePeerIdentity(manifest.identity),
    host: manifest.host,
    port: manifest.port,
    started_at: manifest.startedAt,
    ...(manifest.token !== undefined ? { token: manifest.token } : {}),
  };
}

/**
 * The endpoint key two manifests must share to be considered the same
 * running peer: `product_name|host|port`.
 *
 * One process cannot hold two listening sockets, so two live manifests
 * with the same key cannot both be a distinct peer — a briefly-doubled
 * manifest (an old file lingering while a restarted peer rebinds the same
 * port) must not surface as two discovery rows.
 */
export function manifestEndpointKey(manifest: CxpPeerManifest): string {
  return `${manifest.identity.productName}|${manifest.host}|${manifest.port}`;
}
