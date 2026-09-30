/**
 * Inbound `request_open_artifact` (CXP 1.1) — the editor answering
 * "open the waveform for this design".
 *
 * ### Why the editor answers it at all
 *
 * The message exists for the case where "the receiver has nothing matching
 * open".
 * A VSCode window is the most likely peer in the mesh to be in exactly that
 * state and the most likely to be able to fix it: the user's design folder
 * is usually *the workspace*, so the file the sender is talking about is
 * already inside the consent boundary. Before this, `CxpEditorDispatcher`
 * modelled the kind on the wire and dispatched nothing, so a peer asking got
 * silence — and silence is the one answer the protocol does not define.
 *
 * ### Resolution order, and the rule that must not be broken
 *
 * 1. The receiver's **own** shared-workspace manifest entry for
 *    (`design_id`, `kind`).
 * 2. The request's optional `path` hint.
 *
 * That order is the reference implementation's ("a receiver SHOULD prefer
 * its own workspace-manifest resolution and treat `path` only as a fallback,
 * since the sender's path may not exist on the receiver's machine layout").
 *
 * The rule: the consumer **never re-derives a design_id** from the artifact
 * it is opening. It reads the id off the wire and looks it up. Re-deriving
 * would key the artifact's own folder — a build tree, `/tmp` — while the
 * producer keyed the design's *input* folder, and the two would never meet.
 * Nothing in this file calls `cxpDesignIdForPath`, and that is deliberate.
 *
 * ### Containment
 *
 * Both candidates are peer-supplied — the workspace manifest is a
 * user-writable file in a user-writable directory, exactly like the peer
 * manifests (CXP §11), so "we resolved it ourselves" is *not* a provenance
 * claim. Every candidate therefore goes through `resolveWorkspacePath`, the
 * same §11 gate `request_open_source` uses, with no second implementation of
 * it: symlinks resolved *before* the containment test, and the value checked
 * is the value opened. A peer naming `~/.ssh/id_ed25519` as a `source`
 * artifact gets `honored: false` and no read.
 *
 * ### Any kind, deliberately
 *
 * There is no allow-list of artifact kinds here. LintCrux's handler opens
 * only `source` and WaveCrux's only `waveform`, because each of those apps
 * has exactly one thing it can do with a file. An editor's answer to "open
 * this file" does not depend on what the sender calls it — and
 * [EditorHost.openArtifact] routes through VSCode's own editor resolution,
 * so a `.vcd` still lands in the WaveCrux custom editor when that extension
 * is installed. Refusing kinds we had not thought of would make this peer
 * useless to a fifth product for no gain in safety; containment, not
 * vocabulary, is what makes it safe.
 */
import type { RequestOpenArtifact } from '../cxp/messages';
import type { CxpWorkspaceStore } from '../cxp/workspace-store';
import type { EditorHost } from './editor-host';
import type { CxpAckOutcome } from './open-source';
import { DEFAULT_CROSS_PROBE_SETTINGS, type CrossProbeSettings } from './settings';
import {
  reasonArtifactOpenFailed,
  reasonFileNotFound,
  reasonNoArtifactForDesign,
  reasonNoWorkspaceFolder,
  reasonOutsideWorkspace,
} from './strings';
import { resolveWorkspacePath, type WorkspacePathRefusal } from './workspace-paths';

/** Dependencies of [handleRequestOpenArtifact]. */
export interface OpenArtifactOptions {
  /** The editor to open in. */
  readonly editor: EditorHost;
  /**
   * The shared-workspace store this window reads.
   *
   * Optional: a machine with no resolvable application-data root has no
   * store, and the `path` hint alone still works. Omitting it must not turn
   * the handler off — a refusal for want of a store would be indistinguishable
   * to the sender from a refusal for want of the artifact.
   */
  readonly workspace?: Pick<CxpWorkspaceStore, 'resolveArtifact'>;
  /** Focus policy. Defaults to [DEFAULT_CROSS_PROBE_SETTINGS]. */
  readonly settings?: CrossProbeSettings;
  /** Symlink resolver, injectable for tests. */
  readonly realpath?: (path: string) => Promise<string>;
  /** Platform tag for path-case comparison, injectable for tests. */
  readonly platform?: NodeJS.Platform;
}

/** Human-readable reason for each refusal. Never echoes peer input (§11). */
function refusalReason(refusal: WorkspacePathRefusal): string {
  switch (refusal) {
    case 'empty-path':
      // A blank candidate is indistinguishable, from the sender's side,
      // from one we could not find.
      return reasonNoArtifactForDesign();
    case 'no-workspace':
      return reasonNoWorkspaceFolder();
    case 'outside-workspace':
      return reasonOutsideWorkspace();
    case 'not-found':
      return reasonFileNotFound();
  }
}

/**
 * Handle an inbound `request_open_artifact` and produce the
 * `request_open_artifact_ack` outcome.
 *
 * Never throws. Every failure is `honored: false` with a reason, because an
 * unacknowledged request is the one outcome that leaves the sender waiting.
 */
export async function handleRequestOpenArtifact(
  request: RequestOpenArtifact,
  options: OpenArtifactOptions,
): Promise<CxpAckOutcome> {
  const settings = options.settings ?? DEFAULT_CROSS_PROBE_SETTINGS;

  const candidates: string[] = [];
  if (options.workspace !== undefined && request.designId.length > 0) {
    try {
      const artifact = await options.workspace.resolveArtifact(
        request.designId,
        request.artifactKind,
        // The leaf of the sender's hint is a *descriptive* tie-break among
        // several artifacts of one kind, never a path we resolve. Passing it
        // cannot widen what is reachable: whatever it selects still goes
        // through containment below.
        request.path !== undefined ? { basename: request.path } : {},
      );
      if (artifact !== undefined) candidates.push(artifact.path);
    } catch {
      // A corrupt or unreadable workspace document must not cost the
      // sender the `path` fallback.
    }
  }
  if (request.path !== undefined && !candidates.includes(request.path)) {
    candidates.push(request.path);
  }
  if (candidates.length === 0) return { honored: false, reason: reasonNoArtifactForDesign() };

  let lastRefusal: WorkspacePathRefusal | undefined;
  for (const candidate of candidates) {
    const resolved = await resolveWorkspacePath(candidate, {
      workspaceFolders: options.editor.workspaceFolders(),
      ...(options.realpath !== undefined ? { realpath: options.realpath } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
    if (!resolved.ok) {
      lastRefusal = resolved.reason;
      continue;
    }
    try {
      // The resolved real path, not the candidate string: the containment
      // check is worth nothing if the value checked and the value opened
      // can differ.
      await options.editor.openArtifact(resolved.fsPath, {
        // A request the user just made in the other application, exactly
        // like `request_open_source` — so it obeys the same setting rather
        // than inventing a second focus policy for the same gesture.
        preserveFocus: !settings.openSourceFocusesEditor,
        preview: false,
      });
      return { honored: true };
    } catch {
      return { honored: false, reason: reasonArtifactOpenFailed() };
    }
  }

  return {
    honored: false,
    reason: lastRefusal === undefined ? reasonNoArtifactForDesign() : refusalReason(lastRefusal),
  };
}
