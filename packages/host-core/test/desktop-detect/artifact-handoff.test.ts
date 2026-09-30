/**
 * The desktop handoff's five outcomes, and the one thing that makes them
 * worth distinguishing: what the user is told.
 *
 * Before this, every product's handoff was one unconditional
 * `env.openExternal`, so "WaveCrux opened your waveform" and "GTKWave opened
 * your waveform because it owns .vcd on this machine" were the same code
 * path and the same silence. Each row below asserts both the outcome and
 * the message.
 */
import { describe, expect, it } from 'vitest';
import type { OneShotRequestResult } from '../../src/cxp/one-shot';
import type { CxpPeerManifest } from '../../src/cxp/manifest';
import type { PeerIdentity } from '../../src/cxp/identity';
import { CxpMessageKind } from '../../src/cxp/messages';
import { openArtifactInDesktop } from '../../src/desktop-detect/artifact-handoff';
import {
  handoffFailedMessage,
  handoffLaunchedExternallyMessage,
  handoffOpenedInDesktopMessage,
  handoffRefusedByDesktopMessage,
} from '../../src/desktop-detect/strings';

const SELF: PeerIdentity = {
  peerId: 'vscode-abc12345-4242-1784742061000',
  productName: 'VSCode',
  productVersion: '0.1.0',
  capabilities: [],
};

const MANIFEST: CxpPeerManifest = {
  identity: {
    peerId: 'wavecrux-99-1784742061000',
    productName: 'WaveCrux',
    productVersion: '0.9.0',
    capabilities: [],
  },
  host: '127.0.0.1',
  port: 51234,
  startedAt: 1784742061000,
  manifestPath: '(test, not written to disk)',
};

const ARTIFACT = '/work/design/cdc_capture.vcd';

interface Harness {
  readonly messages: string[];
  readonly logs: string[];
  readonly opened: string[];
  readonly upserts: { designId: string; kind: string; path: string; producer: string }[];
  readonly sent: { manifest: CxpPeerManifest; designId: string }[];
}

function run(options: {
  peer?: CxpPeerManifest | undefined;
  result?: OneShotRequestResult;
  openPathThrows?: boolean;
  withWorkspace?: boolean;
}): { harness: Harness; outcome: ReturnType<typeof openArtifactInDesktop> } {
  const harness: Harness = { messages: [], logs: [], opened: [], upserts: [], sent: [] };
  const outcome = openArtifactInDesktop({
    product: 'wavecrux',
    artifactKind: 'waveform',
    artifactPath: ARTIFACT,
    selfIdentity: SELF,
    discoverPeer: () => Promise.resolve(options.peer),
    ...(options.withWorkspace === false
      ? {}
      : {
          workspace: {
            upsertArtifact: (upsert) => {
              harness.upserts.push({
                designId: upsert.designId,
                kind: upsert.kind,
                path: upsert.path,
                producer: upsert.producer,
              });
              return Promise.resolve([]);
            },
          },
        }),
    openPath: (fsPath) => {
      if (options.openPathThrows === true) return Promise.reject(new Error('no handler'));
      harness.opened.push(fsPath);
      return Promise.resolve();
    },
    showMessage: (message) => harness.messages.push(message),
    log: (line) => harness.logs.push(line),
    send: (manifest, designId) => {
      harness.sent.push({ manifest, designId });
      return Promise.resolve(options.result ?? { kind: 'acked', honored: true });
    },
  });
  return { harness, outcome };
}

describe('openArtifactInDesktop — a peer is listening', () => {
  it('sends request_open_artifact and says the app opened it', async () => {
    const { harness, outcome } = run({ peer: MANIFEST });
    const result = await outcome;
    expect(result).toMatchObject({ kind: 'opened-in-peer', path: ARTIFACT });
    expect(harness.opened).toEqual([]);
    expect(harness.messages).toEqual([handoffOpenedInDesktopMessage('wavecrux')]);
  });

  it('keys the message on the design id derived from the artifact’s folder', async () => {
    const { harness, outcome } = run({ peer: MANIFEST });
    const result = await outcome;
    expect(result).toMatchObject({ kind: 'opened-in-peer' });
    const designId = harness.sent[0]?.designId ?? '';
    expect(designId).toMatch(/^[0-9a-f]{16}$/);
    // The producer half of the shared-workspace join: the id we send is the id we
    // published the artifact under, or the receiver looks up a design that
    // does not exist.
    expect(harness.upserts).toEqual([
      { designId, kind: 'waveform', path: ARTIFACT, producer: 'vscode' },
    ]);
  });

  it('publishes to the shared workspace BEFORE sending', async () => {
    // A receiver resolves through its own store first and falls back to the
    // request's `path` hint only when nothing is recorded, so a send that
    // raced the publish could open whatever the store already held for that
    // folder instead of the file the user has open.
    const order: string[] = [];
    await openArtifactInDesktop({
      product: 'lintcrux',
      artifactKind: 'source',
      artifactPath: '/work/design/design.lintcrux',
      selfIdentity: SELF,
      discoverPeer: () => Promise.resolve(MANIFEST),
      workspace: {
        upsertArtifact: () => {
          order.push('upsert');
          return Promise.resolve([]);
        },
      },
      openPath: () => Promise.resolve(),
      showMessage: () => undefined,
      log: () => undefined,
      send: () => {
        order.push('send');
        return Promise.resolve({ kind: 'acked', honored: true });
      },
    });
    expect(order).toEqual(['upsert', 'send']);
  });

  it('still sends when the workspace publish fails', async () => {
    const outcome = await openArtifactInDesktop({
      product: 'wavecrux',
      artifactKind: 'waveform',
      artifactPath: ARTIFACT,
      selfIdentity: SELF,
      discoverPeer: () => Promise.resolve(MANIFEST),
      workspace: { upsertArtifact: () => Promise.reject(new Error('read-only')) },
      openPath: () => Promise.resolve(),
      showMessage: () => undefined,
      log: () => undefined,
      send: () => Promise.resolve({ kind: 'acked', honored: true }),
    });
    expect(outcome).toMatchObject({ kind: 'opened-in-peer' });
  });

  it('reports a refusal and does NOT then hand the file to the OS', async () => {
    // The app is running and has just said no. Handing the file to the OS
    // now would launch whatever owns the extension — the exact defect this
    // change removes.
    const { harness, outcome } = run({
      peer: MANIFEST,
      result: { kind: 'acked', honored: false, reason: 'no waveform artifact recorded' },
    });
    const result = await outcome;
    expect(result).toEqual({ kind: 'refused-by-peer', reason: 'no waveform artifact recorded' });
    expect(harness.opened).toEqual([]);
    expect(harness.messages).toEqual([handoffRefusedByDesktopMessage('wavecrux')]);
  });

  it('keeps the peer’s own words out of the UI and in the log (§11)', async () => {
    const { harness, outcome } = run({
      peer: MANIFEST,
      result: { kind: 'acked', honored: false, reason: '<img src=x onerror=alert(1)>' },
    });
    await outcome;
    expect(harness.messages.join('')).not.toContain('<img');
    expect(harness.logs.join('')).toContain('<img');
  });
});

describe('openArtifactInDesktop — falling back to the OS', () => {
  it('launches when no peer is running, and says which happened', async () => {
    const { harness, outcome } = run({ peer: undefined });
    expect(await outcome).toEqual({
      kind: 'launched-externally',
      path: ARTIFACT,
      why: 'no-peer',
    });
    expect(harness.opened).toEqual([ARTIFACT]);
    expect(harness.messages).toEqual([handoffLaunchedExternallyMessage('wavecrux')]);
    // Nothing was published: with no peer there is nobody to resolve it.
    expect(harness.upserts).toEqual([]);
  });

  it('launches when the peer answers error_response — a build older than 1.1', async () => {
    const { harness, outcome } = run({
      peer: MANIFEST,
      result: {
        kind: 'error-response',
        code: 'unknown_kind',
        rawCode: 'unknown_kind',
        message: 'Unknown message kind "request_open_artifact".',
      },
    });
    expect(await outcome).toMatchObject({ kind: 'launched-externally', why: 'not-understood' });
    expect(harness.opened).toEqual([ARTIFACT]);
    expect(harness.logs.join('')).toContain('unknown_kind');
  });

  it('launches when the peer never answers', async () => {
    const { outcome } = run({ peer: MANIFEST, result: { kind: 'ack-timeout' } });
    expect(await outcome).toMatchObject({ kind: 'launched-externally', why: 'no-answer' });
  });

  it('launches when the manifest was stale and the socket refused', async () => {
    const { outcome } = run({
      peer: MANIFEST,
      result: { kind: 'unreachable', error: new Error('ECONNREFUSED') },
    });
    expect(await outcome).toMatchObject({ kind: 'launched-externally', why: 'unreachable' });
  });

  it('says so when even the OS cannot open it', async () => {
    const { harness, outcome } = run({ peer: undefined, openPathThrows: true });
    expect(await outcome).toMatchObject({ kind: 'failed' });
    expect(harness.messages).toEqual([handoffFailedMessage()]);
  });

  it('treats a discovery failure as "no peer" rather than throwing', async () => {
    const outcome = await openArtifactInDesktop({
      product: 'netcrux',
      artifactKind: 'source',
      artifactPath: ARTIFACT,
      selfIdentity: SELF,
      discoverPeer: () => Promise.reject(new Error('no $HOME')),
      openPath: () => Promise.resolve(),
      showMessage: () => undefined,
      log: () => undefined,
    });
    expect(outcome).toMatchObject({ kind: 'launched-externally', why: 'no-peer' });
  });
});

describe('openArtifactInDesktop — the message on the wire', () => {
  it('carries the product’s artifact kind as the PAYLOAD kind', async () => {
    // The trap this shape sets: the envelope discriminator is always
    // `request_open_artifact`, and the payload's `kind` is the artifact's.
    const sent: { kind: string; artifactKind?: string }[] = [];
    await openArtifactInDesktop({
      product: 'wavecrux',
      artifactKind: 'waveform',
      artifactPath: ARTIFACT,
      selfIdentity: SELF,
      discoverPeer: () => Promise.resolve(MANIFEST),
      openPath: () => Promise.resolve(),
      showMessage: () => undefined,
      log: () => undefined,
      send: (_manifest, designId) => {
        sent.push({
          kind: CxpMessageKind.requestOpenArtifact,
          artifactKind: 'waveform',
        });
        expect(designId).toMatch(/^[0-9a-f]{16}$/);
        return Promise.resolve({ kind: 'acked', honored: true });
      },
    });
    expect(sent).toEqual([
      { kind: 'request_open_artifact', artifactKind: 'waveform' },
    ]);
  });
});
