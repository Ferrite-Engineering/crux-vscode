import { describe, expect, it } from 'vitest';
import type { PeerIdentity } from '../../src/cxp/identity';
import { CxpMessageKind, type CxpMessage } from '../../src/cxp/messages';
import {
  CRUX_SEND_COMMAND_IDS,
  PeerSendCommands,
  composeElementPathResolvers,
  isElementPathResolver,
  passThroughElementPathResolver,
  type EditorSelectionSnapshot,
  type PeerSendCommandsOptions,
} from '../../src/editor/send';
import { FakeUserInterface, peer } from './harness';

const WAVECRUX = peer('wavecrux-4242-1784742061000', 'WaveCrux', [
  'notify_selection',
  'request_highlight',
]);
const NETCRUX = peer('netcrux-4243-1784742061000', 'NetCrux', ['notify_selection']);
/** An older peer that advertises nothing at all — still a valid target. */
const SILENT = peer('simcrux-4244-1784742061000', 'SimCrux', []);

const SNAPSHOT: EditorSelectionSnapshot = {
  identifier: 'alu_result',
  fsPath: '/ws/rtl/alu.sv',
  line: 214,
  column: 9,
};

interface Setup {
  readonly commands: PeerSendCommands;
  readonly ui: FakeUserInterface;
  readonly sent: { peerId: string; message: CxpMessage }[];
}

function setup(
  peers: readonly PeerIdentity[],
  overrides: Partial<PeerSendCommandsOptions> = {},
): Setup {
  const ui = new FakeUserInterface();
  const sent: { peerId: string; message: CxpMessage }[] = [];
  const commands = new PeerSendCommands({
    ui,
    currentSelection: () => SNAPSHOT,
    connectedPeers: () => peers,
    send: (peerId, message) => {
      sent.push({ peerId, message });
      return true;
    },
    ...overrides,
  });
  return { commands, ui, sent };
}

describe('command ids', () => {
  it('lives in the host-core-owned edacrux namespace', () => {
    expect(CRUX_SEND_COMMAND_IDS.notifySelection).toBe('edacrux.sendSelectionToPeer');
    expect(CRUX_SEND_COMMAND_IDS.requestHighlight).toBe('edacrux.highlightSelectionInPeer');
  });
});

describe('passThroughElementPathResolver', () => {
  it('sends the selected identifier verbatim (NameResolver is the stems-backed alternative)', () => {
    expect(passThroughElementPathResolver.resolve(SNAPSHOT)).toEqual(['alu_result']);
  });

  it('produces nothing for a blank selection', () => {
    expect(passThroughElementPathResolver.resolve({ ...SNAPSHOT, identifier: '  ' })).toEqual([]);
  });
});

describe('PeerSendCommands — targeting (direct action, one peer means no prompt)', () => {
  it('auto-targets a lone peer with no prompt', async () => {
    const { commands, ui, sent } = setup([WAVECRUX]);
    const outcome = await commands.sendSelection();
    expect(outcome.sent).toBe(true);
    expect(ui.placeholders).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.peerId).toBe(WAVECRUX.peerId);
  });

  it('auto-targets a lone peer even when it advertises nothing', async () => {
    // Capabilities are advisory (§8.1). A peer that never advertised must
    // still be sent to when the user asked and it is the only one there.
    const { commands, sent } = setup([SILENT]);
    expect((await commands.requestHighlight()).sent).toBe(true);
    expect(sent[0]?.peerId).toBe(SILENT.peerId);
  });

  it('quick-picks when several peers are connected', async () => {
    const { commands, ui, sent } = setup([NETCRUX, WAVECRUX]);
    ui.answers = [0];
    const outcome = await commands.requestHighlight();
    expect(outcome.sent).toBe(true);
    expect(ui.placeholders).toEqual(['Send the selection to which Crux app?']);
    // WaveCrux advertises request_highlight, NetCrux does not, so WaveCrux
    // is offered first despite being second in the connected list.
    expect(sent[0]?.peerId).toBe(WAVECRUX.peerId);
  });

  it('still offers a peer that has not advertised the capability, labelled', async () => {
    const ui = new FakeUserInterface();
    let offered: readonly { label: string; description?: string }[] = [];
    const commands = new PeerSendCommands({
      ui: {
        showQuickPick: (choices, placeHolder) => {
          offered = choices;
          return ui.showQuickPick(choices, placeHolder);
        },
        showInformationMessage: (message) => ui.showInformationMessage(message),
      },
      currentSelection: () => SNAPSHOT,
      connectedPeers: () => [WAVECRUX, SILENT],
      send: () => true,
    });
    ui.answers = [1];
    expect((await commands.requestHighlight()).sent).toBe(true);
    expect(offered.map((choice) => choice.label)).toEqual(['WaveCrux', 'SimCrux']);
    expect(offered[0]?.description).toBeUndefined();
    expect(offered[1]?.description).toBe('may not accept this');
  });

  it('cancels cleanly when the peer quick-pick is dismissed', async () => {
    const { commands, ui, sent } = setup([NETCRUX, WAVECRUX]);
    ui.answers = [undefined];
    expect(await commands.sendSelection()).toEqual({ sent: false, reason: 'cancelled' });
    expect(sent).toEqual([]);
  });

  it('orders equally-capable peers deterministically', async () => {
    const ui = new FakeUserInterface();
    let offered: readonly { label: string }[] = [];
    const commands = new PeerSendCommands({
      ui: {
        showQuickPick: (choices, placeHolder) => {
          offered = choices;
          return ui.showQuickPick(choices, placeHolder);
        },
        showInformationMessage: () => undefined,
      },
      currentSelection: () => SNAPSHOT,
      connectedPeers: () => [WAVECRUX, NETCRUX],
      send: () => true,
    });
    ui.answers = [0];
    await commands.sendSelection();
    expect(offered.map((choice) => choice.label)).toEqual(['NetCrux', 'WaveCrux']);
  });
});

describe('PeerSendCommands — the messages it emits', () => {
  it('emits notify_selection with the identifier as display_name', async () => {
    const { commands, sent } = setup([WAVECRUX]);
    await commands.sendSelection();
    expect(sent[0]?.message).toEqual({
      kind: CxpMessageKind.notifySelection,
      elements: [{ kind: 'signal', path: 'alu_result' }],
      displayName: 'alu_result',
      metadata: {},
    });
  });

  it('emits request_highlight for the same selection', async () => {
    const { commands, sent } = setup([WAVECRUX]);
    await commands.requestHighlight();
    expect(sent[0]?.message).toEqual({
      kind: CxpMessageKind.requestHighlight,
      element: { kind: 'signal', path: 'alu_result' },
      metadata: {},
    });
  });

  it('honours an overridden element kind', async () => {
    const { commands, sent } = setup([WAVECRUX], { elementKind: 'net' });
    await commands.requestHighlight();
    expect(sent[0]?.message).toMatchObject({ element: { kind: 'net' } });
  });

  it('attaches crux.design_id when the host knows one (wire 1.1)', async () => {
    const { commands, sent } = setup([WAVECRUX], { designId: () => 'design-7' });
    await commands.sendSelection();
    expect(sent[0]?.message).toMatchObject({ metadata: { 'crux.design_id': 'design-7' } });
  });
});

describe('PeerSendCommands — the resolver seam', () => {
  it('uses an injected resolver in place of the pass-through', async () => {
    const { commands, sent } = setup([WAVECRUX], {
      resolver: { resolve: () => ['top.cpu.alu.result'] },
    });
    await commands.requestHighlight();
    expect(sent[0]?.message).toMatchObject({
      element: { kind: 'signal', path: 'top.cpu.alu.result' },
    });
  });

  it('asks rather than guessing when the resolver is ambiguous', async () => {
    // An identifier under several instantiations has no obviously-right
    // answer, so the user is asked.
    const { commands, ui, sent } = setup([WAVECRUX], {
      resolver: { resolve: () => ['top.cpu0.alu.result', 'top.cpu1.alu.result'] },
    });
    ui.answers = [1];
    await commands.requestHighlight();
    expect(ui.placeholders).toEqual(['Which element did you mean?']);
    expect(sent[0]?.message).toMatchObject({
      element: { path: 'top.cpu1.alu.result' },
    });
  });

  it('cancels cleanly when the disambiguation pick is dismissed', async () => {
    const { commands, ui, sent } = setup([WAVECRUX], {
      resolver: { resolve: () => ['a.b', 'c.d'] },
    });
    ui.answers = [undefined];
    expect(await commands.requestHighlight()).toEqual({ sent: false, reason: 'cancelled' });
    expect(sent).toEqual([]);
  });

  it('awaits an async resolver', async () => {
    const { commands, sent } = setup([WAVECRUX], {
      resolver: { resolve: () => Promise.resolve(['top.a']) },
    });
    await commands.sendSelection();
    expect(sent[0]?.message).toMatchObject({ elements: [{ path: 'top.a' }] });
  });

  it('refuses when the resolver produces nothing', async () => {
    const { commands, ui, sent } = setup([WAVECRUX], { resolver: { resolve: () => [] } });
    expect(await commands.sendSelection()).toEqual({ sent: false, reason: 'no-element' });
    expect(ui.messages).toEqual(['Select an identifier in the editor first.']);
    expect(sent).toEqual([]);
  });
});

describe('composeElementPathResolvers — the window-level resolver', () => {
  it('takes the first resolver that has a candidate', async () => {
    const asked: string[] = [];
    const composed = composeElementPathResolvers(() => [
      {
        resolve: () => {
          asked.push('first');
          return [];
        },
      },
      {
        resolve: () => {
          asked.push('second');
          return [{ path: 'top.cpu.alu.result', description: 'from stems' }];
        },
      },
      {
        resolve: () => {
          asked.push('third');
          return ['never.reached'];
        },
      },
    ]);
    expect(await composed.resolve(SNAPSHOT)).toEqual([
      { path: 'top.cpu.alu.result', description: 'from stems' },
    ]);
    expect(asked).toEqual(['first', 'second']);
  });

  it('sends the identifier verbatim when no resolver is contributed', async () => {
    const composed = composeElementPathResolvers(() => []);
    expect(await composed.resolve(SNAPSHOT)).toEqual(['alu_result']);
  });

  it('sends the identifier verbatim when no contributed resolver knows it', async () => {
    // A stems index that does not cover the selection is not a reason to
    // refuse: the selection may already be a full path or a flat name, which
    // is exactly what the pass-through exists for.
    const composed = composeElementPathResolvers(() => [{ resolve: () => Promise.resolve([]) }]);
    expect(await composed.resolve(SNAPSHOT)).toEqual(['alu_result']);
  });

  it('skips a resolver that throws or answers with a non-array, and reports it', async () => {
    const errors: unknown[] = [];
    const composed = composeElementPathResolvers(
      () => [
        {
          resolve: () => {
            throw new Error('index went away');
          },
        },
        { resolve: () => Promise.reject(new Error('read failed')) },
        { resolve: () => 'top.not_an_array' as unknown as readonly string[] },
        { resolve: () => ['top.ok'] },
      ],
      (error) => errors.push(error),
    );
    expect(await composed.resolve(SNAPSHOT)).toEqual(['top.ok']);
    expect(errors).toHaveLength(3);
  });

  it('reads the resolver list per call, so contributions can come and go', async () => {
    let contributed: { resolve: () => readonly string[] }[] = [];
    const composed = composeElementPathResolvers(() => contributed);
    expect(await composed.resolve(SNAPSHOT)).toEqual(['alu_result']);
    contributed = [{ resolve: () => ['top.late'] }];
    expect(await composed.resolve(SNAPSHOT)).toEqual(['top.late']);
  });

  it('recognises a resolver by shape only', () => {
    expect(isElementPathResolver({ resolve: () => [] })).toBe(true);
    expect(isElementPathResolver({ resolve: 'no' })).toBe(false);
    expect(isElementPathResolver(undefined)).toBe(false);
    expect(isElementPathResolver(null)).toBe(false);
  });
});

describe('PeerSendCommands — nothing to send, or nowhere to send it', () => {
  it('tells the user when there is no selection', async () => {
    const { commands, ui } = setup([WAVECRUX], { currentSelection: () => undefined });
    expect(await commands.sendSelection()).toEqual({ sent: false, reason: 'no-selection' });
    expect(ui.messages).toEqual(['Select an identifier in the editor first.']);
  });

  it('treats a whitespace-only selection as no selection', async () => {
    const { commands } = setup([WAVECRUX], {
      currentSelection: () => ({ ...SNAPSHOT, identifier: '   ' }),
    });
    expect(await commands.sendSelection()).toEqual({ sent: false, reason: 'no-selection' });
  });

  it('tells the user when no peer is connected', async () => {
    const { commands, ui } = setup([]);
    expect(await commands.requestHighlight()).toEqual({ sent: false, reason: 'no-peers' });
    expect(ui.messages).toEqual([
      'No Crux apps are connected. Start WaveCrux, LintCrux, SimCrux, or NetCrux to cross-probe.',
    ]);
  });

  it('reports a peer that vanished between the pick and the send', async () => {
    const commands = new PeerSendCommands({
      ui: new FakeUserInterface(),
      currentSelection: () => SNAPSHOT,
      connectedPeers: () => [WAVECRUX],
      send: () => false,
    });
    expect(await commands.sendSelection()).toEqual({ sent: false, reason: 'unreachable' });
  });
});
