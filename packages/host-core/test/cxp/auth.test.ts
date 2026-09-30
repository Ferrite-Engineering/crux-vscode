/**
 * Peer authentication — wire 1.2.
 *
 * A server requires the token it published in its manifest; a dialler
 * presents the token it read there; nothing else about the handshake
 * changes. Every Crux product binds a fixed loopback port (54322–54325), and
 * loopback is reachable by processes the specification's trust model (§11)
 * never included — another local user, a sandboxed app, a container. The
 * manifest lives in the user's private application-data directory, so
 * presenting its token proves exactly the file access the model already
 * assumes.
 *
 * The cases mirror crux_cxp's `test/conformance/auth_token_test.dart`, because
 * a TypeScript peer that is right by its own lights and wrong by the Dart
 * one's fails silently: the handshake is refused and the user sees an
 * unreachable peer. The wire shape pinned here — `token` on the manifest,
 * `token` on the `hello` payload, `unauthorized` in reply — is the Dart
 * one, field names and message text included.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic } from '../../src/cxp/atomic-write';
import { LocalCxpClient, type CxpConnectionEvent } from '../../src/cxp/client';
import { CxpPeerConnector } from '../../src/cxp/connector';
import { CxpDiscovery } from '../../src/cxp/discovery';
import { CxpHandshakeError } from '../../src/cxp/errors';
import type { PeerIdentity } from '../../src/cxp/identity';
import { isJsonObject } from '../../src/cxp/json';
import {
  decodeCxpPeerManifest,
  encodeCxpPeerManifest,
  type CxpPeerManifest,
} from '../../src/cxp/manifest';
import { CxpManifestWriter } from '../../src/cxp/manifest-writer';
import { CxpErrorCode, CxpMessageKind, decodeCxpMessage } from '../../src/cxp/messages';
import { sendOneShotRequest } from '../../src/cxp/one-shot';
import { PidLiveness } from '../../src/cxp/process-liveness';
import { LocalCxpServer, type PeerPresenceEvent } from '../../src/cxp/server';
import { FakeCxpServer, pollUntil, RawPeer, testIdentity } from './harness';

const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

/**
 * Two distinct well-formed tokens, fixed so a failure message is readable.
 * Built by repetition, not written out: a high-entropy hex literal beside the
 * word "token" is exactly what a secret scanner is right to flag.
 */
const TOKEN_A = 'ab'.repeat(16);
const TOKEN_B = 'cd'.repeat(16);

/** crux_cxp's refusal text, verbatim — it lands in the other side's log. */
const UNAUTHORIZED_MESSAGE =
  'A hello to this peer must carry the token published in its manifest.';

const serverIdentity = testIdentity('wavecrux', 1);
const dialerIdentity = testIdentity('netcrux', 2);

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startServer(
  options: Partial<ConstructorParameters<typeof LocalCxpServer>[0]> = {},
): Promise<LocalCxpServer> {
  const server = new LocalCxpServer({ selfIdentity: serverIdentity, ...options });
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}

function newClient(identity: PeerIdentity = dialerIdentity): LocalCxpClient {
  const client = new LocalCxpClient({
    selfIdentity: identity,
    connectTimeoutMs: 2000,
    handshakeTimeoutMs: 2000,
  });
  cleanups.push(() => client.dispose());
  return client;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof CxpHandshakeError && error.code === CxpErrorCode.unauthorized;
}

describe('LocalCxpServer requires its token by default', () => {
  it('holds a 128-bit token and requires it unless told otherwise', async () => {
    const server = await startServer();
    expect(server.authToken).toMatch(TOKEN_SHAPE);
    expect(server.requireAuthToken).toBe(true);
  });

  it('a hello without the token is answered unauthorized, closed, and never becomes a peer', async () => {
    const server = await startServer();
    const presence: PeerPresenceEvent[] = [];
    server.onPresence.listen((e) => presence.push(e));
    const inbound: unknown[] = [];
    server.onInbound.listen((m) => inbound.push(m));

    const client = newClient();
    const events: CxpConnectionEvent[] = [];
    client.onEvent.listen((e) => events.push(e));

    const failure = await client
      .connect({ host: '127.0.0.1', port: server.boundPort ?? 0 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(isUnauthorized(failure), `expected an unauthorized refusal, got ${String(failure)}`).toBe(
      true,
    );
    expect(client.isConnected).toBe(false);
    expect(server.connectedPeers).toEqual([]);
    expect(presence, 'a refused hello must not produce presence').toEqual([]);
    expect(inbound).toEqual([]);
    await pollUntil(
      () => events.some((e) => !e.connected),
      'the refusal must surface as a disconnect event',
    );
    expect(String(events.at(-1)?.error), 'the refusal must not disclose the token').not.toContain(
      server.authToken,
    );
  });

  it('a hello with the wrong token is refused the same way', async () => {
    const server = await startServer({ authToken: TOKEN_A });
    const client = newClient();
    const failure = await client
      .connect({ host: '127.0.0.1', port: server.boundPort ?? 0, token: TOKEN_B })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(isUnauthorized(failure), `expected an unauthorized refusal, got ${String(failure)}`).toBe(
      true,
    );
    expect(server.connectedPeers).toEqual([]);
  });

  it('a hello with the token completes the handshake', async () => {
    const server = await startServer();
    const client = newClient();
    await client.connect({
      host: '127.0.0.1',
      port: server.boundPort ?? 0,
      token: server.authToken,
    });
    expect(client.isConnected).toBe(true);
    expect(client.remotePeer?.peerId).toBe(serverIdentity.peerId);
    await pollUntil(
      () => server.connectedPeers.some((p) => p.peerId === dialerIdentity.peerId),
      'the authenticated peer registers',
    );
  });

  it('an explicit token replaces the default', async () => {
    const server = await startServer({ authToken: TOKEN_A });
    expect(server.authToken).toBe(TOKEN_A);

    const withOther = newClient();
    await expect(
      withOther.connect({ host: '127.0.0.1', port: server.boundPort ?? 0, token: TOKEN_B }),
    ).rejects.toBeInstanceOf(CxpHandshakeError);

    const withExplicit = newClient();
    await withExplicit.connect({ host: '127.0.0.1', port: server.boundPort ?? 0, token: TOKEN_A });
    expect(withExplicit.isConnected).toBe(true);
  });

  it('requireAuthToken: false accepts a hello without one — a pre-1.2 dialler', async () => {
    const server = await startServer({ requireAuthToken: false });
    const client = newClient();
    await client.connect({ host: '127.0.0.1', port: server.boundPort ?? 0 });
    expect(client.isConnected).toBe(true);
  });

  it('a refused client is reusable against the same peer once it has the token', async () => {
    const server = await startServer();
    const client = newClient();
    await expect(
      client.connect({ host: '127.0.0.1', port: server.boundPort ?? 0 }),
    ).rejects.toBeInstanceOf(CxpHandshakeError);
    await client.connect({
      host: '127.0.0.1',
      port: server.boundPort ?? 0,
      token: server.authToken,
    });
    expect(client.isConnected).toBe(true);
  });

  it('refuses before anything else on the socket: no hello_ack, reply to the hello, then close', async () => {
    const server = await startServer({ authToken: TOKEN_A });
    const raw = await RawPeer.connectTo(server.boundPort ?? 0);
    cleanups.push(() => raw.close());
    raw.sendEnvelope({
      kind: CxpMessageKind.hello,
      payload: {
        identity: {
          peer_id: 'raw-peer-1-1700000000000',
          product_name: 'rawpeer',
          product_version: '0.0.0',
          capabilities: [],
        },
        token: TOKEN_B,
      },
      messageId: 'hello-wrong-token',
    });
    await pollUntil(() => raw.closed, 'a refused hello must close the connection');
    const refusals = raw.errorPayloads(CxpErrorCode.unauthorized);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toEqual({
      code: 'unauthorized',
      message: UNAUTHORIZED_MESSAGE,
      in_reply_to: 'hello-wrong-token',
    });
    expect(raw.ofKind(CxpMessageKind.helloAck)).toEqual([]);
    const replies = JSON.stringify(raw.envelopes);
    expect(replies, 'the reply must not echo the required token').not.toContain(TOKEN_A);
    expect(replies, 'the reply must not echo the presented token').not.toContain(TOKEN_B);
  });

  it('accepts a raw hello carrying the token under the field name "token"', async () => {
    const server = await startServer({ authToken: TOKEN_A });
    const raw = await RawPeer.connectTo(server.boundPort ?? 0);
    cleanups.push(() => raw.close());
    raw.sendEnvelope({
      kind: CxpMessageKind.hello,
      payload: {
        identity: {
          peer_id: 'raw-peer-1-1700000000000',
          product_name: 'rawpeer',
          product_version: '0.0.0',
          capabilities: [],
        },
        token: TOKEN_A,
      },
    });
    await pollUntil(() => raw.ofKind(CxpMessageKind.helloAck).length > 0, 'hello_ack must arrive');
    expect(raw.closed).toBe(false);
  });
});

describe('LocalCxpClient presents the token in its hello', () => {
  async function recordingPeer(): Promise<FakeCxpServer> {
    // Answers any hello with hello_ack, as a pre-1.2 server does: it
    // neither requires nor reads the token.
    const fake = await FakeCxpServer.start((f, socket, envelope) => {
      if (envelope['kind'] === CxpMessageKind.hello) f.writeHelloAck(socket, envelope);
    });
    cleanups.push(() => fake.close());
    return fake;
  }

  it('puts the token in the hello payload, beside the identity', async () => {
    const fake = await recordingPeer();
    const client = newClient();
    await client.connect({ host: '127.0.0.1', port: fake.port, token: TOKEN_A });
    const hello = fake.received.find((e) => e['kind'] === CxpMessageKind.hello);
    const payload = hello?.['payload'];
    expect(isJsonObject(payload) ? payload['token'] : undefined).toBe(TOKEN_A);
    expect(isJsonObject(payload) ? isJsonObject(payload['identity']) : false).toBe(true);
  });

  it('sends no token field at all when it has none — the pre-1.2 hello, byte for byte', async () => {
    const fake = await recordingPeer();
    const client = newClient();
    await client.connect({ host: '127.0.0.1', port: fake.port });
    const hello = fake.received.find((e) => e['kind'] === CxpMessageKind.hello);
    const payload = hello?.['payload'];
    expect(isJsonObject(payload) ? Object.keys(payload) : []).toEqual(['identity']);
  });

  it('still dials a pre-1.2 server that ignores the token — a 1.2 build dials older builds', async () => {
    const fake = await recordingPeer();
    const client = newClient();
    await client.connect({ host: '127.0.0.1', port: fake.port, token: TOKEN_A });
    expect(client.isConnected).toBe(true);
  });
});

describe('the hello payload', () => {
  const identity = {
    peer_id: 'wavecrux-1234-1700000000000',
    product_name: 'wavecrux',
    product_version: '1.0.0',
    capabilities: [],
  };

  it('decodes the token, and an empty one as none', () => {
    expect(decodeCxpMessage(CxpMessageKind.hello, { identity, token: TOKEN_A })).toMatchObject({
      token: TOKEN_A,
    });
    expect(decodeCxpMessage(CxpMessageKind.hello, { identity, token: '' })).not.toHaveProperty(
      'token',
    );
    expect(decodeCxpMessage(CxpMessageKind.hello, { identity, token: 7 })).not.toHaveProperty(
      'token',
    );
  });

  it('defines unauthorized as an error code this build acts on', () => {
    expect(CxpErrorCode.unauthorized).toBe('unauthorized');
  });
});

describe('the token travels through the manifest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'crux-cxp-auth-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const base: CxpPeerManifest = {
    identity: serverIdentity,
    host: '127.0.0.1',
    port: 54322,
    startedAt: 1_784_742_061_000,
    manifestPath: 'x.json',
  };

  it('round-trips the token through encode and decode', () => {
    const manifest: CxpPeerManifest = { ...base, token: TOKEN_A };
    const encoded = encodeCxpPeerManifest(manifest);
    expect(encoded['token']).toBe(TOKEN_A);
    expect(decodeCxpPeerManifest(encoded, 'x.json')).toEqual(manifest);
  });

  it('a pre-1.2 manifest without a token decodes with none, and encodes without the field', () => {
    const decoded = decodeCxpPeerManifest(encodeCxpPeerManifest(base), 'x.json');
    expect(decoded.token).toBeUndefined();
    expect(Object.keys(encodeCxpPeerManifest(decoded))).not.toContain('token');
    expect(
      decodeCxpPeerManifest({ ...encodeCxpPeerManifest(base), token: '' }, 'x.json').token,
      'an empty token is no token',
    ).toBeUndefined();
  });

  it('CxpManifestWriter publishes its token under "token"', async () => {
    const writer = new CxpManifestWriter({
      manifestDirectory: dir,
      heartbeatIntervalMs: null,
      authToken: TOKEN_A,
    });
    cleanups.push(() => writer.remove());
    await writer.write({ identity: serverIdentity, host: '127.0.0.1', port: 65200 });
    const path = join(dir, `${serverIdentity.peerId}.json`);
    const json: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect(isJsonObject(json) ? json['token'] : undefined).toBe(TOKEN_A);
    expect(isJsonObject(json) ? decodeCxpPeerManifest(json, path).token : undefined).toBe(TOKEN_A);
  });

  it('the writer defaults to the same token the server requires by default', () => {
    const writer = new CxpManifestWriter({ manifestDirectory: dir, heartbeatIntervalMs: null });
    const server = new LocalCxpServer({ selfIdentity: serverIdentity });
    expect(writer.authToken).toMatch(TOKEN_SHAPE);
    expect(server.authToken).toBe(writer.authToken);
  });

  interface Peer {
    readonly server: LocalCxpServer;
    readonly connector: CxpPeerConnector;
  }

  /**
   * A full peer over the shared directory: server, writer, discovery,
   * connector. The tie-break is off so BOTH sides dial and each must present
   * the other's token — the Dart peers dial symmetrically, and this is the
   * only way to prove the TypeScript client end of it.
   */
  async function startPeer(
    identity: PeerIdentity,
    options: { readonly serverToken: string; readonly publishedToken?: string },
  ): Promise<Peer> {
    const server = new LocalCxpServer({ selfIdentity: identity, authToken: options.serverToken });
    await server.start();
    cleanups.push(() => server.stop());
    const writer = new CxpManifestWriter({
      manifestDirectory: dir,
      heartbeatIntervalMs: null,
      authToken: options.publishedToken ?? options.serverToken,
    });
    cleanups.push(() => writer.remove());
    await writer.write({ identity, host: '127.0.0.1', port: server.boundPort ?? 0 });
    const discovery = new CxpDiscovery({
      manifestDirectory: dir,
      selfPeerId: identity.peerId,
      scanIntervalMs: 50,
      livenessProbe: () => PidLiveness.indeterminate,
    });
    cleanups.push(() => {
      discovery.stop();
    });
    const connector = new CxpPeerConnector({
      selfIdentity: identity,
      discovery,
      server,
      dialTieBreak: false,
      retryIntervalMs: 50,
      maxRetryBackoffTicks: 1,
    });
    cleanups.push(() => connector.dispose());
    await discovery.start();
    connector.start();
    return { server, connector };
  }

  it('two peers with distinct tokens connect both ways with no wiring beyond the manifest', async () => {
    const a = await startPeer(serverIdentity, { serverToken: TOKEN_A });
    const b = await startPeer(dialerIdentity, { serverToken: TOKEN_B });
    await pollUntil(
      () =>
        a.connector.connectedPeers.some((p) => p.peerId === dialerIdentity.peerId) &&
        b.connector.connectedPeers.some((p) => p.peerId === serverIdentity.peerId),
      "each connector must present the other manifest's token and be accepted",
    );
    expect(a.connector.lastDialFailures.size).toBe(0);
    expect(b.connector.lastDialFailures.size).toBe(0);
  });

  it('a manifest publishing the wrong token is refused, and the refusal is a recorded dial failure', async () => {
    // A publishes a token its server does not hold — a stale manifest, or a
    // file somebody else wrote. B dials A with it and is refused.
    const a = await startPeer(serverIdentity, { serverToken: TOKEN_A, publishedToken: TOKEN_B });
    const b = await startPeer(dialerIdentity, { serverToken: TOKEN_B });
    await pollUntil(
      () => b.connector.lastDialFailures.has(serverIdentity.peerId),
      "B's dial to A must fail",
    );
    const failure = b.connector.lastDialFailures.get(serverIdentity.peerId);
    expect(isUnauthorized(failure?.error), String(failure?.error)).toBe(true);
    expect(String(failure?.error)).not.toContain(TOKEN_A);
    // A's own dial to B carries B's correct token, so the pair keeps one
    // working route — the compatibility the reference implementation chose.
    await pollUntil(
      () => a.connector.connectedPeers.some((p) => p.peerId === dialerIdentity.peerId),
      "A's dial to B is unaffected",
    );
  });

  it('a pre-1.2 manifest (no token) is refused by a strict server and accepted by a lenient one', async () => {
    const strict = await startServer({ authToken: TOKEN_A });
    const port = strict.boundPort ?? 0;
    // Hand-written, as a 1.1 peer publishes it: no token field.
    await writeJsonAtomic(join(dir, `${serverIdentity.peerId}.json`), {
      identity: {
        peer_id: serverIdentity.peerId,
        product_name: serverIdentity.productName,
        product_version: serverIdentity.productVersion,
        capabilities: [],
      },
      host: '127.0.0.1',
      port,
      started_at: Date.now(),
    });

    const discovery = new CxpDiscovery({
      manifestDirectory: dir,
      selfPeerId: dialerIdentity.peerId,
      scanIntervalMs: 50,
      livenessProbe: () => PidLiveness.indeterminate,
    });
    cleanups.push(() => {
      discovery.stop();
    });
    const connector = new CxpPeerConnector({
      selfIdentity: dialerIdentity,
      discovery,
      dialTieBreak: false,
      retryIntervalMs: 50,
      maxRetryBackoffTicks: 1,
    });
    cleanups.push(() => connector.dispose());
    await discovery.start();
    connector.start();
    await pollUntil(
      () => isUnauthorized(connector.lastDialFailures.get(serverIdentity.peerId)?.error),
      'a token-less dial must be refused by a strict server',
    );

    // The same manifest against a lenient server on the same port.
    await strict.stop();
    const lenient = new LocalCxpServer({
      selfIdentity: serverIdentity,
      port,
      requireAuthToken: false,
    });
    await lenient.start();
    cleanups.push(() => lenient.stop());
    await pollUntil(
      () => connector.connectedPeers.some((p) => p.peerId === serverIdentity.peerId),
      'a lenient server accepts the pre-1.2 dialler',
    );
  });
});

describe('sendOneShotRequest presents the manifest token', () => {
  const request = {
    kind: CxpMessageKind.requestHighlight,
    element: { kind: 'signal', path: 'top.q' },
    metadata: {},
  } as const;

  async function ackingServer(): Promise<LocalCxpServer> {
    const server = await startServer({ authToken: TOKEN_A });
    server.onInbound.listen(({ message, envelope, from }) => {
      if (message.kind !== CxpMessageKind.requestHighlight) return;
      server.sendTo(from.peerId, {
        kind: CxpMessageKind.requestHighlightAck,
        inReplyTo: envelope.messageId,
        honored: true,
      });
    });
    return server;
  }

  function manifestFor(server: LocalCxpServer, token?: string): CxpPeerManifest {
    return {
      identity: serverIdentity,
      host: '127.0.0.1',
      port: server.boundPort ?? 0,
      startedAt: Date.now(),
      manifestPath: '(test, not written to disk)',
      ...(token !== undefined ? { token } : {}),
    };
  }

  it('is acknowledged when the manifest carries the token', async () => {
    const server = await ackingServer();
    expect(
      await sendOneShotRequest(manifestFor(server, TOKEN_A), request, {
        selfIdentity: dialerIdentity,
        ackKind: CxpMessageKind.requestHighlightAck,
      }),
    ).toEqual({ kind: 'acked', honored: true });
  });

  it('is refused at the handshake when the manifest carries none', async () => {
    const server = await ackingServer();
    const result = await sendOneShotRequest(manifestFor(server), request, {
      selfIdentity: dialerIdentity,
      ackKind: CxpMessageKind.requestHighlightAck,
    });
    expect(result.kind).toBe('unreachable');
    expect(result.kind === 'unreachable' && isUnauthorized(result.error)).toBe(true);
  });
});
