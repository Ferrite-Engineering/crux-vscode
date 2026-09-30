import { createServer, type Server, type Socket } from 'node:net';
import { cxpProcessAuthToken } from './auth-token';
import { CxpConnection } from './connection';
import { Emitter } from './emitter';
import type { CxpEnvelope } from './envelope';
import { DEFAULT_CXP_MAX_LINE_LENGTH, DEFAULT_CXP_MAX_PENDING_WRITE_BYTES } from './framing';
import type { PeerIdentity } from './identity';
import type { CxpMessage, CxpSubscription } from './messages';
import { subscriptionMatches } from './messages';

/** Emitted when a peer becomes reachable or stops being reachable. */
export interface PeerPresenceEvent {
  readonly peer: PeerIdentity;
  readonly connected: boolean;
}

/** An inbound message paired with the peer that sent it. */
export interface InboundCxpMessage {
  readonly envelope: CxpEnvelope;
  readonly message: CxpMessage;
  readonly from: PeerIdentity;
}

/** Construction options for a [LocalCxpServer]. */
export interface LocalCxpServerOptions {
  /**
   * Who we announce ourselves as in every `hello` / `hello_ack`.
   *
   * May be a **function**, read afresh for each connection. A VSCode
   * window's capability list is composed from the extensions installed in
   * it (`surface/`) and one of them can activate after the socket is
   * already listening; a value captured at construction would then have a
   * window handshaking as less capable than it is until the next reload.
   * The `peer_id` must not change between reads — see
   * [window.CruxWindowHost]'s `currentIdentity`.
   */
  readonly selfIdentity: PeerIdentity | (() => PeerIdentity);
  /**
   * Bind address. **Loopback, and effectively not negotiable** (CXP §4.1,
   * §11). The wire-1.2 token proves the dialler can read the user's manifest
   * directory — which a process on another machine never can, but which is
   * no substitute for not being reachable from one: a peer on a routable
   * interface is a remote-control surface for anyone who learns the token.
   */
  readonly host?: string;
  /** Requested port; `0` lets the OS pick, which is what discovery expects. */
  readonly port?: number;
  readonly maxLineLength?: number;
  readonly maxPendingWriteBytes?: number;
  /**
   * The token a dialling peer must present in its `hello` (wire 1.2). See
   * `auth-token.ts` for what it is and is not. Defaults to
   * [cxpProcessAuthToken], which [CxpManifestWriter] publishes by default,
   * so the two agree without wiring. **A caller that passes one here must
   * give the writer the same one**, or every peer is refused.
   */
  readonly authToken?: string;
  /**
   * Whether a `hello` that does not carry [authToken] is refused. `true` —
   * the default, as in crux_cxp — answers it `unauthorized` and closes
   * before the dialler becomes a peer (no identity, no presence, no
   * dispatch). `false` accepts any `hello`: the pre-1.2 behaviour, for a
   * receiver that must accept pre-1.2 diallers.
   */
  readonly requireAuthToken?: boolean;
}

/** An outbound link registered by a connector via `attachLinkedPeer`. */
interface LinkedPeer {
  readonly identity: PeerIdentity;
  readonly send: (message: CxpMessage) => void;
  subscriptions: readonly CxpSubscription[];
}

/**
 * TCP/JSON CXP server bound to loopback.
 *
 * Wire format: newline-delimited JSON envelopes. Each accepted connection
 * runs the handshake (`hello` in, `hello_ack` out) and is then a
 * full-duplex CXP channel; [CxpConnection] owns those rules.
 *
 * Since wire 1.2 the handshake is authenticated: a `hello` must carry
 * [authToken], the token this peer publishes in its manifest, or it is
 * answered `unauthorized` and closed. **This is the one place the
 * minor-compatibility rule bends**, deliberately and as crux_cxp bends it: a
 * pre-1.2 dialler sends no token and is refused. Over CXP's symmetric
 * topology a mixed pair still keeps one working route — our own connector
 * dials the older peer, whose server ignores the token, and traffic flows
 * both ways over that link. [requireAuthToken] `false` is the opt-out.
 *
 * Delivery contract, normative and matched to crux_cxp:
 *
 * - The primary broadcast path is **server-accepted subscribed peers**: a
 *   peer receives gossip by dialling this server and sending `subscribe`.
 *   The symmetric dial is the normative topology.
 * - Connector-attached links ([attachLinkedPeer]) are primarily the
 *   *directed* route for [sendTo]. As a fallback for asymmetric
 *   topologies, a linked peer that has subscribed over its link also
 *   receives matching broadcasts; delivery is de-duplicated, so a
 *   symmetrically connected peer gets each frame exactly once.
 * - A peer that has never subscribed receives no broadcast on either
 *   route.
 */
export class LocalCxpServer {
  readonly host: string;
  readonly port: number;
  readonly maxLineLength: number;
  readonly maxPendingWriteBytes: number;
  /**
   * The token a dialling peer must present. Publish it in this peer's
   * manifest (`CxpManifestWriter.authToken`); both default to
   * [cxpProcessAuthToken]. Never log it.
   */
  readonly authToken: string;
  /** Whether a `hello` without [authToken] is refused. */
  readonly requireAuthToken: boolean;

  /** Inbound messages from every route — accepted sockets and injections. */
  readonly onInbound = new Emitter<InboundCxpMessage>();
  /** Peer reachability transitions. */
  readonly onPresence = new Emitter<PeerPresenceEvent>();

  private readonly identityProvider: () => PeerIdentity;
  private server: Server | undefined;
  private readonly peers: CxpConnection[] = [];
  private readonly linkedPeers = new Map<string, LinkedPeer>();
  private running = false;

  constructor(options: LocalCxpServerOptions) {
    const identity = options.selfIdentity;
    this.identityProvider = typeof identity === 'function' ? identity : (): PeerIdentity => identity;
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 0;
    this.maxLineLength = options.maxLineLength ?? DEFAULT_CXP_MAX_LINE_LENGTH;
    this.maxPendingWriteBytes = options.maxPendingWriteBytes ?? DEFAULT_CXP_MAX_PENDING_WRITE_BYTES;
    this.authToken = options.authToken ?? cxpProcessAuthToken();
    this.requireAuthToken = options.requireAuthToken ?? true;
  }

  /** Who we announce ourselves as, read live — see [LocalCxpServerOptions]. */
  get selfIdentity(): PeerIdentity {
    return this.identityProvider();
  }

  /** The port actually bound, or `undefined` before a successful [start]. */
  get boundPort(): number | undefined {
    const address = this.server?.address();
    return address !== null && typeof address === 'object' ? address.port : undefined;
  }

  /** Peers reachable right now, de-duplicated by peer id. */
  get connectedPeers(): readonly PeerIdentity[] {
    const byId = new Map<string, PeerIdentity>();
    for (const peer of this.peers) {
      const id = peer.remoteIdentity;
      if (id !== undefined) byId.set(id.peerId, id);
    }
    for (const link of this.linkedPeers.values()) {
      if (!byId.has(link.identity.peerId)) byId.set(link.identity.peerId, link.identity);
    }
    return [...byId.values()];
  }

  /**
   * Bind and start accepting.
   *
   * The bind completes **before** the server is marked running: setting
   * the flag first meant a failed bind (port already in use) left a server
   * that reported success from every later `start()` while being
   * permanently dead.
   */
  async start(): Promise<void> {
    if (this.running) return;
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        server.close();
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: this.host, port: this.port });
    });
    // Errors after a successful bind (an accept-time failure) must not
    // become an unhandled 'error' event and take the extension host down.
    server.on('error', () => {
      /* accept-loop errors are per-connection; the listener survives */
    });
    server.on('connection', (socket: Socket) => {
      this.onConnection(socket);
    });
    this.server = server;
    this.running = true;
  }

  /**
   * Stop accepting and close every peer connection.
   *
   * Emitters are deliberately *not* torn down: a user toggling CXP off and
   * on gets a working server rather than one that binds and accepts but
   * silently drops every message because its event sinks were closed on
   * the way down.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const peer of [...this.peers]) peer.disconnect(undefined);
    this.peers.length = 0;
    this.linkedPeers.clear();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }

  /** Broadcast to every reachable peer whose filters match [message]. */
  broadcast(message: CxpMessage): void {
    // Iterate a copy: a failed send disconnects the peer, which removes it
    // from the list mid-iteration.
    const deliveredTo = new Set<string>();
    for (const peer of [...this.peers]) {
      const id = peer.remoteIdentity;
      if (id === undefined) continue;
      if (!peer.accepts(message)) continue;
      peer.sendMessage(message);
      deliveredTo.add(id.peerId);
    }
    for (const link of [...this.linkedPeers.values()]) {
      if (deliveredTo.has(link.identity.peerId)) continue;
      if (!link.subscriptions.some((sub) => subscriptionMatches(sub, message))) continue;
      link.send(message);
    }
  }

  /**
   * Send [message] to one peer, bypassing subscription filters.
   *
   * Prefers the peer's inbound connection and falls back to a
   * connector-attached outbound link, so replies to link-injected messages
   * return over the same link. Returns whether the peer was reachable.
   */
  sendTo(peerId: string, message: CxpMessage): boolean {
    for (const peer of [...this.peers]) {
      if (peer.remoteIdentity?.peerId === peerId) {
        peer.sendMessage(message);
        return true;
      }
    }
    const link = this.linkedPeers.get(peerId);
    if (link !== undefined) {
      link.send(message);
      return true;
    }
    return false;
  }

  /**
   * Register an outbound link to [peer] as a route this server can send
   * on. A connector calls this after its own handshake completes.
   */
  attachLinkedPeer(peer: PeerIdentity, send: (message: CxpMessage) => void): void {
    const wasReachable = this.isReachable(peer.peerId);
    this.linkedPeers.set(peer.peerId, { identity: peer, send, subscriptions: [] });
    if (!wasReachable) this.onPresence.emit({ peer, connected: true });
  }

  /** Remove the outbound-link route to [peerId]. No-op when absent. */
  detachLinkedPeer(peerId: string): void {
    const removed = this.linkedPeers.get(peerId);
    this.linkedPeers.delete(peerId);
    if (removed !== undefined && !this.isReachable(peerId)) {
      this.onPresence.emit({ peer: removed.identity, connected: false });
    }
  }

  /**
   * Feed a message received outside this server's accept loop into the
   * inbound stream, so consumers observe one merged stream regardless of
   * which side dialled.
   *
   * `subscribe` / `unsubscribe` arriving over a link update that link's
   * filter set instead of surfacing — the same way the accepted-socket
   * path consumes them. Recording them here is what lets [broadcast] fan
   * out over a link with the peer's real filter applied.
   */
  injectInbound(inbound: InboundCxpMessage): void {
    const link = this.linkedPeers.get(inbound.from.peerId);
    if (link !== undefined) {
      if (inbound.message.kind === 'subscribe') {
        link.subscriptions = [...inbound.message.subscriptions];
        return;
      }
      if (inbound.message.kind === 'unsubscribe') {
        link.subscriptions = [];
        return;
      }
    }
    this.onInbound.emit(inbound);
  }

  /** Test observability: the subscriptions [peerId] has registered. */
  subscriptionsOf(peerId: string): readonly CxpSubscription[] {
    for (const peer of this.peers) {
      if (peer.remoteIdentity?.peerId === peerId) return peer.subscriptions;
    }
    return [];
  }

  /** Test observability: un-flushed outbound bytes queued for [peerId]. */
  pendingWriteBytesOf(peerId: string): number {
    for (const peer of this.peers) {
      if (peer.remoteIdentity?.peerId === peerId) return peer.pendingWriteBytes;
    }
    return -1;
  }

  private isReachable(peerId: string): boolean {
    return (
      this.linkedPeers.has(peerId) || this.peers.some((p) => p.remoteIdentity?.peerId === peerId)
    );
  }

  private onConnection(socket: Socket): void {
    const connection: CxpConnection = new CxpConnection({
      socket,
      selfIdentity: this.selfIdentity,
      role: 'inbound',
      maxLineLength: this.maxLineLength,
      maxPendingWriteBytes: this.maxPendingWriteBytes,
      requiredToken: this.requireAuthToken ? this.authToken : undefined,
      handlers: {
        onHandshake: (identity) => {
          // Presence is per-peer reachability, not per-socket: suppress a
          // duplicate connect while another route already reaches the peer.
          const reachableElsewhere =
            this.linkedPeers.has(identity.peerId) ||
            this.peers.some(
              (p) => p !== connection && p.remoteIdentity?.peerId === identity.peerId,
            );
          if (!reachableElsewhere) {
            this.onPresence.emit({ peer: identity, connected: true });
          }
        },
        onMessage: (envelope, message) => {
          const from = connection.remoteIdentity;
          if (from === undefined) return;
          this.onInbound.emit({ envelope, message, from });
        },
        onClose: () => {
          const index = this.peers.indexOf(connection);
          if (index >= 0) this.peers.splice(index, 1);
          const id = connection.remoteIdentity;
          if (id !== undefined && !this.isReachable(id.peerId)) {
            this.onPresence.emit({ peer: id, connected: false });
          }
        },
      },
    });
    this.peers.push(connection);
    connection.start();
  }
}
