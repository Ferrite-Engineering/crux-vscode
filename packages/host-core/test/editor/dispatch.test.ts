import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CxpMessageKind } from '../../src/cxp/messages';
import { CxpEditorDispatcher } from '../../src/editor/dispatch';
import { SOURCE_ELEMENT_KIND } from '../../src/editor/notify-selection';
import { SurfaceRegistry } from '../../src/surface/index';
import { FakeEditorHost, FakeTransport, inbound, peer } from './harness';

const FROM = peer('wavecrux-4242-1784742061000', 'WaveCrux');
const FILE_LINES = ['module alu;', '  wire [7:0] result;', 'endmodule'] as const;

let root: string;
let workspace: string;
let sourcePath: string;
let editor: FakeEditorHost;
let transport: FakeTransport;
let registry: SurfaceRegistry;
let dispatcher: CxpEditorDispatcher;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'crux-dispatch-')));
  workspace = join(root, 'workspace');
  await mkdir(join(workspace, 'rtl'), { recursive: true });
  sourcePath = join(workspace, 'rtl', 'alu.sv');
  await writeFile(sourcePath, `${FILE_LINES.join('\n')}\n`);
  editor = new FakeEditorHost([workspace], new Map([[sourcePath, FILE_LINES]]));
  transport = new FakeTransport();
  registry = new SurfaceRegistry();
  dispatcher = new CxpEditorDispatcher({ transport, registry, editor });
});

afterEach(async () => {
  dispatcher.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('CxpEditorDispatcher — acknowledgements', () => {
  it('acks a honoured request_open_source against the request message id', async () => {
    transport.onInbound.emit(
      inbound(
        { kind: CxpMessageKind.requestOpenSource, filePath: sourcePath, line: 2, column: 8 },
        FROM,
        'req-open-1',
      ),
    );
    await dispatcher.settled();
    expect(transport.sent).toEqual([
      {
        peerId: FROM.peerId,
        message: {
          kind: CxpMessageKind.requestOpenSourceAck,
          inReplyTo: 'req-open-1',
          honored: true,
        },
      },
    ]);
    expect(editor.shown[0]?.position).toEqual({ line: 1, character: 7 });
  });

  it('acks honored:false with a reason for a path outside the workspace', async () => {
    transport.onInbound.emit(
      inbound(
        { kind: CxpMessageKind.requestOpenSource, filePath: join(root, 'elsewhere.sv'), line: 1 },
        FROM,
        'req-open-2',
      ),
    );
    await dispatcher.settled();
    expect(transport.sent[0]?.message).toEqual({
      kind: CxpMessageKind.requestOpenSourceAck,
      inReplyTo: 'req-open-2',
      honored: false,
      reason: 'path is outside the open workspace',
    });
    expect(editor.shown).toEqual([]);
  });

  it('acks honored:false for request_highlight with no surface installed', async () => {
    transport.onInbound.emit(
      inbound(
        {
          kind: CxpMessageKind.requestHighlight,
          element: { kind: 'signal', path: 'top.a' },
          metadata: {},
        },
        FROM,
        'req-hl-1',
      ),
    );
    await dispatcher.settled();
    expect(transport.sent[0]?.message).toEqual({
      kind: CxpMessageKind.requestHighlightAck,
      inReplyTo: 'req-hl-1',
      honored: false,
      reason: 'no Crux surface is installed in this window',
    });
  });

  it('acks honored:true once a surface registers that handles the element', async () => {
    registry.register({
      id: 'wavecrux',
      extensionId: 'ferrite-engineering.wavecrux',
      capabilities: ['request_highlight'],
      highlight: () => ({ outcome: 'honored' }),
    });
    transport.onInbound.emit(
      inbound(
        {
          kind: CxpMessageKind.requestHighlight,
          element: { kind: 'signal', path: 'top.a' },
          metadata: {},
        },
        FROM,
        'req-hl-2',
      ),
    );
    await dispatcher.settled();
    expect(transport.sent[0]?.message).toMatchObject({ honored: true, inReplyTo: 'req-hl-2' });
  });
});

describe('CxpEditorDispatcher — notify_selection', () => {
  it('reveals without focus and sends no reply (§9.3)', async () => {
    transport.onInbound.emit(
      inbound(
        {
          kind: CxpMessageKind.notifySelection,
          elements: [{ kind: SOURCE_ELEMENT_KIND, path: sourcePath }],
          metadata: {},
        },
        FROM,
      ),
    );
    await dispatcher.settled();
    expect(transport.sent).toEqual([]);
    expect(editor.shown[0]?.options).toEqual({ preserveFocus: true, preview: true });
  });

  it('re-emits the selection on the presenter', async () => {
    const seen: string[] = [];
    dispatcher.selection.onDidReceiveSelection.listen((event) => {
      seen.push(event.elements[0]?.path ?? '');
    });
    transport.onInbound.emit(
      inbound(
        {
          kind: CxpMessageKind.notifySelection,
          elements: [{ kind: 'signal', path: 'top.cpu.alu.result' }],
          metadata: {},
        },
        FROM,
      ),
    );
    await dispatcher.settled();
    expect(seen).toEqual(['top.cpu.alu.result']);
  });
});

describe('CxpEditorDispatcher — request_open_artifact', () => {
  it('acks a honoured request against the request message id', async () => {
    const artifact = join(workspace, 'rtl', 'alu.sv');
    transport.onInbound.emit(
      inbound(
        {
          kind: CxpMessageKind.requestOpenArtifact,
          designId: 'a1b2c3d4e5f60718',
          artifactKind: 'source',
          path: artifact,
        },
        FROM,
        'req-artifact-1',
      ),
    );
    await dispatcher.settled();
    expect(transport.sent).toEqual([
      {
        peerId: FROM.peerId,
        message: {
          kind: CxpMessageKind.requestOpenArtifactAck,
          inReplyTo: 'req-artifact-1',
          honored: true,
        },
      },
    ]);
    expect(editor.artifacts.map((entry) => entry.fsPath)).toEqual([artifact]);
  });

  it('acks a refusal too, rather than leaving the sender waiting', async () => {
    // The one outcome the protocol does not define is silence, which is
    // what this kind got before the dispatcher modelled it at all.
    transport.onInbound.emit(
      inbound(
        {
          kind: CxpMessageKind.requestOpenArtifact,
          designId: 'a1b2c3d4e5f60718',
          artifactKind: 'waveform',
          path: '/etc/passwd',
        },
        FROM,
        'req-artifact-2',
      ),
    );
    await dispatcher.settled();
    expect(transport.sent[0]?.message).toMatchObject({
      kind: CxpMessageKind.requestOpenArtifactAck,
      inReplyTo: 'req-artifact-2',
      honored: false,
    });
    expect(editor.artifacts).toEqual([]);
  });

  it('resolves through the workspace store when one is wired in', async () => {
    const artifact = join(workspace, 'rtl', 'alu.sv');
    // One dispatcher per transport: the shared one from `beforeEach` would
    // otherwise answer the same frame first, with no store.
    dispatcher.dispose();
    const withStore = new CxpEditorDispatcher({
      transport,
      registry,
      editor,
      workspace: {
        resolveArtifact: () =>
          Promise.resolve({ kind: 'source', path: artifact, producer: 'netcrux', ts: 1 }),
      },
    });
    transport.onInbound.emit(
      inbound(
        {
          kind: CxpMessageKind.requestOpenArtifact,
          designId: 'a1b2c3d4e5f60718',
          artifactKind: 'source',
        },
        FROM,
        'req-artifact-3',
      ),
    );
    await withStore.settled();
    expect(transport.sent[0]?.message).toMatchObject({ honored: true });
    expect(editor.artifacts[0]?.fsPath).toBe(artifact);
    withStore.dispose();
  });
});

describe('CxpEditorDispatcher — what it leaves alone', () => {
  it('ignores kinds another module owns', async () => {
    transport.onInbound.emit(inbound({ kind: CxpMessageKind.unsubscribe }, FROM));
    transport.onInbound.emit(
      inbound(
        {
          kind: CxpMessageKind.requestOpenSourceAck,
          inReplyTo: 'x',
          honored: true,
        },
        FROM,
      ),
    );
    await dispatcher.settled();
    expect(transport.sent).toEqual([]);
  });

  it('stops handling once disposed', async () => {
    dispatcher.dispose();
    transport.onInbound.emit(
      inbound(
        { kind: CxpMessageKind.requestOpenSource, filePath: sourcePath, line: 1 },
        FROM,
        'after-dispose',
      ),
    );
    await dispatcher.settled();
    expect(transport.sent).toEqual([]);
  });

  it('is idempotent on dispose', () => {
    dispatcher.dispose();
    expect(() => dispatcher.dispose()).not.toThrow();
  });
});

describe('CxpEditorDispatcher — serialisation', () => {
  it('acks in receipt order even when handling overlaps', async () => {
    for (const [index, line] of [1, 2, 3].entries()) {
      transport.onInbound.emit(
        inbound(
          { kind: CxpMessageKind.requestOpenSource, filePath: sourcePath, line },
          FROM,
          `req-${index}`,
        ),
      );
    }
    await dispatcher.settled();
    expect(transport.sent.map((entry) => entry.message)).toMatchObject([
      { inReplyTo: 'req-0' },
      { inReplyTo: 'req-1' },
      { inReplyTo: 'req-2' },
    ]);
  });
});
