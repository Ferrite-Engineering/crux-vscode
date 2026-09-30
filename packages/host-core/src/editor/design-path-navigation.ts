/**
 * Design path → the RTL line that declares it, revealed in the editor.
 *
 * The inverse of RTL annotation. Annotation carries waveform *values* into the
 * user's source; this carries the user's *selection* the other way: click a
 * signal in the waveform panel and the editor beside it lands on the line
 * where that signal is declared. Both directions read the same stems index,
 * which is what makes them agree about what a name means.
 *
 * ### What is deliberately not here
 *
 * No containment check of its own, and no second `showTextDocument` call.
 * [openContainedSourceLocation] in `open-source.ts` is *the* path from a
 * file path to an open editor, and §11 containment is the last place in this
 * codebase that should ever have two implementations. The path handed to it
 * has already been through `resolveWorkspacePath` once inside
 * [names.NameResolver.sourceLocationFor] — a stems file is workspace content
 * and entirely capable of naming `../../../.ssh/id_ed25519` — so the second
 * pass is a `realpath` of an already-real path plus a prefix comparison. It
 * is kept rather than skipped because "the value checked is the value
 * opened" has to hold *at the open site*, not two function calls upstream.
 *
 * ### Focus
 *
 * `preserveFocus: true, preview: true` — always, not configurably. The user
 * is interacting with a waveform panel in this very window; moving keyboard
 * focus into a text editor would take the next scroll wheel and the next
 * arrow key away from the thing they are actually driving. `preview` means
 * successive selections replace one tab instead of accumulating twenty. This
 * matches [SelectionPresenter]'s reveal, which is the same act arriving from
 * a different direction.
 */
import type { EditorHost } from './editor-host';
import { openContainedSourceLocation } from './open-source';

/** What a design path resolved to, or why it did not. Mirrors `names.ResolvedSourceLocation`. */
export interface DesignPathLocation {
  readonly ok: boolean;
  readonly fsPath?: string;
  readonly lineNumber?: number;
  readonly reason?: string;
}

/**
 * The forward half of `names.NameResolver`, as this module needs it.
 *
 * Structural, not the class: host-core's editor module must not depend on
 * its names module for one method, and a caller with a different index (a
 * test, a future hierarchy-only resolver) supplies its own.
 */
export interface DesignPathSourceResolver {
  sourceLocationFor(path: string): Promise<DesignPathLocation>;
}

/** What [revealDesignPathInEditor] did. */
export type DesignPathNavigation =
  /** The editor was brought up on the declaration line. */
  | { readonly kind: 'revealed'; readonly fsPath: string; readonly lineNumber: number }
  /** The setting is off. Nothing was resolved and nothing was opened. */
  | { readonly kind: 'disabled' }
  /** No stems entry maps this path to a file, or the file failed §11. */
  | { readonly kind: 'unresolved'; readonly reason: string }
  /** Resolved, but the editor refused to open it. */
  | { readonly kind: 'open-failed'; readonly reason: string };

/** Dependencies of [revealDesignPathInEditor]. */
export interface DesignPathNavigationOptions {
  /** Design path → declaration site. Usually a `names.NameResolver`. */
  readonly resolver: DesignPathSourceResolver;
  /** The editor to reveal in. */
  readonly editor: EditorHost;
  /**
   * Whether the user has opted in — `edacrux.crossProbe.followWaveformSelection`.
   *
   * Read **here**, before anything else happens, rather than at the call
   * site: with the setting off this function must cost nothing at all, not
   * an index lookup and a `realpath` whose result is then discarded. It is a
   * callback rather than a boolean so a settings change takes effect without
   * a reload, the same way `readCrossProbeSettings` is used everywhere else.
   */
  readonly enabled: () => boolean;
  /**
   * Which editor group to reveal in — a `vscode.ViewColumn` value.
   *
   * Supply the group the *panel is not in*. A waveform panel is an editor
   * tab, so the active group when the user clicks a signal is the panel's
   * own; revealing there hides the thing they are driving, which live
   * verification caught on the first run. Omitted means the active group,
   * which is right for a caller whose selection did not come from a tab.
   */
  readonly viewColumn?: () => number | undefined;
  /** Symlink resolver, injectable for tests. */
  readonly realpath?: (path: string) => Promise<string>;
  /** Platform tag for path-case comparison, injectable for tests. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Reveal the declaration of [designPath], if the user asked for that.
 *
 * Never throws: this runs off a webview message, and a selection the index
 * cannot resolve is the *normal* case for a workspace with no stems file.
 */
export async function revealDesignPathInEditor(
  designPath: string,
  options: DesignPathNavigationOptions,
): Promise<DesignPathNavigation> {
  if (!options.enabled()) return { kind: 'disabled' };
  if (designPath.length === 0) return { kind: 'unresolved', reason: 'empty path' };

  const location = await options.resolver.sourceLocationFor(designPath);
  if (!location.ok || location.fsPath === undefined || location.lineNumber === undefined) {
    return { kind: 'unresolved', reason: location.reason ?? 'unknown-path' };
  }

  const viewColumn = options.viewColumn?.();
  const outcome = await openContainedSourceLocation(
    { filePath: location.fsPath, line: location.lineNumber },
    {
      editor: options.editor,
      presentation: {
        preserveFocus: true,
        preview: true,
        ...(viewColumn !== undefined ? { viewColumn } : {}),
      },
      ...(options.realpath !== undefined ? { realpath: options.realpath } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    },
  );
  if (!outcome.honored) {
    return { kind: 'open-failed', reason: outcome.reason ?? 'open failed' };
  }
  return { kind: 'revealed', fsPath: location.fsPath, lineNumber: location.lineNumber };
}
