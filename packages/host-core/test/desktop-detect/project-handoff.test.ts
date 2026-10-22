/**
 * A `project` artifact on the wire, end to end through the real one-shot
 * dial, against a real `LocalCxpServer` on loopback.
 *
 * CXP 1.3 §9.10 gives `request_open_artifact` this payload shape (its own
 * example is a `waveform`; the only difference for a project is the artifact
 * `kind`):
 *
 *   { "kind": "request_open_artifact",
 *     "payload": { "design_id": "<16 hex>", "kind": "project", "path": "<abs>" } }
 *
 * The envelope's `kind` is the message kind and the payload's `kind` is the
 * artifact kind; mixing them up is the trap §9.10 names.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cxpDesignIdForPath } from '../../src/cxp/design-id';
import type { PeerIdentity } from '../../src/cxp/identity';
import type { CxpPeerManifest } from '../../src/cxp/manifest';
import { CxpMessageKind, encodeCxpMessage } from '../../src/cxp/messages';
import { LocalCxpServer } from '../../src/cxp/server';
import { openArtifactInDesktop } from '../../src/desktop-detect/artifact-handoff';

const SELF: PeerIdentity = {
  peerId: 'vscode-abc12345-4242-1784742061000',
  productName: 'VSCode',
  productVersion: '0.1.0',
  capabilities: [],
};

const PROJECT = '/work/cpu/cpu.netcrux-project';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startNetCruxPeer(): Promise<{ manifest: CxpPeerManifest; server: LocalCxpServer }> {
  const identity: PeerIdentity = {
    peerId: 'netcrux-4242-1784742061000',
    productName: 'NetCrux',
    productVersion: '1.1.0',
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

describe('the project artifact on the wire', () => {
  it('encodes exactly the §9.10 payload shape with kind project', () => {
    expect(
      encodeCxpMessage({
        kind: CxpMessageKind.requestOpenArtifact,
        designId: '3f2a9c1d4e5b6708',
        artifactKind: 'project',
        path: PROJECT,
      }),
    ).toEqual({ design_id: '3f2a9c1d4e5b6708', kind: 'project', path: PROJECT });
  });

  it('sends request_open_artifact with the project kind and records it under project', async () => {
    const { manifest, server } = await startNetCruxPeer();
    const received: { kind: string; payload: unknown }[] = [];
    server.onInbound.listen(({ envelope, message, from }) => {
      if (message.kind !== CxpMessageKind.requestOpenArtifact) return;
      received.push({ kind: envelope.kind, payload: envelope.payload });
      server.sendTo(from.peerId, {
        kind: CxpMessageKind.requestOpenArtifactAck,
        inReplyTo: envelope.messageId,
        honored: true,
      });
    });
    const upserts: { designId: string; kind: string; path: string; producer: string }[] = [];

    const outcome = await openArtifactInDesktop({
      product: 'netcrux',
      artifactKind: 'project',
      artifactPath: PROJECT,
      selfIdentity: SELF,
      discoverPeer: () => Promise.resolve(manifest),
      workspace: {
        upsertArtifact: (upsert) => {
          upserts.push({
            designId: upsert.designId,
            kind: upsert.kind,
            path: upsert.path,
            producer: upsert.producer,
          });
          return Promise.resolve([]);
        },
      },
      openPath: () => Promise.reject(new Error('the OS must not be asked when the peer answers')),
      showMessage: () => undefined,
      log: () => undefined,
    });

    const designId = cxpDesignIdForPath(PROJECT);
    expect(outcome).toMatchObject({ kind: 'opened-in-peer', designId, path: PROJECT });
    expect(received).toEqual([
      {
        kind: 'request_open_artifact',
        payload: { design_id: designId, kind: 'project', path: PROJECT },
      },
    ]);
    // Recorded under `project`, never `source` (CXP §9.10.2).
    expect(upserts).toEqual([{ designId, kind: 'project', path: PROJECT, producer: 'vscode' }]);
  });

  it('falls back to handing the project file to the OS, which NetCrux owns, when no answer comes', async () => {
    const { manifest, server } = await startNetCruxPeer();
    server.onInbound.listen(() => undefined); // accepts, never acks
    const opened: string[] = [];

    const outcome = await openArtifactInDesktop({
      product: 'netcrux',
      artifactKind: 'project',
      artifactPath: PROJECT,
      selfIdentity: SELF,
      discoverPeer: () => Promise.resolve(manifest),
      openPath: (fsPath) => {
        opened.push(fsPath);
        return Promise.resolve();
      },
      showMessage: () => undefined,
      log: () => undefined,
      ackTimeoutMs: 150,
    });

    expect(outcome).toEqual({ kind: 'launched-externally', path: PROJECT, why: 'no-answer' });
    expect(opened).toEqual([PROJECT]);
  });
});
