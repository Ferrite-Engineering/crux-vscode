import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicTempPath, writeJsonAtomic } from '../../src/cxp/atomic-write';
import {
  CXP_DEFAULT_MANIFEST_HEARTBEAT_MS,
  CXP_DEFAULT_SCAN_INTERVAL_MS,
  CXP_DEFAULT_STALE_THRESHOLD_MS,
  CxpDiscovery,
  type CxpDiscoveryEvent,
} from '../../src/cxp/discovery';
import type { PeerIdentity } from '../../src/cxp/identity';
import { encodeCxpPeerManifest } from '../../src/cxp/manifest';
import { CxpManifestWriter } from '../../src/cxp/manifest-writer';
import { sharedCxpManifestDirectory } from '../../src/cxp/manifest-directory';
import { PidLiveness, type PidLivenessValue } from '../../src/cxp/process-liveness';

const MINUTE = 60_000;
const NOW = 1_784_742_061_000;

/** [pollUntil] with an async predicate — every check here reads a file. */
async function pollUntilAsync(
  predicate: () => Promise<boolean>,
  reason: string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`pollUntilAsync timed out after ${timeoutMs} ms: ${reason}`);
}

let dir: string;

beforeEach(async () => {
  // Sandboxed: nothing in this file may read or write the real
  // suite-shared directory, which holds the developer's live peers.
  dir = await mkdtemp(join(tmpdir(), 'crux-cxp-peers-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function identity(peerId: string, productName = 'wavecrux'): PeerIdentity {
  return { peerId, productName, productVersion: '0.1.0', capabilities: [] };
}

async function writeManifest(options: {
  readonly peerId: string;
  readonly productName?: string;
  readonly host?: string;
  readonly port?: number;
  readonly startedAt: number;
}): Promise<string> {
  const path = join(dir, `${options.peerId}.json`);
  await writeJsonAtomic(
    path,
    encodeCxpPeerManifest({
      identity: identity(options.peerId, options.productName ?? 'wavecrux'),
      host: options.host ?? '127.0.0.1',
      port: options.port ?? 51734,
      startedAt: options.startedAt,
      manifestPath: path,
    }),
  );
  return path;
}

function discoveryAt(options: {
  readonly selfPeerId?: string;
  readonly now?: number;
  readonly liveness?: (peerId: string) => PidLivenessValue;
  readonly reapThresholdMs?: number;
}): CxpDiscovery {
  return new CxpDiscovery({
    manifestDirectory: dir,
    ...(options.selfPeerId !== undefined ? { selfPeerId: options.selfPeerId } : {}),
    now: () => options.now ?? NOW,
    // Default to "we cannot tell", so a test that is about the TTL is not
    // silently decided by a pid probe against a synthetic id.
    livenessProbe: options.liveness ?? (() => PidLiveness.indeterminate),
    ...(options.reapThresholdMs !== undefined ? { reapThresholdMs: options.reapThresholdMs } : {}),
  });
}

async function entries(): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe('CxpDiscovery — manifest lifecycle', () => {
  it('creates the manifest directory when it does not exist', async () => {
    const nested = join(dir, 'crux', 'cxp', 'peers');
    const discovery = new CxpDiscovery({ manifestDirectory: nested });
    await discovery.start();
    discovery.stop();
    expect((await stat(nested)).isDirectory()).toBe(true);
  });

  it('never scans the real shared directory', () => {
    expect(dir).not.toBe(sharedCxpManifestDirectory());
  });

  it('surfaces a published peer and drops it when the manifest is removed', async () => {
    const writer = new CxpManifestWriter({
      manifestDirectory: dir,
      heartbeatIntervalMs: null,
      now: () => NOW,
    });
    await writer.write({
      identity: identity('wavecrux-4242-1784742000000'),
      host: '127.0.0.1',
      port: 51734,
    });

    const events: CxpDiscoveryEvent[] = [];
    const discovery = discoveryAt({});
    discovery.onEvent.listen((event) => events.push(event));

    await discovery.start();
    expect(discovery.peers.map((p) => p.identity.peerId)).toEqual(['wavecrux-4242-1784742000000']);
    expect(events).toHaveLength(1);
    expect(events[0]?.added).toBe(true);
    expect(events[0]?.manifest.port).toBe(51734);

    await writer.remove();
    await discovery.scanNow();
    expect(discovery.peers).toEqual([]);
    expect(events).toHaveLength(2);
    expect(events[1]?.added).toBe(false);
    discovery.stop();
  });

  it('has already updated `peers` by the time an event fires', async () => {
    // The natural listener is "something changed — re-read `peers`", and
    // for as long as the events fired *before* the view was swapped that
    // read returned the PREVIOUS scan. The consequence was invisible to
    // every other test in this file, all of which assert the events: a
    // desktop app quit, the cross-probe panel logged "Peer disconnected",
    // and the peer's row stayed in the list — because the next scan found
    // no further difference and never emitted again.
    const writer = new CxpManifestWriter({
      manifestDirectory: dir,
      heartbeatIntervalMs: null,
      now: () => NOW,
    });
    await writer.write({
      identity: identity('wavecrux-4242-1784742000000'),
      host: '127.0.0.1',
      port: 51734,
    });

    const seen: { added: boolean; peersDuring: string[] }[] = [];
    const discovery = discoveryAt({});
    discovery.onEvent.listen((event) => {
      seen.push({
        added: event.added,
        peersDuring: discovery.peers.map((p) => p.identity.peerId),
      });
    });

    await discovery.start();
    expect(seen[0]).toEqual({
      added: true,
      peersDuring: ['wavecrux-4242-1784742000000'],
    });

    await writer.remove();
    await discovery.scanNow();
    expect(seen[1]).toEqual({ added: false, peersDuring: [] });
    discovery.stop();
  });

  it('emits nothing on a rescan that changes nothing', async () => {
    await writeManifest({ peerId: 'wavecrux-4242-1', startedAt: NOW });
    const events: CxpDiscoveryEvent[] = [];
    const discovery = discoveryAt({});
    discovery.onEvent.listen((event) => events.push(event));
    await discovery.start();
    await discovery.scanNow();
    await discovery.scanNow();
    expect(events).toHaveLength(1);
    discovery.stop();
  });

  it('ignores its own manifest (§10.4) but leaves the fresh file alone', async () => {
    await writeManifest({ peerId: 'vscode-aa11bb22-4242-1', startedAt: NOW });
    await writeManifest({ peerId: 'wavecrux-9-1', startedAt: NOW });
    const discovery = discoveryAt({ selfPeerId: 'vscode-aa11bb22-4242-1' });
    await discovery.start();
    expect(discovery.peers.map((p) => p.identity.peerId)).toEqual(['wavecrux-9-1']);
    expect(await entries()).toContain('vscode-aa11bb22-4242-1.json');
    discovery.stop();
  });

  it('ignores files that are not manifests', async () => {
    await writeFile(join(dir, 'README'), 'not a manifest\n');
    await writeFile(join(dir, 'wavecrux-1-1.json'), '{ this is not json');
    await writeFile(join(dir, 'wavecrux-2-1.json'), '{"host":"127.0.0.1"}');
    await writeManifest({ peerId: 'wavecrux-3-1', startedAt: NOW });
    const discovery = discoveryAt({});
    await discovery.start();
    expect(discovery.peers.map((p) => p.identity.peerId)).toEqual(['wavecrux-3-1']);
    // Unreadable files are skipped, never deleted — they are not ours.
    expect(await entries()).toContain('README');
    discovery.stop();
  });
});

describe('CxpDiscovery — staleness pruning', () => {
  it('does not evict a live peer that missed a refresh', async () => {
    // The §10.4 requirement that makes the threshold safe: it must be
    // comfortably larger than the 30 s refresh interval, so one — or
    // several — late refreshes cannot evict a peer that is still there.
    expect(CXP_DEFAULT_STALE_THRESHOLD_MS).toBeGreaterThan(4 * CXP_DEFAULT_MANIFEST_HEARTBEAT_MS);

    const missedRefreshes = 3;
    await writeManifest({
      peerId: 'wavecrux-4242-1',
      startedAt: NOW - missedRefreshes * CXP_DEFAULT_MANIFEST_HEARTBEAT_MS,
    });
    const discovery = discoveryAt({});
    await discovery.start();
    expect(discovery.peers.map((p) => p.identity.peerId)).toEqual(['wavecrux-4242-1']);
    expect(await entries()).toEqual(['wavecrux-4242-1.json']);
    discovery.stop();
  });

  it('prunes a stale foreign peer from the view but leaves its file on disk', async () => {
    // The own/foreign asymmetry. Deleting other processes' files at the
    // five-minute mark turns a laptop sleep into a suite-wide
    // disconnect: on wake every product scans before any product
    // heartbeats.
    await writeManifest({ peerId: 'wavecrux-4242-1', startedAt: NOW - 6 * MINUTE });
    const events: CxpDiscoveryEvent[] = [];
    const discovery = discoveryAt({});
    discovery.onEvent.listen((event) => events.push(event));
    await discovery.start();
    expect(discovery.peers).toEqual([]);
    expect(events).toEqual([]);
    expect(await entries()).toEqual(['wavecrux-4242-1.json']);
    discovery.stop();
  });

  it('reaps a foreign manifest from disk only once it is past the reap threshold', async () => {
    await writeManifest({ peerId: 'wavecrux-4242-1', startedAt: NOW - 25 * 60 * MINUTE });
    const discovery = discoveryAt({});
    await discovery.start();
    expect(await entries()).toEqual([]);
    discovery.stop();
  });

  it('deletes our own stale manifest immediately', async () => {
    // A stale self manifest means our heartbeat is not running; nobody
    // else will remove it, and every peer would keep a dead row for us.
    await writeManifest({ peerId: 'vscode-aa11bb22-4242-1', startedAt: NOW - 6 * MINUTE });
    await writeManifest({ peerId: 'wavecrux-9-1', startedAt: NOW - 6 * MINUTE });
    const discovery = discoveryAt({ selfPeerId: 'vscode-aa11bb22-4242-1' });
    await discovery.start();
    expect(await entries()).toEqual(['wavecrux-9-1.json']);
    discovery.stop();
  });

  it('reaps a foreign manifest at once when its pid is provably dead', async () => {
    // Definitive, therefore safe: an asleep-but-alive peer's process
    // still exists and never reads as dead, so this cannot re-arm the
    // sleep/wake mass-delete.
    await writeManifest({ peerId: 'wavecrux-4242-1', startedAt: NOW });
    const discovery = discoveryAt({ liveness: () => PidLiveness.dead });
    await discovery.start();
    expect(discovery.peers).toEqual([]);
    expect(await entries()).toEqual([]);
    discovery.stop();
  });

  it('keeps a fresh foreign manifest whose liveness cannot be determined', async () => {
    await writeManifest({ peerId: 'wavecrux-4242-1', startedAt: NOW });
    const discovery = discoveryAt({ liveness: () => PidLiveness.indeterminate });
    await discovery.start();
    expect(discovery.peers).toHaveLength(1);
    expect(await entries()).toEqual(['wavecrux-4242-1.json']);
    discovery.stop();
  });

  it('exempts the current self manifest from the dead-pid reap', async () => {
    // If this code is running, our process is alive by construction, so a
    // `dead` reading for our own id can only be a recycled pid. Reaping
    // it would erase us from every peer's discovery mid-run.
    await writeManifest({ peerId: 'vscode-aa11bb22-4242-1', startedAt: NOW });
    const discovery = discoveryAt({
      selfPeerId: 'vscode-aa11bb22-4242-1',
      liveness: () => PidLiveness.dead,
    });
    await discovery.start();
    expect(await entries()).toEqual(['vscode-aa11bb22-4242-1.json']);
    discovery.stop();
  });

  it('still reaps a prior run’s leftover self manifest, which carries a different id', async () => {
    await writeManifest({ peerId: 'vscode-aa11bb22-1111-1', startedAt: NOW });
    const discovery = discoveryAt({
      selfPeerId: 'vscode-aa11bb22-4242-9',
      liveness: (peerId) => (peerId === 'vscode-aa11bb22-1111-1' ? PidLiveness.dead : PidLiveness.alive),
    });
    await discovery.start();
    expect(await entries()).toEqual([]);
    discovery.stop();
  });
});

describe('CxpDiscovery — orphaned temp files', () => {
  it('sweeps an orphan whose name ends in .tmp but not .json.tmp', async () => {
    // The exact defect this guards: crux_io writes
    // `<peer>.json.<micros>-<counter>.tmp`, so a sweeper matching only
    // `.json.tmp` lets every genuine orphan through.
    const orphan = atomicTempPath(join(dir, 'netcrux-4242-1.json'));
    expect(orphan.endsWith('.json.tmp')).toBe(false);
    expect(orphan.endsWith('.tmp')).toBe(true);
    await writeFile(orphan, '{}');
    const old = new Date(NOW - 10 * MINUTE);
    await utimes(orphan, old, old);

    const discovery = discoveryAt({});
    await discovery.start();
    expect(await entries()).toEqual([]);
    discovery.stop();
  });

  it('leaves a young temp file alone — it may be a write in progress', async () => {
    const inFlight = atomicTempPath(join(dir, 'netcrux-4242-1.json'));
    await writeFile(inFlight, '{}');
    const discovery = discoveryAt({ now: Date.now() });
    await discovery.start();
    expect(await entries()).toHaveLength(1);
    discovery.stop();
  });

  it('never surfaces a temp file as a peer', async () => {
    // Real clock here: the temp file's mtime is real, so the manifest's
    // `started_at` has to be too.
    const realNow = Date.now();
    const path = join(dir, 'netcrux-4242-1.json');
    await writeJsonAtomic(
      path,
      encodeCxpPeerManifest({
        identity: identity('netcrux-4242-1', 'netcrux'),
        host: '127.0.0.1',
        port: 1,
        startedAt: realNow,
        manifestPath: path,
      }),
    );
    // A doubled copy under a temp name, as a torn write would leave.
    const temp = atomicTempPath(path);
    await writeFile(temp, await readFile(path, 'utf8'));
    const discovery = discoveryAt({ now: realNow });
    await discovery.start();
    expect(discovery.peers).toHaveLength(1);
    expect(await entries()).toHaveLength(2);
    discovery.stop();
  });
});

describe('CxpDiscovery — dedupe by identity', () => {
  it('collapses two live manifests naming the same endpoint, newest winning', async () => {
    await writeManifest({ peerId: 'wavecrux-1111-1', port: 51734, startedAt: NOW - 1000 });
    await writeManifest({ peerId: 'wavecrux-2222-2', port: 51734, startedAt: NOW });
    const discovery = discoveryAt({});
    await discovery.start();
    expect(discovery.peers.map((p) => p.identity.peerId)).toEqual(['wavecrux-2222-2']);
    // Dropped from the view only: deleting the loser here would be a
    // foreign delete at the five-minute mark by another name.
    expect(await entries()).toHaveLength(2);
    discovery.stop();
  });

  it('keeps two peers of the same product on different ports', async () => {
    await writeManifest({ peerId: 'wavecrux-1111-1', port: 51734, startedAt: NOW });
    await writeManifest({ peerId: 'wavecrux-2222-2', port: 51735, startedAt: NOW });
    const discovery = discoveryAt({});
    await discovery.start();
    expect(discovery.peers).toHaveLength(2);
    discovery.stop();
  });

  it('keeps two different products on the same port', async () => {
    await writeManifest({
      peerId: 'wavecrux-1111-1',
      productName: 'wavecrux',
      port: 51734,
      startedAt: NOW,
    });
    await writeManifest({
      peerId: 'lintcrux-2222-2',
      productName: 'lintcrux',
      port: 51734,
      startedAt: NOW,
    });
    const discovery = discoveryAt({});
    await discovery.start();
    expect(discovery.peers).toHaveLength(2);
    discovery.stop();
  });
});

describe('CxpManifestWriter', () => {
  it('publishes <peer_id>.json with the manifest fields §10.2 requires, and the 1.2 token', async () => {
    const writer = new CxpManifestWriter({
      manifestDirectory: dir,
      heartbeatIntervalMs: null,
      now: () => NOW,
      authToken: 'ab'.repeat(16),
    });
    await writer.write({
      identity: {
        peerId: 'vscode-aa11bb22-4242-1',
        productName: 'VSCode',
        productVersion: '0.1.0',
        capabilities: ['request_open_source'],
      },
      host: '127.0.0.1',
      port: 51999,
    });
    const published = join(dir, 'vscode-aa11bb22-4242-1.json');
    expect(writer.manifestPath).toBe(published);
    const decoded: unknown = JSON.parse(await readFile(published, 'utf8'));
    expect(decoded).toEqual({
      identity: {
        peer_id: 'vscode-aa11bb22-4242-1',
        product_name: 'VSCode',
        product_version: '0.1.0',
        capabilities: ['request_open_source'],
      },
      host: '127.0.0.1',
      port: 51999,
      started_at: NOW,
      token: 'ab'.repeat(16),
    });
    await writer.remove();
  });

  it('leaves no temp file behind', async () => {
    const writer = new CxpManifestWriter({ manifestDirectory: dir, heartbeatIntervalMs: null });
    await writer.write({ identity: identity('vscode-a-1-1'), host: '127.0.0.1', port: 1 });
    expect(await entries()).toEqual(['vscode-a-1-1.json']);
    await writer.remove();
  });

  it('refreshes started_at on the heartbeat, so peers never prune a live peer', async () => {
    // §10.3: a peer that publishes once and never refreshes is silently
    // non-conforming — it accepts connections normally right up until
    // every peer prunes it, with no error anywhere.
    let clock = NOW;
    const writer = new CxpManifestWriter({
      manifestDirectory: dir,
      heartbeatIntervalMs: 10,
      now: () => clock,
    });
    await writer.write({ identity: identity('vscode-a-1-1'), host: '127.0.0.1', port: 1 });
    const path = join(dir, 'vscode-a-1-1.json');
    const startedAt = async (): Promise<number> => {
      const decoded = JSON.parse(await readFile(path, 'utf8')) as { started_at: number };
      return decoded.started_at;
    };
    expect(await startedAt()).toBe(NOW);
    clock = NOW + 30_000;
    let refreshed = false;
    await pollUntilAsync(async () => {
      refreshed = (await startedAt()) === NOW + 30_000;
      return refreshed;
    }, 'heartbeat rewrote started_at');
    expect(refreshed).toBe(true);
    await writer.remove();
  });

  it('deletes the manifest on clean shutdown, and is idempotent', async () => {
    const writer = new CxpManifestWriter({ manifestDirectory: dir, heartbeatIntervalMs: 10 });
    await writer.write({ identity: identity('vscode-a-1-1'), host: '127.0.0.1', port: 1 });
    await writer.remove();
    expect(await entries()).toEqual([]);
    expect(writer.manifestPath).toBeUndefined();
    await writer.remove();
    await writer.dispose();
    expect(await entries()).toEqual([]);
  });

  it('stops the heartbeat on remove, so no manifest reappears', async () => {
    const writer = new CxpManifestWriter({ manifestDirectory: dir, heartbeatIntervalMs: 5 });
    await writer.write({ identity: identity('vscode-a-1-1'), host: '127.0.0.1', port: 1 });
    await writer.dispose();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await entries()).toEqual([]);
  });

  it('waits out a write in flight, so its rename cannot republish after remove', async () => {
    const writer = new CxpManifestWriter({ manifestDirectory: dir, heartbeatIntervalMs: null });
    await writer.write({ identity: identity('vscode-a-1-1'), host: '127.0.0.1', port: 1 });
    // What the heartbeat timer does: a refresh nobody awaits.
    const inFlight = writer.refresh();
    await writer.remove();
    await inFlight;
    expect(await entries()).toEqual([]);
    expect(writer.manifestPath).toBeUndefined();
  });
});

describe('CXP discovery defaults', () => {
  it('matches the intervals §10.3/§10.4 recommend', () => {
    expect(CXP_DEFAULT_MANIFEST_HEARTBEAT_MS).toBe(30_000);
    expect(CXP_DEFAULT_SCAN_INTERVAL_MS).toBe(2_000);
    expect(CXP_DEFAULT_STALE_THRESHOLD_MS).toBe(5 * MINUTE);
  });
});
