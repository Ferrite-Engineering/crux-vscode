import { describe, expect, it } from 'vitest';
import type { crossProbe, window as hostWindow } from '@crux-vscode/host-core';
import {
  CROSS_PROBE_SEND_KIND,
  CROSS_PROBE_STATE_KIND,
  WebviewCrossProbeBridge,
  crossProbeStateFrame,
  parseCrossProbeSend,
} from '../src/webview/cross-probe';
import { CXP_FRAME_TYPE, HOST_BRIDGE_PROTOCOL_VERSION, type HostBridgeFrame } from '../src/webview/open-waveform';

const peer = {
  peerId: 'wavecrux-4242-1700000000000',
  productName: 'WaveCrux',
  productVersion: '0.9.0',
  capabilities: ['request_highlight'],
};

const snapshot: crossProbe.CrossProbeSnapshot = {
  online: true,
  peers: [peer],
  unreachable: [
    {
      peerId: 'netcrux-99-1',
      host: '127.0.0.1',
      port: 54_400,
      error: new Error('connect ECONNREFUSED 127.0.0.1:54400'),
      consecutiveFailures: 3,
      nextRetryAfterTicks: 3,
    },
  ],
  events: [
    {
      messageKind: 'peer_connected',
      direction: 'inbound',
      peerLabel: 'WaveCrux',
      timestampMs: 1_700_000_000_000,
    },
    {
      messageKind: 'notify_selection',
      direction: 'outbound',
      peerLabel: 'WaveCrux',
      timestampMs: 1_700_000_000_100,
      summary: 'top.clk',
    },
  ],
};

/** The envelope the Dart `EditorHostBridge.postCrossProbeSend` posts up. */
function sendEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    cxp_version: '1.1',
    message_id: 'wc-12',
    from: 'wavecrux.webview',
    kind: CROSS_PROBE_SEND_KIND,
    payload: {
      peer_id: peer.peerId,
      selection: {
        elements: [{ kind: 'signal', path: 'top.clk' }],
        display_name: 'top.clk',
        metadata: { 'crux.design_id': 'abcdef0123456789' },
      },
    },
    ...overrides,
  };
}

describe('the wire literals', () => {
  it('are exactly what the Dart bridge decodes', () => {
    // Mirrors `kHostBridgeCrossProbeStateKind` / `kHostBridgeCrossProbeSendKind`
    // in `wavecrux/lib/services/host_bridge/host_bridge_messages.dart`.
    // Renaming one side only fails *silently* — the app answers
    // `unknown_kind` and the panel stays blind, which is the exact bug this
    // module exists to fix — so both sides name the constant and both sides
    // pin the literal.
    expect(CROSS_PROBE_STATE_KIND).toBe('crux.cross_probe_state');
    expect(CROSS_PROBE_SEND_KIND).toBe('crux.cross_probe_send');
  });
});

describe('crossProbeStateFrame', () => {
  it('rides the one `crux.cxp` channel and carries PeerIdentity JSON verbatim', () => {
    const frame = crossProbeStateFrame(snapshot);
    expect(frame.type).toBe(CXP_FRAME_TYPE);
    expect(frame.protocol).toBe(HOST_BRIDGE_PROTOCOL_VERSION);
    expect(frame.envelope.kind).toBe(CROSS_PROBE_STATE_KIND);
    const payload = frame.envelope.payload;
    expect(payload.online).toBe(true);
    // §8.1's own field names — the receiver decodes this with the same
    // `PeerIdentity.fromJson` a socket peer's identity goes through.
    expect(payload.peers).toEqual([
      {
        peer_id: peer.peerId,
        product_name: 'WaveCrux',
        product_version: '0.9.0',
        capabilities: ['request_highlight'],
      },
    ]);
  });

  it('sends a dial failure as its message, never the Error', () => {
    const payload = crossProbeStateFrame(snapshot).envelope.payload;
    expect(payload.unreachable).toEqual([
      {
        peer_id: 'netcrux-99-1',
        host: '127.0.0.1',
        port: 54_400,
        error: 'connect ECONNREFUSED 127.0.0.1:54400',
        consecutive_failures: 3,
        next_retry_after_ticks: 3,
      },
    ]);
  });

  it('omits `summary` when there is nothing to say, rather than sending an empty one', () => {
    const payload = crossProbeStateFrame(snapshot).envelope.payload;
    expect(payload.events).toEqual([
      {
        message_kind: 'peer_connected',
        direction: 'inbound',
        peer_label: 'WaveCrux',
        timestamp_ms: 1_700_000_000_000,
      },
      {
        message_kind: 'notify_selection',
        direction: 'outbound',
        peer_label: 'WaveCrux',
        timestamp_ms: 1_700_000_000_100,
        summary: 'top.clk',
      },
    ]);
  });

  it('omits `send_failure` entirely when there is no refusal to report', () => {
    const payload = crossProbeStateFrame(snapshot).envelope.payload;
    expect('send_failure' in payload).toBe(false);
  });

  it('correlates a refusal on the send it answers', () => {
    const payload = crossProbeStateFrame(snapshot, {
      inReplyTo: 'wc-12',
      peerLabel: 'WaveCrux',
      reason: 'not connected',
    }).envelope.payload;
    expect(payload.send_failure).toEqual({
      in_reply_to: 'wc-12',
      peer_label: 'WaveCrux',
      reason: 'not connected',
    });
  });
});

describe('parseCrossProbeSend', () => {
  it('decodes a send through the shared CXP decoder', () => {
    const request = parseCrossProbeSend(sendEnvelope());
    expect(request).toEqual({
      messageId: 'wc-12',
      peerId: peer.peerId,
      selection: {
        elements: [{ kind: 'signal', path: 'top.clk' }],
        displayName: 'top.clk',
        metadata: { 'crux.design_id': 'abcdef0123456789' },
      },
    });
  });

  it('accepts a cleared selection — §9.3 makes an empty array meaningful', () => {
    const request = parseCrossProbeSend(
      sendEnvelope({
        payload: { peer_id: peer.peerId, selection: { elements: [] } },
      }),
    );
    expect(request?.selection.elements).toEqual([]);
  });

  it('rejects anything that is not a well-formed send', () => {
    expect(parseCrossProbeSend(undefined)).toBeUndefined();
    expect(parseCrossProbeSend({ kind: 'notify_selection', payload: {} })).toBeUndefined();
    // No `message_id` — a refusal would have nothing to correlate on, so the
    // frame cannot be acted on honestly.
    expect(parseCrossProbeSend(sendEnvelope({ message_id: '' }))).toBeUndefined();
    expect(
      parseCrossProbeSend(sendEnvelope({ payload: { selection: { elements: [] } } })),
    ).toBeUndefined();
    // Missing `elements` is malformed, NOT a cleared selection: absence is
    // not emptiness, and forwarding it would blank a peer's view.
    expect(
      parseCrossProbeSend(sendEnvelope({ payload: { peer_id: peer.peerId, selection: {} } })),
    ).toBeUndefined();
  });
});

/** The payload of the nth posted frame. Fails loudly rather than `undefined`. */
function payloadOf(posted: readonly HostBridgeFrame[], index: number): Record<string, unknown> {
  const frame = posted[index];
  if (frame === undefined) throw new Error(`no frame at index ${index}`);
  return frame.envelope.payload;
}

/** A [hostWindow.CruxWindowCrossProbe] under the test's control. */
function windowAccess(options: {
  readonly outcome?: crossProbe.CrossProbeSendOutcome;
} = {}): {
  readonly access: hostWindow.CruxWindowCrossProbe;
  readonly sent: { peerId: string; selection: crossProbe.CrossProbeSelection }[];
  change(next: crossProbe.CrossProbeSnapshot): void;
  readonly listeners: number;
} {
  const sent: { peerId: string; selection: crossProbe.CrossProbeSelection }[] = [];
  const listeners: ((snapshot: crossProbe.CrossProbeSnapshot) => void)[] = [];
  let current = snapshot;
  const state = {
    access: {
      snapshot: () => current,
      onDidChange: (listener: (s: crossProbe.CrossProbeSnapshot) => void) => {
        listeners.push(listener);
        return {
          dispose: () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      },
      send: (peerId: string, selection: crossProbe.CrossProbeSelection) => {
        sent.push({ peerId, selection });
        return options.outcome ?? { delivered: true, peerLabel: 'WaveCrux' };
      },
    },
    sent,
    change: (next: crossProbe.CrossProbeSnapshot): void => {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
    get listeners(): number {
      return listeners.length;
    },
  };
  return state;
}

describe('WebviewCrossProbeBridge', () => {
  it('posts nothing until the panel is open, then posts the current state', () => {
    const window = windowAccess();
    const posted: HostBridgeFrame[] = [];
    const bridge = new WebviewCrossProbeBridge({
      post: (frame) => {
        posted.push(frame);
        return true;
      },
      crossProbe: window.access,
    });

    // Subscribed from construction — the window's peer starts on a settle
    // delay well after a tab can exist — but silent until it can receive.
    window.change(snapshot);
    expect(posted).toHaveLength(0);

    bridge.open();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.envelope.kind).toBe(CROSS_PROBE_STATE_KIND);
  });

  it('pushes on change and stops on close', () => {
    const window = windowAccess();
    const posted: HostBridgeFrame[] = [];
    const bridge = new WebviewCrossProbeBridge({
      post: (frame) => {
        posted.push(frame);
        return true;
      },
      crossProbe: window.access,
    });
    bridge.open();
    window.change({ ...snapshot, peers: [] });
    expect(posted).toHaveLength(2);

    bridge.close();
    expect(window.listeners).toBe(0);
    window.change(snapshot);
    expect(posted).toHaveLength(2);
  });

  it('routes a send to the window and answers with a fresh state push', () => {
    const window = windowAccess();
    const posted: HostBridgeFrame[] = [];
    const bridge = new WebviewCrossProbeBridge({
      post: (frame) => {
        posted.push(frame);
        return true;
      },
      crossProbe: window.access,
    });
    bridge.open();
    posted.length = 0;

    expect(bridge.accept(sendEnvelope())).toBe(true);
    expect(window.sent).toEqual([
      {
        peerId: peer.peerId,
        selection: {
          elements: [{ kind: 'signal', path: 'top.clk' }],
          displayName: 'top.clk',
          metadata: { 'crux.design_id': 'abcdef0123456789' },
        },
      },
    ]);
    // The push is the acknowledgement: a delivered send is already an event
    // in the snapshot, so nothing carries a failure.
    expect(posted).toHaveLength(1);
    expect('send_failure' in payloadOf(posted, 0)).toBe(false);
  });

  it('reports a refused send once, correlated, and keeps it across later pushes', () => {
    const window = windowAccess({
      outcome: { delivered: false, peerLabel: 'WaveCrux', reason: 'not connected' },
    });
    const posted: HostBridgeFrame[] = [];
    const bridge = new WebviewCrossProbeBridge({
      post: (frame) => {
        posted.push(frame);
        return true;
      },
      crossProbe: window.access,
    });
    bridge.open();
    posted.length = 0;

    bridge.accept(sendEnvelope());
    expect(payloadOf(posted, 0).send_failure).toEqual({
      in_reply_to: 'wc-12',
      peer_label: 'WaveCrux',
      reason: 'not connected',
    });

    // Sticky rather than one-shot: clearing it here would race the host's
    // own pushes. The Dart side dedupes on `in_reply_to`.
    window.change(snapshot);
    expect(payloadOf(posted, 1).send_failure).toEqual({
      in_reply_to: 'wc-12',
      peer_label: 'WaveCrux',
      reason: 'not connected',
    });
  });

  it('still answers a send when the window exposes no cross-probe access', () => {
    const posted: HostBridgeFrame[] = [];
    const bridge = new WebviewCrossProbeBridge({
      post: (frame) => {
        posted.push(frame);
        return true;
      },
      crossProbe: undefined,
    });
    bridge.open();
    posted.length = 0;

    expect(bridge.accept(sendEnvelope())).toBe(true);
    expect(payloadOf(posted, 0).send_failure).toEqual({
      in_reply_to: 'wc-12',
      peer_label: peer.peerId,
    });
  });

  it('declines an envelope that is not a send, so the router keeps looking', () => {
    const bridge = new WebviewCrossProbeBridge({ post: () => true, crossProbe: undefined });
    bridge.open();
    expect(bridge.accept({ kind: 'notify_selection', payload: { elements: [] } })).toBe(false);
  });
});
