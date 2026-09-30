import { connect, createServer, type Server, type Socket } from 'node:net';
import { encodeEnvelopeLine } from '../../src/cxp/envelope';
import type { PeerIdentity } from '../../src/cxp/identity';
import { asJsonObject, asString, type JsonObject } from '../../src/cxp/json';
import { CXP_PROTOCOL_VERSION } from '../../src/cxp/version';

/**
 * Wait until [predicate] holds, or fail with [reason].
 *
 * Sockets are asynchronous, so every assertion about what arrived is a
 * poll. The counterpart of `poll.dart` in crux_cxp's conformance suite.
 */
export async function pollUntil(
  predicate: () => boolean,
  reason: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs} ms: ${reason}`);
}

/** Build a test identity with the suite's `<product>-<pid>-<started>` shape. */
export function testIdentity(product: string, n: number): PeerIdentity {
  return {
    peerId: `${product}-${1000 + n}-1700000000000`,
    productName: product,
    productVersion: '0.0.0-test',
    capabilities: [],
  };
}

/**
 * A raw TCP peer speaking newline-JSON directly.
 *
 * It exists to drive the implementation with frames a well-behaved client
 * cannot produce — a missing handshake, a bad version, an over-long line,
 * a half-written frame. Same role as `_RawPeer` in crux_cxp's
 * `robustness_test.dart`.
 */
export class RawPeer {
  readonly envelopes: JsonObject[] = [];
  closed = false;

  private constructor(readonly socket: Socket) {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) this.envelopes.push(JSON.parse(line) as JsonObject);
      }
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', () => {
      this.closed = true;
    });
  }

  static async connectTo(port: number): Promise<RawPeer> {
    const socket = connect({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new RawPeer(socket);
  }

  /** Write a well-formed envelope with any field overridden. */
  sendEnvelope(options: {
    readonly kind: string;
    readonly payload: JsonObject;
    readonly from?: string;
    readonly messageId?: string;
    readonly cxpVersion?: string;
  }): void {
    this.socket.write(
      encodeEnvelopeLine({
        cxpVersion: options.cxpVersion ?? CXP_PROTOCOL_VERSION,
        messageId: options.messageId ?? 'raw-m-1',
        from: options.from ?? 'raw-peer-1-1700000000000',
        kind: options.kind,
        payload: options.payload,
      }),
    );
  }

  /** Write arbitrary bytes — malformed frames, partial frames, floods. */
  writeRaw(text: string): void {
    this.socket.write(text);
  }

  /** Every received envelope of the given kind. */
  ofKind(kind: string): JsonObject[] {
    return this.envelopes.filter((e) => e['kind'] === kind);
  }

  /** Every received `error_response` payload carrying [code]. */
  errorPayloads(code: string): JsonObject[] {
    const payloads: JsonObject[] = [];
    for (const envelope of this.ofKind('error_response')) {
      const payload = asJsonObject(envelope['payload']);
      if (payload !== undefined && payload['code'] === code) payloads.push(payload);
    }
    return payloads;
  }

  close(): void {
    this.socket.destroy();
  }
}

/**
 * A scripted TCP acceptor standing in for a remote CXP server.
 *
 * Drives the *client* through handshake behaviours a conforming server
 * cannot produce: outright rejection, silence, a `hello_ack` carrying an
 * incompatible major version. `_FakeCxpServer` in crux_cxp.
 */
export class FakeCxpServer {
  readonly sockets: Socket[] = [];
  readonly received: JsonObject[] = [];

  private constructor(
    private readonly server: Server,
    readonly port: number,
    onEnvelope:
      | ((fake: FakeCxpServer, socket: Socket, envelope: JsonObject) => void)
      | undefined,
  ) {
    server.on('connection', (socket) => {
      this.sockets.push(socket);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.length === 0) continue;
          const envelope = JSON.parse(line) as JsonObject;
          this.received.push(envelope);
          onEnvelope?.(this, socket, envelope);
        }
      });
      socket.on('error', () => undefined);
    });
  }

  static async start(
    onEnvelope?: (fake: FakeCxpServer, socket: Socket, envelope: JsonObject) => void,
  ): Promise<FakeCxpServer> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
    });
    const address = server.address();
    const port = address !== null && typeof address === 'object' ? address.port : 0;
    return new FakeCxpServer(server, port, onEnvelope);
  }

  writeEnvelope(
    socket: Socket,
    options: {
      readonly kind: string;
      readonly payload: JsonObject;
      readonly messageId?: string;
      readonly cxpVersion?: string;
    },
  ): void {
    socket.write(
      encodeEnvelopeLine({
        cxpVersion: options.cxpVersion ?? CXP_PROTOCOL_VERSION,
        messageId: options.messageId ?? 'fake-m-1',
        from: 'fake-peer-1-1700000000000',
        kind: options.kind,
        payload: options.payload,
      }),
    );
  }

  writeHelloAck(socket: Socket, helloEnvelope: JsonObject, cxpVersion?: string): void {
    this.writeEnvelope(socket, {
      kind: 'hello_ack',
      payload: {
        identity: {
          peer_id: 'fake-peer-1-1700000000000',
          product_name: 'fakeserver',
          product_version: '0.0.0',
          capabilities: [],
        },
        in_reply_to: asString(helloEnvelope['message_id']) ?? '',
      },
      ...(cxpVersion !== undefined ? { cxpVersion } : {}),
    });
  }

  /** Every `error_response` payload this fake received carrying [code]. */
  errorPayloads(code: string): JsonObject[] {
    const payloads: JsonObject[] = [];
    for (const envelope of this.received) {
      if (envelope['kind'] !== 'error_response') continue;
      const payload = asJsonObject(envelope['payload']);
      if (payload !== undefined && payload['code'] === code) payloads.push(payload);
    }
    return payloads;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
