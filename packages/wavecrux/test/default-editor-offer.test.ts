import { describe, expect, it } from 'vitest';
import {
  VCD_ASSOCIATION_PATTERN,
  acceptLabel,
  asEditorAssociations,
  confirmedMessage,
  declineLabel,
  failedMessage,
  hasVcdAssociation,
  isVcdPath,
  offerDefaultEditor,
  offerMessage,
  withVcdAssociation,
  type DefaultEditorOfferHost,
  type EditorAssociations,
} from '../src/editor/default-editor-offer';
import { WAVEFORM_VIEW_TYPE } from '../src/formats';

interface Recorder {
  offered: boolean;
  readonly written: EditorAssociations[];
  readonly messages: { message: string; actions: readonly string[] }[];
  readonly logs: string[];
}

function fakeHost(
  options: {
    offered?: boolean;
    effective?: unknown;
    global?: unknown;
    answer?: string | undefined;
    writeFails?: boolean;
  } = {},
): { host: DefaultEditorOfferHost; recorder: Recorder } {
  const recorder: Recorder = {
    offered: options.offered ?? false,
    written: [],
    messages: [],
    logs: [],
  };
  const host: DefaultEditorOfferHost = {
    wasOffered: () => recorder.offered,
    markOffered: () => {
      recorder.offered = true;
      return Promise.resolve();
    },
    effectiveAssociations: () => options.effective,
    globalAssociations: () => options.global,
    writeGlobalAssociations: (value) => {
      if (options.writeFails === true) return Promise.reject(new Error('read-only settings'));
      recorder.written.push(value);
      return Promise.resolve();
    },
    showMessage: (message, ...actions) => {
      recorder.messages.push({ message, actions });
      return Promise.resolve(options.answer);
    },
    log: (line) => recorder.logs.push(line),
  };
  return { host, recorder };
}

const OPTIONS = { path: '/work/sim/top.vcd', viewType: WAVEFORM_VIEW_TYPE };

describe('isVcdPath', () => {
  it('matches .vcd in any case and nothing else', () => {
    expect(isVcdPath('/w/top.vcd')).toBe(true);
    expect(isVcdPath('C:\\w\\TOP.VCD')).toBe(true);
    expect(isVcdPath('/w/top.fst')).toBe(false);
    expect(isVcdPath('/w/top.vcd.gz')).toBe(false);
    expect(isVcdPath('/w/vcd')).toBe(false);
  });
});

describe('hasVcdAssociation', () => {
  it('is false when nothing is configured', () => {
    expect(hasVcdAssociation(undefined)).toBe(false);
    expect(hasVcdAssociation({})).toBe(false);
    expect(hasVcdAssociation([])).toBe(false);
  });

  it('is false for associations about other files', () => {
    expect(hasVcdAssociation({ '*.ipynb': 'jupyter-notebook' })).toBe(false);
  });

  it('is true for an existing .vcd pattern, whichever editor it names', () => {
    expect(hasVcdAssociation({ '*.vcd': 'default' })).toBe(true);
    expect(hasVcdAssociation({ '*.vcd': WAVEFORM_VIEW_TYPE })).toBe(true);
    expect(hasVcdAssociation({ 'waves/*.VCD': 'default' })).toBe(true);
  });

  it('understands the legacy list form', () => {
    expect(hasVcdAssociation([{ viewType: 'x', filenamePattern: '*.vcd' }])).toBe(true);
    expect(hasVcdAssociation([{ viewType: 'x', filenamePattern: '*.txt' }])).toBe(false);
  });
});

describe('asEditorAssociations', () => {
  it('drops entries that are not strings, and non-objects entirely', () => {
    expect(asEditorAssociations({ '*.a': 'x', '*.b': 3 })).toEqual({ '*.a': 'x' });
    expect(asEditorAssociations('nope')).toBeUndefined();
    expect(asEditorAssociations(undefined)).toBeUndefined();
    expect(asEditorAssociations([{ viewType: 'x' }, 7, { filenamePattern: '*.a' }])).toEqual([
      { viewType: 'x' },
    ]);
  });
});

describe('withVcdAssociation', () => {
  it('adds the pattern to the object form and keeps the rest', () => {
    expect(withVcdAssociation({ '*.ipynb': 'jupyter' }, 'v')).toEqual({
      '*.ipynb': 'jupyter',
      [VCD_ASSOCIATION_PATTERN]: 'v',
    });
  });

  it('starts an object when there was none', () => {
    expect(withVcdAssociation(undefined, 'v')).toEqual({ '*.vcd': 'v' });
  });

  it('appends to the legacy list form rather than rewriting it as an object', () => {
    expect(withVcdAssociation([{ viewType: 'x', filenamePattern: '*.a' }], 'v')).toEqual([
      { viewType: 'x', filenamePattern: '*.a' },
      { viewType: 'v', filenamePattern: '*.vcd' },
    ]);
  });
});

describe('offerDefaultEditor', () => {
  it('writes nothing and asks nothing for a file that is not a .vcd', async () => {
    const { host, recorder } = fakeHost({ answer: acceptLabel() });
    const outcome = await offerDefaultEditor(host, { ...OPTIONS, path: '/w/top.fst' });
    expect(outcome).toEqual({ kind: 'not-applicable' });
    expect(recorder.messages).toEqual([]);
    expect(recorder.written).toEqual([]);
    expect(recorder.offered).toBe(false);
  });

  it('asks once, and writes the association only when the user agrees', async () => {
    const { host, recorder } = fakeHost({ answer: acceptLabel(), global: { '*.md': 'x' } });
    let reopened = 0;
    const outcome = await offerDefaultEditor(host, {
      ...OPTIONS,
      onAccepted: () => {
        reopened += 1;
        return Promise.resolve();
      },
    });
    expect(outcome).toEqual({ kind: 'accepted' });
    expect(recorder.messages[0]).toEqual({
      message: offerMessage(),
      actions: [acceptLabel(), declineLabel()],
    });
    // Only the user-level value, with its other entries preserved.
    expect(recorder.written).toEqual([{ '*.md': 'x', '*.vcd': WAVEFORM_VIEW_TYPE }]);
    expect(reopened).toBe(1);
    expect(recorder.messages[1]?.message).toBe(confirmedMessage());
    expect(recorder.offered).toBe(true);
  });

  it('writes nothing when the user declines', async () => {
    const { host, recorder } = fakeHost({ answer: declineLabel() });
    expect(await offerDefaultEditor(host, OPTIONS)).toEqual({ kind: 'declined' });
    expect(recorder.written).toEqual([]);
  });

  it('writes nothing when the message is dismissed', async () => {
    const { host, recorder } = fakeHost({ answer: undefined });
    expect(await offerDefaultEditor(host, OPTIONS)).toEqual({ kind: 'declined' });
    expect(recorder.written).toEqual([]);
  });

  it('counts a dismissed message as the one offer, so it never nags', async () => {
    const { host, recorder } = fakeHost({ answer: undefined });
    await offerDefaultEditor(host, OPTIONS);
    expect(recorder.offered).toBe(true);
    const again = await offerDefaultEditor(host, OPTIONS);
    expect(again).toEqual({ kind: 'already-offered' });
    expect(recorder.messages).toHaveLength(1);
  });

  it('logs nothing for a file that is not a .vcd', async () => {
    const { host, recorder } = fakeHost();
    await offerDefaultEditor(host, { ...OPTIONS, path: '/w/notes.md' });
    expect(recorder.logs).toEqual([]);
  });

  // crux-vscode#8: a .vcd opened from the command line on Windows came up as
  // text and no offer was seen, and nothing in the output channel said
  // whether the offer ran, was skipped, or was shown where nobody looked.
  it('says in the output channel which way every .vcd went', async () => {
    const asked = fakeHost({ answer: undefined });
    await offerDefaultEditor(asked.host, { ...OPTIONS, path: 'C:\\sim\\all5_basic.vcd' });
    expect(asked.recorder.logs).toEqual([
      '   default editor offer: all5_basic.vcd opened as text',
      '   default editor offer: asking',
      '   default editor offer: declined',
    ]);

    const again = await offerDefaultEditor(asked.host, OPTIONS);
    expect(again).toEqual({ kind: 'already-offered' });
    expect(asked.recorder.logs.slice(3)).toEqual([
      '   default editor offer: top.vcd opened as text',
      '   default editor offer: not asked, already offered on this installation',
    ]);

    const configured = fakeHost({ effective: { '*.vcd': 'default' } });
    await offerDefaultEditor(configured.host, OPTIONS);
    expect(configured.recorder.logs).toEqual([
      '   default editor offer: top.vcd opened as text',
      '   default editor offer: not asked, workbench.editorAssociations already names an editor for .vcd',
    ]);
  });

  it('stays silent when an editor is already chosen for .vcd', async () => {
    const { host, recorder } = fakeHost({
      answer: acceptLabel(),
      effective: { '*.vcd': 'default' },
    });
    expect(await offerDefaultEditor(host, OPTIONS)).toEqual({ kind: 'already-configured' });
    expect(recorder.messages).toEqual([]);
    expect(recorder.written).toEqual([]);
  });

  it('says so when the setting cannot be written, and does not reopen the tab', async () => {
    const { host, recorder } = fakeHost({ answer: acceptLabel(), writeFails: true });
    let reopened = 0;
    const outcome = await offerDefaultEditor(host, {
      ...OPTIONS,
      onAccepted: () => {
        reopened += 1;
        return Promise.resolve();
      },
    });
    expect(outcome).toEqual({ kind: 'write-failed' });
    expect(reopened).toBe(0);
    expect(recorder.messages.at(-1)?.message).toBe(failedMessage());
  });

  it('still reports success when reopening the tab fails', async () => {
    const { host, recorder } = fakeHost({ answer: acceptLabel() });
    const outcome = await offerDefaultEditor(host, {
      ...OPTIONS,
      onAccepted: () => Promise.reject(new Error('tab gone')),
    });
    expect(outcome).toEqual({ kind: 'accepted' });
    expect(recorder.written).toHaveLength(1);
  });
});

describe('the strings', () => {
  it('carry no em dash and name the setting a user would edit', () => {
    for (const text of [
      offerMessage(),
      acceptLabel(),
      declineLabel(),
      confirmedMessage(),
      failedMessage(),
    ]) {
      expect(text).not.toContain('\u2014');
    }
    expect(confirmedMessage()).toContain('workbench.editorAssociations');
  });
});
