import { afterEach, describe, expect, it } from 'vitest';
import { LocalCxpClient, type CxpClientInbound, type CxpConnectionEvent } from '../../src/cxp/client';
import { encodeEnvelopeLine } from '../../src/cxp/envelope';
import { CxpFormatError, CxpHandshakeError, CxpTimeoutError } from '../../src/cxp/errors';
import type { ElementId } from '../../src/cxp/element-id';
import type { JsonObject } from '../../src/cxp/json';
import {
  CXP_SUBSCRIBE_TO_ALL,
  CxpErrorCode,
  CxpMessageKind,
  type CxpMessage,
} from '../../src/cxp/messages';
import {
  LocalCxpServer,
  type InboundCxpMessage,
  type PeerPresenceEvent,
} from '../../src/cxp/server';
import { FakeCxpServer, pollUntil, RawPeer, testIdentity } from './harness';

const serverIdentity = testIdentity('wavecrux', 1);
const element: ElementId = { kind: 'signal', path: 'top.dut.q' };

/**
 * The token every server in this file requires, and every well-behaved peer
 * here presents. Explicit rather than the process default so a raw frame
 * built by hand can carry it; `auth.test.ts` covers the default itself.
 */
const SERVER_TOKEN = 'a5'.repeat(16);

function selection(path: string, kind = 'signal'): CxpMessage {
  return {
    kind: CxpMessageKind.notifySelection,
    elements: [{ kind, path }],
    metadata: {},
  };
}

const highlight: CxpMessage = {
  kind: CxpMessageKind.requestHighlight,
  element,
  metadata: {},
};

/** Everything the current test started, torn down in reverse order. */
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function startServer(
  options: Partial<ConstructorParameters<typeof LocalCxpServer>[0]> = {},
): Promise<LocalCxpServer> {
  const server = new LocalCxpServer({
    selfIdentity: serverIdentity,
    authToken: SERVER_TOKEN,
    ...options,
  });
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}

/** Dial [server] the way a connector does: with the token its manifest names. */
function dial(client: LocalCxpClient, server: LocalCxpServer): Promise<void> {
  return client.connect({ host: '127.0.0.1', port: server.boundPort ?? 0, token: SERVER_TOKEN });
}

async function connectClient(
  server: LocalCxpServer,
  n = 2,
  options: { readonly handshakeTimeoutMs?: number } = {},
): Promise<LocalCxpClient> {
  const client = new LocalCxpClient({ selfIdentity: testIdentity('client', n), ...options });
  cleanups.push(() => client.dispose());
  await dial(client, server);
  return client;
}

async function connectRaw(server: LocalCxpServer): Promise<RawPeer> {
  const raw = await RawPeer.connectTo(server.boundPort ?? 0);
  cleanups.push(() => raw.close());
  return raw;
}

function rawHello(peerId = 'raw-peer-1-1700000000000'): {
  kind: string;
  payload: JsonObject;
  from: string;
} {
  return {
    kind: CxpMessageKind.hello,
    payload: {
      identity: {
        peer_id: peerId,
        product_name: 'rawpeer',
        product_version: '0.0.0',
        capabilities: [],
      },
      token: SERVER_TOKEN,
    },
    from: peerId,
  };
}

describe('socket', () => {
  it('binds loopback on an OS-assigned port', async () => {
    // CXP §4.1 / §11: the wire-1.2 token proves only that a dialler can
    // read the user's files, so a routable bind is a remote-control surface
    // for anyone who reaches the port and learns the token.
    const server = await startServer();
    expect(server.host).toBe('127.0.0.1');
    expect(server.boundPort).toBeGreaterThan(0);
  });

  it('reports no bound port before start and after a failed bind', async () => {
    const first = await startServer();
    const occupied = first.boundPort ?? 0;
    const second = new LocalCxpServer({ selfIdentity: serverIdentity, port: occupied });
    expect(second.boundPort).toBeUndefined();
    await expect(second.start()).rejects.toThrow();
    expect(second.boundPort).toBeUndefined();
    // A failed bind must not leave the server falsely marked running: the
    // retry, once the port frees up, has to actually work.
    await first.stop();
    await second.start();
    cleanups.push(() => second.stop());
    expect(second.boundPort).toBe(occupied);
  });

  it('survives a stop/start cycle with its event sinks intact', async () => {
    const server = await startServer();
    await server.stop();
    await server.start();
    const inbound: InboundCxpMessage[] = [];
    const presence: PeerPresenceEvent[] = [];
    server.onInbound.listen((m) => inbound.push(m));
    server.onPresence.listen((e) => presence.push(e));

    const client = await connectClient(server);
    await pollUntil(() => presence.some((e) => e.connected), 'presence after restart');
    client.send(highlight);
    await pollUntil(
      () => inbound.some((m) => m.message.kind === CxpMessageKind.requestHighlight),
      'inbound dispatch after restart',
    );
  });
});

describe('handshake', () => {
  it('completes hello / hello_ack and exchanges identities', async () => {
    const server = await startServer();
    const client = await connectClient(server);
    expect(client.isConnected).toBe(true);
    expect(client.remotePeer?.peerId).toBe(serverIdentity.peerId);
    await pollUntil(() => server.connectedPeers.length === 1, 'the peer must register');
    expect(server.connectedPeers[0]?.peerId).toBe(testIdentity('client', 2).peerId);
  });

  it('emits a presence event after the handshake', async () => {
    const server = await startServer();
    const events: PeerPresenceEvent[] = [];
    server.onPresence.listen((e) => events.push(e));
    await connectClient(server, 3);
    await pollUntil(() => events.length > 0, 'a connect event must fire');
    expect(events[0]).toMatchObject({
      connected: true,
      peer: { peerId: testIdentity('client', 3).peerId },
    });
  });

  it('rejects traffic before hello with handshake_required and stays open', async () => {
    const server = await startServer();
    const raw = await connectRaw(server);
    raw.sendEnvelope({
      kind: CxpMessageKind.requestHighlight,
      payload: { element: { kind: 'signal', path: 'top.q' } },
      messageId: 'pre-hs-1',
    });
    await pollUntil(
      () => raw.errorPayloads(CxpErrorCode.handshakeRequired).length > 0,
      'pre-handshake traffic must be rejected',
    );
    expect(raw.errorPayloads(CxpErrorCode.handshakeRequired)[0]?.['in_reply_to']).toBe(
      'pre-hs-1',
    );
    expect(server.connectedPeers, 'a peer that never said hello must not register').toHaveLength(
      0,
    );

    // The rejection is not fatal: a proper hello on the same socket still
    // completes the handshake.
    raw.sendEnvelope({ ...rawHello(), messageId: 'hs-2' });
    await pollUntil(
      () => server.connectedPeers.length === 1,
      'a hello after the rejection must still register the peer',
    );
    expect(raw.closed).toBe(false);
  });

  it('a peer that drops before hello never registers', async () => {
    const server = await startServer();
    const aborted = await RawPeer.connectTo(server.boundPort ?? 0);
    aborted.close();

    const good = await connectRaw(server);
    good.sendEnvelope(rawHello('good-peer-2-1700000000000'));
    await pollUntil(() => server.connectedPeers.length > 0, 'the well-behaved peer must register');
    expect(server.connectedPeers.map((p) => p.peerId)).toEqual(['good-peer-2-1700000000000']);
  });

  it('removes the peer when it says goodbye', async () => {
    const server = await startServer();
    const client = await connectClient(server, 4);
    await pollUntil(() => server.connectedPeers.length === 1, 'the peer must register');
    const events: PeerPresenceEvent[] = [];
    server.onPresence.listen((e) => events.push(e));
    await client.disconnect();
    await pollUntil(() => events.some((e) => !e.connected), 'a disconnect event must fire');
    expect(server.connectedPeers).toHaveLength(0);
  });

  it('removes the peer when its socket dies without a goodbye', async () => {
    // CXP §4.3: a crashed peer cannot say goodbye, so an abrupt close is
    // equivalent.
    const server = await startServer();
    const raw = await connectRaw(server);
    raw.sendEnvelope(rawHello());
    await pollUntil(() => server.connectedPeers.length === 1, 'the peer must register');
    raw.close();
    await pollUntil(() => server.connectedPeers.length === 0, 'a dead socket must be reaped');
  });

  it('fails the dial when the peer accepts but never answers', async () => {
    const fake = await FakeCxpServer.start();
    cleanups.push(() => fake.close());
    const client = new LocalCxpClient({
      selfIdentity: testIdentity('client', 5),
      handshakeTimeoutMs: 200,
    });
    cleanups.push(() => client.dispose());
    await expect(client.connect({ host: '127.0.0.1', port: fake.port })).rejects.toThrow(
      CxpTimeoutError,
    );
    expect(client.isConnected).toBe(false);

    // The failed handshake must have torn the socket down, so the same
    // client can dial a healthy peer.
    const server = await startServer();
    await dial(client, server);
    expect(client.isConnected).toBe(true);
  });

  it('fails the dial when the peer answers with an error_response', async () => {
    const fake = await FakeCxpServer.start((f, socket) => {
      f.writeEnvelope(socket, {
        kind: CxpMessageKind.errorResponse,
        payload: {
          code: CxpErrorCode.unsupportedVersion,
          message: 'rejected',
          in_reply_to: 'x',
        },
      });
    });
    cleanups.push(() => fake.close());
    const client = new LocalCxpClient({ selfIdentity: testIdentity('client', 6) });
    cleanups.push(() => client.dispose());
    await expect(client.connect({ host: '127.0.0.1', port: fake.port })).rejects.toThrow(
      CxpHandshakeError,
    );
    expect(client.isConnected).toBe(false);

    const server = await startServer();
    await dial(client, server);
    expect(client.remotePeer?.peerId).toBe(serverIdentity.peerId);
  });

  it('fails the dial when the peer closes before hello_ack', async () => {
    const fake = await FakeCxpServer.start((_f, socket) => socket.destroy());
    cleanups.push(() => fake.close());
    const client = new LocalCxpClient({ selfIdentity: testIdentity('client', 7) });
    cleanups.push(() => client.dispose());
    await expect(client.connect({ host: '127.0.0.1', port: fake.port })).rejects.toThrow();
    expect(client.isConnected).toBe(false);
  });
});

describe('version negotiation', () => {
  it('rejects a major mismatch with unsupported_version AND closes', async () => {
    const server = await startServer();
    const raw = await connectRaw(server);
    raw.sendEnvelope({ ...rawHello(), cxpVersion: '9.9' });
    await pollUntil(
      () => raw.errorPayloads(CxpErrorCode.unsupportedVersion).length > 0,
      'major mismatch must be answered',
    );
    await pollUntil(() => raw.closed, 'major mismatch must close the connection');
    expect(server.connectedPeers).toHaveLength(0);
  });

  it('accepts a minor difference and keeps dispatching', async () => {
    const server = await startServer();
    const inbound: InboundCxpMessage[] = [];
    server.onInbound.listen((m) => inbound.push(m));
    const raw = await connectRaw(server);
    raw.sendEnvelope({ ...rawHello(), cxpVersion: '1.9' });
    await pollUntil(
      () => raw.ofKind(CxpMessageKind.helloAck).length > 0,
      'a minor difference must complete the handshake',
    );
    raw.sendEnvelope({
      kind: CxpMessageKind.requestHighlight,
      payload: { element: { kind: 'signal', path: 'top.q' } },
      cxpVersion: '1.9',
    });
    await pollUntil(
      () => inbound.some((m) => m.message.kind === CxpMessageKind.requestHighlight),
      'traffic from a 1.x peer must dispatch',
    );
    expect(raw.closed).toBe(false);
  });

  it('accepts a bare "1" as compatible', async () => {
    const server = await startServer();
    const raw = await connectRaw(server);
    raw.sendEnvelope({ ...rawHello(), cxpVersion: '1' });
    await pollUntil(
      () => raw.ofKind(CxpMessageKind.helloAck).length > 0,
      'a version with no dot is compared whole',
    );
  });

  it('sends 1.2 on the wire', async () => {
    const server = await startServer();
    const raw = await connectRaw(server);
    raw.sendEnvelope(rawHello());
    await pollUntil(() => raw.ofKind(CxpMessageKind.helloAck).length > 0, 'hello_ack must arrive');
    expect(raw.ofKind(CxpMessageKind.helloAck)[0]?.['cxp_version']).toBe('1.2');
  });

  it('fails the client handshake on a major mismatch in hello_ack', async () => {
    const fake = await FakeCxpServer.start((f, socket, envelope) => {
      if (envelope['kind'] === CxpMessageKind.hello) f.writeHelloAck(socket, envelope, '2.0');
    });
    cleanups.push(() => fake.close());
    const client = new LocalCxpClient({ selfIdentity: testIdentity('client', 8) });
    cleanups.push(() => client.dispose());
    await expect(client.connect({ host: '127.0.0.1', port: fake.port })).rejects.toThrow(
      CxpHandshakeError,
    );
    expect(client.isConnected).toBe(false);
  });
});

describe('fault paths', () => {
  it('answers an unknown kind with unknown_kind and keeps the connection', async () => {
    const server = await startServer();
    const inbound: InboundCxpMessage[] = [];
    server.onInbound.listen((m) => inbound.push(m));
    const raw = await connectRaw(server);
    raw.sendEnvelope(rawHello());
    await pollUntil(() => raw.ofKind(CxpMessageKind.helloAck).length > 0, 'handshake');

    raw.sendEnvelope({
      kind: 'unknown_future_extension_kind',
      payload: {},
      messageId: 'uk-1',
    });
    await pollUntil(
      () => raw.errorPayloads(CxpErrorCode.unknownKind).length > 0,
      'an unknown kind must be answered',
    );
    expect(raw.errorPayloads(CxpErrorCode.unknownKind)[0]?.['in_reply_to']).toBe('uk-1');
    expect(raw.closed, 'the connection must survive an unknown kind').toBe(false);

    raw.sendEnvelope({
      kind: CxpMessageKind.requestHighlight,
      payload: { element: { kind: 'signal', path: 'top.q' } },
    });
    await pollUntil(
      () => inbound.some((m) => m.message.kind === CxpMessageKind.requestHighlight),
      'the connection must keep serving',
    );
  });

  it('answers a malformed payload of a known kind and keeps the connection', async () => {
    const server = await startServer();
    const inbound: InboundCxpMessage[] = [];
    server.onInbound.listen((m) => inbound.push(m));
    const raw = await connectRaw(server);
    raw.sendEnvelope(rawHello());
    await pollUntil(() => raw.ofKind(CxpMessageKind.helloAck).length > 0, 'handshake');

    raw.sendEnvelope({
      kind: CxpMessageKind.notifySelection,
      payload: {},
      messageId: 'bad-payload-1',
    });
    await pollUntil(
      () => raw.errorPayloads(CxpErrorCode.malformedPayload).length > 0,
      'an undecodable payload must be answered',
    );
    expect(raw.errorPayloads(CxpErrorCode.malformedPayload)[0]?.['in_reply_to']).toBe(
      'bad-payload-1',
    );

    raw.sendEnvelope({
      kind: CxpMessageKind.requestHighlight,
      payload: { element: { kind: 'signal', path: 'top.q' } },
    });
    await pollUntil(
      () => inbound.some((m) => m.message.kind === CxpMessageKind.requestHighlight),
      'the connection must survive a malformed payload',
    );
  });

  it('NEVER answers an error_response with an error_response (§9.8)', async () => {
    const server = await startServer();
    const raw = await connectRaw(server);
    raw.sendEnvelope(rawHello());
    await pollUntil(() => raw.ofKind(CxpMessageKind.helloAck).length > 0, 'handshake');
    const errorsBefore = raw.ofKind(CxpMessageKind.errorResponse).length;

    // An error_response whose own payload is undecodable — the frame that
    // starts an infinite error ping-pong in an implementation without the
    // guard.
    raw.sendEnvelope({
      kind: CxpMessageKind.errorResponse,
      payload: { nonsense: true },
      messageId: 'err-1',
    });
    // And one sent before any handshake would otherwise draw
    // handshake_required.
    const second = await connectRaw(server);
    second.sendEnvelope({
      kind: CxpMessageKind.errorResponse,
      payload: { nonsense: true },
      messageId: 'err-2',
    });

    // Bound both absence checks with a frame that IS answered, on the same
    // socket and after: once it lands, an answer to the error_response
    // would already have arrived.
    raw.sendEnvelope({ kind: 'definitely_unknown', payload: {}, messageId: 'marker' });
    await pollUntil(
      () => raw.errorPayloads(CxpErrorCode.unknownKind).length > 0,
      'the marker must be answered',
    );
    second.sendEnvelope(rawHello('second-peer-2-1700000000000'));
    await pollUntil(
      () => second.ofKind(CxpMessageKind.helloAck).length > 0,
      "the marker must be answered on the second peer's socket",
    );

    expect(raw.ofKind(CxpMessageKind.errorResponse)).toHaveLength(errorsBefore + 1);
    expect(
      second.ofKind(CxpMessageKind.errorResponse),
      'an error_response before the handshake draws no handshake_required either',
    ).toHaveLength(0);
  });
});

/**
 * A frame that is not an envelope ends the connection — crux_cxp's
 * "unparseable frames close the connection" group, case for case.
 *
 * Every product listens on a fixed default port, and a web page can `fetch()`
 * a loopback port with a `text/plain` POST that needs no CORS preflight: the
 * browser writes the HTTP request straight onto the socket. Its request line
 * and headers are frames the decoder rejects; its body is whatever the page
 * chose, newline-delimited JSON included. A receiver that answered each bad
 * frame and read on would dispatch that body as a handshake and a stream of
 * requests. An HTTP request cannot begin with a JSON object, so closing on the
 * first frame that is not an envelope ends it before the body is reached.
 *
 * Frames that ARE envelopes but carry an undecodable payload or an unknown
 * kind still leave the connection open (§6.1) — see 'fault paths' above.
 */
describe('unparseable frames close the connection', () => {
  function browserPost(port: number): string {
    // The body carries the server's real token: the property under test is
    // that the request line closes the socket before the body is read, and
    // it must hold even for a body that would otherwise pass the handshake.
    const hello = encodeEnvelopeLine({
      cxpVersion: '1.2',
      messageId: 'b-1',
      from: 'raw-peer-1-1700000000000',
      kind: CxpMessageKind.hello,
      payload: rawHello().payload,
    });
    const request = encodeEnvelopeLine({
      cxpVersion: '1.2',
      messageId: 'b-2',
      from: 'raw-peer-1-1700000000000',
      kind: CxpMessageKind.requestOpenSource,
      payload: { file_path: '/etc/passwd', line: 1 },
    });
    const body = hello + request;
    return (
      'POST / HTTP/1.1\r\n' +
      `Host: 127.0.0.1:${port}\r\n` +
      'Content-Type: text/plain;charset=UTF-8\r\n' +
      'Origin: https://attacker.example\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body
    );
  }

  it('a browser POST to the port is dropped at its request line and its body is never dispatched', async () => {
    const server = await startServer();
    const inbound: InboundCxpMessage[] = [];
    server.onInbound.listen((m) => inbound.push(m));
    const presence: PeerPresenceEvent[] = [];
    server.onPresence.listen((e) => presence.push(e));

    const raw = await connectRaw(server);
    raw.writeRaw(browserPost(server.boundPort ?? 0));
    await pollUntil(() => raw.closed, 'the request line is not an envelope; the socket must close');
    expect(
      raw.errorPayloads(CxpErrorCode.malformedEnvelope),
      'the rejection is answered before the close',
    ).not.toHaveLength(0);

    // A well-behaved peer registering afterwards bounds the negative
    // assertions: the body's hello and request shared the socket, in order,
    // with the request line, so if either had been dispatched it would have
    // happened before this peer's handshake completed.
    const good = await connectRaw(server);
    good.sendEnvelope(rawHello('good-peer-2-1700000000000'));
    await pollUntil(
      () => server.connectedPeers.some((p) => p.peerId === 'good-peer-2-1700000000000'),
      'the server must keep serving after dropping the browser',
    );
    expect(inbound, 'the request_open_source in the POST body must never dispatch').toEqual([]);
    expect(
      presence.map((e) => e.peer.peerId),
      'the hello in the POST body must never register a peer',
    ).toEqual(['good-peer-2-1700000000000']);
  });

  it('a frame that is not JSON closes the connection', async () => {
    const server = await startServer();
    const raw = await connectRaw(server);
    raw.writeRaw('GET / HTTP/1.1\r\n');
    await pollUntil(() => raw.closed, 'non-JSON must close');
    expect(raw.errorPayloads(CxpErrorCode.malformedEnvelope)).toHaveLength(1);
  });

  it('a JSON frame that is not an object closes the connection', async () => {
    const server = await startServer();
    const raw = await connectRaw(server);
    raw.writeRaw('[1, 2, 3]\n');
    await pollUntil(() => raw.closed, 'a JSON array must close');
    expect(raw.errorPayloads(CxpErrorCode.malformedEnvelope)).toHaveLength(1);
  });

  it('a JSON object missing a required envelope field closes the connection', async () => {
    const server = await startServer();
    const raw = await connectRaw(server);
    raw.writeRaw('{"cxp_version":"1.2","message_id":"m","from":"f"}\n');
    await pollUntil(() => raw.closed, 'a non-envelope must close');
    const answers = raw.errorPayloads(CxpErrorCode.malformedEnvelope);
    expect(answers).toHaveLength(1);
    // No message id could be recovered from the offending frame.
    expect(answers[0]?.['in_reply_to']).toBe('');
  });

  it('only the first bad frame is answered — nothing after it is read', async () => {
    const server = await startServer();
    const raw = await connectRaw(server);
    raw.writeRaw('{not json at all\n[1,2,3]\n');
    raw.sendEnvelope(rawHello());
    await pollUntil(() => raw.closed, 'the first bad frame must close');
    expect(raw.errorPayloads(CxpErrorCode.malformedEnvelope)).toHaveLength(1);
    expect(raw.ofKind(CxpMessageKind.helloAck)).toEqual([]);
    expect(server.connectedPeers).toEqual([]);
  });

  it('an established peer that sends garbage is dropped, and the drop is a disconnect', async () => {
    const server = await startServer();
    const presence: PeerPresenceEvent[] = [];
    server.onPresence.listen((e) => presence.push(e));
    const raw = await connectRaw(server);
    raw.sendEnvelope(rawHello());
    await pollUntil(() => server.connectedPeers.length === 1, 'handshake must complete');

    raw.writeRaw('not an envelope\n');
    await pollUntil(() => raw.closed, 'garbage must close');
    await pollUntil(
      () => presence.some((e) => !e.connected),
      'the drop must surface as a disconnect presence event',
    );
    expect(server.connectedPeers).toEqual([]);
  });

  it('the client drops a peer that answers with something other than envelopes', async () => {
    // A dialled port that turns out to speak HTTP — a squatter, a
    // misconfigured tool — must not stay attached as a link.
    const fake = await FakeCxpServer.start((f, socket, envelope) => {
      if (envelope['kind'] === CxpMessageKind.hello) f.writeHelloAck(socket, envelope);
    });
    cleanups.push(() => fake.close());
    const client = new LocalCxpClient({ selfIdentity: testIdentity('client', 10) });
    cleanups.push(() => client.dispose());
    const events: CxpConnectionEvent[] = [];
    client.onEvent.listen((e) => events.push(e));
    await client.connect({ host: '127.0.0.1', port: fake.port });
    expect(client.isConnected).toBe(true);

    fake.sockets[0]?.write('HTTP/1.1 200 OK\r\n');
    await pollUntil(() => !client.isConnected, 'a non-envelope frame must drop the link');
    expect(events.at(-1)?.error, 'the disconnect must say why').toBeInstanceOf(CxpFormatError);
  });

  it('a client that has not finished the handshake fails it on garbage', async () => {
    const fake = await FakeCxpServer.start((_f, socket, envelope) => {
      if (envelope['kind'] === CxpMessageKind.hello) socket.write('HTTP/1.1 400 Bad Request\r\n');
    });
    cleanups.push(() => fake.close());
    const client = new LocalCxpClient({
      selfIdentity: testIdentity('client', 11),
      handshakeTimeoutMs: 2000,
    });
    cleanups.push(() => client.dispose());
    await expect(client.connect({ host: '127.0.0.1', port: fake.port })).rejects.toBeInstanceOf(
      CxpFormatError,
    );
    expect(client.isConnected).toBe(false);
  });
});

describe('framing over a real socket', () => {
  it('reassembles a frame delivered in two writes', async () => {
    const server = await startServer();
    const raw = await connectRaw(server);
    const hello = JSON.stringify({
      cxp_version: '1.1',
      message_id: 'split-1',
      from: 'raw-peer-1-1700000000000',
      kind: 'hello',
      payload: {
        identity: {
          peer_id: 'raw-peer-1-1700000000000',
          product_name: 'rawpeer',
          product_version: '0.0.0',
          capabilities: [],
        },
        token: SERVER_TOKEN,
      },
    });
    const half = Math.floor(hello.length / 2);
    raw.writeRaw(hello.slice(0, half));
    await new Promise((resolve) => setTimeout(resolve, 20));
    raw.writeRaw(`${hello.slice(half)}\n`);
    await pollUntil(
      () => raw.ofKind(CxpMessageKind.helloAck).length > 0,
      'a split frame must still be handled',
    );
  });

  it('handles several frames coalesced into one write', async () => {
    const server = await startServer();
    const inbound: InboundCxpMessage[] = [];
    server.onInbound.listen((m) => inbound.push(m));
    const raw = await connectRaw(server);
    const frame = (id: string, path: string): string =>
      `${JSON.stringify({
        cxp_version: '1.1',
        message_id: id,
        from: 'raw-peer-1-1700000000000',
        kind: 'request_highlight',
        payload: { element: { kind: 'signal', path } },
      })}\n`;
    const helloFrame = `${JSON.stringify({
      cxp_version: '1.1',
      message_id: 'h',
      from: 'raw-peer-1-1700000000000',
      kind: 'hello',
      payload: {
        identity: {
          peer_id: 'raw-peer-1-1700000000000',
          product_name: 'rawpeer',
          product_version: '0.0.0',
          capabilities: [],
        },
        token: SERVER_TOKEN,
      },
    })}\n`;
    raw.writeRaw(helloFrame + frame('a', 'top.a') + frame('b', 'top.b') + frame('c', 'top.c'));
    await pollUntil(() => inbound.length === 3, 'all three coalesced frames must dispatch');
    expect(
      inbound.map((m) =>
        m.message.kind === CxpMessageKind.requestHighlight ? m.message.element.path : '',
      ),
    ).toEqual(['top.a', 'top.b', 'top.c']);
  });

  it('drops a connection streaming an unterminated over-long line', async () => {
    const server = await startServer({ maxLineLength: 1024 });
    const raw = await connectRaw(server);
    raw.writeRaw('x'.repeat(5000));
    await pollUntil(() => raw.closed, 'an unbounded line must not buffer forever');

    // And the server keeps serving everyone else.
    const second = await connectRaw(server);
    second.sendEnvelope(rawHello('second-peer-2-1700000000000'));
    await pollUntil(
      () => second.ofKind(CxpMessageKind.helloAck).length > 0,
      'the server must keep accepting',
    );
  });

  it('drops a connection sending an over-long terminated frame', async () => {
    const server = await startServer({ maxLineLength: 1024 });
    const raw = await connectRaw(server);
    raw.writeRaw(`${'y'.repeat(5000)}\n`);
    await pollUntil(() => raw.closed, 'an over-long frame must drop the connection');
  });

  it('drops the client connection when the peer sends an over-long frame', async () => {
    const fake = await FakeCxpServer.start((f, socket, envelope) => {
      if (envelope['kind'] === CxpMessageKind.hello) f.writeHelloAck(socket, envelope);
    });
    cleanups.push(() => fake.close());
    const client = new LocalCxpClient({
      selfIdentity: testIdentity('client', 9),
      maxLineLength: 512,
    });
    cleanups.push(() => client.dispose());
    await client.connect({ host: '127.0.0.1', port: fake.port });
    expect(client.isConnected).toBe(true);
    fake.sockets[0]?.write(`${'z'.repeat(2000)}\n`);
    await pollUntil(() => !client.isConnected, 'an over-long frame must drop the link');
  });

  it('drops a peer whose outbound backlog exceeds the cap', async () => {
    const server = await startServer({ maxPendingWriteBytes: 4096 });
    const raw = await connectRaw(server);
    raw.sendEnvelope(rawHello());
    await pollUntil(() => raw.ofKind(CxpMessageKind.helloAck).length > 0, 'handshake');
    expect(
      server.pendingWriteBytesOf('raw-peer-1-1700000000000'),
      'one handshake frame must not approach the cap',
    ).toBeLessThan(4096);
    raw.sendEnvelope({
      kind: CxpMessageKind.subscribe,
      payload: {
        subscriptions: CXP_SUBSCRIBE_TO_ALL.map((s) => ({
          message_kind: s.messageKind,
          element_kinds: [],
        })),
      },
    });
    await pollUntil(
      () => server.subscriptionsOf('raw-peer-1-1700000000000').length > 0,
      'the subscription must register',
    );

    // One synchronous burst: every frame is queued before any of them can
    // flush, so the backlog is unambiguously over the cap.
    const bulky: CxpMessage = {
      kind: CxpMessageKind.notifySelection,
      elements: [element],
      displayName: 'w'.repeat(3000),
      metadata: {},
    };
    server.broadcast(bulky);
    server.broadcast(bulky);
    await pollUntil(
      () => server.connectedPeers.length === 0,
      'an unbounded outbound backlog must drop the peer',
    );
  });
});

describe('subscribe, broadcast and directed send', () => {
  async function subscribedClient(
    server: LocalCxpServer,
    n: number,
    subscriptions: readonly { messageKind: string; elementKinds: string[]; pathPrefix?: string }[],
  ): Promise<{ client: LocalCxpClient; received: CxpClientInbound[] }> {
    const client = await connectClient(server, n);
    const received: CxpClientInbound[] = [];
    client.onInbound.listen((m) => received.push(m));
    client.send({ kind: CxpMessageKind.subscribe, subscriptions });
    await pollUntil(
      () => server.subscriptionsOf(testIdentity('client', n).peerId).length > 0,
      'the subscription must register before broadcasting',
    );
    return { client, received };
  }

  it('delivers a broadcast to a subscriber', async () => {
    const server = await startServer();
    const { received } = await subscribedClient(server, 20, [
      { messageKind: CxpMessageKind.notifySelection, elementKinds: [] },
    ]);
    server.broadcast(selection('top.a'));
    await pollUntil(() => received.length > 0, 'the broadcast must arrive');
    expect(received[0]?.message).toMatchObject({ elements: [{ path: 'top.a' }] });
  });

  it('delivers nothing to a peer that never subscribed', async () => {
    const server = await startServer();
    const client = await connectClient(server, 21);
    const received: CxpClientInbound[] = [];
    client.onInbound.listen((m) => received.push(m));
    server.broadcast(selection('top.a'));
    // A directed marker bounds the absence check: sendTo bypasses filters
    // and shares the same socket, so once it lands the broadcast would
    // already have arrived if it had been sent.
    server.sendTo(testIdentity('client', 21).peerId, highlight);
    await pollUntil(
      () => received.some((m) => m.message.kind === CxpMessageKind.requestHighlight),
      'the directed marker must arrive',
    );
    expect(received.filter((m) => m.message.kind === CxpMessageKind.notifySelection)).toEqual([]);
  });

  it('stops delivering after unsubscribe', async () => {
    const server = await startServer();
    const { client, received } = await subscribedClient(server, 22, [
      { messageKind: CxpMessageKind.notifySelection, elementKinds: [] },
    ]);
    client.send({ kind: CxpMessageKind.unsubscribe });
    await pollUntil(
      () => server.subscriptionsOf(testIdentity('client', 22).peerId).length === 0,
      'the unsubscribe must register',
    );
    server.broadcast(selection('top.a'));
    server.sendTo(testIdentity('client', 22).peerId, highlight);
    await pollUntil(
      () => received.some((m) => m.message.kind === CxpMessageKind.requestHighlight),
      'the directed marker must arrive',
    );
    expect(received.filter((m) => m.message.kind === CxpMessageKind.notifySelection)).toEqual([]);
  });

  it('replaces, never merges, the previous subscription set (§9.1)', async () => {
    const server = await startServer();
    const { client } = await subscribedClient(server, 23, [
      { messageKind: CxpMessageKind.notifySelection, elementKinds: [] },
      { messageKind: CxpMessageKind.requestHighlight, elementKinds: [] },
    ]);
    client.send({
      kind: CxpMessageKind.subscribe,
      subscriptions: [{ messageKind: CxpMessageKind.requestHighlight, elementKinds: [] }],
    });
    await pollUntil(
      () => server.subscriptionsOf(testIdentity('client', 23).peerId).length === 1,
      'the second subscribe must replace the first',
    );
  });

  it('enforces a path_prefix filter at the socket', async () => {
    const server = await startServer();
    const { received } = await subscribedClient(server, 24, [
      { messageKind: CxpMessageKind.notifySelection, elementKinds: [], pathPrefix: 'top.cpu.' },
    ]);
    server.broadcast(selection('top.mem.q'));
    server.broadcast(selection('top.cpu.alu'));
    await pollUntil(() => received.length > 0, 'the matching selection must be delivered');
    expect(
      received.map((m) =>
        m.message.kind === CxpMessageKind.notifySelection ? m.message.elements[0]?.path : '',
      ),
    ).toEqual(['top.cpu.alu']);
  });

  it('enforces an element_kinds filter at the socket', async () => {
    const server = await startServer();
    const { received } = await subscribedClient(server, 25, [
      { messageKind: CxpMessageKind.notifySelection, elementKinds: ['signal'] },
    ]);
    server.broadcast(selection('top.mem', 'scope'));
    server.broadcast(selection('top.cpu.clk', 'signal'));
    await pollUntil(() => received.length > 0, 'the signal-kind selection must be delivered');
    expect(
      received.map((m) =>
        m.message.kind === CxpMessageKind.notifySelection ? m.message.elements[0]?.kind : '',
      ),
    ).toEqual(['signal']);
  });

  it('sendTo reaches only the named peer, and reports an unknown one', async () => {
    const server = await startServer();
    const a = await connectClient(server, 26);
    const b = await connectClient(server, 27);
    const toA: CxpClientInbound[] = [];
    const toB: CxpClientInbound[] = [];
    a.onInbound.listen((m) => toA.push(m));
    b.onInbound.listen((m) => toB.push(m));

    expect(server.sendTo(testIdentity('client', 26).peerId, selection('top.t'))).toBe(true);
    await pollUntil(() => toA.length > 0, 'the directed message must reach a');
    server.sendTo(testIdentity('client', 27).peerId, highlight);
    await pollUntil(
      () => toB.some((m) => m.message.kind === CxpMessageKind.requestHighlight),
      "the marker must arrive on b's socket",
    );
    expect(toB.filter((m) => m.message.kind === CxpMessageKind.notifySelection)).toEqual([]);
    expect(server.sendTo('no-such-peer', selection('x'))).toBe(false);
  });

  it('dispatches inbound messages with the sending peer attached', async () => {
    const server = await startServer();
    const inbound: InboundCxpMessage[] = [];
    server.onInbound.listen((m) => inbound.push(m));
    const client = await connectClient(server, 28);
    client.send(highlight);
    await pollUntil(() => inbound.length > 0, 'the message must dispatch');
    expect(inbound[0]?.from.peerId).toBe(testIdentity('client', 28).peerId);
    expect(inbound[0]?.message).toMatchObject({ element: { path: 'top.dut.q' } });
  });

  it('never surfaces handshake or subscription frames on the inbound stream', async () => {
    const server = await startServer();
    const inbound: InboundCxpMessage[] = [];
    server.onInbound.listen((m) => inbound.push(m));
    const client = await connectClient(server, 29);
    client.send({ kind: CxpMessageKind.subscribe, subscriptions: [...CXP_SUBSCRIBE_TO_ALL] });
    client.send({ kind: CxpMessageKind.unsubscribe });
    client.send(highlight);
    await pollUntil(() => inbound.length > 0, 'the dispatchable message must arrive');
    expect(inbound.map((m) => m.message.kind)).toEqual([CxpMessageKind.requestHighlight]);
  });
});

describe('connector-attached links', () => {
  it('routes sendTo over an attached link and reports presence', async () => {
    const server = await startServer();
    const sent: CxpMessage[] = [];
    const linked = testIdentity('simcrux', 30);
    const events: PeerPresenceEvent[] = [];
    server.onPresence.listen((e) => events.push(e));

    server.attachLinkedPeer(linked, (m) => sent.push(m));
    expect(events).toEqual([{ peer: linked, connected: true }]);
    expect(server.connectedPeers.map((p) => p.peerId)).toEqual([linked.peerId]);
    expect(server.sendTo(linked.peerId, highlight)).toBe(true);
    expect(sent).toEqual([highlight]);

    server.detachLinkedPeer(linked.peerId);
    expect(events.at(-1)).toEqual({ peer: linked, connected: false });
    expect(server.connectedPeers).toHaveLength(0);
  });

  it('applies the link peer subscriptions injected over it to broadcasts', async () => {
    const server = await startServer();
    const sent: CxpMessage[] = [];
    const linked = testIdentity('simcrux', 31);
    server.attachLinkedPeer(linked, (m) => sent.push(m));

    // No subscribe yet: the link receives no gossip.
    server.broadcast(selection('top.a'));
    expect(sent).toEqual([]);

    server.injectInbound({
      envelope: {
        cxpVersion: '1.1',
        messageId: 'i-1',
        from: linked.peerId,
        kind: CxpMessageKind.subscribe,
        payload: {},
      },
      message: { kind: CxpMessageKind.subscribe, subscriptions: [...CXP_SUBSCRIBE_TO_ALL] },
      from: linked,
    });
    server.broadcast(selection('top.b'));
    expect(sent).toHaveLength(1);
  });

  it('surfaces an injected non-subscription message on the inbound stream', async () => {
    const server = await startServer();
    const inbound: InboundCxpMessage[] = [];
    server.onInbound.listen((m) => inbound.push(m));
    const linked = testIdentity('simcrux', 32);
    server.injectInbound({
      envelope: {
        cxpVersion: '1.1',
        messageId: 'i-2',
        from: linked.peerId,
        kind: CxpMessageKind.notifySelection,
        payload: {},
      },
      message: selection('top.c'),
      from: linked,
    });
    expect(inbound).toHaveLength(1);
  });
});

describe('stress', () => {
  it('completes 40 concurrent handshakes', async () => {
    const server = await startServer();
    const clients = Array.from(
      { length: 40 },
      (_, i) => new LocalCxpClient({ selfIdentity: testIdentity('client', 100 + i) }),
    );
    for (const client of clients) cleanups.push(() => client.dispose());
    await Promise.all(
      clients.map((c) => dial(c, server)),
    );
    await pollUntil(
      () => server.connectedPeers.length === 40,
      'every handshake must register a peer',
    );
  });
});
