/**
 * WaveCrux's `activate()` hands the RTL annotation's name resolver to the
 * window.
 *
 * WaveCrux is last in the host order, so in a multi-extension window the
 * `edacrux.sendSelectionToPeer` / `edacrux.highlightSelectionInPeer` commands
 * are registered by another extension. They resolve names through WaveCrux's
 * stems index only because `activate()` passes that resolver to
 * `joinCruxWindow` — the same resolver RTL annotation and the waveform
 * selection follow use, not a second index. This pins that wiring.
 * host-core's `test/window/send-commands-resolver.test.ts` covers the other
 * half: a contributed resolver reaching the host's commands.
 */
import * as hostCore from '@crux-vscode/host-core';
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { activate } from '../src/extension';

// `vi.mock` is hoisted above the imports, so both imports above see the mock.
const captured = vi.hoisted(() => ({
  joinOptions: [] as Record<string, unknown>[],
  stemsServices: [] as InstanceType<typeof hostCore.names.StemsIndexService>[],
}));

vi.mock('@crux-vscode/host-core', async (importOriginal) => {
  const actual = await importOriginal<typeof hostCore>();

  /** The real service, recorded so the test can load stems into its index. */
  class RecordingStemsIndexService extends actual.names.StemsIndexService {
    constructor(options: ConstructorParameters<typeof actual.names.StemsIndexService>[0]) {
      super(options);
      captured.stemsServices.push(this);
    }
  }

  /** No timers, no network: the client is not what is under test. */
  class InertTelemetryClient {
    start(): void {}
    dispose(): void {}
    record(): void {}
    recordFromWebview(): void {}
  }

  return {
    ...actual,
    // Decorations and editor event wiring need a real extension host; the
    // annotation loop is not what is under test, its resolver is.
    annotate: {
      ...actual.annotate,
      registerRtlAnnotation: () => ({ refreshAll: () => undefined, dispose: () => undefined }),
    },
    names: { ...actual.names, StemsIndexService: RecordingStemsIndexService },
    telemetry: { ...actual.telemetry, TelemetryClient: InertTelemetryClient },
    // The real one scans this machine's CXP manifest directory.
    status: {
      ...actual.status,
      registerProductStatusSurface: () => ({ detector: undefined, dispose: () => undefined }),
    },
    window: {
      ...actual.window,
      joinCruxWindow: (options: Record<string, unknown>) => {
        captured.joinOptions.push(options);
        return {
          api: {},
          host: undefined,
          settled: () => new Promise(() => undefined),
          dispose: () => Promise.resolve(),
        };
      },
    },
  };
});

function fakeContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extension: { packageJSON: { version: '0.1.0' } },
    extensionUri: { scheme: 'file', path: '/ext/wavecrux', fsPath: '/ext/wavecrux' },
    globalState: { get: () => undefined, update: () => Promise.resolve() },
    extensionMode: 1,
  } as unknown as vscode.ExtensionContext;
}

describe('wavecrux activate() — the window gets its name resolver', () => {
  it('passes the annotation’s stems-backed NameResolver to joinCruxWindow, and a selection resolves through it', async () => {
    activate(fakeContext());

    expect(captured.joinOptions).toHaveLength(1);
    const resolver = captured.joinOptions[0]?.['resolver'];
    expect(resolver).toBeInstanceOf(hostCore.names.NameResolver);

    // One stems index for the whole extension: the resolver the window gets
    // answers from the same service RTL annotation reads.
    expect(captured.stemsServices).toHaveLength(1);
    captured.stemsServices[0]?.index.replace('/ws/top.stems', [
      { path: 'top.cpu.alu.result', sourceFile: '/ws/rtl/alu.sv', lineNumber: 21, kind: 'variable' },
    ]);
    const candidates = await (resolver as InstanceType<typeof hostCore.names.NameResolver>).resolve({
      identifier: 'result',
      fsPath: '/ws/rtl/alu.sv',
      line: 21,
      column: 9,
    });
    expect(candidates.map((candidate) => candidate.path)).toEqual(['top.cpu.alu.result']);
  });
});
