/**
 * The product boundary, and the handoff across it.
 *
 * The line is drawn here, and this module is where a user meets it: the
 * **editor** shows the violations in the file you are editing; the **app**
 * does triage across the whole design — new-vs-old tracking, waiver
 * management, and trends. Nothing in this extension rebuilds any of that,
 * so "show me everything" has to go somewhere, and this is the somewhere.
 *
 * Two outcomes, decided by the same per-product desktop detection every
 * other surface uses (`desktop-detect/`):
 *
 * - **A LintCrux desktop peer is running** — hand the project over,
 *   through the command id host-core already names
 *   (`edacrux.openInDesktop.lintcrux`).
 * - **No peer** — say what the app does that the editor does not, once,
 *   in a non-modal message, with a link. That is a *boundary message*, not
 *   a nag: it is shown only when the user asked for the cross-design view,
 *   which is exactly the moment the difference is worth explaining.
 *
 * ### `request_open_artifact`, with `openExternal` as the fallback
 *
 * This used to hand the project file to the OS unconditionally, deferring
 * the protocol-native path because `request_open_artifact`'s `design_id`
 * derivation was "owned by the Dart side". It is now ported and
 * conformance-tested (`host-core/src/cxp/design-id.ts`), so the peer branch
 * sends the message and falls back to `openExternal` only when no peer
 * answers.
 *
 * ### What LintCrux does with it
 *
 * Its handler (`LintCruxCxpRequestHandler` in the LintCrux open core, wired
 * in `lib/features/remote/providers/cxp_server_provider.dart`):
 *
 * - honours exactly one artifact kind, `source`, and refuses the rest;
 * - resolves the project through its own copy of the shared workspace,
 *   falling back to the request's `path` hint when nothing is recorded — so
 *   the publish in [desktopDetect.openArtifactInDesktop] is what makes the
 *   file the user has open win over anything recorded for that folder
 *   before;
 * - swaps a `<design>.crux-project` manifest for the lint project it names,
 *   and opens the project as a workspace tab.
 *
 * ### Which project
 *
 * A workspace can hold several `.lintcrux` projects, and the first one a
 * search happened to return used to be the one handed over. Now it is the
 * one related to the active editor ([pickLintCruxProjectFile]), as NetCrux's
 * hand-off prefers the active file: the project in the active editor, else
 * the nearest project above the file being edited, else the first in path
 * order.
 *
 * ### The contract with the receiver
 *
 * Asserted here by `test/handoff.test.ts` and on the LintCrux side by
 * `test/features/remote/cxp_open_artifact_test.dart`:
 *
 * 1. the artifact kind is `source` ([LINTCRUX_ARTIFACT_KIND]);
 * 2. the path is absolute, carries no NUL, and is spelled exactly as it is
 *    on disk — no surrounding white space. That is the floor LintCrux holds
 *    this request to, and the only path rule: it is not rooted in the
 *    projects LintCrux has opened, so a project it has never seen is
 *    honoured;
 * 3. the path names an existing `.lintcrux` project.
 *
 * Every dependency is injected, so both branches are tested without an
 * extension host.
 */
import path from 'node:path';
import * as vscode from 'vscode';
import { status } from '@crux-vscode/host-core';
import type { desktopDetect } from '@crux-vscode/host-core';

/**
 * The artifact kind LintCrux hands over. `source` — its handler's only
 * accepted kind, and what `publishLintcruxProjectArtifact` writes.
 */
export const LINTCRUX_ARTIFACT_KIND = 'source';

/** A LintCrux project file's extension, lowercase and with the dot. */
export const LINTCRUX_PROJECT_EXTENSION = '.lintcrux';

/** The workspace search for LintCrux projects, matching [LINTCRUX_PROJECT_EXTENSION]. */
export const LINTCRUX_PROJECT_GLOB = '**/*.lintcrux';

/**
 * How many projects the workspace search returns at most. Enough for any
 * real design tree; a bound, because the search walks the folder.
 */
export const LINTCRUX_PROJECT_SEARCH_LIMIT = 200;

/** Whether [fsPath] is a LintCrux project file. */
export function isLintCruxProjectFile(fsPath: string): boolean {
  return fsPath.toLowerCase().endsWith(LINTCRUX_PROJECT_EXTENSION);
}

/**
 * The project to hand over, related to the active editor where it can be:
 *
 * 1. [activeFile], when it is itself a `.lintcrux` project;
 * 2. otherwise the project whose folder most closely contains [activeFile] —
 *    the nearest one above the file the user is editing;
 * 3. otherwise the first project in path order, so the choice does not
 *    depend on the order the search returned them in.
 *
 * [activeFile] is the active editor's path when it shows a file on disk, and
 * `undefined` otherwise. The search results are checked too, so a glob that
 * drifts cannot put something else on the wire.
 */
export async function pickLintCruxProjectFile(
  activeFile: string | undefined,
  searchWorkspace: () => Promise<readonly string[]>,
): Promise<string | undefined> {
  if (activeFile !== undefined && isLintCruxProjectFile(activeFile)) return activeFile;
  const projects = (await searchWorkspace()).filter(isLintCruxProjectFile).sort();
  if (activeFile !== undefined) {
    let nearest: string | undefined;
    let nearestDepth = -1;
    for (const project of projects) {
      const folder = path.dirname(project);
      const relative = path.relative(folder, activeFile);
      const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
      if (inside && folder.length > nearestDepth) {
        nearest = project;
        nearestDepth = folder.length;
      }
    }
    if (nearest !== undefined) return nearest;
  }
  return projects[0];
}

/** What [openTriageInDesktop] did, for tests and telemetry. */
export type TriageHandoffOutcome =
  /**
   * A peer was running and the project was handed over. [handoff] carries
   * *how* — over CXP, or through the OS after the peer failed to answer —
   * so the caller and the tests can tell the two apart rather than
   * inferring from a toast.
   */
  | {
      readonly kind: 'handed-off';
      readonly projectFile: string;
      readonly handoff: desktopDetect.ArtifactHandoffOutcome;
    }
  /** A peer was running but this workspace has no `.lintcrux` project to open. */
  | { readonly kind: 'no-project' }
  /** No peer: the boundary was explained. [followed] is whether the link was taken. */
  | { readonly kind: 'boundary'; readonly followed: boolean };

/** Injected environment for [openTriageInDesktop]. */
export interface TriageHandoffDeps {
  /** Whether a LintCrux desktop peer is present right now. */
  readonly desktopPeerPresent: () => boolean;
  /**
   * Absolute path of the `.lintcrux` project to hand over, if there is one.
   * Async because the production implementation is [pickLintCruxProjectFile]
   * over `workspace.findFiles`, which walks the folder.
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
export function triageBoundaryMessage(): string {
  return vscode.l10n.t(
    'This extension shows the violations in the file you are editing. Triage across the whole design — what is new since last run, which waivers are in force, and how the counts are trending — is what LintCrux Desktop is for.',
  );
}

/** Label on the boundary message's one button. */
export function getLintCruxLabel(): string {
  return vscode.l10n.t('Get LintCrux');
}

/** Shown when a peer is running but there is no project file to hand it. */
export function noProjectMessage(): string {
  return vscode.l10n.t(
    'LintCrux Desktop is running, but this workspace has no .lintcrux project file to open. Create one in the app and its violations will triage there.',
  );
}

/**
 * Take the user to the cross-design view, or explain why it is not here.
 *
 * Never throws: a failed handoff is reported through the same message
 * channel rather than surfacing as an unhandled command error.
 */
export async function openTriageInDesktop(
  deps: TriageHandoffDeps,
): Promise<TriageHandoffOutcome> {
  if (!deps.desktopPeerPresent()) {
    const choice = await deps.showMessage(triageBoundaryMessage(), getLintCruxLabel());
    if (choice === getLintCruxLabel()) {
      await deps.openUrl(status.cruxProductInstallUrl('lintcrux'));
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
