/**
 * **Click a failing property → the waveform opens in the WaveCrux tab
 * beside it.** The suite demo, running inside one editor window.
 *
 * ### The route, and why this one
 *
 * Three routes were available and only one of them works today.
 *
 * 1. *A command WaveCrux contributes.* WaveCrux contributes exactly one,
 *    `wavecrux.openPanel`, and it takes no argument — there is nothing to
 *    hand a path to. Rejected on the facts.
 * 2. *CXP `request_open_artifact` through host-core.* The protocol-native
 *    answer for reaching a desktop app — its payload is keyed on a
 *    `design_id` (`cxpDesignIdForPath`, rooted at the `simcrux.yaml`
 *    directory, *not* the VCD's; ported and conformance-tested in
 *    host-core's `cxp/design-id.ts`). But it is the wrong shape for this
 *    job: CXP addresses the **desktop** peer, and the whole point of this
 *    gesture is that the waveform opens *in this window*.
 * 3. **`vscode.openWith` against `wavecrux.waveform`.** Chosen. A
 *    `viewType` in a manifest is a public id — it is what lands in a
 *    user's `workbench.editorAssociations` — so naming it reaches into no
 *    internals; SimCrux imports nothing from the WaveCrux package, and the
 *    literal lives in host-core (`editor/peer-extension.ts`) precisely so
 *    the two cannot drift. `ViewColumn.Beside` is what makes it *beside*:
 *    the test tree stays where it is and the trace opens next to it.
 *
 * ### What it takes, end to end
 *
 * A failing bounded proof, and then five things in order:
 *
 * 1. `sby` writes a counterexample VCD and announces it; the `riscv_formal`
 *    driver resolves it and records it on `TestResult.waveformPath` (B4).
 * 2. The run writes `results.ndjson`, carrying `waveform_path` and the
 *    `riscv.formal.*` metrics on that row.
 * 3. This extension reads the file and marks the node with a
 *    counterexample — gated on the *exact* mirror of the CXP producer's
 *    rule (`hasCounterexample`): formal row, verdict `FAIL`, non-empty
 *    path. `UNKNOWN` and `TIMEOUT` never offer it, because offering it
 *    would assert a counterexample exists.
 * 4. The user runs the command from the failing test.
 * 5. `vscode.openWith(uri, 'wavecrux.waveform', Beside)`.
 *
 * Between 3 and 5 sit the two states that make this a *handoff* rather
 * than a function call, and both are answered here rather than left to
 * fail: the WaveCrux extension may not be installed, and the trace file
 * may not be on this machine.
 *
 * ### When WaveCrux is not installed
 *
 * SimCrux ships standalone, so this is an ordinary state, not an error.
 * The user gets a boundary message that names what the other extension
 * would do and offers one link — the same treatment `../handoff.ts` gives
 * a missing desktop app, and deliberately not a broken command.
 *
 * ### When the trace is not on this machine
 *
 * A regression that ran on CI or a farm records absolute paths from
 * *there*. Opening a path that does not exist would produce an empty
 * editor with no explanation, so the missing file is stated as what it is.
 * This is the product boundary made concrete: the editor surface
 * serves the local loop, and it says so instead of pretending.
 *
 * Every dependency is injected, so both boundaries and the success path
 * are asserted without an extension host — including the exact URI and
 * `viewType` the command resolves to.
 */
import * as vscode from 'vscode';
import { editor } from '@crux-vscode/host-core';

/** What [openCounterexampleInWaveCrux] did. */
export type CounterexampleHandoffOutcome =
  /** The trace was opened in a WaveCrux tab beside the current one. */
  | { readonly kind: 'opened'; readonly waveformPath: string }
  /** The row has no counterexample to open. */
  | { readonly kind: 'no-counterexample' }
  /** The path is recorded but no such file is on this machine. */
  | { readonly kind: 'trace-missing'; readonly waveformPath: string }
  /** WaveCrux is not installed here. [followed] is whether the link was taken. */
  | { readonly kind: 'wavecrux-absent'; readonly followed: boolean }
  /** The editor host refused the open. */
  | { readonly kind: 'failed'; readonly reason: string };

/** Injected environment for [openCounterexampleInWaveCrux]. */
export interface CounterexampleHandoffDeps {
  /** The counterexample VCD, or undefined when the row has none. */
  readonly waveformPath: string | undefined;
  /** Whether the path exists on this machine. Production: `existsSync`. */
  readonly pathExists: (fsPath: string) => boolean;
  /** Production: `vscode.extensions.getExtension(id) !== undefined`. */
  readonly isExtensionInstalled: (extensionId: string) => boolean;
  /**
   * Open [waveformPath] with [viewType] beside the active tab.
   * Production: `commands.executeCommand('vscode.openWith', Uri.file(p),
   * viewType, ViewColumn.Beside)`.
   */
  readonly openWith: (waveformPath: string, viewType: string) => Promise<void>;
  /**
   * Open a URI. Production: `vscode.env.openExternal`. The one URL this
   * passes is `vscode:extension/…`, which VSCode resolves *in the window*
   * — the Extensions view, not a browser.
   */
  readonly openUrl: (url: string) => Promise<void>;
  /** Non-modal message with optional buttons; resolves to the chosen label. */
  readonly showMessage: (
    message: string,
    ...actions: readonly string[]
  ) => Promise<string | undefined>;
}

/** The sentence shown when WaveCrux is not installed in this window. */
export function waveCruxAbsentMessage(): string {
  return vscode.l10n.t(
    'SimCrux found the counterexample trace, but the WaveCrux extension is not installed in this window, so there is nothing here that can display a waveform. Install WaveCrux and the trace opens in a tab beside this one.',
  );
}

/** Label on the boundary message's one button. */
export function getWaveCruxLabel(): string {
  return vscode.l10n.t('Get WaveCrux');
}

/** Shown when the recorded trace is not on this machine. */
export function traceMissingMessage(waveformPath: string): string {
  return vscode.l10n.t(
    'The counterexample trace for this property is recorded at {0}, but that file is not on this machine. Regressions that run on CI or a farm record their paths there; fetch the trace locally to open it.',
    waveformPath,
  );
}

/** Shown when the row simply has no counterexample. */
export function noCounterexampleMessage(): string {
  return vscode.l10n.t(
    'This property has no counterexample trace. Only a proof that SymbiYosys refuted — verdict FAIL — produces one; a proof the engine could not decide has nothing to show.',
  );
}

/**
 * Open a failing property's counterexample in the WaveCrux tab beside the
 * current one.
 *
 * Never throws: this runs from a command handler and from a terminal-link
 * activation, where an unhandled rejection is invisible to the user.
 */
export async function openCounterexampleInWaveCrux(
  deps: CounterexampleHandoffDeps,
): Promise<CounterexampleHandoffOutcome> {
  const waveformPath = deps.waveformPath;
  if (waveformPath === undefined || waveformPath === '') {
    await deps.showMessage(noCounterexampleMessage());
    return { kind: 'no-counterexample' };
  }

  // Order matters. The trace is checked *before* the extension, because
  // "the file is not here" is true whether or not WaveCrux is installed,
  // and pitching an install to open a file that does not exist would be
  // both useless and slightly dishonest.
  if (!deps.pathExists(waveformPath)) {
    await deps.showMessage(traceMissingMessage(waveformPath));
    return { kind: 'trace-missing', waveformPath };
  }

  const outcome = await editor.openInPeerExtensionEditor(
    'wavecrux',
    editor.WAVEFORM_CUSTOM_EDITOR_VIEW_TYPE,
    {
      isExtensionInstalled: deps.isExtensionInstalled,
      openWith: (viewType) => deps.openWith(waveformPath, viewType),
    },
  );

  switch (outcome.kind) {
    case 'opened':
      return { kind: 'opened', waveformPath };
    case 'failed':
      return { kind: 'failed', reason: outcome.reason };
    case 'not-installed': {
      const choice = await deps.showMessage(waveCruxAbsentMessage(), getWaveCruxLabel());
      if (choice === getWaveCruxLabel()) {
        await deps.openUrl(editor.cruxExtensionMarketplaceUri('wavecrux'));
        return { kind: 'wavecrux-absent', followed: true };
      }
      return { kind: 'wavecrux-absent', followed: false };
    }
  }
}
