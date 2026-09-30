import { describe, expect, it } from 'vitest';
import type { cxp, editor } from '@crux-vscode/host-core';
import type { SendHighlightResult } from '../../src/highlight/send-request';
import { whatDrivesThis, type WhatDrivesThisDeps } from '../../src/highlight/what-drives-this';

const SNAPSHOT: editor.EditorSelectionSnapshot = {
  identifier: 'alarm_r',
  fsPath: '/ws/rtl/top.sv',
  line: 42,
  column: 3,
};

const MANIFEST: cxp.CxpPeerManifest = {
  identity: { peerId: 'netcrux-4242-1', productName: 'netcrux', productVersion: '0.6.0', capabilities: [] },
  host: '127.0.0.1',
  port: 51_500,
  startedAt: Date.now(),
  manifestPath: '(test)',
};

/** Records quick-picks and info messages; `UserInterface`-shaped. */
class FakeUi implements editor.UserInterface {
  readonly infoMessages: string[] = [];
  readonly offered: (readonly editor.ElementPathChoice[] | readonly { label: string }[])[] = [];
  answers: (number | undefined)[] = [];

  showQuickPick<T extends { label: string }>(choices: readonly T[], _placeHolder: string): Promise<T | undefined> {
    this.offered.push(choices);
    const index = this.answers.shift();
    return Promise.resolve(index === undefined ? undefined : choices[index]);
  }

  showInformationMessage(message: string): void {
    this.infoMessages.push(message);
  }
}

interface Recorder {
  readonly logs: string[];
  readonly launched: string[];
  readonly openedInstallUrl: number[];
  readonly shownMessages: { readonly message: string; readonly actions: readonly string[] }[];
}

function baseDeps(overrides: Partial<WhatDrivesThisDeps> = {}): {
  deps: WhatDrivesThisDeps;
  ui: FakeUi;
  recorder: Recorder;
} {
  const ui = new FakeUi();
  const recorder: Recorder = { logs: [], launched: [], openedInstallUrl: [], shownMessages: [] };

  const deps: WhatDrivesThisDeps = {
    currentSelection: () => SNAPSHOT,
    resolver: { resolve: () => [SNAPSHOT.identifier] },
    ui,
    discoverPeer: () => Promise.resolve(undefined),
    sendHighlight: () => Promise.resolve<SendHighlightResult>({ kind: 'ack-timeout' }),
    locateInstalled: () => undefined,
    launch: (p) => {
      recorder.launched.push(p);
      return Promise.resolve();
    },
    openInstallUrl: () => {
      recorder.openedInstallUrl.push(1);
      return Promise.resolve();
    },
    showMessage: (message, ...actions) => {
      recorder.shownMessages.push({ message, actions });
      return Promise.resolve(undefined);
    },
    log: (line) => recorder.logs.push(line),
    ...overrides,
  };

  return { deps, ui, recorder };
}

/**
 * Wraps [deps]'s `showMessage` so it also resolves with [choice] — the
 * button the fake user clicked — while still recording the call the way
 * [baseDeps]'s own does. Kept separate from [baseDeps] because most tests
 * below don't need a chosen button at all.
 */
function withMessageChoice(
  deps: WhatDrivesThisDeps,
  recorder: Recorder,
  choice: string | undefined,
): WhatDrivesThisDeps {
  return {
    ...deps,
    showMessage: (message, ...actions) => {
      recorder.shownMessages.push({ message, actions });
      return Promise.resolve(choice);
    },
  };
}

describe('whatDrivesThis — selection and resolution', () => {
  it('reports no-selection when nothing is selected', async () => {
    const { deps, ui } = baseDeps({ currentSelection: () => undefined });
    const outcome = await whatDrivesThis(deps);
    expect(outcome).toEqual({ kind: 'no-selection' });
    expect(ui.infoMessages).toEqual(['Select an identifier in the editor first.']);
  });

  it('reports no-candidates when the resolver finds nothing', async () => {
    const { deps, ui } = baseDeps({ resolver: { resolve: () => Promise.resolve([]) } });
    const outcome = await whatDrivesThis(deps);
    expect(outcome).toEqual({ kind: 'no-candidates' });
    expect(ui.infoMessages).toEqual(['Select an identifier in the editor first.']);
  });

  it('auto-picks a single candidate with no quick-pick', async () => {
    const { deps, ui } = baseDeps({
      resolver: { resolve: () => Promise.resolve(['top.cpu.alarm_r']) },
      discoverPeer: () => Promise.resolve(MANIFEST),
      sendHighlight: () => Promise.resolve<SendHighlightResult>({ kind: 'acked', honored: true }),
    });
    const outcome = await whatDrivesThis(deps);
    expect(outcome).toEqual({ kind: 'sent', path: 'top.cpu.alarm_r', honored: true });
    expect(ui.offered).toHaveLength(0);
  });

  it('asks with every candidate, described, on ambiguity — never guesses', async () => {
    const { deps, ui } = baseDeps({
      resolver: {
        resolve: () =>
          Promise.resolve([
            { path: 'top.cpu.alu.alarm_r', description: 'from stems' },
            { path: 'top.dbg.alarm_r', description: 'name match — a stems file would make this exact' },
          ]),
      },
      discoverPeer: () => Promise.resolve(MANIFEST),
      sendHighlight: () => Promise.resolve<SendHighlightResult>({ kind: 'acked', honored: true }),
    });
    ui.answers = [1]; // pick the second candidate
    const outcome = await whatDrivesThis(deps);

    expect(ui.offered).toHaveLength(1);
    expect(ui.offered[0]).toEqual([
      { label: 'top.cpu.alu.alarm_r', description: 'from stems', path: 'top.cpu.alu.alarm_r' },
      {
        label: 'top.dbg.alarm_r',
        description: 'name match — a stems file would make this exact',
        path: 'top.dbg.alarm_r',
      },
    ]);
    expect(outcome).toEqual({ kind: 'sent', path: 'top.dbg.alarm_r', honored: true });
  });

  it('reports cancelled when the element quick-pick is dismissed', async () => {
    const { deps } = baseDeps({
      resolver: { resolve: () => Promise.resolve(['a.x', 'b.x']) },
    });
    const outcome = await whatDrivesThis(deps); // no answers queued → dismissed
    expect(outcome).toEqual({ kind: 'cancelled' });
  });
});

describe('whatDrivesThis — a peer is present', () => {
  it('sends element kind "net" — established by reading NetCrux’s own inbound handler', async () => {
    let sentElement: cxp.ElementId | undefined;
    const { deps } = baseDeps({
      discoverPeer: () => Promise.resolve(MANIFEST),
      sendHighlight: (_manifest, element) => {
        sentElement = element;
        return Promise.resolve<SendHighlightResult>({ kind: 'acked', honored: true });
      },
    });
    await whatDrivesThis(deps);
    expect(sentElement).toEqual({ kind: 'net', path: 'alarm_r' });
  });

  it('reports "sent" honored:true silently — no toast for the outcome that IS the point', async () => {
    const { deps, ui } = baseDeps({
      discoverPeer: () => Promise.resolve(MANIFEST),
      sendHighlight: () => Promise.resolve<SendHighlightResult>({ kind: 'acked', honored: true }),
    });
    await whatDrivesThis(deps);
    expect(ui.infoMessages).toEqual([]);
  });

  it('surfaces a decline with NetCrux’s own reason', async () => {
    const { deps, ui } = baseDeps({
      discoverPeer: () => Promise.resolve(MANIFEST),
      sendHighlight: () =>
        Promise.resolve<SendHighlightResult>({ kind: 'acked', honored: false, reason: 'No active tab' }),
    });
    const outcome = await whatDrivesThis(deps);
    expect(outcome).toEqual({ kind: 'sent', path: 'alarm_r', honored: false, reason: 'No active tab' });
    expect(ui.infoMessages).toEqual(['NetCrux could not show alarm_r: No active tab']);
  });

  it('reports ack-timeout with a message', async () => {
    const { deps, ui } = baseDeps({
      discoverPeer: () => Promise.resolve(MANIFEST),
      sendHighlight: () => Promise.resolve<SendHighlightResult>({ kind: 'ack-timeout' }),
    });
    const outcome = await whatDrivesThis(deps);
    expect(outcome).toEqual({ kind: 'ack-timeout', path: 'alarm_r' });
    expect(ui.infoMessages).toHaveLength(1);
  });

  it('reports unreachable with a message', async () => {
    const { deps, ui } = baseDeps({
      discoverPeer: () => Promise.resolve(MANIFEST),
      sendHighlight: () =>
        Promise.resolve<SendHighlightResult>({ kind: 'unreachable', error: new Error('ECONNREFUSED') }),
    });
    const outcome = await whatDrivesThis(deps);
    expect(outcome).toEqual({ kind: 'unreachable', path: 'alarm_r' });
    expect(ui.infoMessages).toHaveLength(1);
  });
});

describe('whatDrivesThis — no peer, NetCrux installed', () => {
  it('offers to launch, and launches on request', async () => {
    const { deps, recorder } = baseDeps({
      locateInstalled: () => '/Applications/NetCrux Pro.app',
    });
    const withChoice = withMessageChoice(deps, recorder, 'Launch NetCrux');
    const outcome = await whatDrivesThis(withChoice);

    expect(outcome).toEqual({ kind: 'offered-launch', launched: true });
    expect(recorder.launched).toEqual(['/Applications/NetCrux Pro.app']);
    expect(recorder.shownMessages[0]?.message).toContain('alarm_r');
    expect(recorder.shownMessages[0]?.message).not.toMatch(/sorry|unfortunately/i);
  });

  it('does not launch when the offer is dismissed', async () => {
    const { deps, recorder } = baseDeps({
      locateInstalled: () => '/Applications/NetCrux Pro.app',
    });
    const withChoice = withMessageChoice(deps, recorder, undefined);
    const outcome = await whatDrivesThis(withChoice);

    expect(outcome).toEqual({ kind: 'offered-launch', launched: false });
    expect(recorder.launched).toEqual([]);
  });
});

describe('whatDrivesThis — no peer, NetCrux not installed', () => {
  it('offers the install boundary, without apologising', async () => {
    const { deps, recorder } = baseDeps({ locateInstalled: () => undefined });
    const withChoice = withMessageChoice(deps, recorder, 'Get NetCrux');
    const outcome = await whatDrivesThis(withChoice);

    expect(outcome).toEqual({ kind: 'boundary', followed: true });
    expect(recorder.openedInstallUrl).toEqual([1]);
    expect(recorder.shownMessages[0]?.message).not.toMatch(/sorry|unfortunately|apologi/i);
  });

  it('does not open the install page when the boundary is dismissed', async () => {
    const { deps, recorder } = baseDeps({ locateInstalled: () => undefined });
    const withChoice = withMessageChoice(deps, recorder, undefined);
    const outcome = await whatDrivesThis(withChoice);

    expect(outcome).toEqual({ kind: 'boundary', followed: false });
    expect(recorder.openedInstallUrl).toEqual([]);
  });
});
