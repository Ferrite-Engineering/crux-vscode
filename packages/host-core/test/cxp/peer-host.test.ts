import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CxpPeerHost } from '../../src/cxp/peer-host';
import { createVscodePeerIdentity } from '../../src/cxp/peer-id';
import { SurfaceRegistry } from '../../src/surface/index';
import { pollUntil } from './harness';

let dir: string;
const hosts: CxpPeerHost[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crux-cxp-host-'));
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  await rm(dir, { recursive: true, force: true });
});

/**
 * A host whose peer id carries **this** process's pid.
 *
 * Not cosmetic: the host wires the production liveness probe, so a
 * synthetic pid would read as `dead` on any machine where no such process
 * exists and discovery would reap the manifest before the peer was ever
 * seen. Windows are distinguished by their workspace folder instead.
 */
function newHost(options: {
  readonly workspace: string;
  readonly capabilities?: readonly string[];
}): CxpPeerHost {
  const host = new CxpPeerHost({
    selfIdentity: createVscodePeerIdentity({
      workspaceFolder: `/Users/dev/${options.workspace}`,
      productVersion: '0.1.0',
      ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
      pid: process.pid,
      startedAt: Date.now(),
    }),
    manifestDirectory: dir,
    heartbeatIntervalMs: null,
    scanIntervalMs: 3_600_000,
    retryIntervalMs: 3_600_000,
  });
  hosts.push(host);
  return host;
}

describe('CxpPeerHost', () => {
  it('publishes a manifest naming the port it is actually listening on', async () => {
    const host = newHost({ workspace: 'publish', capabilities: ['request_open_source'] });
    await host.start();

    const entries = await readdir(dir);
    expect(entries).toEqual([`${host.selfIdentity.peerId}.json`]);
    const manifest = JSON.parse(await readFile(join(dir, entries[0] ?? ''), 'utf8')) as {
      host: string;
      port: number;
      identity: { capabilities: string[] };
    };
    expect(manifest.port).toBe(host.server.boundPort);
    expect(manifest.port).toBeGreaterThan(0);
    // §11: loopback only. A routable bind is a remote-control surface.
    expect(manifest.host).toBe('127.0.0.1');
    expect(manifest.identity.capabilities).toEqual(['request_open_source']);
  });

  it('deletes its manifest on dispose — the deactivate path', async () => {
    const host = newHost({ workspace: 'deactivate' });
    await host.start();
    expect(await readdir(dir)).toHaveLength(1);
    await host.dispose();
    expect(await readdir(dir)).toEqual([]);
    expect(host.isRunning).toBe(false);
  });

  it('is safe to dispose twice, as a deactivate racing a shutdown command would', async () => {
    const host = newHost({ workspace: 'double-dispose' });
    await host.start();
    await host.dispose();
    await host.dispose();
    expect(await readdir(dir)).toEqual([]);
  });

  it('two windows in the same directory discover and connect to each other', async () => {
    // The tie-break means exactly one of them dials; both end up
    // connected. If the comparison were flipped, *neither* would dial and
    // this would hang — which is the failure mode worth a test.
    const a = newHost({ workspace: 'window-a' });
    const b = newHost({ workspace: 'window-b' });
    await a.start();
    await b.start();
    await a.discovery.scanNow();
    await b.discovery.scanNow();

    await pollUntil(
      () =>
        a.server.connectedPeers.some((p) => p.peerId === b.selfIdentity.peerId) &&
        b.server.connectedPeers.some((p) => p.peerId === a.selfIdentity.peerId),
      'both windows see each other connected',
    );
    const diallers = [a, b].filter((host) => host.connector.dialAttempts > 0);
    expect(diallers).toHaveLength(1);
  });

  it('republishes the manifest when the installed surfaces change', async () => {
    const registry = new SurfaceRegistry();
    const host = newHost({ workspace: 'republish', capabilities: registry.capabilities() });
    await host.start();
    const path = join(dir, `${host.selfIdentity.peerId}.json`);
    const capabilities = async (): Promise<string[]> => {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as {
        identity: { capabilities: string[] };
      };
      return manifest.identity.capabilities;
    };
    expect(await capabilities()).toEqual(['request_open_artifact', 'request_open_source']);

    registry.register({
      id: 'lintcrux',
      extensionId: 'ferrite-engineering.lintcrux',
      capabilities: ['lintcrux.diagnostics'],
    });
    await host.republish({ ...host.selfIdentity, capabilities: registry.capabilities() });
    expect(await capabilities()).toEqual([
      'lintcrux.diagnostics',
      'request_open_artifact',
      'request_open_source',
    ]);
  });
});
