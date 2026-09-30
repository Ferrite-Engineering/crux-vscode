/**
 * The connector dials loopback and nothing else — crux_cxp's
 * `test/conformance/dial_containment_test.dart`, case for case, plus the
 * one-shot path, which is this implementation's second dialler.
 *
 * CXP is a same-machine protocol, and the manifest that names a peer's
 * address is a file any process running as the user can write. A connector
 * that dialled whatever `host` a manifest carried would subscribe to, and
 * stream selection gossip to, any address one 200-byte JSON file named — and
 * hand that address a full-duplex link into this window's dispatch stream.
 * These cases pin that a non-loopback host is refused **before a socket
 * exists**, which is why they use a client that records `connect` calls
 * rather than a real one: a real dial to a documentation address fails
 * whether or not the rule held.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalCxpClient } from '../../src/cxp/client';
import { CxpPeerConnector, type CxpDialFailure } from '../../src/cxp/connector';
import { CxpDiscovery } from '../../src/cxp/discovery';
import { CxpDialRefusedError } from '../../src/cxp/errors';
import type { PeerIdentity } from '../../src/cxp/identity';
import type { CxpPeerManifest } from '../../src/cxp/manifest';
import { CxpManifestWriter } from '../../src/cxp/manifest-writer';
import { CxpMessageKind } from '../../src/cxp/messages';
import { sendOneShotRequest } from '../../src/cxp/one-shot';
import { PidLiveness } from '../../src/cxp/process-liveness';
import { LocalCxpServer } from '../../src/cxp/server';
import { pollUntil } from './harness';

/** A client that records every connect request and never opens a socket. */
class RecordingClient extends LocalCxpClient {
  readonly connectCalls: { readonly host: string; readonly port: number }[] = [];

  override connect(options: {
    readonly host: string;
    readonly port: number;
    readonly token?: string | undefined;
  }): Promise<void> {
    this.connectCalls.push({ host: options.host, port: options.port });
    return Promise.reject(new Error('recording client never connects'));
  }
}

const SELF: PeerIdentity = {
  peerId: 'wavecrux-dial-1',
  productName: 'wavecrux',
  productVersion: '0.0.0',
  capabilities: [],
};

let dir: string;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crux-cxp-dial-'));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

async function publish(identity: PeerIdentity, host: string, port: number): Promise<void> {
  const writer = new CxpManifestWriter({ manifestDirectory: dir, heartbeatIntervalMs: null });
  cleanups.push(() => writer.remove());
  await writer.write({ identity, host, port });
}

function newDiscovery(): CxpDiscovery {
  const discovery = new CxpDiscovery({
    manifestDirectory: dir,
    selfPeerId: SELF.peerId,
    scanIntervalMs: 50,
    // Synthetic pids: never let a real probe decide these tests.
    livenessProbe: () => PidLiveness.indeterminate,
  });
  cleanups.push(() => {
    discovery.stop();
  });
  return discovery;
}

describe('CxpPeerConnector — loopback only', () => {
  it('a manifest naming a non-loopback host is refused without a socket, and the refusal is reported as a dial failure', async () => {
    const remote: PeerIdentity = {
      peerId: 'evil-dial-1',
      productName: 'evil',
      productVersion: '0.0.0',
      capabilities: [],
    };
    await publish(remote, '192.0.2.1', 54322);

    const discovery = newDiscovery();
    const client = new RecordingClient({ selfIdentity: SELF });
    const connector = new CxpPeerConnector({
      selfIdentity: SELF,
      discovery,
      // Symmetric, as crux_cxp dials: the tie-break must not be what spares
      // the manifest here.
      dialTieBreak: false,
      retryIntervalMs: 30,
      clientFactory: () => client,
    });
    cleanups.push(() => connector.dispose());
    const failures: CxpDialFailure[] = [];
    connector.onDialFailure.listen((failure) => failures.push(failure));
    await discovery.start();
    connector.start();

    await pollUntil(
      () => failures.length >= 2,
      'the refusal must be reported, and re-reported on retry',
    );
    expect(
      discovery.peers.map((m) => m.identity.peerId),
      'the manifest itself is still visible to discovery',
    ).toEqual([remote.peerId]);
    expect(client.connectCalls, 'no socket may be opened towards a non-loopback host').toEqual([]);
    expect(connector.dialAttempts, 'a refused dial is not an attempt').toBe(0);

    const failure = connector.lastDialFailures.get(remote.peerId);
    expect(failure?.host).toBe('192.0.2.1');
    expect(failure?.error).toBeInstanceOf(CxpDialRefusedError);
    const refusal = failure?.error as CxpDialRefusedError;
    expect(refusal.reason).toContain('non-loopback');
    expect(refusal.host).toBe('192.0.2.1');
    expect(refusal.port).toBe(54322);
    expect(
      failures.at(-1)?.nextRetryAfterTicks,
      'a refused peer backs off like any other failure',
    ).toBeGreaterThan(failures[0]?.nextRetryAfterTicks ?? Number.POSITIVE_INFINITY);
  });

  it('a loopback manifest is still dialled', async () => {
    const remote: PeerIdentity = {
      peerId: 'netcrux-dial-2',
      productName: 'netcrux',
      productVersion: '0.0.0',
      capabilities: [],
    };
    const server = new LocalCxpServer({ selfIdentity: remote });
    await server.start();
    cleanups.push(() => server.stop());
    await publish(remote, '127.0.0.1', server.boundPort ?? 0);

    const discovery = newDiscovery();
    const connector = new CxpPeerConnector({
      selfIdentity: SELF,
      discovery,
      dialTieBreak: false,
      retryIntervalMs: 50,
    });
    cleanups.push(() => connector.dispose());
    await discovery.start();
    connector.start();

    await pollUntil(
      () => connector.connectedPeers.some((p) => p.peerId === remote.peerId),
      'loopback must still connect',
    );
    expect(connector.dialAttempts).toBeGreaterThanOrEqual(1);
  });
});

describe('sendOneShotRequest — loopback only', () => {
  const request = {
    kind: CxpMessageKind.requestOpenArtifact,
    designId: 'd',
    artifactKind: 'waveform',
    path: '/work/design/cdc_capture.vcd',
  } as const;

  it('refuses a non-loopback manifest before a socket exists', async () => {
    // The one-shot is fed by `discoverDesktopPeer`, which reads the same
    // user-writable directory: a planted "netcrux" manifest would otherwise
    // receive the request — file path included — at any address it named.
    const client = new RecordingClient({ selfIdentity: SELF });
    const manifest: CxpPeerManifest = {
      identity: {
        peerId: 'netcrux-1-1',
        productName: 'NetCrux',
        productVersion: '1.0.0',
        capabilities: [],
      },
      host: '192.0.2.1',
      port: 54324,
      startedAt: Date.now(),
      manifestPath: '(test, not written to disk)',
    };
    const result = await sendOneShotRequest(manifest, request, {
      selfIdentity: SELF,
      ackKind: CxpMessageKind.requestOpenArtifactAck,
      clientFactory: () => client,
    });
    expect(result.kind).toBe('unreachable');
    expect(result.kind === 'unreachable' ? result.error : undefined).toBeInstanceOf(
      CxpDialRefusedError,
    );
    expect(client.connectCalls).toEqual([]);
  });
});
