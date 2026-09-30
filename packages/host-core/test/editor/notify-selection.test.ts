import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CxpMessageKind, type NotifySelection } from '../../src/cxp/messages';
import {
  SelectionPresenter,
  SOURCE_ELEMENT_KIND,
  type InboundSelection,
} from '../../src/editor/notify-selection';
import { DEFAULT_CROSS_PROBE_SETTINGS } from '../../src/editor/settings';
import { FakeEditorHost, peer } from './harness';

const FROM = peer('wavecrux-4242-1784742061000', 'wavecrux');
const FILE_LINES = ['module alu;', 'endmodule'] as const;

let root: string;
let workspace: string;
let outside: string;
let sourcePath: string;
let editor: FakeEditorHost;

function selection(elements: NotifySelection['elements'], displayName?: string): NotifySelection {
  return {
    kind: CxpMessageKind.notifySelection,
    elements,
    ...(displayName !== undefined ? { displayName } : {}),
    metadata: {},
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'crux-notify-selection-')));
  workspace = join(root, 'workspace');
  outside = join(root, 'outside');
  await mkdir(join(workspace, 'rtl'), { recursive: true });
  await mkdir(outside, { recursive: true });
  sourcePath = join(workspace, 'rtl', 'alu.sv');
  await writeFile(sourcePath, `${FILE_LINES.join('\n')}\n`);
  await writeFile(join(outside, 'secrets.txt'), 'private key\n');
  editor = new FakeEditorHost([workspace], new Map([[sourcePath, FILE_LINES]]));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('SelectionPresenter — announcing', () => {
  it('announces every inbound selection, with the sender', async () => {
    const presenter = new SelectionPresenter({ editor });
    const seen: InboundSelection[] = [];
    presenter.onDidReceiveSelection.listen((event) => seen.push(event));
    await presenter.present(
      selection([{ kind: 'signal', path: 'top.cpu.alu.result' }], 'alu.result'),
      FROM,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.displayName).toBe('alu.result');
    expect(seen[0]?.from.peerId).toBe(FROM.peerId);
  });

  it('announces even when nothing can be revealed', async () => {
    const presenter = new SelectionPresenter({ editor });
    const seen: InboundSelection[] = [];
    presenter.onDidReceiveSelection.listen((event) => seen.push(event));
    // A design path is not a file: only the stems index (`names/`) can map
    // it, so the window announces and reveals nothing.
    const outcome = await presenter.present(
      selection([{ kind: 'signal', path: 'top.cpu.alu.result' }]),
      FROM,
    );
    expect(outcome).toBe('announced');
    expect(seen).toHaveLength(1);
    expect(editor.shown).toEqual([]);
  });

  it('announces before revealing, and still announces when revealing is off', async () => {
    const presenter = new SelectionPresenter({
      editor,
      settings: () => ({
        ...DEFAULT_CROSS_PROBE_SETTINGS,
        revealSelection: false,
      }),
    });
    const seen: InboundSelection[] = [];
    presenter.onDidReceiveSelection.listen((event) => seen.push(event));
    const outcome = await presenter.present(
      selection([{ kind: SOURCE_ELEMENT_KIND, path: sourcePath }]),
      FROM,
    );
    expect(outcome).toBe('suppressed');
    expect(seen).toHaveLength(1);
    expect(editor.shown).toEqual([]);
  });
});

describe('SelectionPresenter — revealing without stealing focus', () => {
  it('reveals a source element as a preview tab, keeping focus', async () => {
    const presenter = new SelectionPresenter({ editor });
    const outcome = await presenter.present(
      selection([{ kind: SOURCE_ELEMENT_KIND, path: sourcePath }]),
      FROM,
    );
    expect(outcome).toBe('revealed');
    expect(editor.shown).toHaveLength(1);
    // The focus rule in its in-window form: the tab comes forward, the caret
    // does not move out from under a typing user, no window is raised.
    expect(editor.shown[0]?.options).toEqual({ preserveFocus: true, preview: true });
    expect(editor.shown[0]?.position).toEqual({ line: 0, character: 0 });
  });

  it('reveals on by default', async () => {
    const presenter = new SelectionPresenter({ editor });
    expect(
      await presenter.present(selection([{ kind: SOURCE_ELEMENT_KIND, path: sourcePath }]), FROM),
    ).toBe('revealed');
  });

  it('picks the first source element and ignores design elements around it', async () => {
    const presenter = new SelectionPresenter({ editor });
    await presenter.present(
      selection([
        { kind: 'signal', path: 'top.cpu.alu.result' },
        { kind: SOURCE_ELEMENT_KIND, path: sourcePath },
      ]),
      FROM,
    );
    expect(editor.shown[0]?.fsPath).toBe(sourcePath);
  });

  it('applies the §11 containment rule to a source element too', async () => {
    // `notify_selection` has no ack, so a hostile path cannot be refused —
    // it is simply not opened.
    const presenter = new SelectionPresenter({ editor });
    const outcome = await presenter.present(
      selection([{ kind: SOURCE_ELEMENT_KIND, path: join(outside, 'secrets.txt') }]),
      FROM,
    );
    expect(outcome).toBe('announced');
    expect(editor.shown).toEqual([]);
  });

  it('degrades to announced when the editor cannot open the file', async () => {
    editor.openRejects = true;
    const presenter = new SelectionPresenter({ editor });
    expect(
      await presenter.present(selection([{ kind: SOURCE_ELEMENT_KIND, path: sourcePath }]), FROM),
    ).toBe('announced');
  });

  it('stops announcing once disposed', async () => {
    const presenter = new SelectionPresenter({ editor });
    const seen: InboundSelection[] = [];
    presenter.onDidReceiveSelection.listen((event) => seen.push(event));
    presenter.dispose();
    await presenter.present(selection([{ kind: 'signal', path: 'top.a' }]), FROM);
    expect(seen).toEqual([]);
  });
});
