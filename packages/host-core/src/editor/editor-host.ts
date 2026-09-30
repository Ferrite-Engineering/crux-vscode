import * as vscode from 'vscode';
import type { EditorSelectionSnapshot } from './send';

/**
 * A zero-based caret position, in VSCode's coordinate space.
 *
 * **Zero-based, unlike the wire.** CXP `line` and `column` are 1-based
 * (§9.6) and `vscode.Position` is 0-based; the conversion happens exactly
 * once, in `open-source.ts`, and this type exists so the two never meet as
 * bare numbers. An off-by-one here does not fail — it silently lands the
 * user one line away from the bug they were sent to, which is worse.
 */
export interface EditorPosition {
  /** Zero-based line index. */
  readonly line: number;
  /** Zero-based character offset within the line. */
  readonly character: number;
}

/** How an editor should be brought up. */
export interface ShowDocumentOptions {
  /**
   * Leave keyboard focus where it is. Always `true` for anything triggered
   * by a *statement* from a peer (`notify_selection`); configurable for a
   * *request* the user just made in the other app.
   */
  readonly preserveFocus: boolean;
  /** Open as a preview tab (italic, replaced by the next preview). */
  readonly preview: boolean;
  /**
   * Which editor group to open in — a `vscode.ViewColumn` value. Omitted
   * means the active group, which is `showTextDocument`'s own default.
   *
   * Exists for one measured reason. A waveform panel *is* an editor tab, so
   * when the user clicks a signal in it the active group is the waveform's
   * own — and revealing the RTL there covers the panel they are driving.
   * Live verification, first run: the source opened correctly at the right
   * line and the waveform disappeared behind it, so the second click of the
   * gesture had nothing to click on. A number rather than an enum because
   * host-core is unit-tested without a `vscode` module; the *choice* of
   * column belongs to the surface that knows the layout (see
   * `wavecrux/src/extension.ts`), not to this seam.
   */
  readonly viewColumn?: number;
}

/** Just enough of an open document to clamp a caret into it. */
export interface EditorDocument {
  /** Real filesystem path of the document. */
  readonly fsPath: string;
  /** Number of lines. Always ≥ 1 for a document VSCode opened. */
  readonly lineCount: number;
  /** Length in characters of the zero-based [line]. */
  lineLength(line: number): number;
}

/**
 * The editor operations this module needs, behind an interface.
 *
 * host-core is unit-tested under plain Node with a stand-in `vscode`
 * module, which cannot open documents. Everything that touches the real
 * editor goes through here so the *logic* — containment, clamping, ack
 * shape, focus policy — is tested against a fake, and the thin adapter that
 * is not worth unit-testing is [vscodeEditorHost].
 */
export interface EditorHost {
  /**
   * Absolute paths of the folders the user has opened. The consent
   * boundary for every inbound path (CXP §11).
   */
  workspaceFolders(): readonly string[];
  /** Open [fsPath] without showing it. Rejects if it cannot be read. */
  openTextDocument(fsPath: string): Promise<EditorDocument>;
  /** Bring [document] up with the caret at [position]. */
  showTextDocument(
    document: EditorDocument,
    position: EditorPosition,
    options: ShowDocumentOptions,
  ): Promise<void>;
  /**
   * Open [fsPath] in whichever editor VSCode considers its default — the
   * WaveCrux custom editor for a `.vcd`, the text editor for a `.sv`.
   *
   * Separate from [openTextDocument] because `request_open_artifact` names a
   * *file*, not a location in a text document, and half the artifact kinds
   * on the wire are not text: opening an FST through `openTextDocument`
   * would either fail or render a binary as garbage, in a window where the
   * extension that can render it properly may well be installed. Rejects if
   * the editor refuses the URI.
   */
  openArtifact(fsPath: string, options: ShowDocumentOptions): Promise<void>;
}

/** A quick-pick entry. Shaped like `vscode.QuickPickItem`, minus the rest. */
export interface QuickPickChoice {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}

/** The user-interaction surface the outbound send command needs. */
export interface UserInterface {
  /** Ask the user to choose one of [choices]; `undefined` if dismissed. */
  showQuickPick<T extends QuickPickChoice>(
    choices: readonly T[],
    placeHolder: string,
  ): Promise<T | undefined>;
  /** Show a non-blocking information message. */
  showInformationMessage(message: string): void;
}

class VscodeDocument implements EditorDocument {
  constructor(private readonly document: vscode.TextDocument) {}

  get fsPath(): string {
    return this.document.uri.fsPath;
  }

  get lineCount(): number {
    return this.document.lineCount;
  }

  lineLength(line: number): number {
    return this.document.lineAt(line).text.length;
  }

  /** The wrapped document, for [vscodeEditorHost]'s own use. */
  get raw(): vscode.TextDocument {
    return this.document;
  }
}

/**
 * The real [EditorHost], backed by the `vscode` API.
 *
 * Note what is *absent*: nothing here raises or focuses the VSCode window.
 * `showTextDocument` moves focus within the window when asked to and never
 * beyond it — the rule that a message from another application never
 * steals focus holds because there is no call site that could break it.
 */
export const vscodeEditorHost: EditorHost = {
  workspaceFolders(): readonly string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  },

  async openTextDocument(fsPath: string): Promise<EditorDocument> {
    return new VscodeDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath)));
  },

  async showTextDocument(
    document: EditorDocument,
    position: EditorPosition,
    options: ShowDocumentOptions,
  ): Promise<void> {
    if (!(document instanceof VscodeDocument)) {
      throw new TypeError('vscodeEditorHost.showTextDocument: foreign EditorDocument');
    }
    const caret = new vscode.Position(position.line, position.character);
    await vscode.window.showTextDocument(document.raw, {
      selection: new vscode.Selection(caret, caret),
      preserveFocus: options.preserveFocus,
      preview: options.preview,
      // Omitted, not `undefined`-assigned: `showTextDocument` treats an
      // explicit `undefined` the same way here, but leaving the key off
      // keeps the "active group" default legible in a debugger.
      ...(options.viewColumn !== undefined ? { viewColumn: options.viewColumn } : {}),
    });
  },

  async openArtifact(fsPath: string, options: ShowDocumentOptions): Promise<void> {
    // `vscode.open` is the command VSCode routes through its own editor
    // resolution, so a `.vcd` lands in WaveCrux's CustomEditorProvider when
    // that extension is installed and in the text editor when it is not.
    // Reimplementing that choice here would mean this window opened a
    // waveform as text next to an extension that could have drawn it.
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fsPath), {
      preserveFocus: options.preserveFocus,
      preview: options.preview,
      ...(options.viewColumn !== undefined ? { viewColumn: options.viewColumn } : {}),
    });
  },
};

/** The real [UserInterface], backed by the `vscode` API. */
export const vscodeUserInterface: UserInterface = {
  async showQuickPick<T extends QuickPickChoice>(
    choices: readonly T[],
    placeHolder: string,
  ): Promise<T | undefined> {
    return await vscode.window.showQuickPick<T & vscode.QuickPickItem>(
      choices as readonly (T & vscode.QuickPickItem)[],
      { placeHolder },
    );
  },

  showInformationMessage(message: string): void {
    // Fire-and-forget: the thenable resolves when the toast is dismissed,
    // which is not something any caller here should wait on.
    void vscode.window.showInformationMessage(message);
  },
};

/**
 * Read [editor]'s current selection as an [EditorSelectionSnapshot] — the
 * real counterpart of the type `send.ts` defines and every "Send to <peer>"
 * / cross-probe command consumes.
 *
 * No production caller built this until NetCrux's context-menu "what drives
 * this" command needed to turn a right-clicked register into a
 * [RequestHighlight][../cxp/messages.RequestHighlight]; it lives beside
 * [vscodeEditorHost] and [vscodeUserInterface] rather than in that product's
 * package because the type it fills in belongs to host-core and every one of
 * the four products will eventually need the same reading of "what did the
 * user select right now" for their own send commands.
 *
 * Mirrors [noEditorSelectionMessage]'s own description: the selected text
 * when there is a non-empty selection, otherwise the word under the caret.
 * Returns `undefined` for an empty selection with no word at the caret
 * (whitespace, punctuation, an empty line) — there is nothing to resolve.
 */
export function vscodeCurrentSelectionSnapshot(
  editor: vscode.TextEditor,
): EditorSelectionSnapshot | undefined {
  const document = editor.document;
  const selection = editor.selection;
  const range = selection.isEmpty
    ? document.getWordRangeAtPosition(selection.active)
    : selection;
  if (range === undefined) return undefined;

  const identifier = document.getText(range).trim();
  if (identifier.length === 0) return undefined;

  return {
    identifier,
    fsPath: document.uri.fsPath,
    // CXP counts lines and columns from 1 (§9.6); `Position` counts from 0.
    line: range.start.line + 1,
    column: range.start.character + 1,
  };
}
