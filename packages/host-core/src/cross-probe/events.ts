/**
 * The window's cross-probe activity log — what a Crux app's Cross-Probe
 * panel calls "Recent Events".
 *
 * Pure data and a bounded buffer. No `vscode` import and no CXP object graph,
 * so the shape below is exactly what crosses a bridge to a webview and
 * exactly what a test can construct by hand.
 *
 * ### Why the `messageKind` vocabulary is the Dart one
 *
 * The receiving end of this is `CxpEventLogEntry` in the WaveCrux app, whose
 * panel controller already folds a wire kind plus a direction into the shared
 * `CrossProbeEvent` categories — including the two sentinel kinds
 * `peer_connected` / `peer_disconnected` that no CXP message has. Minting a
 * second vocabulary here and translating at the bridge would mean two lists
 * to keep in step; using the app's means the frames land in a mapping that
 * already exists and already has tests.
 */
import { CxpMessageKind } from '../cxp/messages';

/**
 * `messageKind` for a peer that completed its handshake. Not a CXP message
 * kind — see the module docs. Mirrors the literal
 * `cross_probe_panel.dart`'s `_toSharedEvent` switches on.
 */
export const CROSS_PROBE_PEER_CONNECTED = 'peer_connected';

/** `messageKind` for a peer that went away. See [CROSS_PROBE_PEER_CONNECTED]. */
export const CROSS_PROBE_PEER_DISCONNECTED = 'peer_disconnected';

/**
 * How many events the window keeps.
 *
 * Matches `kCxpEventLogMaxEntries` in the WaveCrux app so a panel hosted in
 * an editor shows the same depth of history as a desktop one, and matches
 * `kHostBridgeMaxCrossProbeEvents`, which is the cap the receiving decoder
 * enforces. All three being one number is deliberate: a producer that
 * exceeded the receiver's cap would have its oldest events silently dropped
 * at the far end instead of here, where the drop is visible.
 */
export const CROSS_PROBE_EVENT_LIMIT = 50;

/** One entry in the window's cross-probe activity log. */
export interface CrossProbeEventRecord {
  /**
   * The wire kind, or one of the two lifecycle sentinels.
   *
   * @see CROSS_PROBE_PEER_CONNECTED
   */
  readonly messageKind: string;
  /** Whether the window sent it or received it. */
  readonly direction: 'inbound' | 'outbound';
  /** The peer's `product_name`, falling back to its `peer_id`. */
  readonly peerLabel: string;
  /** Epoch milliseconds. */
  readonly timestampMs: number;
  /** One-line gloss — a design path, an artifact kind. */
  readonly summary?: string;
}

/**
 * The inbound message kinds that earn a log line.
 *
 * Deliberately not "everything inbound". `hello`, `hello_ack`, `subscribe`
 * and the acks are protocol bookkeeping the user did not do and cannot act
 * on, and a `subscribe` per connection would push a real cross-probe out of
 * a fifty-entry buffer on a window with four peers in it. What is left is
 * the set the panel has icons for.
 */
export const CROSS_PROBE_LOGGED_INBOUND_KINDS: readonly string[] = [
  CxpMessageKind.notifySelection,
  CxpMessageKind.requestHighlight,
  CxpMessageKind.requestOpenSource,
  CxpMessageKind.requestOpenArtifact,
];

/** Append [event] to [log], keeping at most [limit] entries, oldest-first. */
export function appendCrossProbeEvent(
  log: readonly CrossProbeEventRecord[],
  event: CrossProbeEventRecord,
  limit: number = CROSS_PROBE_EVENT_LIMIT,
): readonly CrossProbeEventRecord[] {
  const next = [...log, event];
  return next.length > limit ? next.slice(next.length - limit) : next;
}
