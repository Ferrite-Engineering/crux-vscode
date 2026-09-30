/**
 * NetCrux's `activate()` hands its stems-backed name resolver to the window.
 *
 * The window-level `edacrux.sendSelectionToPeer` /
 * `edacrux.highlightSelectionInPeer` commands are registered by whichever
 * extension the election picks — LintCrux, in a four-extension window — so
 * they can only resolve names through NetCrux's index if NetCrux passes its
 * resolver to `joinCruxWindow`. This pins that production wiring, and that a
 * selection resolves through the stems index the extension itself maintains.
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
    globalState: { get: () => undefined, update: () => Promise.resolve() },
    extensionMode: 1,
  } as unknown as vscode.ExtensionContext;
}

describe('netcrux activate() — the window gets its name resolver', () => {
  it('passes a stems-backed NameResolver to joinCruxWindow, and a selection resolves through it', async () => {
    activate(fakeContext());

    expect(captured.joinOptions).toHaveLength(1);
    const resolver = captured.joinOptions[0]?.['resolver'];
    expect(resolver).toBeInstanceOf(hostCore.names.NameResolver);

    // The resolver answers from the extension's own stems index — load one
    // entry into it and ask about the identifier at its declaration.
    expect(captured.stemsServices).toHaveLength(1);
    captured.stemsServices[0]?.index.replace('/ws/top.stems', [
      { path: 'top.cpu.alarm_r', sourceFile: '/ws/rtl/cpu.sv', lineNumber: 40, kind: 'variable' },
    ]);
    const candidates = await (resolver as InstanceType<typeof hostCore.names.NameResolver>).resolve({
      identifier: 'alarm_r',
      fsPath: '/ws/rtl/cpu.sv',
      line: 40,
      column: 7,
    });
    expect(candidates.map((candidate) => candidate.path)).toEqual(['top.cpu.alarm_r']);
  });
});
