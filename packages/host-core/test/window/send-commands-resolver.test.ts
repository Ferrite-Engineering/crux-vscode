/**
 * The window-level `edacrux.sendSelectionToPeer` /
 * `edacrux.highlightSelectionInPeer` commands, end to end: a product joins
 * the window with its name resolver, the elected host registers the
 * commands, a real CXP peer is connected over loopback, and what arrives on
 * that peer's socket is the resolved design path — or, with no resolver
 * contributed, the selected identifier verbatim.
 *
 * End to end on purpose. The resolver seam on `PeerSendCommands` has always
 * been unit-tested; what was missing was the *production* wiring from a
 * product's `joinCruxWindow` call to the host's commands, and only a test
 * that goes through that wiring can notice it missing again.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { asJsonObject, isJsonObject, type JsonObject } from '../../src/cxp/json';
import { decodeCxpPeerManifest } from '../../src/cxp/manifest';
import { CxpMessageKind } from '../../src/cxp/messages';
import { CRUX_SEND_COMMAND_IDS } from '../../src/editor/send';
import { NameIndex } from '../../src/names/name-index';
import { NameResolver } from '../../src/names/resolver';
import type { CruxSurface } from '../../src/surface/index';
import { CRUX_WINDOW_API_VERSION, type CruxWindowApi } from '../../src/window/api';
import type { ExtensionHandle, ExtensionRegistryView } from '../../src/window/election';
import { joinCruxWindow, type CruxWindowMembership } from '../../src/window/join';
import { CruxWindowHost } from '../../src/window/window-host';
import { RawPeer, pollUntil } from '../cxp/harness';

/**
 * What the `vscode` stand-in has to do for real here: capture command
 * handlers so a test can invoke one, and report an active text editor.
 * Everything else stays auto-mocked.
 */
const vscodeState = vi.hoisted(
  (): { commands: Map<string, () => void>; activeTextEditor: unknown } => ({
    commands: new Map(),
    activeTextEditor: undefined,
  }),
);

vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const autoWindow = actual['window'] as Record<string | symbol, unknown>;
  const autoWorkspace = actual['workspace'] as Record<string | symbol, unknown>;
  return {
    ...actual,
    commands: {
      registerCommand: (id: string, handler: () => void) => {
        vscodeState.commands.set(id, handler);
        return { dispose: () => vscodeState.commands.delete(id) };
      },
    },
    window: new Proxy(autoWindow, {
      get: (target, prop) =>
        prop === 'activeTextEditor' ? vscodeState.activeTextEditor : target[prop],
    }),
    workspace: new Proxy(autoWorkspace, {
      get: (target, prop) => (prop === 'workspaceFolders' ? undefined : target[prop]),
    }),
  };
});

let dir: string;
const cleanups: (() => unknown)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'crux-send-resolver-'));
  vscodeState.commands.clear();
  vscodeState.activeTextEditor = undefined;
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  // A leaving product triggers a manifest republish that is deliberately not
  // awaited by the host, so its temp file can still be landing here.
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function fakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extension: { packageJSON: { version: '0.4.2' } },
  } as unknown as vscode.ExtensionContext;
}

const LINTCRUX: CruxSurface = {
  id: 'lintcrux',
  extensionId: 'ferrite-engineering.lintcrux',
  capabilities: ['lintcrux.diagnostics'],
};

const NETCRUX: CruxSurface = {
  id: 'netcrux',
  extensionId: 'ferrite-engineering.netcrux',
  capabilities: [],
};

/** A stems-backed resolver that knows `result` on line 21 of `alu.sv`. */
function stemsResolver(): NameResolver {
  const index = new NameIndex('linux');
  index.replace('/ws/top.stems', [
    { path: 'top.cpu.alu.result', sourceFile: '/ws/rtl/alu.sv', lineNumber: 21, kind: 'variable' },
  ]);
  return new NameResolver({ index });
}

/** Just enough `TextEditor` for `vscodeCurrentSelectionSnapshot`. */
function editorSelecting(identifier: string, fsPath: string, line: number): unknown {
  const start = { line: line - 1, character: 8 };
  return {
    document: {
      uri: { fsPath },
      getText: () => identifier,
      getWordRangeAtPosition: () => undefined,
    },
    selection: {
      isEmpty: false,
      active: start,
      start,
      end: { line: line - 1, character: 8 + identifier.length },
    },
  };
}

/** The LintCrux host a four-extension window elects, with a real peer. */
function lintCruxHost(): CruxWindowHost {
  const host = new CruxWindowHost({
    context: fakeContext(),
    product: 'lintcrux',
    log: () => undefined,
    record: () => undefined,
    manifestDirectory: dir,
    heartbeatIntervalMs: null,
    peerStartDelayMs: 3_600_000,
    workspaceFolder: () => '/Users/dev/send-resolver',
    scanIntervalMs: 3_600_000,
    retryIntervalMs: 3_600_000,
  });
  cleanups.push(() => host.dispose());
  host.join({ surface: LINTCRUX });
  return host;
}

function hostApiFor(host: CruxWindowHost): CruxWindowApi {
  return {
    cruxWindowApiVersion: CRUX_WINDOW_API_VERSION,
    isWindowHost: () => true,
    hostExtensionId: () => 'ferrite-engineering.lintcrux',
    join: (contribution) => host.join(contribution),
    peers: () => [],
    capabilities: () => host.registry.capabilities(),
  };
}

function registryWith(host: CruxWindowHost): ExtensionRegistryView {
  const lintcrux: ExtensionHandle = {
    id: 'ferrite-engineering.lintcrux',
    isActive: true,
    exports: hostApiFor(host),
    activate: () => Promise.resolve(hostApiFor(host)),
  };
  return { getExtension: (id) => (id === lintcrux.id ? lintcrux : undefined) };
}

/** NetCrux joining the LintCrux-hosted window, the way its `activate()` does. */
async function netCruxJoins(
  host: CruxWindowHost,
  resolver: NameResolver | undefined,
): Promise<CruxWindowMembership> {
  const membership = joinCruxWindow({
    context: fakeContext(),
    product: 'netcrux',
    surface: NETCRUX,
    ...(resolver !== undefined ? { resolver } : {}),
    log: () => undefined,
    record: () => undefined,
    extensions: registryWith(host),
  });
  cleanups.push(() => membership.dispose());
  await membership.settled();
  expect(membership.api.isWindowHost()).toBe(false);
  return membership;
}

/**
 * Start the host's peer and connect a handshaken raw CXP peer to it.
 *
 * The raw peer learns the port and the token the way a real one does — from
 * the manifest the host published — so this also proves the host's server
 * requires exactly the token its manifest names.
 */
async function connectedPeer(host: CruxWindowHost): Promise<RawPeer> {
  await host.started();
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  expect(names, 'the host must have published exactly one manifest').toHaveLength(1);
  const path = join(dir, names[0] ?? '');
  const json: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isJsonObject(json)) throw new Error('the published manifest is not a JSON object');
  const manifest = decodeCxpPeerManifest(json, path);
  expect(manifest.token, 'the published manifest must carry a token').toBeDefined();
  const raw = await RawPeer.connectTo(manifest.port);
  cleanups.push(() => raw.close());
  const peerId = 'wavecrux-4242-1700000000000';
  raw.sendEnvelope({
    kind: CxpMessageKind.hello,
    from: peerId,
    payload: {
      identity: {
        peer_id: peerId,
        product_name: 'WaveCrux',
        product_version: '0.0.0-test',
        capabilities: ['notify_selection', 'request_highlight'],
      },
      ...(manifest.token !== undefined ? { token: manifest.token } : {}),
    },
  });
  await pollUntil(() => raw.ofKind(CxpMessageKind.helloAck).length > 0, 'hello_ack must arrive');
  return raw;
}

function run(commandId: string): void {
  const handler = vscodeState.commands.get(commandId);
  expect(handler, `${commandId} must be registered by the host`).toBeDefined();
  handler?.();
}

function firstPayload(raw: RawPeer, kind: string): JsonObject {
  return asJsonObject(raw.ofKind(kind)[0]?.['payload']) ?? {};
}

describe('window send commands resolve through the contributed resolver', () => {
  it('sends the stems path when a guest product contributed its resolver', async () => {
    const host = lintCruxHost();
    await netCruxJoins(host, stemsResolver());
    const raw = await connectedPeer(host);
    vscodeState.activeTextEditor = editorSelecting('result', '/ws/rtl/alu.sv', 21);

    run(CRUX_SEND_COMMAND_IDS.notifySelection);
    await pollUntil(
      () => raw.ofKind(CxpMessageKind.notifySelection).length > 0,
      'notify_selection must reach the peer',
    );
    expect(firstPayload(raw, CxpMessageKind.notifySelection)['elements']).toEqual([
      { kind: 'signal', path: 'top.cpu.alu.result' },
    ]);

    run(CRUX_SEND_COMMAND_IDS.requestHighlight);
    await pollUntil(
      () => raw.ofKind(CxpMessageKind.requestHighlight).length > 0,
      'request_highlight must reach the peer',
    );
    expect(firstPayload(raw, CxpMessageKind.requestHighlight)['element']).toEqual({
      kind: 'signal',
      path: 'top.cpu.alu.result',
    });
  });

  it('resolves through the resolver when the contributing product hosts the window itself', async () => {
    const membership = joinCruxWindow({
      context: fakeContext(),
      product: 'netcrux',
      surface: NETCRUX,
      resolver: stemsResolver(),
      log: () => undefined,
      record: () => undefined,
      extensions: { getExtension: () => undefined },
      hostOptions: { manifestDirectory: dir, heartbeatIntervalMs: null, peerStartDelayMs: 3_600_000 },
    });
    cleanups.push(() => membership.dispose());
    await membership.settled();
    const host = membership.host;
    expect(host).toBeDefined();
    if (host === undefined) return;

    await expect(
      host.elementPathResolver.resolve({
        identifier: 'result',
        fsPath: '/ws/rtl/alu.sv',
        line: 21,
        column: 9,
      }),
    ).resolves.toEqual([{ path: 'top.cpu.alu.result', description: expect.any(String) as string }]);
  });

  it('sends the identifier verbatim when no product contributed a resolver', async () => {
    const host = lintCruxHost();
    await netCruxJoins(host, undefined);
    const raw = await connectedPeer(host);
    vscodeState.activeTextEditor = editorSelecting('result', '/ws/rtl/alu.sv', 21);

    run(CRUX_SEND_COMMAND_IDS.notifySelection);
    await pollUntil(
      () => raw.ofKind(CxpMessageKind.notifySelection).length > 0,
      'notify_selection must reach the peer',
    );
    expect(firstPayload(raw, CxpMessageKind.notifySelection)['elements']).toEqual([
      { kind: 'signal', path: 'result' },
    ]);
  });

  it('sends the identifier verbatim when the contributed index does not know it', async () => {
    const host = lintCruxHost();
    await netCruxJoins(host, new NameResolver({ index: new NameIndex('linux') }));
    const raw = await connectedPeer(host);
    vscodeState.activeTextEditor = editorSelecting('top.cpu.clk', '/ws/rtl/cpu.sv', 3);

    run(CRUX_SEND_COMMAND_IDS.requestHighlight);
    await pollUntil(
      () => raw.ofKind(CxpMessageKind.requestHighlight).length > 0,
      'request_highlight must reach the peer',
    );
    expect(firstPayload(raw, CxpMessageKind.requestHighlight)['element']).toEqual({
      kind: 'signal',
      path: 'top.cpu.clk',
    });
  });

  it('stops using a resolver once its product leaves the window', async () => {
    const host = lintCruxHost();
    const membership = await netCruxJoins(host, stemsResolver());
    const selection = { identifier: 'result', fsPath: '/ws/rtl/alu.sv', line: 21, column: 9 };
    expect(await host.elementPathResolver.resolve(selection)).not.toEqual(['result']);

    await membership.dispose();
    expect(await host.elementPathResolver.resolve(selection)).toEqual(['result']);
  });

  it('ignores a contributed resolver that is not callable', async () => {
    const host = lintCruxHost();
    // An older or foreign bundle's contribution: only the shape is trusted.
    host.join({
      surface: NETCRUX,
      resolver: { resolve: 'not a function' } as unknown as NameResolver,
    });
    await expect(
      host.elementPathResolver.resolve({
        identifier: 'result',
        fsPath: '/ws/rtl/alu.sv',
        line: 21,
        column: 9,
      }),
    ).resolves.toEqual(['result']);
  });
});
