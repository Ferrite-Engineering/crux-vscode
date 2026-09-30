import * as vscode from 'vscode';
import type { NameIndex } from '../names/name-index';
import { pickElementPlaceholder } from '../editor/strings';
import type { AnnotationEntry, LineAnnotation } from './annotations';
import {
  RtlAnnotationController,
  type AnnotatableEditor,
  type AnnotationProfileSample,
  type AnnotationRenderer,
  type VisibleRange,
} from './controller';
import { hdlDialectFor } from './identifiers';
import type { AnnotationLimits } from './model';
import {
  RTL_ANNOTATION_SETTING_KEYS,
  readRtlAnnotationSettings,
  toggleRtlAnnotationEnabled,
} from './settings';
import {
  annotationAmbiguousHoverBody,
  annotationAmbiguousHoverTitle,
  annotationDisabledMessage,
  annotationEnabledMessage,
  annotationHoverTitle,
  annotationNoWaveformMessage,
  annotationPickLabel,
} from './strings';
import type { SignalValueSource } from './value-source';

/**
 * The `vscode` half of RTL annotation: the adapter, the decoration types, the
 * two commands, and the event wiring.
 *
 * Everything with a decision in it is in the sibling modules and is tested
 * without an extension host. What is left here is the part that can only be
 * verified by running it — in a real Extension Development Host, not by
 * trusting this file's shape.
 *
 * ### Two decoration types, not one
 *
 * A resolved value and an ambiguity have to be distinguishable *before* the
 * text is read, because the whole promise of the feature is that an
 * annotation can be glanced at. So they get different theme colors — a
 * value is `editorCodeLens.foreground` (the colour VSCode already uses for
 * ambient, non-source text), an ambiguity is `editorWarning.foreground`.
 * Theme colours rather than literals: this text sits inside the user's own
 * syntax highlighting and has to recede into whatever theme they chose.
 */

/** Command ids. `edacrux.*` for the reason `editor/send.ts` gives. */
export const RTL_ANNOTATION_COMMAND_IDS = {
  /** Flip `edacrux.rtlAnnotation.enabled`. */
  toggle: 'edacrux.toggleRtlAnnotation',
  /** Resolve one ambiguous identifier, from the hover's link. */
  pickSignal: 'edacrux.pickRtlAnnotationSignal',
} as const;

/** Arguments the hover's command link carries. */
interface PickSignalArguments {
  readonly fsPath: string;
  readonly identifier: string;
}

/** A `vscode.TextEditor` as the annotation loop wants to see it. */
export class VscodeAnnotatableEditor implements AnnotatableEditor {
  constructor(readonly editor: vscode.TextEditor) {}

  get fsPath(): string {
    return this.editor.document.uri.fsPath;
  }

  get languageId(): string {
    return this.editor.document.languageId;
  }

  /** 1-based and inclusive, converted from VSCode's 0-based ranges. */
  visibleRanges(): readonly VisibleRange[] {
    return this.editor.visibleRanges.map((range) => ({
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
    }));
  }

  lineText(line: number): string | undefined {
    const index = line - 1;
    if (index < 0 || index >= this.editor.document.lineCount) return undefined;
    return this.editor.document.lineAt(index).text;
  }
}

/** Paints annotations with two `TextEditorDecorationType`s. */
export class VscodeAnnotationRenderer implements AnnotationRenderer {
  private readonly value = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2em',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  private readonly ambiguous = vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 2em',
      color: new vscode.ThemeColor('editorWarning.foreground'),
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  render(editor: AnnotatableEditor, annotations: readonly LineAnnotation[]): void {
    if (!(editor instanceof VscodeAnnotatableEditor)) return;
    const values: vscode.DecorationOptions[] = [];
    const ambiguities: vscode.DecorationOptions[] = [];
    for (const annotation of annotations) {
      const resolved = annotation.entries.filter((entry) => entry.path !== undefined);
      const unresolved = annotation.entries.filter((entry) => entry.path === undefined);
      const anchor = endOfLine(editor.editor.document, annotation.line);
      if (anchor === undefined) continue;
      if (resolved.length > 0) {
        values.push({ range: anchor, ...decoration(resolved, editor.fsPath, false) });
      }
      if (unresolved.length > 0) {
        ambiguities.push({ range: anchor, ...decoration(unresolved, editor.fsPath, true) });
      }
    }
    editor.editor.setDecorations(this.value, values);
    editor.editor.setDecorations(this.ambiguous, ambiguities);
  }

  clear(editor: AnnotatableEditor): void {
    if (!(editor instanceof VscodeAnnotatableEditor)) return;
    editor.editor.setDecorations(this.value, []);
    editor.editor.setDecorations(this.ambiguous, []);
  }

  dispose(): void {
    this.value.dispose();
    this.ambiguous.dispose();
  }
}

/** A zero-width range at the end of a 1-based line, or `undefined`. */
function endOfLine(document: vscode.TextDocument, line: number): vscode.Range | undefined {
  const index = line - 1;
  if (index < 0 || index >= document.lineCount) return undefined;
  const end = document.lineAt(index).range.end;
  return new vscode.Range(end, end);
}

/**
 * The rendered text and hover for one line's worth of entries.
 *
 * The inline text is joined with a wide space rather than a comma: it is
 * pseudo-source sitting at the end of a line of real source, and punctuation
 * makes it read as part of the code.
 */
function decoration(
  entries: readonly AnnotationEntry[],
  fsPath: string,
  ambiguous: boolean,
): { renderOptions: vscode.DecorationInstanceRenderOptions; hoverMessage: vscode.MarkdownString } {
  return {
    renderOptions: { after: { contentText: entries.map((entry) => entry.label).join('   ') } },
    hoverMessage: hover(entries, fsPath, ambiguous),
  };
}

function hover(
  entries: readonly AnnotationEntry[],
  fsPath: string,
  ambiguous: boolean,
): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  // Scoped to the one command this hover offers. A blanket `isTrusted: true`
  // would let any future markdown built here — including text derived from
  // the user's own file — invoke arbitrary commands.
  markdown.isTrusted = { enabledCommands: [RTL_ANNOTATION_COMMAND_IDS.pickSignal] };
  markdown.appendMarkdown(
    `**${ambiguous ? annotationAmbiguousHoverTitle() : annotationHoverTitle()}**\n\n`,
  );
  if (!ambiguous) {
    for (const entry of entries) {
      markdown.appendMarkdown(`\`${entry.path ?? ''}\` — \`${entry.value ?? ''}\`\n\n`);
    }
    return markdown;
  }
  markdown.appendMarkdown(`${annotationAmbiguousHoverBody()}\n\n`);
  for (const entry of entries) {
    for (const path of entry.ambiguousPaths ?? []) markdown.appendMarkdown(`- \`${path}\`\n`);
    const args: PickSignalArguments = { fsPath, identifier: entry.identifier };
    const encoded = encodeURIComponent(JSON.stringify([args]));
    markdown.appendMarkdown(
      `\n[${annotationPickLabel()}](command:${RTL_ANNOTATION_COMMAND_IDS.pickSignal}?${encoded})\n\n`,
    );
  }
  return markdown;
}

/** What the extension supplies to [registerRtlAnnotation]. */
export interface RtlAnnotationRegistrationOptions {
  /** The live stems index, or `undefined` until one is loaded. */
  readonly index: () => NameIndex | undefined;
  /** The waveform to ask. */
  readonly valueSource?: () => SignalValueSource | undefined;
  /** Viewport bounds. See [AnnotationLimits]. */
  readonly limits?: Partial<AnnotationLimits>;
  /** Coalescing window; the default is [DEFAULT_DEBOUNCE_MS]. */
  readonly debounceMs?: number;
  /** Every completed pass, measured. Wired to the product's output channel. */
  readonly onProfile?: (sample: AnnotationProfileSample) => void;
  /**
   * Called once per session, the first time annotations are painted. The
   * caller records `feature.used {feature: 'rtl_annotation'}`; nothing
   * derived from a path, a value or a file may be added to it.
   */
  readonly onFirstRender?: () => void;
}

/** The registration's handle: the controller, and everything to dispose. */
export interface RtlAnnotationRegistration extends vscode.Disposable {
  readonly controller: RtlAnnotationController;
  /** Recompute every visible HDL editor. Call when the waveform cursor moves. */
  refreshAll(): void;
}

/**
 * Wire RTL annotation into a window.
 *
 * Registers both commands, both decoration types, and the four events that
 * can change what should be on screen:
 *
 * - **scroll** (`onDidChangeTextEditorVisibleRanges`) — new lines to resolve;
 * - **active editor** — a different file, possibly not HDL at all;
 * - **document edit** — the text under an annotation moved;
 * - **the setting** — turning it off must clear immediately, not at the next
 *   scroll.
 *
 * The fifth trigger, the *waveform* cursor, does not arrive as a VSCode event
 * at all: it is pushed from the app over the bridge, and the surface calls
 * [RtlAnnotationRegistration.refreshAll] when it does.
 */
export function registerRtlAnnotation(
  options: RtlAnnotationRegistrationOptions,
): RtlAnnotationRegistration {
  const renderer = new VscodeAnnotationRenderer();
  /** Candidates for the last-rendered ambiguities, for the picker. */
  const ambiguities = new Map<string, readonly string[]>();
  const ambiguityKey = (fsPath: string, identifier: string): string =>
    `${fsPath} ${identifier.toLowerCase()}`;

  const recordingRenderer: AnnotationRenderer = {
    render(editor, annotations) {
      for (const annotation of annotations) {
        for (const entry of annotation.entries) {
          if (entry.ambiguousPaths === undefined) continue;
          ambiguities.set(ambiguityKey(editor.fsPath, entry.identifier), entry.ambiguousPaths);
        }
      }
      renderer.render(editor, annotations);
    },
    clear: (editor) => {
      renderer.clear(editor);
    },
  };

  const controller = new RtlAnnotationController({
    index: options.index,
    ...(options.valueSource !== undefined ? { valueSource: options.valueSource } : {}),
    renderer: recordingRenderer,
    isEnabled: () => readRtlAnnotationSettings().enabled,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
    ...(options.onProfile !== undefined ? { onProfile: options.onProfile } : {}),
    ...(options.onFirstRender !== undefined ? { onFirstRender: options.onFirstRender } : {}),
  });

  const refresh = (editor: vscode.TextEditor | undefined): void => {
    if (editor === undefined) return;
    if (hdlDialectFor(editor.document.languageId) === undefined) return;
    controller.refresh(new VscodeAnnotatableEditor(editor));
  };

  const refreshAll = (): void => {
    for (const editor of vscode.window.visibleTextEditors) refresh(editor);
  };

  const clearAll = (): void => {
    for (const editor of vscode.window.visibleTextEditors) {
      controller.clear(new VscodeAnnotatableEditor(editor));
    }
  };

  const subscriptions: vscode.Disposable[] = [
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      refresh(event.textEditor);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      refresh(editor);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === event.document) refresh(editor);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(RTL_ANNOTATION_SETTING_KEYS.enabled)) return;
      if (readRtlAnnotationSettings().enabled) refreshAll();
      else clearAll();
    }),
    vscode.commands.registerCommand(RTL_ANNOTATION_COMMAND_IDS.toggle, async () => {
      const enabled = await toggleRtlAnnotationEnabled();
      if (!enabled) {
        clearAll();
        vscode.window.showInformationMessage(annotationDisabledMessage());
        return;
      }
      refreshAll();
      // "It is on and nothing happened" is indistinguishable from "it is
      // broken", and with no waveform open that is exactly what the user
      // sees. Naming the missing input is the difference.
      const ready = options.valueSource?.()?.isReady() === true;
      vscode.window.showInformationMessage(
        ready ? annotationEnabledMessage() : annotationNoWaveformMessage(),
      );
    }),
    vscode.commands.registerCommand(
      RTL_ANNOTATION_COMMAND_IDS.pickSignal,
      async (args?: PickSignalArguments) => {
        if (args === undefined) return;
        const candidates = ambiguities.get(ambiguityKey(args.fsPath, args.identifier));
        if (candidates === undefined || candidates.length === 0) return;
        const picked = await vscode.window.showQuickPick(
          candidates.map((path) => ({ label: path })),
          { placeHolder: pickElementPlaceholder() },
        );
        if (picked === undefined) return;
        controller.pinned.set(args.fsPath, args.identifier, picked.label);
        refreshAll();
      },
    ),
    renderer,
    controller,
  ];

  if (readRtlAnnotationSettings().enabled) refreshAll();

  return {
    controller,
    refreshAll,
    dispose: () => {
      for (const subscription of subscriptions) subscription.dispose();
      ambiguities.clear();
    },
  };
}
