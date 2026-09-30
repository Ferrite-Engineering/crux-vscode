import { describe, expect, it } from 'vitest';
import { PeerSendCommands, type EditorSelectionSnapshot } from '../../src/editor/send';
import { CxpMessageKind, type CxpMessage } from '../../src/cxp/messages';
import {
  MAX_HIERARCHY_CANDIDATES,
  emptyHierarchyProvider,
  hierarchyCandidates,
  type DesignHierarchyProvider,
} from '../../src/names/hierarchy';
import { NameIndex } from '../../src/names/name-index';
import { NameResolver, describeCandidate } from '../../src/names/resolver';
import { FakeUserInterface, peer } from '../editor/harness';

/** A hierarchy provider over a fixed list — the WCP client's stand-in. */
function hierarchy(paths: readonly string[]): DesignHierarchyProvider {
  return { paths: () => paths };
}

const HIERARCHY = hierarchy([
  'top.alu_a.result',
  'top.alu_b.result',
  'top.cpu.clk',
  'top.cpu.regfile.data[31:0]',
]);

function stemsIndex(): NameIndex {
  const index = new NameIndex('linux');
  index.replace('/ws/top.stems', [
    { path: 'top.alu_a.result', sourceFile: '/ws/rtl/alu.sv', lineNumber: 21, kind: 'variable' },
    { path: 'top.alu_b.result', sourceFile: '/ws/rtl/alu.sv', lineNumber: 21, kind: 'variable' },
  ]);
  return index;
}

const SELECTION: EditorSelectionSnapshot = {
  identifier: 'result',
  fsPath: '/ws/rtl/alu.sv',
  line: 21,
  column: 9,
};

describe('hierarchyCandidates — the fallback when there are no stems', () => {
  it('matches the trailing component and returns every instantiation', async () => {
    expect((await hierarchyCandidates('result', HIERARCHY)).map((c) => c.path)).toEqual([
      'top.alu_a.result',
      'top.alu_b.result',
    ]);
  });

  it('matches a full dotted path and a dotted suffix on a component boundary', async () => {
    expect((await hierarchyCandidates('top.cpu.clk', HIERARCHY)).map((c) => c.path)).toEqual([
      'top.cpu.clk',
    ]);
    expect((await hierarchyCandidates('cpu.clk', HIERARCHY)).map((c) => c.path)).toEqual([
      'top.cpu.clk',
    ]);
    // Not a component boundary: `pu.clk` must not match `top.cpu.clk`.
    expect(await hierarchyCandidates('pu.clk', HIERARCHY)).toEqual([]);
  });

  it('strips bit ranges from both sides', async () => {
    expect((await hierarchyCandidates('data', HIERARCHY)).map((c) => c.path)).toEqual([
      'top.cpu.regfile.data[31:0]',
    ]);
  });

  it('labels everything it finds as a name match, never as exact', async () => {
    const candidates = await hierarchyCandidates('result', HIERARCHY);
    expect(candidates.every((c) => c.origin === 'hierarchy-name')).toBe(true);
  });

  it('degrades to no candidates when nothing is loaded', async () => {
    expect(await hierarchyCandidates('result', emptyHierarchyProvider)).toEqual([]);
  });

  it('degrades to no candidates when the provider throws', async () => {
    const broken: DesignHierarchyProvider = {
      paths: () => {
        throw new Error('peer went away mid-request');
      },
    };
    await expect(hierarchyCandidates('result', broken)).resolves.toEqual([]);
  });

  it('degrades to no candidates when the provider rejects', async () => {
    const rejecting: DesignHierarchyProvider = { paths: () => Promise.reject(new Error('nope')) };
    await expect(hierarchyCandidates('result', rejecting)).resolves.toEqual([]);
  });

  it('deduplicates and caps a pathologically generic identifier', async () => {
    const many = Array.from({ length: 500 }, (_, i) => `top.u${i}.clk`);
    const candidates = await hierarchyCandidates('clk', hierarchy([...many, ...many]));
    expect(candidates).toHaveLength(MAX_HIERARCHY_CANDIDATES);
  });
});

describe('NameResolver — stems first, hierarchy only as a fallback', () => {
  it('answers from stems and marks the answers exact', async () => {
    const resolver = new NameResolver({ index: stemsIndex(), hierarchy: HIERARCHY });
    const candidates = await resolver.candidates({
      fsPath: '/ws/rtl/alu.sv',
      line: 21,
      identifier: 'result',
    });
    expect(candidates.map((c) => [c.path, c.origin])).toEqual([
      ['top.alu_a.result', 'stems-declaration'],
      ['top.alu_b.result', 'stems-declaration'],
    ]);
  });

  it('does not mix hierarchy guesses in among stems answers', async () => {
    const resolver = new NameResolver({
      index: stemsIndex(),
      hierarchy: hierarchy(['some.other.result']),
    });
    const candidates = await resolver.candidates({ fsPath: '/ws/rtl/alu.sv', identifier: 'result' });
    expect(candidates.map((c) => c.path)).not.toContain('some.other.result');
  });

  it('falls back to the hierarchy when no stems file covers the workspace', async () => {
    const resolver = new NameResolver({ index: new NameIndex('linux'), hierarchy: HIERARCHY });
    const candidates = await resolver.candidates({ fsPath: '/ws/rtl/alu.sv', identifier: 'result' });
    expect(candidates.map((c) => [c.path, c.origin])).toEqual([
      ['top.alu_a.result', 'hierarchy-name'],
      ['top.alu_b.result', 'hierarchy-name'],
    ]);
  });

  it('resolves to nothing, not an error, in a window with no peer at all', async () => {
    const resolver = new NameResolver({ index: new NameIndex('linux') });
    await expect(
      resolver.candidates({ fsPath: '/ws/rtl/alu.sv', identifier: 'result' }),
    ).resolves.toEqual([]);
  });

  it('describes candidates so the quick-pick can say how sure it is', () => {
    const exact = describeCandidate({ path: 'top.a', origin: 'stems-declaration' });
    const guess = describeCandidate({ path: 'top.a', origin: 'hierarchy-name' });
    expect(exact).not.toBe(guess);
    expect(guess).toContain('stems');
  });
});

describe('NameResolver — forward direction with the §11 containment gate', () => {
  const realpath = (path: string): Promise<string> => Promise.resolve(path);

  it('resolves a design path to a real file inside the workspace', async () => {
    const resolver = new NameResolver({
      index: stemsIndex(),
      workspaceFolders: () => ['/ws'],
      realpath,
      platform: 'linux',
    });
    await expect(resolver.sourceLocationFor('top.alu_a.result')).resolves.toEqual({
      ok: true,
      fsPath: '/ws/rtl/alu.sv',
      lineNumber: 21,
    });
  });

  it('refuses a stems entry that names a file outside the workspace', async () => {
    const index = new NameIndex('linux');
    // A generated stems file is workspace content, not a manifest we wrote:
    // it can name anything at all, and the containment check is the reason
    // that does not matter.
    index.replace('/ws/evil.stems', [
      { path: 'top.key', sourceFile: '/home/user/.ssh/id_ed25519', lineNumber: 1, kind: 'variable' },
    ]);
    const resolver = new NameResolver({
      index,
      workspaceFolders: () => ['/ws'],
      realpath,
      platform: 'linux',
    });
    await expect(resolver.sourceLocationFor('top.key')).resolves.toEqual({
      ok: false,
      reason: 'outside-workspace',
    });
  });

  it('refuses everything when no folder is open', async () => {
    const resolver = new NameResolver({ index: stemsIndex(), realpath, platform: 'linux' });
    await expect(resolver.sourceLocationFor('top.alu_a.result')).resolves.toEqual({
      ok: false,
      reason: 'no-workspace',
    });
  });

  it('says so when no stems entry maps the path at all', async () => {
    const resolver = new NameResolver({
      index: stemsIndex(),
      workspaceFolders: () => ['/ws'],
      realpath,
      platform: 'linux',
    });
    await expect(resolver.sourceLocationFor('top.nowhere')).resolves.toEqual({
      ok: false,
      reason: 'unknown-path',
    });
  });
});

describe('NameResolver wired into the send command', () => {
  function commands(resolver: NameResolver, ui: FakeUserInterface) {
    const sent: { peerId: string; message: CxpMessage }[] = [];
    const target = peer('wavecrux-1-1', 'WaveCrux', ['notify_selection']);
    return {
      sent,
      commands: new PeerSendCommands({
        ui,
        currentSelection: () => SELECTION,
        connectedPeers: () => [target],
        send: (peerId, message) => {
          sent.push({ peerId, message });
          return true;
        },
        resolver,
      }),
    };
  }

  it('sends the hierarchical path, not the selected text', async () => {
    const index = new NameIndex('linux');
    index.replace('/ws/top.stems', [
      { path: 'top.alu.result', sourceFile: '/ws/rtl/alu.sv', lineNumber: 21, kind: 'variable' },
    ]);
    const ui = new FakeUserInterface();
    const { commands: send, sent } = commands(new NameResolver({ index }), ui);

    const outcome = await send.sendSelection();

    expect(outcome.sent).toBe(true);
    expect(sent[0]?.message).toMatchObject({
      kind: CxpMessageKind.notifySelection,
      elements: [{ kind: 'signal', path: 'top.alu.result' }],
    });
    // One candidate: no quick-pick, no prompt.
    expect(ui.placeholders).toEqual([]);
  });

  it('offers every instantiation with its provenance rather than guessing', async () => {
    const ui = new FakeUserInterface();
    ui.answers = [1];
    const { commands: send, sent } = commands(new NameResolver({ index: stemsIndex() }), ui);

    await send.sendSelection();

    expect(ui.offered[0]?.map((choice) => choice.label)).toEqual([
      'top.alu_a.result',
      'top.alu_b.result',
    ]);
    expect(ui.offered[0]?.[0]?.description).toBeDefined();
    expect(sent[0]?.message).toMatchObject({ elements: [{ path: 'top.alu_b.result' }] });
  });

  it('refuses the send when nothing resolves, without inventing a path', async () => {
    const ui = new FakeUserInterface();
    const resolver = new NameResolver({ index: new NameIndex('linux') });
    const { commands: send, sent } = commands(resolver, ui);

    expect(await send.sendSelection()).toEqual({ sent: false, reason: 'no-element' });
    expect(sent).toEqual([]);
  });
});
