/**
 * "Open in <Product> Desktop", done over the protocol instead of through the
 * operating system.
 *
 * ### What this replaces, and why it was wrong
 *
 * All four products handed off with `vscode.env.openExternal` on the
 * product's own file. That hands the path to whatever the OS thinks owns the
 * extension — a user whose default `.vcd` handler is GTKWave got GTKWave,
 * from a button labelled "Open in WaveCrux Desktop". Three prompts in a row
 * recorded the same reason for not fixing it: `request_open_artifact` keys on
 * a `design_id` "whose derivation the Dart side owns". That was a misreading
 * of a warning about divergence (`cxp/design-id.ts` has the port and the
 * conformance test); with the id available, the protocol-native handoff is
 * simply the right one.
 *
 * ### The three steps, and why the middle one exists
 *
 * 1. **Find the peer.** No manifest for the product ⇒ nothing to ask.
 * 2. **Publish the artifact into the shared workspace**, keyed by the
 *    design id, *before* sending. This is not optional politeness: the
 *    receiver resolves `(design_id, kind)` through **its own** copy of the
 *    workspace store first, and treats the request's `path` hint only as a
 *    fallback for when nothing is recorded (CXP §9.10). A window that
 *    skipped the upsert could have a running app open whatever the store
 *    already held for that folder instead of the file the user is looking
 *    at. The editor is a legitimate shared-workspace producer — it holds
 *    design files open that no desktop app has seen, and all four desktop
 *    apps hold this request to the path floor alone (absolute, no NUL, no
 *    surrounding white space), not to the folders they have opened, so a
 *    file the app has never seen is honoured.
 * 3. **Send `request_open_artifact` and honour the ack.**
 *
 * ### The fallback ladder, stated once
 *
 * | What happened | What we do | Why |
 * |---|---|---|
 * | ack `honored: true` | nothing more | the app opened it |
 * | ack `honored: false` | report the refusal | the app is running and has just said no; handing the file to the OS *then* would launch whatever owns the extension, which is the exact defect this change removes |
 * | `error_response` | fall back to `openExternal` | the peer did not understand the request — a build older than wire minor 1.1 answers `unknown_kind` here |
 * | no ack in time | fall back to `openExternal` | no answer is not an answer |
 * | no peer / unreachable | fall back to `openExternal` | launching the app is still the right thing when it is not running |
 *
 * The UI says which of those happened (`strings.ts`), because "nothing
 * appeared" and "something else appeared" are the two failure reports this
 * feature will actually generate.
 *
 * Every dependency is injected, so all five rows are exercised without a
 * socket, a filesystem or an extension host.
 */
import { cxpDesignIdForPath } from '../cxp/design-id';
import type { CxpPeerManifest } from '../cxp/manifest';
import { CxpMessageKind } from '../cxp/messages';
import type { PeerIdentity } from '../cxp/identity';
import {
  sendOneShotRequest,
  type OneShotRequestResult,
} from '../cxp/one-shot';
import {
  VSCODE_WORKSPACE_PRODUCER,
  type CxpWorkspaceStore,
} from '../cxp/workspace-store';
import type { CruxDesktopProduct } from './detector';
import {
  handoffFailedMessage,
  handoffLaunchedExternallyMessage,
  handoffOpenedInDesktopMessage,
  handoffRefusedByDesktopMessage,
} from './strings';

/** What [openArtifactInDesktop] did. Test and telemetry observability. */
export type ArtifactHandoffOutcome =
  /** The peer acknowledged and opened it. */
  | { readonly kind: 'opened-in-peer'; readonly designId: string; readonly path: string }
  /** The peer answered, and refused. [reason] is its words, for the log only. */
  | { readonly kind: 'refused-by-peer'; readonly reason?: string }
  /** Handed to the OS. [why] records which rung of the ladder we fell to. */
  | {
      readonly kind: 'launched-externally';
      readonly path: string;
      readonly why: 'no-peer' | 'unreachable' | 'no-answer' | 'not-understood';
    }
  /** Even `openExternal` failed. */
  | { readonly kind: 'failed'; readonly error: unknown };

/** Injected environment for [openArtifactInDesktop]. */
export interface ArtifactHandoffDeps {
  /** The desktop product to hand off to. */
  readonly product: CruxDesktopProduct;
  /**
   * The artifact kind, in the shared vocabulary the Dart producers use —
   * `waveform` for a dump, `source` for HDL and for a product's project
   * file. This is the one part of the handoff each product owns, because it
   * is the one part that differs: the receiver's handler keys on it
   * (WaveCrux opens only `waveform`, LintCrux only `source`).
   */
  readonly artifactKind: string;
  /** Absolute path of the artifact to hand over. */
  readonly artifactPath: string;
  /** This window's CXP identity, for the handshake. */
  readonly selfIdentity: PeerIdentity;
  /** The running desktop manifest, if any. Production: `discoverDesktopPeer`. */
  readonly discoverPeer: () => Promise<CxpPeerManifest | undefined>;
  /**
   * The shared workspace store to publish into, when there is one.
   * Omitted on a machine with no resolvable application-data root; the
   * request still goes out with its `path` hint.
   */
  readonly workspace?: Pick<CxpWorkspaceStore, 'upsertArtifact'>;
  /** Hand a path to the OS. Production: `vscode.env.openExternal`. */
  readonly openPath: (fsPath: string) => Promise<void>;
  /** Non-modal message. Production: `vscode.window.showInformationMessage`. */
  readonly showMessage: (message: string) => void;
  /** Diagnostics. */
  readonly log: (line: string) => void;
  /** Ack timeout override. Tests only. */
  readonly ackTimeoutMs?: number;
  /** Send override. Tests only; defaults to a real one-shot dial. */
  readonly send?: (
    manifest: CxpPeerManifest,
    designId: string,
  ) => Promise<OneShotRequestResult>;
}

/**
 * Hand [artifactPath] to the product's desktop app, over CXP when it is
 * listening and through the OS when it is not.
 *
 * Never throws.
 */
export async function openArtifactInDesktop(
  deps: ArtifactHandoffDeps,
): Promise<ArtifactHandoffOutcome> {
  const manifest = await deps.discoverPeer().catch(() => undefined);
  if (manifest === undefined) {
    deps.log(`   handoff: no ${deps.product} peer; handing ${deps.artifactPath} to the OS`);
    return await launchExternally(deps, 'no-peer');
  }

  // The consumer never re-derives this id — but the *producer* is exactly
  // who derives it, from its own primary design input. Here that input is
  // the artifact the user has open, so its containing directory is the
  // design, which is what makes the id match the one a desktop app computes
  // for the same folder.
  const designId = cxpDesignIdForPath(deps.artifactPath);
  await publishArtifact(deps, designId);

  const send = deps.send ?? ((peer, id) => sendRequest(deps, peer, id));
  const result = await send(manifest, designId);
  switch (result.kind) {
    case 'acked':
      if (result.honored) {
        deps.log(`   handoff: ${deps.artifactPath} → ${deps.product} peer (design ${designId})`);
        deps.showMessage(handoffOpenedInDesktopMessage(deps.product));
        return { kind: 'opened-in-peer', designId, path: deps.artifactPath };
      }
      // The peer's own words go to the log, never into a toast (§11).
      deps.log(
        `   handoff: ${deps.product} peer refused (design ${designId}): ` +
          `${result.reason ?? 'no reason given'}`,
      );
      deps.showMessage(handoffRefusedByDesktopMessage(deps.product));
      return {
        kind: 'refused-by-peer',
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      };
    case 'error-response':
      // `unknown_kind` from a peer older than wire minor 1.1 lands here, and
      // it is the reason this rung exists rather than being folded into the
      // refusal above: the request was never understood, so the OS handoff
      // is still the best remaining answer.
      deps.log(
        `   handoff: ${deps.product} peer answered ${result.rawCode} (${result.message})`,
      );
      return await launchExternally(deps, 'not-understood');
    case 'ack-timeout':
      deps.log(`   handoff: ${deps.product} peer did not answer`);
      return await launchExternally(deps, 'no-answer');
    case 'unreachable':
      deps.log(`   handoff: ${deps.product} peer unreachable: ${String(result.error)}`);
      return await launchExternally(deps, 'unreachable');
  }
}

async function sendRequest(
  deps: ArtifactHandoffDeps,
  manifest: CxpPeerManifest,
  designId: string,
): Promise<OneShotRequestResult> {
  return await sendOneShotRequest(
    manifest,
    {
      kind: CxpMessageKind.requestOpenArtifact,
      designId,
      artifactKind: deps.artifactKind,
      // The hint is sent even though a conforming receiver prefers its own
      // resolution: a peer whose workspace document we could not write (no
      // app-data root) has nothing else to go on.
      path: deps.artifactPath,
    },
    {
      selfIdentity: deps.selfIdentity,
      ackKind: CxpMessageKind.requestOpenArtifactAck,
      ...(deps.ackTimeoutMs !== undefined ? { ackTimeoutMs: deps.ackTimeoutMs } : {}),
    },
  );
}

/**
 * Record the artifact in the shared workspace so the receiver can resolve it.
 *
 * Best-effort by design, matching every Dart producer's own rule ("a failed
 * workspace write must never break the path that invoked it"): a store we
 * could not write leaves the request's `path` hint as the receiver's only
 * candidate, which some receivers accept and some do not — a worse handoff,
 * never a broken command.
 */
async function publishArtifact(deps: ArtifactHandoffDeps, designId: string): Promise<void> {
  if (deps.workspace === undefined) return;
  try {
    await deps.workspace.upsertArtifact({
      designId,
      kind: deps.artifactKind,
      path: deps.artifactPath,
      producer: VSCODE_WORKSPACE_PRODUCER,
    });
  } catch (error) {
    deps.log(`   handoff: workspace publish failed (${String(error)})`);
  }
}

async function launchExternally(
  deps: ArtifactHandoffDeps,
  why: 'no-peer' | 'unreachable' | 'no-answer' | 'not-understood',
): Promise<ArtifactHandoffOutcome> {
  try {
    await deps.openPath(deps.artifactPath);
  } catch (error) {
    deps.log(`   handoff: openExternal failed (${String(error)})`);
    deps.showMessage(handoffFailedMessage());
    return { kind: 'failed', error };
  }
  deps.showMessage(handoffLaunchedExternallyMessage(deps.product));
  return { kind: 'launched-externally', path: deps.artifactPath, why };
}
