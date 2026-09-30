import type { RequestOpenSource } from '../cxp/messages';
import type { EditorHost, EditorPosition, ShowDocumentOptions } from './editor-host';
import { DEFAULT_CROSS_PROBE_SETTINGS, type CrossProbeSettings } from './settings';
import {
  reasonEditorOpenFailed,
  reasonFileNotFound,
  reasonNoFilePath,
  reasonNoWorkspaceFolder,
  reasonOutsideWorkspace,
} from './strings';
import { resolveWorkspacePath, type WorkspacePathRefusal } from './workspace-paths';

/**
 * The `honored` / `reason` pair a `*_ack` carries (CXP §9.5, §9.7).
 *
 * `honored: false` with a reason is a **normal outcome, not an error** —
 * the spec says so explicitly, and it is why nothing in this module throws
 * out to the caller. A refusal is an answer.
 */
export interface CxpAckOutcome {
  readonly honored: boolean;
  readonly reason?: string;
}

/** Dependencies of [handleRequestOpenSource]. */
export interface OpenSourceOptions {
  /** The editor to open in. */
  readonly editor: EditorHost;
  /** Symlink resolver, injectable for tests. */
  readonly realpath?: (path: string) => Promise<string>;
  /** Platform tag for path-case comparison, injectable for tests. */
  readonly platform?: NodeJS.Platform;
  /** Focus policy. Defaults to [DEFAULT_CROSS_PROBE_SETTINGS]. */
  readonly settings?: CrossProbeSettings;
}

/** Human-readable [reason] for each refusal, for the ack. */
function refusalReason(refusal: WorkspacePathRefusal): string {
  switch (refusal) {
    case 'empty-path':
      return reasonNoFilePath();
    case 'no-workspace':
      return reasonNoWorkspaceFolder();
    case 'outside-workspace':
      return reasonOutsideWorkspace();
    case 'not-found':
      return reasonFileNotFound();
  }
}

function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value)) return low;
  if (value < low) return low;
  if (value > high) return high;
  return value;
}

/**
 * Convert a 1-based CXP `line`/`column` to a caret position inside
 * [lineCount] lines, clamped to the document's real bounds.
 *
 * Exported for its own tests because the boundaries are where this goes
 * wrong quietly:
 *
 * - `line: 1` is the **first** line, index 0. Off by one here sends every
 *   cross-probe one line low.
 * - `line: 0` is not legal on the wire but peers send it (a 0-based
 *   producer that forgot to convert). Clamping to the first line lands the
 *   user in the right file rather than refusing the message.
 * - a line past EOF clamps to the last line, for the common case of a file
 *   edited since the stems/log that named the line was produced.
 * - `column` is optional and 1-based; absent means column 1. It clamps to
 *   the line's length *inclusive*, since end-of-line is a valid caret spot.
 */
export function caretForCxpLocation(
  line: number,
  column: number | undefined,
  document: { readonly lineCount: number; lineLength(line: number): number },
): EditorPosition {
  const lastLine = Math.max(0, document.lineCount - 1);
  const zeroBasedLine = clamp(Math.trunc(line) - 1, 0, lastLine);
  const requestedColumn = column === undefined ? 1 : Math.trunc(column);
  const zeroBasedCharacter = clamp(
    requestedColumn - 1,
    0,
    Math.max(0, document.lineLength(zeroBasedLine)),
  );
  return { line: zeroBasedLine, character: zeroBasedCharacter };
}

/** Dependencies of [openContainedSourceLocation]. */
export interface ContainedOpenOptions {
  /** The editor to open in. */
  readonly editor: EditorHost;
  /** How the editor should come up. See [ShowDocumentOptions]. */
  readonly presentation: ShowDocumentOptions;
  /** Symlink resolver, injectable for tests. */
  readonly realpath?: (path: string) => Promise<string>;
  /** Platform tag for path-case comparison, injectable for tests. */
  readonly platform?: NodeJS.Platform;
}

/**
 * **The** containment-checked open: resolve a path against the folders the
 * user opened, then show it with the caret on a 1-based line/column.
 *
 * Extracted from [handleRequestOpenSource] when a second caller appeared
 * (`design-path-navigation.ts`, the waveform-selection follow), and
 * deliberately extracted rather than copied. §11 containment is the kind of
 * check where the second implementation is always the one that is wrong, and
 * `realpath`-before-containment plus "open the value you checked" is a
 * two-line invariant that is easy to reproduce *almost* correctly.
 *
 * The one thing the two callers genuinely differ on is [presentation], and
 * that is a parameter precisely so it has to be stated at each call site:
 * a request the user just made in another app lands the caret; a selection
 * the user made in a panel in *this* window must not move focus out from
 * under them.
 *
 * Never throws. Every failure is a [CxpAckOutcome] with `honored: false`,
 * because for the `request_open_source` caller that is an ack the protocol
 * requires (§9.7) and for the other it is simply "nothing happened".
 */
export async function openContainedSourceLocation(
  location: { readonly filePath: string; readonly line: number; readonly column?: number },
  options: ContainedOpenOptions,
): Promise<CxpAckOutcome> {
  const resolved = await resolveWorkspacePath(location.filePath, {
    workspaceFolders: options.editor.workspaceFolders(),
    ...(options.realpath !== undefined ? { realpath: options.realpath } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
  });
  if (!resolved.ok) return { honored: false, reason: refusalReason(resolved.reason) };

  try {
    // Open the *resolved real path*, not the string that came in: the
    // containment check is only worth anything if the thing checked and the
    // thing opened are the same value.
    const document = await options.editor.openTextDocument(resolved.fsPath);
    await options.editor.showTextDocument(
      document,
      caretForCxpLocation(location.line, location.column, document),
      options.presentation,
    );
    return { honored: true };
  } catch {
    // A binary file, a permissions change between realpath and open, an
    // editor that refuses the URI: all of them are `honored: false`, and
    // none of them may take the extension host down or bubble into the
    // socket read loop.
    return { honored: false, reason: reasonEditorOpenFailed() };
  }
}

/**
 * Handle an inbound `request_open_source` (CXP §9.6) and produce the
 * `request_open_source_ack` outcome (§9.7).
 *
 * ### What this replaces
 *
 * `dispatchCxpOpenSource` in
 * `wavecrux/lib/services/remote/cxp/cxp_inbound_handlers.dart` reads a
 * `cxpEditorCommand` setting that defaults to empty, so out of the box it
 * answers `honored: false, reason: 'no editor command configured'` — the
 * mesh has a hole exactly where the engineer's attention lives. It then
 * shells out to whatever the user typed, appending `path:line:column` as an
 * argv token.
 *
 * Inside VSCode neither half is needed: the editor is already running and
 * already knows the workspace, so there is no command to configure and no
 * process to spawn. The `file_path` never reaches a shell (CXP §11), which
 * removes the whole class of quoting bug that the Dart implementation's
 * argv splitter exists to manage.
 *
 * ### What is still refused
 *
 * Everything `resolveWorkspacePath` refuses — see its docs for the threat.
 * A refusal is an ack, not an exception, and the reason never echoes the
 * peer's path back at it.
 */
export async function handleRequestOpenSource(
  request: RequestOpenSource,
  options: OpenSourceOptions,
): Promise<CxpAckOutcome> {
  const settings = options.settings ?? DEFAULT_CROSS_PROBE_SETTINGS;
  return await openContainedSourceLocation(
    {
      filePath: request.filePath,
      line: request.line,
      ...(request.column !== undefined ? { column: request.column } : {}),
    },
    {
      editor: options.editor,
      // A *request* the user just made in the other app: landing the caret
      // on the line is the point of it, and `preview: false` keeps the tab.
      presentation: { preserveFocus: !settings.openSourceFocusesEditor, preview: false },
      ...(options.realpath !== undefined ? { realpath: options.realpath } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    },
  );
}
