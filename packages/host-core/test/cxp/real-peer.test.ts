import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalCxpClient } from '../../src/cxp/client';
import type { PeerIdentity } from '../../src/cxp/identity';
import { isJsonObject } from '../../src/cxp/json';
import { CXP_DEFAULT_STALE_THRESHOLD_MS } from '../../src/cxp/discovery';
import { decodeCxpPeerManifest } from '../../src/cxp/manifest';
import { sharedCxpManifestDirectory } from '../../src/cxp/manifest-directory';
import { CXP_SUBSCRIBE_TO_ALL, CxpMessageKind, type CxpMessage } from '../../src/cxp/messages';
import { testIdentity } from './harness';

/**
 * Interoperability against a **live** crux_cxp peer.
 *
 * Everything else in this directory tests this implementation against
 * itself, which cannot catch the failure that matters most: two conforming
 * implementations that disagree in practice. This one dials a real Crux
 * desktop app — WaveCrux, NetCrux, LintCrux, SimCrux — if one happens to
 * be running on this machine, and checks that the handshake completes and
 * the identity decodes.
 *
 * It **skips**, never fails, when no peer is discoverable. No Crux app is
 * guaranteed to be running on a developer's machine and none is running in
 * CI, so a hard failure here would mean a permanently red pipeline. The
 * value is that it turns green the moment someone runs it beside a live
 * app.
 *
 * The directory resolver and the manifest decoder come from the discovery
 * module — this test reads the live directory directly (synchronously, at
 * collection time, so `skipIf` can be decided before the suite runs)
 * rather than starting a `CxpDiscovery`, but it must not carry a second
 * copy of the §10.1 path rule that could drift from the real one.
 */

interface LivePeer {
  readonly identity: PeerIdentity;
  readonly host: string;
  readonly port: number;
  /** The manifest's token (wire 1.2); absent for a pre-1.2 peer. */
  readonly token: string | undefined;
}

/** Peers whose manifest is fresh enough to be worth dialling. */
function discoverablePeers(): LivePeer[] {
  let directory: string;
  try {
    directory = sharedCxpManifestDirectory();
  } catch {
    return []; // No HOME/APPDATA: discovery unavailable on this host.
  }
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  // CXP §10.3: a manifest older than five minutes is stale. A peer that
  // publishes once and never refreshes is non-conforming, and dialling its
  // port would hang this test on a stale listener.
  const cutoff = Date.now() - CXP_DEFAULT_STALE_THRESHOLD_MS;
  const peers: LivePeer[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(directory, entry);
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isJsonObject(parsed)) continue;
      const manifest = decodeCxpPeerManifest(parsed, path);
      if (manifest.startedAt < cutoff) continue;
      peers.push({
        identity: manifest.identity,
        host: manifest.host,
        port: manifest.port,
        token: manifest.token,
      });
    } catch {
      // Unreadable, or a manifest we cannot decode — not a peer to dial.
    }
  }
  return peers;
}

const livePeers = discoverablePeers();
const noLivePeer = livePeers.length === 0;

describe('interoperability with a live crux_cxp peer', () => {
  it.skipIf(noLivePeer)(
    'completes the handshake and decodes the peer identity',
    async () => {
      const peer = livePeers[0];
      expect(peer).toBeDefined();
      if (peer === undefined) return;

      const client = new LocalCxpClient({
        selfIdentity: testIdentity('vscode', 1),
        connectTimeoutMs: 3000,
        handshakeTimeoutMs: 3000,
      });
      try {
        // Present the manifest's token, as the connector does: a 1.2 peer
        // refuses a hello without it, and a pre-1.2 one ignores it.
        await client.connect({ host: peer.host, port: peer.port, token: peer.token });
        expect(client.isConnected).toBe(true);
        const remote = client.remotePeer;
        expect(remote?.peerId).toBe(peer.identity.peerId);
        expect(remote?.productName).toBe(peer.identity.productName);
        expect(remote?.productVersion.length).toBeGreaterThan(0);

        // Announce the subscribe-to-all default, exactly as a connector
        // does after each handshake. A real peer accepting it silently is
        // the pass condition — a non-conforming set would draw an
        // error_response.
        const errors: string[] = [];
        const gossip: CxpMessage[] = [];
        client.onInbound.listen((inbound) => {
          if (inbound.message.kind === CxpMessageKind.errorResponse) {
            errors.push(`${inbound.message.code}: ${inbound.message.message}`);
          } else {
            gossip.push(inbound.message);
          }
        });
        client.send({ kind: CxpMessageKind.subscribe, subscriptions: [...CXP_SUBSCRIBE_TO_ALL] });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(errors, 'a live peer must accept our subscribe-to-all').toEqual([]);

        // Anything the peer happened to gossip in that window is a frame
        // produced by the reference implementation, not by us. Assert on
        // what arrived rather than requiring that something does: a live
        // app with nothing selected is idle, and that is not a failure.
        for (const message of gossip) {
          expect(
            Object.values(CxpMessageKind),
            `a live peer sent a kind we do not model: ${message.kind}`,
          ).toContain(message.kind);
          if (message.kind === CxpMessageKind.notifySelection) {
            // An empty list is legal — a retraction (§9.3) — so only the
            // shape of what is there is asserted.
            expect(Array.isArray(message.elements)).toBe(true);
            for (const element of message.elements) expect(element.path).toBeTypeOf('string');
          }
        }
        console.log(`[cxp interop] decoded ${gossip.length} frame(s) from ${peer.identity.peerId}`);
      } finally {
        await client.dispose();
      }
    },
    15_000,
  );

  it('reports what it found, so a skip is never silent', () => {
    // Not an assertion about the environment — a log line, so a developer
    // running this beside a live app can tell the interop case actually
    // ran rather than quietly skipping.
    const summary = noLivePeer
      ? 'no live crux_cxp peer discoverable; interop case skipped'
      : `live peers: ${livePeers.map((p) => p.identity.peerId).join(', ')}`;
    console.log(`[cxp interop] ${summary}`);
    expect(typeof summary).toBe('string');
  });
});
