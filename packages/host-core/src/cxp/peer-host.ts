import { cxpProcessAuthToken } from './auth-token';
import { CxpPeerConnector, type CxpDialFailure } from './connector';
import { CxpDiscovery } from './discovery';
import { Emitter, type Disposable } from './emitter';
import type { PeerIdentity } from './identity';
import type { CxpPeerManifest } from './manifest';
import { sharedCxpManifestDirectory } from './manifest-directory';
import { CxpManifestWriter } from './manifest-writer';
import type { CxpSubscription } from './messages';
import { LocalCxpServer } from './server';

/** Construction options for [CxpPeerHost]. */
export interface CxpPeerHostOptions {
  /**
   * This window's identity — see `createVscodePeerIdentity`.
   *
   * May be a **function**, read afresh on every handshake, dial and
   * manifest write, so a surface that activates after the peer is already
   * listening changes what this window advertises without a reload. The
   * `peer_id` must be stable across reads: it names the manifest file, and
   * a changed one would leave the old file behind.
   */
  readonly selfIdentity: PeerIdentity | (() => PeerIdentity);
  /**
   * Manifest directory. Defaults to [sharedCxpManifestDirectory]; pass an
   * explicit path only to sandbox a test. **Never** point this at a
   * per-extension storage path: discovery only works if every product in
   * the suite agrees on one directory.
   */
  readonly manifestDirectory?: string;
  /** Address to listen on. Loopback only — §11 forbids anything routable. */
  readonly host?: string;
  /** Subscription set announced on every outbound link. */
  readonly subscriptions?: readonly CxpSubscription[];
  /** Apply the §10.5 lexicographic dial tie-break. Defaults to true. */
  readonly dialTieBreak?: boolean;
  /** Manifest heartbeat period. `null` disables it — tests only. */
  readonly heartbeatIntervalMs?: number | null;
  /** Directory rescan period. */
  readonly scanIntervalMs?: number;
  /** Retry period for failed dials. */
  readonly retryIntervalMs?: number;
  /**
   * The token this window's server requires and its manifest publishes
   * (wire 1.2). Defaults to [cxpProcessAuthToken]. One value, handed to
   * both halves, so they cannot disagree.
   */
  readonly authToken?: string;
}

/**
 * Everything a VSCode window needs to be a first-class CXP peer, with one
 * start and — the part that matters — **one shutdown**.
 *
 * Composes the four pieces that must live and die together: the
 * [LocalCxpServer] that accepts inbound links, the [CxpManifestWriter]
 * that publishes and heartbeats our manifest, the [CxpDiscovery] that
 * scans for peers, and the [CxpPeerConnector] that dials them.
 *
 * ### Why this exists rather than four objects a caller wires up
 *
 * A peer's manifest must be deleted on clean shutdown *and* on extension
 * `deactivate`, and a caller holding four handles will eventually get that
 * ordering wrong or forget the writer entirely — leaving a manifest
 * pointing at a closed port for every peer in the suite to dial and time
 * out on. [dispose] is the single call an extension's `deactivate` makes.
 *
 * The order in [dispose] is deliberate:
 *
 * 1. **Remove the manifest first.** The moment we are going away, stop
 *    advertising: a peer that scans during our teardown must not find us.
 * 2. **Then the connector**, whose links each send `goodbye` before
 *    closing, so peers stop dialling us rather than inferring a crash.
 * 3. **Then discovery**, which has nothing left to feed.
 * 4. **Then the server**, closing the accepted sockets last so a reply
 *    in flight still has somewhere to land.
 *
 * VSCode gives `deactivate` a limited window and does not wait forever, so
 * every step is best-effort and none of them can throw out of [dispose].
 */
export class CxpPeerHost {
  /** The accept side. */
  readonly server: LocalCxpServer;
  /** The publish-and-heartbeat side. */
  readonly writer: CxpManifestWriter;
  /** The scan side. */
  readonly discovery: CxpDiscovery;
  /** The dial side. */
  readonly connector: CxpPeerConnector;

  /** Re-emits the connector's dial failures. */
  readonly onDialFailure = new Emitter<CxpDialFailure>();

  private readonly identityProvider: () => PeerIdentity;
  private readonly forwarders: Disposable[] = [];
  private started = false;

  constructor(options: CxpPeerHostOptions) {
    const identity = options.selfIdentity;
    this.identityProvider = typeof identity === 'function' ? identity : (): PeerIdentity => identity;
    const manifestDirectory = options.manifestDirectory ?? sharedCxpManifestDirectory();
    // The server requires what the manifest publishes. Both would default to
    // the same process token anyway; passing one value to each makes the
    // agreement structural rather than a coincidence of two defaults.
    const authToken = options.authToken ?? cxpProcessAuthToken();
    this.server = new LocalCxpServer({
      selfIdentity: this.identityProvider,
      authToken,
      ...(options.host !== undefined ? { host: options.host } : {}),
    });
    this.writer = new CxpManifestWriter({
      manifestDirectory,
      authToken,
      ...(options.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: options.heartbeatIntervalMs }
        : {}),
    });
    this.discovery = new CxpDiscovery({
      manifestDirectory,
      selfPeerId: this.identityProvider().peerId,
      ...(options.scanIntervalMs !== undefined ? { scanIntervalMs: options.scanIntervalMs } : {}),
    });
    this.connector = new CxpPeerConnector({
      selfIdentity: this.identityProvider,
      discovery: this.discovery,
      server: this.server,
      ...(options.subscriptions !== undefined ? { subscriptions: options.subscriptions } : {}),
      ...(options.dialTieBreak !== undefined ? { dialTieBreak: options.dialTieBreak } : {}),
      ...(options.retryIntervalMs !== undefined ? { retryIntervalMs: options.retryIntervalMs } : {}),
    });
    this.forwarders.push(
      this.connector.onDialFailure.listen((failure) => {
        this.onDialFailure.emit(failure);
      }),
    );
  }

  /** This window's identity, read live — see [CxpPeerHostOptions]. */
  get selfIdentity(): PeerIdentity {
    return this.identityProvider();
  }

  /** Whether [start] has run and [dispose] has not. */
  get isRunning(): boolean {
    return this.started;
  }

  /** Peers currently believed live, excluding ourselves. */
  get peers(): readonly CxpPeerManifest[] {
    return this.discovery.peers;
  }

  /**
   * Bind, publish, scan, dial.
   *
   * The manifest is written only *after* the server is listening, so its
   * `port` is the real bound port and no peer can dial an address that is
   * not accepting yet.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.server.start();
    await this.writer.write({
      identity: this.identityProvider(),
      host: this.server.host,
      port: this.server.boundPort ?? this.server.port,
    });
    await this.discovery.start();
    this.connector.start();
  }

  /**
   * Republish the manifest immediately.
   *
   * Call after the advertised capabilities change — a product extension
   * activating mid-session — so peers see the new set within a scan
   * instead of within a heartbeat.
   *
   * With no argument the identity provider is re-read, which is what a
   * caller that passed a function to [CxpPeerHostOptions.selfIdentity]
   * wants. An explicit [identity] is still accepted for a caller holding
   * an immutable one; **its `peerId` must match**, or the manifest is
   * written under a second filename and this window appears twice.
   */
  async republish(identity?: PeerIdentity): Promise<void> {
    if (!this.started) return;
    await this.writer.write({
      identity: identity ?? this.identityProvider(),
      host: this.server.host,
      port: this.server.boundPort ?? this.server.port,
    });
  }

  /**
   * Stop being a peer, and leave nothing behind.
   *
   * **This is what an extension's `deactivate` calls**, and what a
   * user-initiated "turn CXP off" calls. Best-effort throughout: a
   * teardown step that fails must not prevent the rest, because the step
   * most likely to fail is not the one that matters most.
   */
  async dispose(): Promise<void> {
    this.started = false;
    for (const forwarder of this.forwarders) forwarder.dispose();
    this.forwarders.length = 0;
    // 1. Stop advertising before anything else.
    await this.writer.remove().catch(() => undefined);
    // 2. Say goodbye on every outbound link.
    await this.connector.dispose().catch(() => undefined);
    // 3. Stop scanning.
    this.discovery.stop();
    // 4. Close the accepted sockets last.
    await this.server.stop().catch(() => undefined);
    this.onDialFailure.clear();
  }
}
