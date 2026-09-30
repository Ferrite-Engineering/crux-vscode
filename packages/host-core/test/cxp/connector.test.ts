import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic } from '../../src/cxp/atomic-write';
import { cxpProcessAuthToken } from '../../src/cxp/auth-token';
import { LocalCxpClient } from '../../src/cxp/client';
import { CxpPeerConnector, type CxpDialFailure } from '../../src/cxp/connector';
import { CxpDiscovery } from '../../src/cxp/discovery';
import type { PeerIdentity } from '../../src/cxp/identity';
import { encodeCxpPeerManifest } from '../../src/cxp/manifest';
import { CxpMessageKind } from '../../src/cxp/messages';
import { PidLiveness } from '../../src/cxp/process-liveness';
import { LocalCxpServer } from '../../src/cxp/server';
import { pollUntil } from './harness';

const NOW = 1_784_742_061_000;

/**
 * Self identity for the window under test.
 *
 * `vscode-…` sorts *after* `lintcrux-…`/`fake-…` and *before* `wavecrux-…`,
 * which is what makes the tie-break tests below able to exercise both
 * directions with realistic ids.
 */
const SELF: PeerIdentity = {
  peerId: 'vscode-aa11bb22-4242-1784742000000',
  productName: 'VSCode',
  productVersion: '0.1.0',
  capabilities: ['request_open_source'],
};

let dir: string;
const cleanups: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crux-cxp-connector-'));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

function newDiscovery(): CxpDiscovery {
  const discovery = new CxpDiscovery({
    manifestDirectory: dir,
    selfPeerId: SELF.peerId,
    now: () => NOW,
    // Synthetic pids: never let a real probe decide these tests.
    livenessProbe: () => PidLiveness.indeterminate,
  });
  cleanups.push(async () => {
    discovery.stop();
    await Promise.resolve();
  });
  return discovery;
}

function newConnector(options: {
  readonly discovery: CxpDiscovery;
  readonly server?: LocalCxpServer;
  readonly dialTieBreak?: boolean;
}): CxpPeerConnector {
  const connector = new CxpPeerConnector({
    selfIdentity: SELF,
    discovery: options.discovery,
    ...(options.server !== undefined ? { server: options.server } : {}),
    ...(options.dialTieBreak !== undefined ? { dialTieBreak: options.dialTieBreak } : {}),
    retryIntervalMs: 3_600_000, // ticks are driven by hand in these tests
    clientFactory: (self) =>
      new LocalCxpClient({ selfIdentity: self, connectTimeoutMs: 2000, handshakeTimeoutMs: 2000 }),
  });
  cleanups.push(() => connector.dispose());
  return connector;
}

async function startRemote(identity: PeerIdentity): Promise<LocalCxpServer> {
  const server = new LocalCxpServer({ selfIdentity: identity });
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}

/**
 * Write a peer manifest by hand.
 *
 * It carries the process token by default because that is what every
 * `LocalCxpServer` in this file requires by default — the same agreement a
 * real peer gets from its writer and server sharing one default.
 */
async function publish(options: {
  readonly identity: PeerIdentity;
  readonly port: number;
  readonly startedAt?: number;
}): Promise<string> {
  const path = join(dir, `${options.identity.peerId}.json`);
  await writeJsonAtomic(
    path,
    encodeCxpPeerManifest({
      identity: options.identity,
      host: '127.0.0.1',
      port: options.port,
      startedAt: options.startedAt ?? NOW,
      manifestPath: path,
      token: cxpProcessAuthToken(),
    }),
  );
  return path;
}

function peerIdentity(peerId: string, productName: string): PeerIdentity {
  return { peerId, productName, productVersion: '0.1.0', capabilities: [] };
}

/** A loopback port that is free right now — bind it, read it, release it. */
async function reserveFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      resolve();
    });
  });
  const address = probe.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

describe('CxpPeerConnector — dialling', () => {
  it('dials a discovered peer and auto-subscribes before anything else', async () => {
    const remoteIdentity = peerIdentity('wavecrux-9999-1784742000000', 'wavecrux');
    const remote = await startRemote(remoteIdentity);
    await publish({ identity: remoteIdentity, port: remote.boundPort ?? 0 });

    const server = new LocalCxpServer({ selfIdentity: SELF });
    await server.start();
    cleanups.push(() => server.stop());

    const discovery = newDiscovery();
    await discovery.start();
    const connector = newConnector({ discovery, server });
    connector.start();

    await pollUntil(() => connector.connectedPeers.length === 1, 'outbound handshake completed');
    expect(connector.connectedPeers[0]?.peerId).toBe(remoteIdentity.peerId);

    // The remote must see our subscribe: without it its broadcast gossip
    // never reaches us, and the window that opens between handshake and a
    // late subscribe is exactly where a notify_selection is lost.
    await pollUntil(
      () => remote.subscriptionsOf(SELF.peerId).length > 0,
      'subscribe arrived at the remote',
    );
    expect(remote.subscriptionsOf(SELF.peerId).map((s) => s.messageKind)).toContain(
      CxpMessageKind.notifySelection,
    );

    // The link is registered as a reply route, so the remote is reachable
    // from our own server even though it never dialled us.
    expect(server.connectedPeers.map((p) => p.peerId)).toContain(remoteIdentity.peerId);
  });

  it('never dials itself', async () => {
    await publish({ identity: SELF, port: 1 });
    const discovery = newDiscovery();
    await discovery.start();
    const connector = newConnector({ discovery, dialTieBreak: false });
    connector.start();
    connector.retryNow();
    expect(connector.dialAttempts).toBe(0);
    expect(connector.shouldDial(SELF.peerId)).toBe(false);
  });

  it('drops the link when the peer manifest disappears', async () => {
    const remoteIdentity = peerIdentity('wavecrux-9999-1784742000000', 'wavecrux');
    const remote = await startRemote(remoteIdentity);
    const path = await publish({ identity: remoteIdentity, port: remote.boundPort ?? 0 });

    const discovery = newDiscovery();
    await discovery.start();
    const connector = newConnector({ discovery });
    connector.start();
    await pollUntil(() => connector.connectedPeers.length === 1, 'connected');

    await rm(path, { force: true });
    await discovery.scanNow();
    await pollUntil(() => connector.connectedPeers.length === 0, 'link dropped');
  });
});

describe('CxpPeerConnector — dial failures and backoff', () => {
  it('surfaces every failure rather than swallowing it', async () => {
    // An unreachable peer must not be indistinguishable from an absent
    // one. A manifest pointing at a port nobody listens on is exactly
    // what a peer that crashed without cleaning up leaves behind.
    const ghost = peerIdentity('wavecrux-9999-1784742000000', 'wavecrux');
    await publish({ identity: ghost, port: 1 });

    const failures: CxpDialFailure[] = [];
    const discovery = newDiscovery();
    await discovery.start();
    const connector = newConnector({ discovery });
    connector.onDialFailure.listen((failure) => failures.push(failure));
    connector.start();

    await pollUntil(() => failures.length >= 1, 'first dial failed');
    expect(failures[0]?.peerId).toBe(ghost.peerId);
    expect(failures[0]?.port).toBe(1);
    expect(failures[0]?.consecutiveFailures).toBe(1);
    expect(failures[0]?.nextRetryAfterTicks).toBe(0);
    expect(connector.lastDialFailures.get(ghost.peerId)?.error).toBeInstanceOf(Error);
  });

  it('backs off 0, 1, 3, 7 … skipped ticks so an unreachable peer is not dialled forever', async () => {
    const ghost = peerIdentity('wavecrux-9999-1784742000000', 'wavecrux');
    await publish({ identity: ghost, port: 1 });

    const failures: CxpDialFailure[] = [];
    const discovery = newDiscovery();
    await discovery.start();
    const connector = newConnector({ discovery });
    connector.onDialFailure.listen((failure) => failures.push(failure));
    connector.start();
    await pollUntil(() => failures.length >= 1, 'first dial failed');

    /**
     * Drive retry ticks until one of them actually dials, and report how
     * many were skipped first. `dialAttempts` increments synchronously
     * inside the dialling tick, which is what makes the count exact.
     */
    const skippedTicksBeforeNextDial = async (): Promise<number> => {
      const attemptsBefore = connector.dialAttempts;
      const failuresBefore = failures.length;
      let ticks = 0;
      while (connector.dialAttempts === attemptsBefore && ticks < 64) {
        connector.retryNow();
        ticks += 1;
      }
      await pollUntil(() => failures.length > failuresBefore, 'the dial failed');
      return ticks - 1;
    };

    expect(failures[0]?.nextRetryAfterTicks).toBe(0);
    expect(await skippedTicksBeforeNextDial()).toBe(0);
    expect(failures[1]?.nextRetryAfterTicks).toBe(1);
    expect(await skippedTicksBeforeNextDial()).toBe(1);
    expect(failures[2]?.nextRetryAfterTicks).toBe(3);
    expect(await skippedTicksBeforeNextDial()).toBe(3);
    expect(failures[3]?.nextRetryAfterTicks).toBe(7);
    expect(connector.dialAttempts).toBe(4);
  });

  it('caps the backoff so a permanently dead peer still gets ~1 attempt a minute', () => {
    const discovery = newDiscovery();
    const connector = newConnector({ discovery });
    // 5 s ticks × 12 ≈ one attempt a minute, rather than one every five
    // seconds forever — and, crucially, not "never again".
    expect(connector.maxRetryBackoffTicks).toBe(12);
    expect(connector.maxRetryBackoffTicks * 5).toBeLessThanOrEqual(60);
  });

  it('resets the backoff and clears the failure once the handshake succeeds', async () => {
    // The peer was still starting up when we first dialled: same
    // manifest, same address, no re-discovery in between.
    const port = await reserveFreePort();
    const remoteIdentity = peerIdentity('wavecrux-9999-1784742000000', 'wavecrux');
    await publish({ identity: remoteIdentity, port });

    const failures: CxpDialFailure[] = [];
    const discovery = newDiscovery();
    await discovery.start();
    const connector = newConnector({ discovery });
    connector.onDialFailure.listen((failure) => failures.push(failure));
    connector.start();
    await pollUntil(() => failures.length >= 1, 'first dial failed');
    expect(connector.lastDialFailures.has(remoteIdentity.peerId)).toBe(true);

    const remote = new LocalCxpServer({ selfIdentity: remoteIdentity, port });
    await remote.start();
    cleanups.push(() => remote.stop());

    connector.retryNow();
    await pollUntil(() => connector.connectedPeers.length === 1, 'connected on the retry');
    expect(connector.lastDialFailures.has(remoteIdentity.peerId)).toBe(false);
    expect(connector.dialAttempts).toBe(2);
  });
});

describe('CxpPeerConnector — §10.5 tie-break', () => {
  it('dials only peers whose peer_id sorts after ours', () => {
    const discovery = newDiscovery();
    const connector = newConnector({ discovery });
    expect(connector.dialTieBreak).toBe(true);
    expect(connector.shouldDial('wavecrux-1-1')).toBe(true); // 'v' < 'w'
    expect(connector.shouldDial('lintcrux-1-1')).toBe(false); // 'l' < 'v'
    expect(connector.shouldDial(SELF.peerId)).toBe(false);
  });

  it('declines to dial the smaller peer and records it as awaiting inbound', async () => {
    const smaller = peerIdentity('lintcrux-9999-1784742000000', 'lintcrux');
    const remote = await startRemote(smaller);
    await publish({ identity: smaller, port: remote.boundPort ?? 0 });

    const discovery = newDiscovery();
    await discovery.start();
    const connector = newConnector({ discovery });
    connector.start();
    connector.retryNow();

    expect(connector.dialAttempts).toBe(0);
    expect(connector.peersAwaitingInboundDial.map((m) => m.identity.peerId)).toEqual([
      smaller.peerId,
    ]);
  });

  it('still accepts an inbound connection from a peer it declined to dial', async () => {
    // The asymmetry that makes the tie-break safe against crux_cxp, which
    // does NOT implement it and dials symmetrically: declining to dial is
    // not declining to connect. Nothing may gate the accept loop on it —
    // and a *flipped* comparison would yield zero connections, not one.
    const smaller = peerIdentity('lintcrux-9999-1784742000000', 'lintcrux');
    const server = new LocalCxpServer({ selfIdentity: SELF });
    await server.start();
    cleanups.push(() => server.stop());
    await publish({ identity: smaller, port: 1 });

    const discovery = newDiscovery();
    await discovery.start();
    const connector = newConnector({ discovery, server });
    connector.start();
    expect(connector.dialAttempts).toBe(0);

    const dartStyleDialler = new LocalCxpClient({ selfIdentity: smaller });
    cleanups.push(() => dartStyleDialler.dispose());
    await dartStyleDialler.connect({
      host: '127.0.0.1',
      port: server.boundPort ?? 0,
      token: server.authToken,
    });
    await pollUntil(
      () => server.connectedPeers.some((p) => p.peerId === smaller.peerId),
      'inbound connection from the declined peer was accepted',
    );
  });

  it('dials symmetrically when the tie-break is turned off', async () => {
    const smaller = peerIdentity('lintcrux-9999-1784742000000', 'lintcrux');
    const remote = await startRemote(smaller);
    await publish({ identity: smaller, port: remote.boundPort ?? 0 });

    const discovery = newDiscovery();
    await discovery.start();
    const connector = newConnector({ discovery, dialTieBreak: false });
    connector.start();
    await pollUntil(() => connector.connectedPeers.length === 1, 'dialled despite sorting first');
    expect(connector.peersAwaitingInboundDial).toEqual([]);
  });
});

describe('CxpPeerConnector — goodbye', () => {
  it('never redials a peer that said goodbye', async () => {
    const remoteIdentity = peerIdentity('wavecrux-9999-1784742000000', 'wavecrux');
    const remote = await startRemote(remoteIdentity);
    await publish({ identity: remoteIdentity, port: remote.boundPort ?? 0 });

    const discovery = newDiscovery();
    await discovery.start();
    const connector = newConnector({ discovery });
    connector.start();
    await pollUntil(() => connector.connectedPeers.length === 1, 'connected');
    const attemptsWhenConnected = connector.dialAttempts;

    // The remote says goodbye, exactly as a peer shutting down cleanly
    // does. `goodbye` is consumed by the connection and never reaches
    // `onInbound`, so the connector can only learn of it from the close
    // event — which is why the client carries the flag.
    remote.sendTo(SELF.peerId, { kind: CxpMessageKind.goodbye, reason: 'shutting_down' });

    await pollUntil(() => connector.farewelledPeers.length === 1, 'goodbye observed');
    expect(connector.farewelledPeers).toEqual([remoteIdentity.peerId]);

    // The manifest is still there — a peer that says goodbye but has not
    // yet removed its file is the case that used to cause an immediate
    // redial loop.
    await discovery.scanNow();
    connector.retryNow();
    connector.retryNow();
    expect(connector.dialAttempts).toBe(attemptsWhenConnected);
    expect(connector.connectedPeers).toEqual([]);
  });

  it('forgets the goodbye once the manifest is gone, since a restart mints a new id', async () => {
    const remoteIdentity = peerIdentity('wavecrux-9999-1784742000000', 'wavecrux');
    const remote = await startRemote(remoteIdentity);
    const path = await publish({ identity: remoteIdentity, port: remote.boundPort ?? 0 });

    const discovery = newDiscovery();
    await discovery.start();
    const connector = newConnector({ discovery });
    connector.start();
    await pollUntil(() => connector.connectedPeers.length === 1, 'connected');
    remote.sendTo(SELF.peerId, { kind: CxpMessageKind.goodbye, reason: 'shutting_down' });
    await pollUntil(() => connector.farewelledPeers.length === 1, 'goodbye observed');

    await rm(path, { force: true });
    await discovery.scanNow();
    expect(connector.farewelledPeers).toEqual([]);
  });
});
