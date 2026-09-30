import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { vscodeCurrentSelectionSnapshot } from '../../src/editor/editor-host';

/**
 * `vscodeCurrentSelectionSnapshot` never calls into the `vscode` namespace
 * itself — it only reads the `TextEditor` it is handed — so it is exercised
 * here against plain fakes rather than the `vscode-mock.mjs` stand-in, the
 * same way [FakeUserInterface] in `harness.ts` exercises `UserInterface`
 * without a real quick-pick.
 */

interface FakePosition {
  readonly line: number;
  readonly character: number;
}

function position(line: number, character: number): FakePosition {
  return { line, character };
}

interface FakeRange {
  readonly start: FakePosition;
  readonly end: FakePosition;
}

function fakeEditor(options: {
  readonly fsPath: string;
  readonly text: Record<string, string>;
  readonly selection: { readonly isEmpty: boolean; readonly active: FakePosition } & FakeRange;
  readonly wordRangeAt?: (position: FakePosition) => FakeRange | undefined;
}): vscode.TextEditor {
  const document = {
    uri: { fsPath: options.fsPath },
    getText: (range: FakeRange) => options.text[rangeKey(range)] ?? '',
    getWordRangeAtPosition: (pos: FakePosition) => options.wordRangeAt?.(pos),
  };
  return {
    document,
    selection: options.selection,
  } as unknown as vscode.TextEditor;
}

function rangeKey(range: FakeRange): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

describe('vscodeCurrentSelectionSnapshot', () => {
  it('uses the selected text, converting to 1-based line/column', () => {
    const start = position(213, 8);
    const end = position(213, 18);
    const editor = fakeEditor({
      fsPath: '/ws/rtl/alu.sv',
      text: { [rangeKey({ start, end })]: 'alu_result' },
      selection: { isEmpty: false, active: end, start, end },
    });

    expect(vscodeCurrentSelectionSnapshot(editor)).toEqual({
      identifier: 'alu_result',
      fsPath: '/ws/rtl/alu.sv',
      line: 214,
      column: 9,
    });
  });

  it('falls back to the word under the caret when the selection is empty', () => {
    const caret = position(41, 12);
    const wordStart = position(41, 10);
    const wordEnd = position(41, 20);
    const editor = fakeEditor({
      fsPath: '/ws/rtl/top.sv',
      text: { [rangeKey({ start: wordStart, end: wordEnd })]: 'alarm_r' },
      selection: { isEmpty: true, active: caret, start: caret, end: caret },
      wordRangeAt: (pos) =>
        pos.line === caret.line && pos.character === caret.character
          ? { start: wordStart, end: wordEnd }
          : undefined,
    });

    expect(vscodeCurrentSelectionSnapshot(editor)).toEqual({
      identifier: 'alarm_r',
      fsPath: '/ws/rtl/top.sv',
      line: 42,
      column: 11,
    });
  });

  it('returns undefined when nothing is selected and there is no word at the caret', () => {
    const caret = position(0, 0);
    const editor = fakeEditor({
      fsPath: '/ws/rtl/top.sv',
      text: {},
      selection: { isEmpty: true, active: caret, start: caret, end: caret },
      wordRangeAt: () => undefined,
    });

    expect(vscodeCurrentSelectionSnapshot(editor)).toBeUndefined();
  });

  it('returns undefined for a selection that is only whitespace', () => {
    const start = position(5, 0);
    const end = position(5, 4);
    const editor = fakeEditor({
      fsPath: '/ws/rtl/top.sv',
      text: { [rangeKey({ start, end })]: '    ' },
      selection: { isEmpty: false, active: end, start, end },
    });

    expect(vscodeCurrentSelectionSnapshot(editor)).toBeUndefined();
  });
});
