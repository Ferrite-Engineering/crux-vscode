import type { ElementId } from '../cxp/element-id';
import { Emitter } from '../cxp/emitter';
import type { PeerIdentity } from '../cxp/identity';
import type { JsonObject } from '../cxp/json';
import type { NotifySelection } from '../cxp/messages';
import type { CxpStreamCoordinate } from '../cxp/stream-coordinate';
import type { EditorHost } from './editor-host';
import { DEFAULT_CROSS_PROBE_SETTINGS, type CrossProbeSettings } from './settings';
import { resolveWorkspacePath } from './workspace-paths';

/**
 * The element kind whose `path` is a source file rather than a design path
 * (CXP §8.2). The one kind in the vocabulary this window can act on
 * without a product surface installed.
 */
export const SOURCE_ELEMENT_KIND = 'source';

/** An inbound `notify_selection` (CXP §9.3), with its sender. */
export interface InboundSelection {
  /** The peer's selection, in the peer's own order. */
  readonly elements: readonly ElementId[];
  /**
   * Human-readable label the sender supplied.
   *
   * **Untrusted** (CXP §11): plain text only, never markup, never a shell
   * argument. Anything rendering this must escape it.
   */
  readonly displayName?: string;
  /** Semantic stream coordinate (§9.9). */
  readonly coordinate?: CxpStreamCoordinate;
  /** Free-form sender context; unknown keys are ignored. */
  readonly metadata: JsonObject;
  /** Who announced it. */
  readonly from: PeerIdentity;
}

/** What [SelectionPresenter.present] actually did. */
export type SelectionPresentation =
  /** A tab was brought forward, without taking focus. */
  | 'revealed'
  /** Listeners were told; nothing was revealed. */
  | 'announced'
  /** Revealing is switched off in settings; listeners were still told. */
  | 'suppressed';

/** Construction options for [SelectionPresenter]. */
export interface SelectionPresenterOptions {
  /** The editor to reveal in. */
  readonly editor: EditorHost;
  /** Focus/reveal policy. Read live so a settings change takes effect. */
  readonly settings?: () => CrossProbeSettings;
  /** Symlink resolver, injectable for tests. */
  readonly realpath?: (path: string) => Promise<string>;
  /** Platform tag for path-case comparison, injectable for tests. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Surfaces an inbound `notify_selection` **without stealing focus**.
 *
 * ### Where the focus rule applies, and where it does not
 *
 * A cross-probe message may request attention but never steal focus, and
 * that rule is absolute for the cross-process case: nothing here raises the VSCode window, bounces the dock,
 * or calls any API that would. There is no such call site in this module.
 *
 * Inside a single window, though, "bring the relevant tab forward" is not
 * that. No application loses focus, no window is raised, and the reveal is
 * done with `preserveFocus: true` and `preview: true`, so a user mid-word
 * keeps their caret and the tab replaces the previous preview instead of
 * accumulating. That is the behaviour
 * [CrossProbeSettings.revealSelection] governs, and it defaults on.
 *
 * ### Why so little happens without a surface
 *
 * `notify_selection` is a *statement* — not acknowledged, no reply (§9.3) —
 * and its elements are design paths (`top.cpu.alu.result`), not files. A
 * bare VSCode window cannot map one to a location; that is what the stems
 * index and the product surfaces are for. So the presenter does two honest
 * things: it announces the selection on [onDidReceiveSelection] for
 * whatever is listening (the status surface, a product's own view), and it
 * reveals the file when — and only when — the peer named one directly with
 * a `source` element, which still goes through the §11 workspace
 * containment check.
 */
export class SelectionPresenter {
  /**
   * Fires for every inbound selection, before any reveal and regardless of
   * settings. This is the "surface it" half; the reveal is the optional
   * half.
   */
  readonly onDidReceiveSelection = new Emitter<InboundSelection>();

  constructor(private readonly options: SelectionPresenterOptions) {}

  /** Announce [message], and reveal a source tab if it named one. */
  async present(message: NotifySelection, from: PeerIdentity): Promise<SelectionPresentation> {
    const selection: InboundSelection = {
      elements: message.elements,
      ...(message.displayName !== undefined ? { displayName: message.displayName } : {}),
      ...(message.coordinate !== undefined ? { coordinate: message.coordinate } : {}),
      metadata: message.metadata,
      from,
    };
    this.onDidReceiveSelection.emit(selection);

    const settings = this.options.settings?.() ?? DEFAULT_CROSS_PROBE_SETTINGS;
    if (!settings.revealSelection) return 'suppressed';

    const sourceElement = message.elements.find(
      (element) => element.kind === SOURCE_ELEMENT_KIND,
    );
    if (sourceElement === undefined) return 'announced';

    const resolved = await resolveWorkspacePath(sourceElement.path, {
      workspaceFolders: this.options.editor.workspaceFolders(),
      ...(this.options.realpath !== undefined ? { realpath: this.options.realpath } : {}),
      ...(this.options.platform !== undefined ? { platform: this.options.platform } : {}),
    });
    // A path outside the workspace is simply not revealed. No ack exists
    // for `notify_selection`, so there is nothing to report and nothing to
    // report it on — the announcement above already happened.
    if (!resolved.ok) return 'announced';

    try {
      const document = await this.options.editor.openTextDocument(resolved.fsPath);
      await this.options.editor.showTextDocument(
        document,
        { line: 0, character: 0 },
        { preserveFocus: true, preview: true },
      );
      return 'revealed';
    } catch {
      return 'announced';
    }
  }

  /** Drop every listener. */
  dispose(): void {
    this.onDidReceiveSelection.clear();
  }
}
