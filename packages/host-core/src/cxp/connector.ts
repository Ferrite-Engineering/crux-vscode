import { LocalCxpClient, type CxpConnectionEvent } from './client';
import type { CxpDiscovery, CxpDiscoveryEvent } from './discovery';
import { Emitter, type Disposable } from './emitter';
import { CxpDialRefusedError } from './errors';
import type { PeerIdentity } from './identity';
import { CXP_NON_LOOPBACK_REFUSAL_REASON, cxpLoopbackDialAddress } from './loopback';
import type { CxpPeerManifest } from './manifest';
import { CXP_SUBSCRIBE_TO_ALL, CxpMessageKind, type CxpSubscription } from './messages';
import type { LocalCxpServer } from './server';

/** Default retry period between dial attempts. */
export const CXP_DEFAULT_RETRY_INTERVAL_MS = 5_000;
/** Default ceiling on the backoff, in retry ticks (≈1 attempt/minute at 5 s). */
export const CXP_DEFAULT_MAX_RETRY_BACKOFF_TICKS = 12;

/** Why an outbound dial to a peer failed. */
export interface CxpDialFailure {
  /** Peer whose manifest we were dialling. */
  readonly peerId: string;
  /** Host from the peer's manifest. */
  readonly host: string;
  /** Port from the peer's manifest. */
  readonly port: number;
  /**
   * What `connect` threw — a socket error, a timeout, a handshake refusal —
   * or why the dial was never made.
   *
   * - A refused token is a [CxpHandshakeError] with code `unauthorized`: the
   *   manifest named a token the peer's server does not hold (a stale or
   *   foreign file), or named none and the peer requires one.
   * - A [CxpDialRefusedError] means no socket was opened: the manifest
   *   advertises a host that is not loopback.
   */
  readonly error: Error;
  /** Dials to this peer that have failed in a row, including this one. */
  readonly consecutiveFailures: number;
  /** Retry ticks that will be skipped before the next attempt. */
  readonly nextRetryAfterTicks: number;
}

/** Construction options for [CxpPeerConnector]. */
export interface CxpPeerConnectorOptions {
  /**
   * Our own identity. Manifests carrying this peer id are never dialled.
   *
   * May be a **function**, read afresh for every dial — see
   * [LocalCxpServerOptions.selfIdentity] for why. The `peer_id` must be
   * stable across reads; only `capabilities` may change.
   */
  readonly selfIdentity: PeerIdentity | (() => PeerIdentity);
  /** Discovery whose peer set drives the connection set. */
  readonly discovery: CxpDiscovery;
  /**
   * Local server that link traffic is routed into. Without it the links
   * provide presence only and their inbound frames are dropped.
   */
  readonly server?: LocalCxpServer;
  /** Subscription set announced on every link. Defaults to subscribe-to-all. */
  readonly subscriptions?: readonly CxpSubscription[];
  /** Retry period. Defaults to [CXP_DEFAULT_RETRY_INTERVAL_MS]. */
  readonly retryIntervalMs?: number;
  /** Backoff ceiling in ticks. Defaults to [CXP_DEFAULT_MAX_RETRY_BACKOFF_TICKS]. */
  readonly maxRetryBackoffTicks?: number;
  /**
   * Apply the §10.5 lexicographic tie-break — dial only peers whose
   * `peer_id` sorts *after* ours. Defaults to true. See
   * [CxpPeerConnector] for why turning it off is sometimes right and why
   * getting it backwards yields zero connections rather than one.
   */
  readonly dialTieBreak?: boolean;
  /** Client factory, injectable for tests. */
  readonly clientFactory?: (self: PeerIdentity) => LocalCxpClient;
}

interface PeerLink {
  readonly manifest: CxpPeerManifest;
  readonly client: LocalCxpClient;
  readonly subscriptions: Disposable[];
  connecting: boolean;
  consecutiveFailures: number;
  skipTicks: number;
  attachedPeerId: string | undefined;
}

/**
 * Dials every peer [CxpDiscovery] surfaces and routes each link's traffic
 * into the local [LocalCxpServer]'s dispatch stream.
 *
 * Discovery alone only proves a manifest file exists; it establishes no
 * socket. The connector maintains one outbound [LocalCxpClient] per
 * dialled manifest:
 *
 * - manifest added → connect (hello handshake) to `host:port`, **when `host`
 *   is loopback** (`isCxpLoopbackHost`); any other host is refused before a
 *   socket exists and recorded as a [CxpDialRefusedError] dial failure;
 * - connect failure → retried every `retryIntervalMs` with backoff, while
 *   the manifest remains known;
 * - manifest removed → drop the link;
 * - peer said `goodbye` → drop the link and **never redial it** (§10.5).
 *
 * ### Link traffic routing (the connector↔server seam)
 *
 * An outbound link is full-duplex, and the remote peer uses it as its
 * reply and delivery path back to us: when it calls `sendTo(us, …)` or
 * `broadcast(…)`, those frames arrive on *this* client socket, not on our
 * server's accept loop. So on handshake we (1) feed every inbound frame
 * into `server.injectInbound` tagged with the remote identity, (2)
 * register the link with `server.attachLinkedPeer` so `server.sendTo` can
 * answer over it, and (3) send `subscribe` **immediately**, before
 * anything else can happen on the link, so no broadcast window is missed.
 *
 * ### The tie-break, and why it must not be symmetric-only *or* strict
 *
 * §10.5 recommends a deterministic tie-break so two peers do not hold a
 * redundant pair of connections: only the lexicographically smaller
 * `peer_id` dials. It is a SHOULD in 1.0, and **`crux_cxp` does not
 * implement it — every Dart peer dials symmetrically.**
 *
 * We implement it (default on), and that asymmetry is safe for exactly one
 * reason: declining to dial is not declining to *connect*. A Dart peer
 * will dial us regardless of what our ids sort like, our server accepts
 * it, and `attachLinkedPeer` is not needed on that path because the
 * server already owns the accepted socket. The rule to hold onto:
 *
 * > **We must keep accepting inbound connections from every peer we
 * > declined to dial.** Nothing here may ever gate the server's accept
 * > loop on the tie-break.
 *
 * And the failure mode is worth stating plainly, because it is not the
 * obvious one: getting the comparison backwards does not produce *one*
 * connection instead of two — against another tie-breaking peer it
 * produces **zero**, since both sides decide the other should dial. Only
 * the Dart peers' symmetric dialling hides it today.
 *
 * Set `dialTieBreak: false` to restore fully symmetric dialling if a peer
 * ever appears that neither dials nor tolerates being the only dialler.
 */
export class CxpPeerConnector {
  /** Discovery driving the connection set. */
  readonly discovery: CxpDiscovery;
  /** Local server link traffic is routed into, when wired. */
  readonly server: LocalCxpServer | undefined;
  /** Retry period in milliseconds. */
  readonly retryIntervalMs: number;
  /** Backoff ceiling in retry ticks. */
  readonly maxRetryBackoffTicks: number;
  /** Whether the §10.5 lexicographic tie-break is applied. */
  readonly dialTieBreak: boolean;

  /** One event per failed dial attempt. */
  readonly onDialFailure = new Emitter<CxpDialFailure>();

  private readonly identityProvider: () => PeerIdentity;
  private readonly clientFactory: (self: PeerIdentity) => LocalCxpClient;
  private readonly links = new Map<string, PeerLink>();
  private readonly failures = new Map<string, CxpDialFailure>();
  private readonly farewelled = new Set<string>();
  private readonly declined = new Map<string, CxpPeerManifest>();
  private subs: readonly CxpSubscription[];
  private discoverySub: Disposable | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private running = false;
  private attempts = 0;

  constructor(options: CxpPeerConnectorOptions) {
    const identity = options.selfIdentity;
    this.identityProvider = typeof identity === 'function' ? identity : (): PeerIdentity => identity;
    this.discovery = options.discovery;
    this.server = options.server;
    this.retryIntervalMs = options.retryIntervalMs ?? CXP_DEFAULT_RETRY_INTERVAL_MS;
    this.maxRetryBackoffTicks = options.maxRetryBackoffTicks ?? CXP_DEFAULT_MAX_RETRY_BACKOFF_TICKS;
    this.dialTieBreak = options.dialTieBreak ?? true;
    this.subs = [...(options.subscriptions ?? CXP_SUBSCRIBE_TO_ALL)];
    this.clientFactory =
      options.clientFactory ?? ((self) => new LocalCxpClient({ selfIdentity: self }));
  }

  /** Our own identity, read live — see [CxpPeerConnectorOptions.selfIdentity]. */
  get selfIdentity(): PeerIdentity {
    return this.identityProvider();
  }

  /** Whether [start] has been called and [stop] has not. */
  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Total dial attempts since construction, retries included. A dial
   * refused before any socket existed (a non-loopback manifest) is not an
   * attempt and is not counted.
   */
  get dialAttempts(): number {
    return this.attempts;
  }

  /** The subscription set announced on every link. */
  get subscriptions(): readonly CxpSubscription[] {
    return this.subs;
  }

  /** Identities of peers whose outbound handshake has completed. */
  get connectedPeers(): readonly PeerIdentity[] {
    const peers: PeerIdentity[] = [];
    for (const link of this.links.values()) {
      const remote = link.client.remotePeer;
      if (link.client.isConnected && remote !== undefined) peers.push(remote);
    }
    return peers;
  }

  /**
   * The most recent failure per peer, for peers not currently connected.
   * A peer leaves this map on a successful handshake or when its manifest
   * disappears. Products surface it so an *unreachable* peer is never
   * indistinguishable from an *absent* one.
   */
  get lastDialFailures(): ReadonlyMap<string, CxpDialFailure> {
    return this.failures;
  }

  /**
   * Peers we know about but deliberately did not dial because the §10.5
   * tie-break says they should dial us. Observability, not state we act
   * on: if one of these never connects, the tie-break is the first thing
   * to suspect.
   */
  get peersAwaitingInboundDial(): readonly CxpPeerManifest[] {
    return [...this.declined.values()];
  }

  /** Peers that said `goodbye` and will not be redialled. */
  get farewelledPeers(): readonly string[] {
    return [...this.farewelled];
  }

  /**
   * Start dialling: seeds from [CxpDiscovery.peers] — covering manifests
   * found before the connector started — then follows the event stream.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.discoverySub = this.discovery.onEvent.listen((event) => {
      this.onDiscoveryEvent(event);
    });
    for (const manifest of this.discovery.peers) this.track(manifest);
    this.retryTimer = setInterval(() => {
      this.retryNow();
    }, this.retryIntervalMs);
    this.retryTimer.unref();
  }

  /** Stop dialling and tear down every outbound link. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.discoverySub?.dispose();
    this.discoverySub = undefined;
    if (this.retryTimer !== undefined) clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    const links = [...this.links.values()];
    this.links.clear();
    this.failures.clear();
    this.declined.clear();
    for (const link of links) await this.disposeLink(link);
  }

  /** Stop and release the diagnostics emitter. */
  async dispose(): Promise<void> {
    await this.stop();
    this.onDialFailure.clear();
    this.farewelled.clear();
  }

  /** Replace the subscription set and re-announce it on every live link. */
  updateSubscriptions(subscriptions: readonly CxpSubscription[]): void {
    this.subs = [...subscriptions];
    for (const link of this.links.values()) {
      if (link.client.isConnected) {
        link.client.send({ kind: CxpMessageKind.subscribe, subscriptions: this.subs });
      }
    }
  }

  /**
   * Run one retry tick: dial every known-but-unconnected peer whose
   * backoff has elapsed. This is what the retry timer calls; public so a
   * "reconnect now" command and the tests can drive it without waiting.
   */
  retryNow(): void {
    if (!this.running) return;
    for (const link of this.links.values()) {
      if (link.client.isConnected || link.connecting) continue;
      if (link.skipTicks > 0) {
        link.skipTicks -= 1;
        continue;
      }
      void this.connect(link);
    }
  }

  /**
   * Whether we dial [peerId], or wait for it to dial us (§10.5).
   *
   * Lexicographically smaller dials. Exported behaviour rather than an
   * inline comparison because the direction is the whole rule and a
   * flipped `<` is a silent zero-connection bug against any other
   * tie-breaking peer.
   */
  shouldDial(peerId: string): boolean {
    if (peerId === this.selfIdentity.peerId) return false;
    if (!this.dialTieBreak) return true;
    return this.selfIdentity.peerId < peerId;
  }

  private onDiscoveryEvent(event: CxpDiscoveryEvent): void {
    if (!this.running) return;
    const peerId = event.manifest.identity.peerId;
    if (event.added) {
      this.track(event.manifest);
      return;
    }
    // The manifest vanished: drop the link, and forget everything keyed on
    // this peer id. A peer that comes back mints a new id (its pid and
    // start time are in it), so nothing here can outlive its peer.
    this.declined.delete(peerId);
    this.failures.delete(peerId);
    this.farewelled.delete(peerId);
    const link = this.links.get(peerId);
    if (link !== undefined) {
      this.links.delete(peerId);
      void this.disposeLink(link);
    }
  }

  private track(manifest: CxpPeerManifest): void {
    const peerId = manifest.identity.peerId;
    if (peerId === this.selfIdentity.peerId) return; // never dial ourselves
    if (this.links.has(peerId)) return;
    // §10.5: a peer that said goodbye is not redialled for as long as its
    // manifest is around. It is still free to dial us.
    if (this.farewelled.has(peerId)) return;
    if (!this.shouldDial(peerId)) {
      this.declined.set(peerId, manifest);
      return;
    }
    const client = this.clientFactory(this.selfIdentity);
    const link: PeerLink = {
      manifest,
      client,
      subscriptions: [],
      connecting: false,
      consecutiveFailures: 0,
      skipTicks: 0,
      attachedPeerId: undefined,
    };
    // Listen from creation, not from connect success: an event emitted
    // before a listener attaches is simply lost.
    link.subscriptions.push(
      client.onInbound.listen((inbound) => {
        const from = link.client.remotePeer;
        // Only handshake frames precede `remotePeer`, and the client
        // consumes those; a null here means the link is mid-teardown,
        // where dropping is correct.
        if (from === undefined) return;
        this.server?.injectInbound({ envelope: inbound.envelope, message: inbound.message, from });
      }),
      client.onEvent.listen((event) => {
        this.onLinkEvent(link, event);
      }),
    );
    this.links.set(peerId, link);
    void this.connect(link);
  }

  private onLinkEvent(link: PeerLink, event: CxpConnectionEvent): void {
    if (event.connected) {
      const peer = event.peer;
      if (peer === undefined) return;
      link.attachedPeerId = peer.peerId;
      // Subscribe first, before anything else can happen on the link, so
      // no broadcast window is missed.
      link.client.send({ kind: CxpMessageKind.subscribe, subscriptions: this.subs });
      this.server?.attachLinkedPeer(peer, (message) => {
        link.client.send(message);
      });
      return;
    }
    this.detachLink(link);
    if (event.goodbye === true) {
      const peerId = link.manifest.identity.peerId;
      this.farewelled.add(peerId);
      this.links.delete(peerId);
      this.failures.delete(peerId);
      void this.disposeLink(link);
    }
  }

  private detachLink(link: PeerLink): void {
    const attached = link.attachedPeerId;
    link.attachedPeerId = undefined;
    if (attached !== undefined) this.server?.detachLinkedPeer(attached);
  }

  private async disposeLink(link: PeerLink): Promise<void> {
    this.detachLink(link);
    for (const sub of link.subscriptions) sub.dispose();
    link.subscriptions.length = 0;
    await link.client.dispose();
  }

  private async connect(link: PeerLink): Promise<void> {
    if (link.connecting || link.client.isConnected) return;
    link.connecting = true;
    const peerId = link.manifest.identity.peerId;
    try {
      const address = cxpLoopbackDialAddress(link.manifest.host);
      if (address === undefined) {
        // Refused, not attempted: no socket is opened towards an address a
        // manifest file chose. Thrown into the same bookkeeping as a failed
        // dial, so the unreachable-peer row shows the reason and the retry
        // backs off like any other failure; the check re-runs on each retry
        // and costs no I/O. Not counted in `dialAttempts`.
        throw new CxpDialRefusedError(
          link.manifest.host,
          link.manifest.port,
          CXP_NON_LOOPBACK_REFUSAL_REASON,
        );
      }
      this.attempts += 1;
      // The manifest is where the peer's token lives (wire 1.2); presenting
      // it is what a 1.2 receiver requires, and a pre-1.2 manifest carries
      // none, which a pre-1.2 receiver does not ask for. The address is the
      // literal that passed the loopback check, never a respelling of it.
      await link.client.connect({
        host: address,
        port: link.manifest.port,
        token: link.manifest.token,
      });
      link.consecutiveFailures = 0;
      link.skipTicks = 0;
      this.failures.delete(peerId);
    } catch (error) {
      // Peer not listening yet, gone, or the handshake failed. Retried
      // with backoff while the manifest is known; discovery prunes dead
      // peers. Observable rather than silently dropped — an unreachable
      // peer must not look the same as an absent one.
      link.consecutiveFailures += 1;
      const backoff = this.backoffTicksFor(link.consecutiveFailures);
      link.skipTicks = backoff;
      const failure: CxpDialFailure = {
        peerId,
        host: link.manifest.host,
        port: link.manifest.port,
        error: error instanceof Error ? error : new Error(String(error)),
        consecutiveFailures: link.consecutiveFailures,
        nextRetryAfterTicks: backoff,
      };
      this.failures.set(peerId, failure);
      this.onDialFailure.emit(failure);
    } finally {
      link.connecting = false;
    }
  }

  /** 0, 1, 3, 7, 15, … ticks, capped at [maxRetryBackoffTicks]. */
  private backoffTicksFor(consecutiveFailures: number): number {
    if (consecutiveFailures <= 1) return 0;
    const exponent = consecutiveFailures - 1;
    if (exponent >= 31) return this.maxRetryBackoffTicks;
    const ticks = (1 << exponent) - 1;
    return Math.min(ticks, this.maxRetryBackoffTicks);
  }
}
