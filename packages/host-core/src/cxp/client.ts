import { connect as netConnect, type Socket } from 'node:net';
import { CxpConnection } from './connection';
import { Emitter } from './emitter';
import type { CxpEnvelope } from './envelope';
import { CxpTimeoutError } from './errors';
import { DEFAULT_CXP_MAX_LINE_LENGTH, DEFAULT_CXP_MAX_PENDING_WRITE_BYTES } from './framing';
import type { PeerIdentity } from './identity';
import { CxpMessageKind, type CxpMessage } from './messages';

/** A decoded message received on a [LocalCxpClient] socket. */
export interface CxpClientInbound {
  readonly envelope: CxpEnvelope;
  readonly message: CxpMessage;
}

/** Lifecycle event emitted as a client connects to or leaves a peer. */
export interface CxpConnectionEvent {
  readonly connected: boolean;
  /** The remote identity after a successful handshake. */
  readonly peer?: PeerIdentity;
  /** Set when the disconnect was a failure rather than a clean close. */
  readonly error?: Error;
  /**
   * True when the peer sent `goodbye` before the socket closed.
   *
   * The distinction is load-bearing for the connector: §10.5 says an
   * implementation SHOULD NOT redial a peer that has said goodbye, and a
   * bare close is indistinguishable from a crash — which *must* be
   * redialled. `goodbye` is consumed by [CxpConnection] and never reaches
   * `onInbound`, so this flag is the only place it surfaces.
   */
  readonly goodbye?: boolean;
  /** The `reason` the peer gave with its `goodbye`, when it gave one. */
  readonly goodbyeReason?: string;
}

/** Construction options for a [LocalCxpClient]. */
export interface LocalCxpClientOptions {
  readonly selfIdentity: PeerIdentity;
  /** Upper bound on establishing the TCP connection. */
  readonly connectTimeoutMs?: number;
  /**
   * Upper bound on the `hello` → `hello_ack` exchange after the socket is
   * up. Without it, a peer that accepts and then never answers leaves the
   * dialler wedged half-open forever — and a connector whose link is
   * "still connecting" never retries it.
   */
  readonly handshakeTimeoutMs?: number;
  readonly maxLineLength?: number;
  readonly maxPendingWriteBytes?: number;
}

/**
 * TCP/JSON CXP client — one peer at a time, matching [LocalCxpServer]'s
 * wire format.
 *
 * [connect] resolves once the `hello_ack` is in. It rejects — and leaves
 * the client reusable — on socket failure, on a handshake rejection
 * (`error_response` instead of `hello_ack`, `unauthorized` among them), on
 * an incompatible major version, on a reply that is not an envelope, and on
 * the handshake timeout.
 */
export class LocalCxpClient {
  readonly selfIdentity: PeerIdentity;

  /** Messages from the connected peer, handshake frames excluded. */
  readonly onInbound = new Emitter<CxpClientInbound>();
  /** Connection lifecycle events. */
  readonly onEvent = new Emitter<CxpConnectionEvent>();

  private readonly connectTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxLineLength: number;
  private readonly maxPendingWriteBytes: number;

  private connection: CxpConnection | undefined;
  private socket: Socket | undefined;
  private remote: PeerIdentity | undefined;
  private disposed = false;
  private goodbyeSeen = false;
  private goodbyeReason: string | undefined;

  constructor(options: LocalCxpClientOptions) {
    this.selfIdentity = options.selfIdentity;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.maxLineLength = options.maxLineLength ?? DEFAULT_CXP_MAX_LINE_LENGTH;
    this.maxPendingWriteBytes = options.maxPendingWriteBytes ?? DEFAULT_CXP_MAX_PENDING_WRITE_BYTES;
  }

  /** True once the socket is up and the handshake has completed. */
  get isConnected(): boolean {
    return this.connection !== undefined && this.remote !== undefined;
  }

  /** The remote peer's identity after a successful handshake. */
  get remotePeer(): PeerIdentity | undefined {
    return this.remote;
  }

  /**
   * Connect to a peer and perform the `hello` / `hello_ack` handshake.
   *
   * [token] is the peer's authentication token as read from its manifest
   * (`CxpPeerManifest.token`, wire 1.2); it is carried in the `hello`. A peer
   * that requires one and is not given it rejects the handshake with
   * `unauthorized`, which rejects this call with a [CxpHandshakeError].
   * Absent presents none — the pre-1.2 `hello`, which an older peer accepts.
   */
  async connect(options: {
    readonly host: string;
    readonly port: number;
    readonly token?: string | undefined;
  }): Promise<void> {
    if (this.disposed) throw new Error('LocalCxpClient already disposed.');
    if (this.connection !== undefined) throw new Error('LocalCxpClient is already connected.');

    this.goodbyeSeen = false;
    this.goodbyeReason = undefined;

    const socket = await this.openSocket(options.host, options.port);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Tear down so a later connect() starts from a clean state rather
        // than reporting "already connected" against a dead socket.
        this.teardown(
          new CxpTimeoutError(
            `CXP handshake with ${options.host}:${options.port} timed out after ` +
              `${this.handshakeTimeoutMs} ms.`,
          ),
        );
        reject(
          new CxpTimeoutError(
            `CXP handshake with ${options.host}:${options.port} timed out after ` +
              `${this.handshakeTimeoutMs} ms.`,
          ),
        );
      }, this.handshakeTimeoutMs);
      timer.unref();

      const connection = new CxpConnection({
        socket,
        selfIdentity: this.selfIdentity,
        role: 'outbound',
        maxLineLength: this.maxLineLength,
        maxPendingWriteBytes: this.maxPendingWriteBytes,
        helloToken: options.token,
        handlers: {
          onHandshake: (identity) => {
            this.remote = identity;
            this.onEvent.emit({ connected: true, peer: identity });
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          },
          onMessage: (envelope, message) => {
            this.onInbound.emit({ envelope, message });
          },
          onGoodbye: (reason) => {
            // Recorded rather than emitted: `goodbye` is always followed
            // by the close, and the connector only needs to know *why*
            // the link went away when deciding whether to redial.
            this.goodbyeSeen = true;
            this.goodbyeReason = reason;
          },
          onClose: (error) => {
            const remote = this.remote;
            const saidGoodbye = this.goodbyeSeen;
            const goodbyeReason = this.goodbyeReason;
            this.connection = undefined;
            this.socket = undefined;
            this.remote = undefined;
            this.onEvent.emit({
              connected: false,
              ...(remote !== undefined ? { peer: remote } : {}),
              ...(error !== undefined ? { error } : {}),
              ...(saidGoodbye ? { goodbye: true } : {}),
              ...(saidGoodbye && goodbyeReason !== undefined
                ? { goodbyeReason: goodbyeReason }
                : {}),
            });
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error ?? new Error('Peer closed connection before hello_ack.'));
          },
        },
      });
      this.connection = connection;
      connection.start();
    });
  }

  /** Send `goodbye`, then close. No-op when not connected. */
  async disconnect(): Promise<void> {
    const connection = this.connection;
    if (connection === undefined) return;
    if (!connection.isClosed) {
      connection.sendMessage({ kind: CxpMessageKind.goodbye, reason: 'client_disconnect' });
    }
    connection.disconnect(undefined);
    this.connection = undefined;
    this.socket = undefined;
    this.remote = undefined;
    // Let the socket flush the goodbye and the FIN before returning, so a
    // caller that immediately asserts on the peer's state is not racing
    // the kernel.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  /** Send a message to the connected peer. No-op when disconnected. */
  send(message: CxpMessage): void {
    if (!this.isConnected) return;
    this.connection?.sendMessage(message);
  }

  /** Release the client. Further [connect] calls throw. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.disconnect();
    this.onInbound.clear();
    this.onEvent.clear();
  }

  private async openSocket(host: string, port: number): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = netConnect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new CxpTimeoutError(`CXP connect to ${host}:${port} timed out.`));
      }, this.connectTimeoutMs);
      timer.unref();
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        resolve(socket);
      });
      const onError = (error: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      socket.once('error', onError);
    });
  }

  private teardown(error: Error): void {
    const connection = this.connection;
    this.connection = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.remote = undefined;
    connection?.disconnect(error);
  }
}
