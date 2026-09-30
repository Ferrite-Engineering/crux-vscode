import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CxpMessageKind, type RequestOpenSource } from '../../src/cxp/messages';
import {
  caretForCxpLocation,
  handleRequestOpenSource,
} from '../../src/editor/open-source';
import { DEFAULT_CROSS_PROBE_SETTINGS } from '../../src/editor/settings';
import { FakeDocument, FakeEditorHost } from './harness';

const FILE_LINES = ['module alu;', '  wire [7:0] result;', 'endmodule'] as const;

let root: string;
let workspace: string;
let outside: string;
let sourcePath: string;
let editor: FakeEditorHost;

function request(filePath: string, line: number, column?: number): RequestOpenSource {
  return {
    kind: CxpMessageKind.requestOpenSource,
    filePath,
    line,
    ...(column !== undefined ? { column } : {}),
  };
}

beforeEach(async () => {
  // Canonical from the start — see workspace-paths.test.ts for why.
  root = await realpath(await mkdtemp(join(tmpdir(), 'crux-open-source-')));
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

describe('caretForCxpLocation — 1-based wire, 0-based editor', () => {
  const document = new FakeDocument('/x', FILE_LINES);

  it('maps line 1 to index 0', () => {
    expect(caretForCxpLocation(1, undefined, document)).toEqual({ line: 0, character: 0 });
  });

  it('maps column 1 to character 0', () => {
    expect(caretForCxpLocation(2, 1, document)).toEqual({ line: 1, character: 0 });
  });

  it('maps line/column n to n-1', () => {
    expect(caretForCxpLocation(2, 8, document)).toEqual({ line: 1, character: 7 });
  });

  it('clamps a 0 line a 0-based peer sent to the first line', () => {
    expect(caretForCxpLocation(0, undefined, document)).toEqual({ line: 0, character: 0 });
  });

  it('clamps a negative line to the first line', () => {
    expect(caretForCxpLocation(-5, undefined, document)).toEqual({ line: 0, character: 0 });
  });

  it('clamps a line past EOF to the last line', () => {
    expect(caretForCxpLocation(9999, undefined, document)).toEqual({ line: 2, character: 0 });
  });

  it('clamps a column past end-of-line to end-of-line inclusive', () => {
    // Line 2 is '  wire [7:0] result;' — 20 characters, so character 20 is
    // the valid caret position after the last one.
    expect(caretForCxpLocation(2, 9999, document)).toEqual({
      line: 1,
      character: FILE_LINES[1].length,
    });
  });

  it('clamps a 0 column to the first character', () => {
    expect(caretForCxpLocation(2, 0, document)).toEqual({ line: 1, character: 0 });
  });

  it('treats an absent column as column 1', () => {
    expect(caretForCxpLocation(3, undefined, document)).toEqual({ line: 2, character: 0 });
  });

  it('never returns a negative line for an empty document', () => {
    expect(caretForCxpLocation(1, 1, new FakeDocument('/x', []))).toEqual({
      line: 0,
      character: 0,
    });
  });
});

describe('handleRequestOpenSource — honored', () => {
  it('opens the file and lands the caret on the 1-based line/column', async () => {
    const ack = await handleRequestOpenSource(request(sourcePath, 2, 8), { editor });
    expect(ack).toEqual({ honored: true });
    expect(editor.shown).toHaveLength(1);
    expect(editor.shown[0]?.position).toEqual({ line: 1, character: 7 });
  });

  it('opens the resolved real path, not the string the peer sent', async () => {
    // The containment check is only worth something if the value checked
    // and the value opened are the same one.
    const viaDots = join(workspace, 'rtl', '..', 'rtl', 'alu.sv');
    const ack = await handleRequestOpenSource(request(viaDots, 1), { editor });
    expect(ack).toEqual({ honored: true });
    expect(editor.shown[0]?.fsPath).toBe(sourcePath);
  });

  it('focuses the editor by default and leaves the window alone', async () => {
    await handleRequestOpenSource(request(sourcePath, 1), { editor });
    expect(editor.shown[0]?.options).toEqual({ preserveFocus: false, preview: false });
  });

  it('preserves focus when the setting is off', async () => {
    await handleRequestOpenSource(request(sourcePath, 1), {
      editor,
      settings: { ...DEFAULT_CROSS_PROBE_SETTINGS, openSourceFocusesEditor: false },
    });
    expect(editor.shown[0]?.options.preserveFocus).toBe(true);
  });
});

describe('handleRequestOpenSource — honored:false is a normal outcome', () => {
  it('refuses a path outside the workspace without opening anything', async () => {
    const ack = await handleRequestOpenSource(request(join(outside, 'secrets.txt'), 1), {
      editor,
    });
    expect(ack.honored).toBe(false);
    expect(ack.reason).toBe('path is outside the open workspace');
    expect(editor.shown).toEqual([]);
  });

  it('refuses a symlink inside the workspace that escapes it', async () => {
    await symlink(join(outside, 'secrets.txt'), join(workspace, 'rtl', 'leak.sv'), 'file');
    const ack = await handleRequestOpenSource(request(join(workspace, 'rtl', 'leak.sv'), 1), {
      editor,
    });
    expect(ack.honored).toBe(false);
    expect(ack.reason).toBe('path is outside the open workspace');
    expect(editor.shown).toEqual([]);
  });

  it('refuses `..` traversal', async () => {
    const ack = await handleRequestOpenSource(
      request(join(workspace, '..', 'outside', 'secrets.txt'), 1),
      { editor },
    );
    expect(ack).toEqual({ honored: false, reason: 'path is outside the open workspace' });
  });

  it('refuses when no folder is open', async () => {
    const bare = new FakeEditorHost([], new Map());
    const ack = await handleRequestOpenSource(request(sourcePath, 1), { editor: bare });
    expect(ack).toEqual({ honored: false, reason: 'no workspace folder open' });
  });

  it('refuses a blank file_path', async () => {
    const ack = await handleRequestOpenSource(request('   ', 1), { editor });
    expect(ack).toEqual({ honored: false, reason: 'no file path given' });
  });

  it('refuses a missing file inside the workspace', async () => {
    const ack = await handleRequestOpenSource(request(join(workspace, 'rtl', 'gone.sv'), 1), {
      editor,
    });
    expect(ack).toEqual({ honored: false, reason: 'file not found in the open workspace' });
  });

  it('turns an editor failure into an ack rather than an exception', async () => {
    editor.openRejects = true;
    const ack = await handleRequestOpenSource(request(sourcePath, 1), { editor });
    expect(ack).toEqual({ honored: false, reason: 'the editor could not open the file' });
  });

  it('never echoes the peer-supplied path back in the reason', async () => {
    // CXP §11: the reason we send is rendered in the *peer's* UI. Echoing
    // an attacker-chosen string into another app is the hop to avoid.
    const hostile = join(outside, '<img src=x onerror=alert(1)>.txt');
    const ack = await handleRequestOpenSource(request(hostile, 1), { editor });
    expect(ack.honored).toBe(false);
    expect(ack.reason).not.toContain('<img');
    expect(ack.reason).not.toContain(outside);
  });
});
