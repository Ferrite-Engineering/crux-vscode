/**
 * [sendOneShotRequest] against a real `LocalCxpServer` on loopback.
 *
 * The same convention `connector.test.ts` and NetCrux's own send test use:
 * `LocalCxpClient` has private fields, so nothing can fake it structurally,
 * and a real socket on loopback is fast and hermetic.
 *
 * The arm worth the most attention is `error_response`. NetCrux's original
 * one-shot ignored anything that was not the expected ack, so a peer that
 * answered `unknown_kind` cost the user the full 8-second timeout before
 * anything happened — and for `request_open_artifact`, whose kind is newer
 * than some shipped builds, that is the *expected* answer from an old peer,
 * not an exotic one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LocalCxpServer } from '../../src/cxp/server';
import { CxpMessageKind } from '../../src/cxp/messages';
import { sendOneShotRequest } from '../../src/cxp/one-shot';
import type { CxpPeerManifest } from '../../src/cxp/manifest';
import type { PeerIdentity } from '../../src/cxp/identity';

const SELF: PeerIdentity = {
  peerId: 'vscode-aa11bb22-4242-1784742000000',
  productName: 'VSCode',
  productVersion: '0.1.0',
  capabilities: [],
};

const REQUEST = {
  kind: CxpMessageKind.requestOpenArtifact,
  designId: 'a1b2c3d4e5f60718',
  artifactKind: 'waveform',
  path: '/work/design/cdc_capture.vcd',
} as const;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startPeer(): Promise<{ manifest: CxpPeerManifest; server: LocalCxpServer }> {
  const identity: PeerIdentity = {
    peerId: 'wavecrux-4242-1784742061000',
    productName: 'wavecrux',
    productVersion: '0.9.0',
    capabilities: [],
  };
  const server = new LocalCxpServer({ selfIdentity: identity });
  await server.start();
  cleanups.push(() => server.stop());
  return {
    server,
    manifest: {
      identity,
      host: '127.0.0.1',
      port: server.boundPort ?? 0,
      startedAt: Date.now(),
      manifestPath: '(test, not written to disk)',
      token: server.authToken,
    },
  };
}

describe('sendOneShotRequest', () => {
  it('resolves with the ack of the expected kind', async () => {
    const { manifest, server } = await startPeer();
    server.onInbound.listen(({ message, envelope, from }) => {
      if (message.kind !== CxpMessageKind.requestOpenArtifact) return;
      server.sendTo(from.peerId, {
        kind: CxpMessageKind.requestOpenArtifactAck,
        inReplyTo: envelope.messageId,
        honored: true,
      });
    });

    expect(
      await sendOneShotRequest(manifest, REQUEST, {
        selfIdentity: SELF,
        ackKind: CxpMessageKind.requestOpenArtifactAck,
      }),
    ).toEqual({ kind: 'acked', honored: true });
  });

  it('carries a refusal reason through unchanged', async () => {
    const { manifest, server } = await startPeer();
    server.onInbound.listen(({ message, envelope, from }) => {
      if (message.kind !== CxpMessageKind.requestOpenArtifact) return;
      server.sendTo(from.peerId, {
        kind: CxpMessageKind.requestOpenArtifactAck,
        inReplyTo: envelope.messageId,
        honored: false,
        reason: 'no waveform artifact recorded for design "a1b2c3d4e5f60718"',
      });
    });

    expect(
      await sendOneShotRequest(manifest, REQUEST, {
        selfIdentity: SELF,
        ackKind: CxpMessageKind.requestOpenArtifactAck,
      }),
    ).toEqual({
      kind: 'acked',
      honored: false,
      reason: 'no waveform artifact recorded for design "a1b2c3d4e5f60718"',
    });
  });

  it('reports an error_response instead of waiting out the timeout', async () => {
    const { manifest, server } = await startPeer();
    server.onInbound.listen(({ message, envelope, from }) => {
      if (message.kind !== CxpMessageKind.requestOpenArtifact) return;
      server.sendTo(from.peerId, {
        kind: CxpMessageKind.errorResponse,
        code: 'unknown_kind',
        message: 'Unknown message kind "request_open_artifact".',
        inReplyTo: envelope.messageId,
      });
    });

    const result = await sendOneShotRequest(manifest, REQUEST, {
      selfIdentity: SELF,
      ackKind: CxpMessageKind.requestOpenArtifactAck,
      // Long enough that a result arriving promptly proves the error was
      // read rather than the timeout being hit.
      ackTimeoutMs: 30_000,
    });
    expect(result).toMatchObject({ kind: 'error-response', code: 'unknown_kind' });
  });

  it('normalises an error code it does not know, keeping the raw one for the log', async () => {
    const { manifest, server } = await startPeer();
    server.onInbound.listen(({ message, envelope, from }) => {
      if (message.kind !== CxpMessageKind.requestOpenArtifact) return;
      server.sendTo(from.peerId, {
        kind: CxpMessageKind.errorResponse,
        code: 'quantum_flux_exhausted',
        message: 'from a peer built against a later vocabulary',
        inReplyTo: envelope.messageId,
      });
    });

    expect(
      await sendOneShotRequest(manifest, REQUEST, {
        selfIdentity: SELF,
        ackKind: CxpMessageKind.requestOpenArtifactAck,
        ackTimeoutMs: 30_000,
      }),
    ).toMatchObject({
      kind: 'error-response',
      code: 'internal_error',
      rawCode: 'quantum_flux_exhausted',
    });
  });

  it('times out when the peer accepts the socket and says nothing', async () => {
    const { manifest } = await startPeer();
    expect(
      await sendOneShotRequest(manifest, REQUEST, {
        selfIdentity: SELF,
        ackKind: CxpMessageKind.requestOpenArtifactAck,
        ackTimeoutMs: 50,
      }),
    ).toEqual({ kind: 'ack-timeout' });
  });

  it('reports unreachable when nothing is listening', async () => {
    const result = await sendOneShotRequest(
      {
        identity: {
          peerId: 'wavecrux-1-1',
          productName: 'wavecrux',
          productVersion: '0.9.0',
          capabilities: [],
        },
        host: '127.0.0.1',
        // A privileged port a test runner's user cannot bind, so the
        // connection is refused rather than accepted by something else.
        port: 1,
        startedAt: Date.now(),
        manifestPath: '(test, not written to disk)',
      },
      REQUEST,
      { selfIdentity: SELF, ackKind: CxpMessageKind.requestOpenArtifactAck, ackTimeoutMs: 200 },
    );
    expect(result.kind).toBe('unreachable');
  });

  it('sends the payload exactly as given, artifact kind included', async () => {
    const { manifest, server } = await startPeer();
    const received: unknown[] = [];
    server.onInbound.listen(({ message, envelope, from }) => {
      if (message.kind !== CxpMessageKind.requestOpenArtifact) return;
      received.push(message);
      server.sendTo(from.peerId, {
        kind: CxpMessageKind.requestOpenArtifactAck,
        inReplyTo: envelope.messageId,
        honored: true,
      });
    });

    await sendOneShotRequest(manifest, REQUEST, {
      selfIdentity: SELF,
      ackKind: CxpMessageKind.requestOpenArtifactAck,
    });
    expect(received).toEqual([REQUEST]);
  });
});
