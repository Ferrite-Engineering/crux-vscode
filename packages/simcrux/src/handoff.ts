/**
 * The product boundary, and the handoff across it.
 *
 * The line is drawn here, and this module is where a user meets it: the
 * **editor** runs the regression in front of you and shows this run's
 * results; the **app** holds the history — flakiness across seeds, trends,
 * run-to-run comparison, retention. Nothing in this extension rebuilds any
 * of that, so "show me the history" has to go somewhere, and this is the
 * somewhere.
 *
 * Two outcomes, decided by the same per-product desktop detection every
 * other surface uses (`desktop-detect/`):
 *
 * - **A SimCrux desktop peer is running** — hand the project over, through
 *   the command id host-core already names
 *   (`edacrux.openInDesktop.simcrux`).
 * - **No peer** — say what the app does that the editor does not, once, in
 *   a non-modal message, with a link. A *boundary message*, not a nag: it
 *   is shown only when the user asked for the history, which is exactly
 *   the moment the difference is worth explaining.
 *
 * ### `request_open_artifact`, with `openExternal` as the fallback
 *
 * All three product handoffs switched together, as their notes said they
 * would: the `design_id` derivation those notes deferred to the Dart side
 * is now a conformance-tested port in host-core
 * (`host-core/src/cxp/design-id.ts`), so the peer branch sends the protocol
 * message and only falls back to the OS when nothing answers.
 *
 * SimCrux is the product where the derivation's *input* matters most, and
 * the handoff picks it deliberately: the subject is the **`simcrux.yaml`**,
 * so the id is rooted at the project directory — the same directory
 * `publishWaveformWorkspaceArtifact` keys the dumps it produces by, and
 * emphatically **not** the output directory a VCD happens to land in.
 * Handing over the results file instead would key a build tree and join
 * nothing.
 *
 * Note this is a *different* question from the counterexample handoff in
 * `counterexample/handoff.ts`, which targets the WaveCrux **extension** in
 * this window rather than a desktop peer.
 *
 * ### What SimCrux does with it
 *
 * Its handler (`InboundRequestHandler` in the SimCrux open core,
 * `lib/features/remote/providers/inbound_request_handler.dart`) honours one
 * artifact kind, `source`, resolves the file through its own copy of the
 * shared workspace (falling back to the `path` hint), and then routes on
 * what the file is: a SimCrux project — a regression config, or a
 * `<design>.crux-project` naming one — opens as a config tab, the way File →
 * Open Project opens it; any other source file goes to the user's editor.
 * So this module must hand over a project file ([isSimCruxProjectFile]):
 * anything else would come back to this window as text.
 *
 * ### The contract with the receiver
 *
 * Asserted here by `test/handoff.test.ts` and on the SimCrux side by
 * `test/features/remote/providers/cxp_open_artifact_test.dart`:
 *
 * 1. the artifact kind is `source` ([SIMCRUX_ARTIFACT_KIND]);
 * 2. the path is absolute, carries no NUL, and is spelled exactly as it is
 *    on disk — no surrounding white space. That is the floor SimCrux holds
 *    a project open to, and the only path rule: it is not rooted in the
 *    projects SimCrux has opened, so a config it has never seen opens;
 * 3. the path names an existing SimCrux project file (`.yaml`, `.yml`, or a
 *    `.crux-project` manifest).
 *
 * Every dependency is injected, so both branches are tested without an
 * extension host.
 */
import * as vscode from 'vscode';
import { status } from '@crux-vscode/host-core';
import type { desktopDetect } from '@crux-vscode/host-core';

/**
 * The artifact kind SimCrux hands over: its project file is a `source`
 * artifact. (`waveform` is what SimCrux *produces*, and that is the
 * desktop app's upsert to make, not this extension's.)
 */
export const SIMCRUX_ARTIFACT_KIND = 'source';

/**
 * The files SimCrux opens as a config tab when a `source` artifact names
 * them, lowercase and with the dot: the regression config types File → Open
 * Project accepts, and the suite's design manifest.
 */
export const SIMCRUX_PROJECT_EXTENSIONS: readonly string[] = ['.yaml', '.yml', '.crux-project'];

/** Whether [fsPath] is a file SimCrux opens as a project, not in an editor. */
export function isSimCruxProjectFile(fsPath: string): boolean {
  const lower = fsPath.toLowerCase();
  return SIMCRUX_PROJECT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * The project to hand over: [configured] — the config this window's tree
 * and task already work against (`edacrux.sim.projectFile`) — when it is a
 * project file, otherwise whatever [searchWorkspace] finds.
 *
 * Both are checked, so neither a setting pointed at another kind of file
 * nor a drifting glob can hand SimCrux a file it would send to an editor.
 */
export async function pickSimCruxProjectFile(
  configured: string | undefined,
  searchWorkspace: () => Promise<string | undefined>,
): Promise<string | undefined> {
  if (configured !== undefined && isSimCruxProjectFile(configured)) return configured;
  const found = await searchWorkspace();
  return found !== undefined && isSimCruxProjectFile(found) ? found : undefined;
}

/** What [openHistoryInDesktop] did, for tests and telemetry. */
export type HistoryHandoffOutcome =
  /**
   * A peer was running and the project was handed over. [handoff] records
   * whether that went over CXP or fell back to the OS.
   */
  | {
      readonly kind: 'handed-off';
      readonly projectFile: string;
      readonly handoff: desktopDetect.ArtifactHandoffOutcome;
    }
  /** A peer was running but this workspace has no `simcrux.yaml` to open. */
  | { readonly kind: 'no-project' }
  /** No peer: the boundary was explained. [followed] is whether the link was taken. */
  | { readonly kind: 'boundary'; readonly followed: boolean };

/** Injected environment for [openHistoryInDesktop]. */
export interface HistoryHandoffDeps {
  /** Whether a SimCrux desktop peer is present right now. */
  readonly desktopPeerPresent: () => boolean;
  /**
   * Absolute path of the `simcrux.yaml` in the workspace, if there is one.
   * Production: [pickSimCruxProjectFile] over the configured project file
   * and a workspace search.
   */
  readonly projectFile: () => Promise<string | undefined>;
  /**
   * Hand the project to the running desktop peer. Production:
   * `desktopDetect.createVscodeArtifactHandoff({ artifactKind: 'source', … })`.
   */
  readonly handOff: (fsPath: string) => Promise<desktopDetect.ArtifactHandoffOutcome>;
  /** Open a web URL. Production: `vscode.env.openExternal`. */
  readonly openUrl: (url: string) => Promise<void>;
  /** Non-modal message with optional buttons; resolves to the chosen label. */
  readonly showMessage: (
    message: string,
    ...actions: readonly string[]
  ) => Promise<string | undefined>;
}

/** The sentence that states the boundary. Shown only when there is no peer. */
export function historyBoundaryMessage(): string {
  return vscode.l10n.t(
    'This extension shows one results file: the run you just did. Whether that failure is new, whether it is flaky across seeds, and how the suite has trended over weeks are questions that need a run history — which is what SimCrux Desktop keeps.',
  );
}

/** Label on the boundary message's one button. */
export function getSimCruxLabel(): string {
  return vscode.l10n.t('Get SimCrux');
}

/** Shown when a peer is running but there is no project file to hand it. */
export function noProjectMessage(): string {
  return vscode.l10n.t(
    'SimCrux Desktop is running, but this workspace has no simcrux.yaml to open. Create one in the app, or point edacrux.sim.projectFile at the config you use.',
  );
}

/**
 * Take the user to the run history, or explain why it is not here.
 *
 * Never throws: a failed `openExternal` is reported through the same
 * message channel rather than surfacing as an unhandled command error.
 */
export async function openHistoryInDesktop(
  deps: HistoryHandoffDeps,
): Promise<HistoryHandoffOutcome> {
  if (!deps.desktopPeerPresent()) {
    const choice = await deps.showMessage(historyBoundaryMessage(), getSimCruxLabel());
    if (choice === getSimCruxLabel()) {
      await deps.openUrl(status.cruxProductInstallUrl('simcrux'));
      return { kind: 'boundary', followed: true };
    }
    return { kind: 'boundary', followed: false };
  }

  const projectFile = await deps.projectFile();
  if (projectFile === undefined) {
    await deps.showMessage(noProjectMessage());
    return { kind: 'no-project' };
  }
  const handoff = await deps.handOff(projectFile);
  return { kind: 'handed-off', projectFile, handoff };
}
