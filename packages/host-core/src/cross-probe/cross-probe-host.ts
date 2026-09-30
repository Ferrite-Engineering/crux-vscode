/**
 * [CrossProbeHost] — the window's cross-probe state, as a *panel* wants to
 * see it, and the one place a directed send leaves from.
 *
 * ### Why this exists
 *
 * Everything below is already known to the window. [cxp.CxpPeerHost] knows
 * whether the peer is up; [cxp.CxpDiscovery] knows which peers exist;
 * [cxp.CxpPeerConnector] knows which ones would not answer a dial; the
 * server knows what arrived. What nothing knew was how to *hand all of that
 * to a surface* — so a Crux app rendered inside a webview showed an empty
 * peer list, no events, and a banner blaming a setting, while the extension
 * host it was running in had been a healthy peer the whole time.
 *
 * This is the missing seam, and it lives in host-core rather than in the
 * WaveCrux package for the standing reason: the panel is WaveCrux's, but
 * "what are this window's peers, what has crossed the wire, and send this to
 * that one" is not — LintCrux, SimCrux and NetCrux all have the same panel
 * in their own apps, and a second copy of this would be a second answer to
 * the same question.
 *
 * ### Push, never poll
 *
 * [onDidChange] fires when something actually changed: a peer appeared or
 * vanished (discovery), a link came up or went down (presence), a dial
 * failed (the connector), or an event was logged. Nothing here runs a timer,
 * and the four sources it listens to are the ones the window already runs —
 * `desktop-detect`'s rule about never starting a second filesystem poller
 * applies verbatim.
 */
import type { CxpDialFailure } from '../cxp/connector';
import { Emitter, type Disposable } from '../cxp/emitter';
import type { PeerIdentity } from '../cxp/identity';
import type { ElementId } from '../cxp/element-id';
import type { JsonObject } from '../cxp/json';
import { CxpMessageKind, type CxpMessage, type NotifySelection } from '../cxp/messages';
import type { CxpPeerHost } from '../cxp/peer-host';
import type { CxpStreamCoordinate } from '../cxp/stream-coordinate';
import {
  appendCrossProbeEvent,
  CROSS_PROBE_EVENT_LIMIT,
  CROSS_PROBE_LOGGED_INBOUND_KINDS,
  CROSS_PROBE_PEER_CONNECTED,
  CROSS_PROBE_PEER_DISCONNECTED,
  type CrossProbeEventRecord,
} from './events';
import {
  reasonCrossProbeUnavailable,
  reasonPeerNotConnected,
  reasonPeerUnknown,
} from './strings';

/** Everything a cross-probe panel renders, as one consistent snapshot. */
export interface CrossProbeSnapshot {
  /**
   * Whether this window's CXP peer is listening.
   *
   * Note what this is *not*: the surface's own server. A webview has no
   * socket and never will, so a panel hosted in one must read this and not
   * its own (permanently stopped) server — which is the bug this module was
   * written to fix.
   */
  readonly online: boolean;
  /**
   * Peers this window can cross-probe with — the union of the discovered
   * manifests and the live links.
   *
   * A union rather than either alone, because the two disagree in both
   * directions and each disagreement is a real state: a peer whose manifest
   * we have scanned but not yet dialled is worth showing (it is about to
   * work), and a peer that dialled *us* before our next scan is connected
   * without being in the manifest set at all. Matches what the Dart apps'
   * `cxpPeersProvider` shows, so a panel reads the same either side.
   */
  readonly peers: readonly PeerIdentity[];
  /** Discovered peers whose last dial failed. Never merged into [peers]. */
  readonly unreachable: readonly CxpDialFailure[];
  /** The activity log, oldest-first. */
  readonly events: readonly CrossProbeEventRecord[];
}

/**
 * The snapshot of a window with no CXP peer.
 *
 * Not an error state and not a placeholder for one: a window whose peer has
 * not started yet (the 750 ms settle delay) and a window that could not
 * start one at all (no resolvable application-data root) look identical from
 * a panel, and both are honestly described by "nothing to cross-probe with".
 */
export const CROSS_PROBE_OFFLINE: CrossProbeSnapshot = {
  online: false,
  peers: [],
  unreachable: [],
  events: [],
};

/** What became of one directed send. */
export interface CrossProbeSendOutcome {
  /** Whether the frame reached a socket. */
  readonly delivered: boolean;
  /** The peer's `product_name`, or its `peer_id`. For the panel's toast. */
  readonly peerLabel: string;
  /**
   * Why it did not go, localized, when it did not. Absent on success.
   *
   * `notify_selection` is a statement and has no ack (§9.3), so "delivered"
   * is as far as this can honestly go: what the receiver did with it is not
   * knowable from here, and inventing an outcome would be worse than saying
   * only what happened.
   */
  readonly reason?: string;
}

/** The §9.3 announcement, minus the discriminator the sender cannot get wrong. */
export interface CrossProbeSelection {
  readonly elements: readonly ElementId[];
  readonly displayName?: string;
  readonly coordinate?: CxpStreamCoordinate;
  readonly metadata: JsonObject;
}

/** Construction options for [CrossProbeHost]. */
export interface CrossProbeHostOptions {
  /** The window's one peer. Not owned: [dispose] never disposes it. */
  readonly peer: CxpPeerHost;
  /** Event-buffer depth. Defaults to [CROSS_PROBE_EVENT_LIMIT]. */
  readonly eventLimit?: number;
  /** Clock seam, for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** The peer's `product_name`, or its `peer_id` when it announced none. */
export function crossProbePeerLabel(identity: PeerIdentity): string {
  return identity.productName.length > 0 ? identity.productName : identity.peerId;
}

export class CrossProbeHost {
  /** Fires with a fresh snapshot whenever one of the four sources changes. */
  readonly onDidChange = new Emitter<CrossProbeSnapshot>();

  private readonly peer: CxpPeerHost;
  private readonly eventLimit: number;
  private readonly now: () => number;
  private readonly subscriptions: Disposable[] = [];
  private events: readonly CrossProbeEventRecord[] = [];
  private disposed = false;

  constructor(options: CrossProbeHostOptions) {
    this.peer = options.peer;
    this.eventLimit = options.eventLimit ?? CROSS_PROBE_EVENT_LIMIT;
    this.now = options.now ?? ((): number => Date.now());

    this.subscriptions.push(
      // A link came up or went down. This is the event a panel's "Connected
      // Peers" list is really about, and the only one that fires for a peer
      // that dialled us rather than the other way round.
      this.peer.server.onPresence.listen((event) => {
        this.record({
          messageKind: event.connected
            ? CROSS_PROBE_PEER_CONNECTED
            : CROSS_PROBE_PEER_DISCONNECTED,
          // Lifecycle events have no direction; the receiving panel drops
          // this field for them. `inbound` is the arbitrary filler the Dart
          // `CxpEventLogEntry` requires, matching what the desktop apps put
          // there for the same two kinds.
          direction: 'inbound',
          peerLabel: crossProbePeerLabel(event.peer),
          timestampMs: this.now(),
        });
      }),
      this.peer.server.onInbound.listen((inbound) => {
        if (!CROSS_PROBE_LOGGED_INBOUND_KINDS.includes(inbound.message.kind)) return;
        this.record({
          messageKind: inbound.message.kind,
          direction: 'inbound',
          peerLabel: crossProbePeerLabel(inbound.from),
          timestampMs: this.now(),
          ...summaryOf(inbound.message),
        });
      }),
      // A manifest appeared or vanished: the peer list changed even though
      // no socket did.
      this.peer.discovery.onEvent.listen(() => {
        this.emit();
      }),
      // An unreachable peer must never look the same as an absent one — the
      // connector's own words, and this is where that reaches a user.
      this.peer.onDialFailure.listen(() => {
        this.emit();
      }),
    );
  }

  /** The window's cross-probe state right now. */
  get snapshot(): CrossProbeSnapshot {
    return {
      online: this.peer.isRunning,
      peers: this.peers(),
      unreachable: [...this.peer.connector.lastDialFailures.values()],
      events: this.events,
    };
  }

  /**
   * Send [selection] to one peer as a `notify_selection` (§9.3).
   *
   * The panel's per-peer Send button, arriving from a surface that has no
   * socket of its own. Never throws: every failure is an outcome, because
   * the caller owes the user an answer either way — R8's "never a silent
   * no-op", which is exactly what this button was before.
   */
  sendSelectionToPeer(peerId: string, selection: CrossProbeSelection): CrossProbeSendOutcome {
    const identity = this.peers().find((peer) => peer.peerId === peerId);
    const peerLabel = identity === undefined ? peerId : crossProbePeerLabel(identity);
    if (!this.peer.isRunning) {
      return { delivered: false, peerLabel, reason: reasonCrossProbeUnavailable() };
    }
    if (identity === undefined) {
      return { delivered: false, peerLabel, reason: reasonPeerUnknown() };
    }
    const message: NotifySelection = {
      kind: CxpMessageKind.notifySelection,
      elements: selection.elements,
      ...(selection.displayName !== undefined ? { displayName: selection.displayName } : {}),
      ...(selection.coordinate !== undefined ? { coordinate: selection.coordinate } : {}),
      metadata: selection.metadata,
    };
    // `sendTo` answers false for a peer with no accepted socket and no
    // attached link — discovered, in the list, and not currently reachable.
    // That is the overwhelmingly common failure and the one the panel used
    // to swallow.
    if (!this.peer.server.sendTo(peerId, message)) {
      return { delivered: false, peerLabel, reason: reasonPeerNotConnected() };
    }
    this.record({
      messageKind: CxpMessageKind.notifySelection,
      direction: 'outbound',
      peerLabel,
      timestampMs: this.now(),
      ...summaryOf(message),
    });
    return { delivered: true, peerLabel };
  }

  /** Stop listening. Does **not** dispose the peer, which it does not own. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    this.onDidChange.clear();
  }

  private peers(): readonly PeerIdentity[] {
    const byId = new Map<string, PeerIdentity>();
    for (const manifest of this.peer.peers) byId.set(manifest.identity.peerId, manifest.identity);
    // Second, so a live link's identity — read off a completed handshake —
    // wins over the copy in a manifest that may be up to a heartbeat stale.
    for (const identity of this.peer.server.connectedPeers) byId.set(identity.peerId, identity);
    return [...byId.values()];
  }

  private record(event: CrossProbeEventRecord): void {
    if (this.disposed) return;
    this.events = appendCrossProbeEvent(this.events, event, this.eventLimit);
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    this.onDidChange.emit(this.snapshot);
  }
}

/**
 * The one-line gloss for a logged message, or nothing.
 *
 * Design paths and artifact kinds only, and both stay inside this window —
 * the log is rendered in the window that produced it and travels nowhere
 * else. A message with nothing worth glossing gets no `summary` field at
 * all rather than an empty string, so the receiving decoder's "absent means
 * nothing to say" holds.
 */
function summaryOf(message: CxpMessage): { summary?: string } {
  switch (message.kind) {
    case CxpMessageKind.notifySelection: {
      const first = message.elements[0];
      if (first !== undefined && first.path.length > 0) return { summary: first.path };
      // A cleared selection (§9.3's empty array) has no element to name; the
      // app's own label for it, if it sent one, is the next best gloss.
      if (message.displayName !== undefined && message.displayName.length > 0) {
        return { summary: message.displayName };
      }
      return {};
    }
    case CxpMessageKind.requestHighlight:
      return message.element.path.length > 0 ? { summary: message.element.path } : {};
    case CxpMessageKind.requestOpenArtifact:
      return message.artifactKind.length > 0 ? { summary: message.artifactKind } : {};
    case CxpMessageKind.requestOpenSource:
      return message.filePath.length > 0 ? { summary: message.filePath } : {};
    default:
      return {};
  }
}
