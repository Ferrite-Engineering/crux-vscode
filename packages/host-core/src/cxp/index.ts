/**
 * CXP (Cross-Tool eXchange Protocol) — the peer transport.
 *
 * Owns: the loopback socket, newline framing with the 1 MiB inbound and
 * 8 MiB outbound caps, the envelope, all thirteen typed message kinds, the
 * `hello` / `hello_ack` / `goodbye` handshake and its wire-1.2 token
 * (`auth-token.ts`), peer and element identity, and major/minor version
 * negotiation with the forward-compatibility rule.
 *
 * Authority is the specification (https://edacrux.app/cxp, §§4–9);
 * **behaviour** is matched to `crux_cxp`, the Dart reference
 * implementation and the peer on the other end of every real link. Where
 * the two disagree, the divergence is recorded at the point of decision
 * rather than resolved silently — grep for "DIVERGENCE" across this
 * module. Two points worth knowing up front:
 *
 * - the wire version is **1.2** (`version.ts`), as crux_cxp ships it. 1.2
 *   authenticates the handshake with a token published in the manifest,
 *   and a 1.2 server refuses a pre-1.2 dialler — the one place the
 *   minor-compatibility rule bends, recorded there;
 * - an empty `notify_selection.elements` is legal per §9.3 and *was*
 *   rejected by the reference implementation; both now accept it, and
 *   §9.1.2 makes it a retraction that bypasses element filters
 *   (`messages.ts`).
 *
 * Also here: discovery (§10) — the shared manifest directory, the
 * publish-and-heartbeat writer, the scanner with its asymmetric pruning
 * rule, and the connector that dials what the scanner finds — plus the two
 * shared-workspace pieces the 1.1 messages need: the `design_id` derivation
 * (`design-id.ts`, a conformance-tested port of `crux_cxp`'s) and the
 * shared workspace artifact store (`workspace-store.ts`).
 */
export {
  DEFAULT_CXP_MAX_LINE_LENGTH,
  DEFAULT_CXP_MAX_PENDING_WRITE_BYTES,
  CappedLineSplitter,
  encodeFrame,
  type CappedLineSplitterHandlers,
} from './framing';

export { CXP_PROTOCOL_VERSION, isCompatibleCxpVersion } from './version';

export { cxpAuthTokensMatch, cxpProcessAuthToken, generateCxpAuthToken } from './auth-token';

export {
  CxpDialRefusedError,
  CxpFormatError,
  CxpFrameTooLongError,
  CxpHandshakeError,
  CxpTimeoutError,
} from './errors';

export {
  CXP_NON_LOOPBACK_REFUSAL_REASON,
  cxpLoopbackDialAddress,
  isCxpLoopbackHost,
} from './loopback';

export {
  asInteger,
  asJsonArray,
  asJsonObject,
  asString,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from './json';

export {
  decodeEnvelope,
  encodeEnvelope,
  encodeEnvelopeLine,
  envelopeFor,
  newCxpMessageId,
  parseEnvelopeLine,
  type CxpEnvelope,
} from './envelope';

export {
  decodeIdentityField,
  decodePeerIdentity,
  encodePeerIdentity,
  peerIdentityEquals,
  pidFromPeerId,
  type PeerIdentity,
} from './identity';

export {
  decodeElementId,
  decodeElementIdList,
  elementIdEquals,
  encodeElementId,
  isKnownElementKind,
  KNOWN_ELEMENT_KINDS,
  type ElementId,
  type ElementKind,
  type KnownElementKind,
} from './element-id';

export {
  decodeStreamCoordinate,
  encodeStreamCoordinate,
  RISCV_FORMAL_TRACE_STEP_STREAM_ID,
  RISCV_RVFI_RETIRE_STREAM_ID,
  streamCoordinateEquals,
  type CxpStreamCoordinate,
} from './stream-coordinate';

export {
  CXP_DESIGN_ID_METADATA_KEY,
  CXP_SUBSCRIBE_TO_ALL,
  CxpErrorCode,
  CxpMessageKind,
  decodeCxpMessage,
  encodeCxpMessage,
  normaliseCxpErrorCode,
  referencedElements,
  subscriptionMatches,
  type CxpErrorCodeName,
  type CxpMessage,
  type CxpMessageKindName,
  type CxpSubscription,
  type ErrorResponse,
  type Goodbye,
  type Hello,
  type HelloAck,
  type NotifySelection,
  type RequestHighlight,
  type RequestHighlightAck,
  type RequestOpenArtifact,
  type RequestOpenArtifactAck,
  type RequestOpenSource,
  type RequestOpenSourceAck,
  type Subscribe,
  type Unsubscribe,
} from './messages';

export {
  CxpConnection,
  type CxpConnectionHandlers,
  type CxpConnectionOptions,
  type CxpConnectionRole,
} from './connection';

export {
  LocalCxpServer,
  type InboundCxpMessage,
  type LocalCxpServerOptions,
  type PeerPresenceEvent,
} from './server';

export {
  LocalCxpClient,
  type CxpClientInbound,
  type CxpConnectionEvent,
  type LocalCxpClientOptions,
} from './client';

export { Emitter, type Disposable } from './emitter';

export {
  CxpDiscoveryUnavailableError,
  sharedCxpManifestDirectory,
  type SharedCxpManifestDirectoryOptions,
} from './manifest-directory';

export {
  peerIdLiveness,
  pidLiveness,
  PidLiveness,
  type PidLivenessOptions,
  type PidLivenessValue,
} from './process-liveness';

export { atomicTempPath, writeJsonAtomic } from './atomic-write';

export {
  decodeCxpPeerManifest,
  encodeCxpPeerManifest,
  manifestEndpointKey,
  type CxpPeerManifest,
} from './manifest';

export {
  createVscodePeerIdentity,
  mintVscodePeerId,
  VSCODE_PEER_ID_PREFIX,
  VSCODE_PRODUCT_NAME,
  workspaceHash8,
  type VscodePeerIdentityOptions,
  type VscodePeerIdOptions,
} from './peer-id';

export {
  CXP_DEFAULT_MANIFEST_HEARTBEAT_MS,
  CXP_DEFAULT_REAP_THRESHOLD_MS,
  CXP_DEFAULT_SCAN_INTERVAL_MS,
  CXP_DEFAULT_STALE_THRESHOLD_MS,
  CxpDiscovery,
  dedupeByEndpoint,
  type CxpDiscoveryEvent,
  type CxpDiscoveryOptions,
} from './discovery';

export { CxpManifestWriter, type CxpManifestWriterOptions } from './manifest-writer';

export {
  CXP_DEFAULT_MAX_RETRY_BACKOFF_TICKS,
  CXP_DEFAULT_RETRY_INTERVAL_MS,
  CxpPeerConnector,
  type CxpDialFailure,
  type CxpPeerConnectorOptions,
} from './connector';

export { CxpPeerHost, type CxpPeerHostOptions } from './peer-host';

export {
  CXP_DESIGN_ID_PATTERN,
  NODE_DESIGN_ID_ENVIRONMENT,
  cxpDesignDirectoryForPath,
  cxpDesignIdForPath,
  type DesignIdEnvironment,
} from './design-id';

export {
  CXP_WORKSPACE_DEFAULT_TTL_MS,
  CxpWorkspaceStore,
  VSCODE_WORKSPACE_PRODUCER,
  effectiveArtifactBasename,
  sharedCxpWorkspaceDirectory,
  type CxpWorkspaceStoreOptions,
  type WorkspaceArtifact,
  type WorkspaceArtifactUpsert,
} from './workspace-store';

export {
  CXP_DEFAULT_ONE_SHOT_ACK_TIMEOUT_MS,
  sendOneShotRequest,
  type OneShotRequestOptions,
  type OneShotRequestResult,
} from './one-shot';
