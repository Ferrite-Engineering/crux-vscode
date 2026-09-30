import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CROSS_PROBE_PEER_CONNECTED,
  CROSS_PROBE_PEER_DISCONNECTED,
  CrossProbeHost,
  crossProbePeerLabel,
  type CrossProbeSnapshot,
} from '../../src/cross-probe';
import { appendCrossProbeEvent, type CrossProbeEventRecord } from '../../src/cross-probe/events';
import { CxpPeerHost } from '../../src/cxp/peer-host';
import { createVscodePeerIdentity } from '../../src/cxp/peer-id';
import { CxpMessageKind } from '../../src/cxp/messages';
import type { PeerIdentity } from '../../src/cxp/identity';

let dir: string;
const hosts: CxpPeerHost[] = [];
const bridges: CrossProbeHost[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crux-cross-probe-'));
});

afterEach(async () => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  for (const host of hosts.splice(0)) await host.dispose();
  await rm(dir, { recursive: true, force: true });
});

/** A peer host with every timer effectively disabled — see peer-host.test.ts. */
function newPeerHost(workspace: string): CxpPeerHost {
  const host = new CxpPeerHost({
    selfIdentity: createVscodePeerIdentity({
      workspaceFolder: `/Users/dev/${workspace}`,
      productVersion: '0.1.0',
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

function newCrossProbe(peer: CxpPeerHost, now?: () => number): CrossProbeHost {
  const bridge = new CrossProbeHost({ peer, ...(now !== undefined ? { now } : {}) });
  bridges.push(bridge);
  return bridge;
}

const desktopPeer: PeerIdentity = {
  peerId: 'wavecrux-4242-1700000000000',
  productName: 'WaveCrux',
  productVersion: '0.9.0',
  capabilities: ['request_highlight'],
};

describe('crossProbePeerLabel', () => {
  it('prefers the product name and falls back to the peer id', () => {
    expect(crossProbePeerLabel(desktopPeer)).toBe('WaveCrux');
    expect(crossProbePeerLabel({ ...desktopPeer, productName: '' })).toBe(
      'wavecrux-4242-1700000000000',
    );
  });
});

describe('appendCrossProbeEvent', () => {
  const event = (n: number): CrossProbeEventRecord => ({
    messageKind: CxpMessageKind.notifySelection,
    direction: 'outbound',
    peerLabel: 'WaveCrux',
    timestampMs: n,
  });

  it('keeps the newest `limit` entries, oldest-first', () => {
    let log: readonly CrossProbeEventRecord[] = [];
    for (let n = 0; n < 10; n++) log = appendCrossProbeEvent(log, event(n), 3);
    expect(log.map((e) => e.timestampMs)).toEqual([7, 8, 9]);
  });
});

describe('CrossProbeHost', () => {
  it('reports offline with nothing in it before the peer starts', () => {
    const bridge = newCrossProbe(newPeerHost('cold'));
    expect(bridge.snapshot).toEqual({
      online: false,
      peers: [],
      unreachable: [],
      events: [],
    });
  });

  it('reports online once the peer is listening', async () => {
    const peer = newPeerHost('online');
    const bridge = newCrossProbe(peer);
    await peer.start();
    expect(bridge.snapshot.online).toBe(true);
  });

  it('logs a peer connecting and disconnecting, and pushes each change', () => {
    const peer = newPeerHost('presence');
    const bridge = newCrossProbe(peer, () => 1_700_000_000_000);
    const pushes: CrossProbeSnapshot[] = [];
    bridge.onDidChange.listen((snapshot) => pushes.push(snapshot));

    peer.server.onPresence.emit({ peer: desktopPeer, connected: true });
    peer.server.onPresence.emit({ peer: desktopPeer, connected: false });

    expect(bridge.snapshot.events).toEqual([
      {
        messageKind: CROSS_PROBE_PEER_CONNECTED,
        direction: 'inbound',
        peerLabel: 'WaveCrux',
        timestampMs: 1_700_000_000_000,
      },
      {
        messageKind: CROSS_PROBE_PEER_DISCONNECTED,
        direction: 'inbound',
        peerLabel: 'WaveCrux',
        timestampMs: 1_700_000_000_000,
      },
    ]);
    // Push on change, never polled: one snapshot per event, no timer.
    expect(pushes).toHaveLength(2);
  });

  it('logs an inbound selection with the element path as its summary', () => {
    const peer = newPeerHost('inbound');
    const bridge = newCrossProbe(peer, () => 7);
    peer.server.onInbound.emit({
      envelope: {
        cxpVersion: '1.1',
        messageId: 'm1',
        from: desktopPeer.peerId,
        kind: CxpMessageKind.notifySelection,
        payload: {},
      },
      message: {
        kind: CxpMessageKind.notifySelection,
        elements: [{ kind: 'signal', path: 'top.clk' }],
        metadata: {},
      },
      from: desktopPeer,
    });
    expect(bridge.snapshot.events).toEqual([
      {
        messageKind: CxpMessageKind.notifySelection,
        direction: 'inbound',
        peerLabel: 'WaveCrux',
        timestampMs: 7,
        summary: 'top.clk',
      },
    ]);
  });

  it('does not log protocol bookkeeping', () => {
    const peer = newPeerHost('bookkeeping');
    const bridge = newCrossProbe(peer);
    for (const message of [
      { kind: CxpMessageKind.subscribe, subscriptions: [] } as const,
      { kind: CxpMessageKind.helloAck, identity: desktopPeer, inReplyTo: 'm0' } as const,
    ]) {
      peer.server.onInbound.emit({
        envelope: {
          cxpVersion: '1.1',
          messageId: 'm2',
          from: desktopPeer.peerId,
          kind: message.kind,
          payload: {},
        },
        message,
        from: desktopPeer,
      });
    }
    expect(bridge.snapshot.events).toEqual([]);
  });

  it('refuses a send to a peer it does not know, and says so', async () => {
    const peer = newPeerHost('unknown-peer');
    const bridge = newCrossProbe(peer);
    await peer.start();

    const outcome = bridge.sendSelectionToPeer('nobody-1-2', {
      elements: [{ kind: 'signal', path: 'top.clk' }],
      metadata: {},
    });
    expect(outcome.delivered).toBe(false);
    expect(outcome.peerLabel).toBe('nobody-1-2');
    expect(outcome.reason).toBe('That app is no longer running.');
    // A refusal is never logged as a cross-probe: nothing crossed.
    expect(bridge.snapshot.events).toEqual([]);
  });

  it('refuses a send before the peer is running', () => {
    const bridge = newCrossProbe(newPeerHost('not-running'));
    const outcome = bridge.sendSelectionToPeer(desktopPeer.peerId, {
      elements: [],
      metadata: {},
    });
    expect(outcome).toEqual({
      delivered: false,
      peerLabel: desktopPeer.peerId,
      reason: 'Cross-probing is unavailable in this window.',
    });
  });

  it('sends to a linked peer, logs it outbound, and pushes', async () => {
    const peer = newPeerHost('send');
    const bridge = newCrossProbe(peer, () => 99);
    await peer.start();

    const sent: unknown[] = [];
    peer.server.attachLinkedPeer(desktopPeer, (message) => sent.push(message));
    const pushes: CrossProbeSnapshot[] = [];
    bridge.onDidChange.listen((snapshot) => pushes.push(snapshot));

    const outcome = bridge.sendSelectionToPeer(desktopPeer.peerId, {
      elements: [{ kind: 'signal', path: 'top.data' }],
      displayName: 'top.data',
      metadata: { 'crux.design_id': 'abcdef0123456789' },
    });

    expect(outcome).toEqual({ delivered: true, peerLabel: 'WaveCrux' });
    expect(sent).toEqual([
      {
        kind: CxpMessageKind.notifySelection,
        elements: [{ kind: 'signal', path: 'top.data' }],
        displayName: 'top.data',
        metadata: { 'crux.design_id': 'abcdef0123456789' },
      },
    ]);
    // Attaching the link is itself a presence transition, so the log reads
    // as a user would expect it to: the peer arrived, then we sent to it.
    expect(bridge.snapshot.events).toEqual([
      {
        messageKind: CROSS_PROBE_PEER_CONNECTED,
        direction: 'inbound',
        peerLabel: 'WaveCrux',
        timestampMs: 99,
      },
      {
        messageKind: CxpMessageKind.notifySelection,
        direction: 'outbound',
        peerLabel: 'WaveCrux',
        timestampMs: 99,
        summary: 'top.data',
      },
    ]);
    expect(pushes).toHaveLength(1);
  });

  it('lists a linked peer under `peers` and drops it when the link goes', async () => {
    const peer = newPeerHost('list');
    const bridge = newCrossProbe(peer);
    await peer.start();

    peer.server.attachLinkedPeer(desktopPeer, () => undefined);
    expect(bridge.snapshot.peers).toEqual([desktopPeer]);

    peer.server.detachLinkedPeer(desktopPeer.peerId);
    expect(bridge.snapshot.peers).toEqual([]);
  });

  it('stops listening after dispose', () => {
    const peer = newPeerHost('disposed');
    const bridge = newCrossProbe(peer);
    bridge.dispose();
    peer.server.onPresence.emit({ peer: desktopPeer, connected: true });
    expect(bridge.snapshot.events).toEqual([]);
  });
});
