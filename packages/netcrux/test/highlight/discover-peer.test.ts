import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cxp } from '@crux-vscode/host-core';
import { discoverNetCruxPeer } from '../../src/highlight/discover-peer';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'netcrux-cxp-peers-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Builds a peer id of the real `<product>-<pid>-<startedAtMillis>` shape,
 * with **this test process's own pid** — `CxpDiscovery`'s default liveness
 * probe reads the pid out of the id and would otherwise read an arbitrary
 * literal pid as dead and reap the manifest before `discoverNetCruxPeer`
 * ever saw it.
 */
function peerId(productName: string, startedAt: number): string {
  return `${productName}-${process.pid}-${startedAt}`;
}

async function writeManifest(options: {
  readonly productName: string;
  readonly startedAt: number;
  readonly port?: number;
}): Promise<string> {
  const id = peerId(options.productName, options.startedAt);
  const manifest: cxp.CxpPeerManifest = {
    identity: { peerId: id, productName: options.productName, productVersion: '0.1.0', capabilities: [] },
    host: '127.0.0.1',
    port: options.port ?? 51_000,
    startedAt: options.startedAt,
    manifestPath: join(dir, `${id}.json`),
  };
  await cxp.writeJsonAtomic(manifest.manifestPath, cxp.encodeCxpPeerManifest(manifest));
  return id;
}

describe('discoverNetCruxPeer', () => {
  it('returns undefined when the manifest directory does not exist', async () => {
    const missing = join(dir, 'does-not-exist');
    expect(await discoverNetCruxPeer({ manifestDirectory: missing })).toBeUndefined();
  });

  it('returns undefined when no manifest names netcrux', async () => {
    await writeManifest({ productName: 'wavecrux', startedAt: Date.now() });
    expect(await discoverNetCruxPeer({ manifestDirectory: dir })).toBeUndefined();
  });

  it('finds a live netcrux manifest among other products', async () => {
    await writeManifest({ productName: 'wavecrux', startedAt: Date.now() });
    const netcruxId = await writeManifest({ productName: 'netcrux', startedAt: Date.now(), port: 51_500 });

    const found = await discoverNetCruxPeer({ manifestDirectory: dir });
    expect(found?.identity.peerId).toBe(netcruxId);
    expect(found?.port).toBe(51_500);
  });

  it('picks the most recently started peer when several netcrux windows are up', async () => {
    const now = Date.now();
    await writeManifest({ productName: 'netcrux', startedAt: now - 10_000, port: 1 });
    const newer = await writeManifest({ productName: 'netcrux', startedAt: now, port: 2 });

    const found = await discoverNetCruxPeer({ manifestDirectory: dir });
    expect(found?.identity.peerId).toBe(newer);
  });
});
