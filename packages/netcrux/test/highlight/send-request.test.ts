import { afterEach, describe, expect, it } from 'vitest';
import { cxp } from '@crux-vscode/host-core';
import { sendHighlightToNetCrux } from '../../src/highlight/send-request';

/**
 * Exercised against a real `LocalCxpServer` on loopback, standing in for a
 * NetCrux desktop — the same convention `test/cxp/connector.test.ts` uses
 * for `LocalCxpClient`: it has private fields, so nothing here can fake it
 * structurally, and a real socket on loopback is fast and hermetic.
 */

const SELF: cxp.PeerIdentity = {
  peerId: 'vscode-aa11bb22-4242-1784742000000',
  productName: 'VSCode',
  productVersion: '0.1.0',
  capabilities: [],
};

const ELEMENT: cxp.ElementId = { kind: 'net', path: 'top.cpu.alarm_r' };
const REQUEST: cxp.RequestHighlight = {
  kind: cxp.CxpMessageKind.requestHighlight,
  element: ELEMENT,
  metadata: {},
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface FakeNetCrux {
  readonly manifest: cxp.CxpPeerManifest;
  readonly server: cxp.LocalCxpServer;
}

/** Stands up a real `LocalCxpServer` on loopback and returns its manifest. */
async function startFakeNetCrux(): Promise<FakeNetCrux> {
  const identity: cxp.PeerIdentity = {
    peerId: 'netcrux-4242-1784742061000',
    productName: 'netcrux',
    productVersion: '0.6.0',
    capabilities: [],
  };
  const server = new cxp.LocalCxpServer({ selfIdentity: identity });
  await server.start();
  cleanups.push(() => server.stop());
  const manifest: cxp.CxpPeerManifest = {
    identity,
    host: '127.0.0.1',
    port: server.boundPort ?? 0,
    startedAt: Date.now(),
    manifestPath: '(test, not written to disk)',
    // A 1.2 desktop publishes the token its server requires (wire 1.2).
    token: server.authToken,
  };
  return { manifest, server };
}

/** Wires [server] to ack every inbound `request_highlight` with [honored]/[reason]. */
function ackEveryHighlightWith(
  server: cxp.LocalCxpServer,
  honored: boolean,
  reason?: string,
): void {
  server.onInbound.listen(({ message, envelope, from }) => {
    if (message.kind !== cxp.CxpMessageKind.requestHighlight) return;
    server.sendTo(from.peerId, {
      kind: cxp.CxpMessageKind.requestHighlightAck,
      inReplyTo: envelope.messageId,
      honored,
      ...(reason !== undefined ? { reason } : {}),
    });
  });
}

describe('sendHighlightToNetCrux', () => {
  it('resolves "acked" with honored: true', async () => {
    const { manifest, server } = await startFakeNetCrux();
    ackEveryHighlightWith(server, true);

    const result = await sendHighlightToNetCrux(manifest, REQUEST, { selfIdentity: SELF });

    expect(result).toEqual({ kind: 'acked', honored: true });
  });

  it('carries a decline reason through from the peer', async () => {
    const { manifest, server } = await startFakeNetCrux();
    ackEveryHighlightWith(server, false, 'Element top.cpu.alarm_r not found in current design');

    const result = await sendHighlightToNetCrux(manifest, REQUEST, { selfIdentity: SELF });

    expect(result).toEqual({
      kind: 'acked',
      honored: false,
      reason: 'Element top.cpu.alarm_r not found in current design',
    });
  });

  it('resolves "ack-timeout" when the peer never answers', async () => {
    const { manifest } = await startFakeNetCrux();
    // No `ackEveryHighlightWith` wired — the fake peer accepts the socket
    // and completes the handshake, then simply never replies.

    const result = await sendHighlightToNetCrux(manifest, REQUEST, {
      selfIdentity: SELF,
      ackTimeoutMs: 50,
    });

    expect(result).toEqual({ kind: 'ack-timeout' });
  });

  it('resolves "unreachable" when nothing is listening on the manifest port', async () => {
    const deadManifest: cxp.CxpPeerManifest = {
      identity: { peerId: 'netcrux-1-1', productName: 'netcrux', productVersion: '0.6.0', capabilities: [] },
      host: '127.0.0.1',
      // Port 1 is a privileged port practically guaranteed to refuse a
      // loopback connection under a test runner's non-root user.
      port: 1,
      startedAt: Date.now(),
      manifestPath: '(test, not written to disk)',
    };

    const result = await sendHighlightToNetCrux(deadManifest, REQUEST, {
      selfIdentity: SELF,
      ackTimeoutMs: 200,
    });

    expect(result.kind).toBe('unreachable');
  });

  it('sends the element kind and path exactly as given', async () => {
    const { manifest, server } = await startFakeNetCrux();
    const received: cxp.RequestHighlight[] = [];
    server.onInbound.listen(({ message, envelope, from }) => {
      if (message.kind !== cxp.CxpMessageKind.requestHighlight) return;
      received.push(message);
      server.sendTo(from.peerId, {
        kind: cxp.CxpMessageKind.requestHighlightAck,
        inReplyTo: envelope.messageId,
        honored: true,
      });
    });

    await sendHighlightToNetCrux(manifest, REQUEST, { selfIdentity: SELF });

    expect(received).toEqual([REQUEST]);
  });
});
