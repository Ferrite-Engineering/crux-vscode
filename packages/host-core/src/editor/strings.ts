import * as vscode from 'vscode';

/**
 * Every user-facing string the editor module produces, in one place.
 *
 * Two audiences, and the difference matters:
 *
 * - **UI strings** are shown in *this* window (quick-pick placeholders,
 *   information messages).
 * - **Ack reasons** travel on the wire in `request_open_source_ack` /
 *   `request_highlight_ack` `reason` (CXP §9.5/§9.7) and are then rendered
 *   by the *peer* — a Dart Crux app's cross-probe panel — and written to
 *   its log.
 *
 * Both go through `vscode.l10n.t()` per repo policy, and the source string
 * *is* the bundle key. That matters for the second audience: with no
 * translation loaded, `l10n.t()` returns the source string unchanged, so
 * the value on the wire is exactly the English phrase below. Those phrases
 * deliberately echo the vocabulary of `dispatchCxpOpenSource` in
 * `wavecrux/lib/services/remote/cxp/cxp_inbound_handlers.dart` (lowercase,
 * terse, no trailing punctuation — `no editor command configured`,
 * `editor not found: …`) so a log with both implementations in it reads as
 * one system.
 *
 * ### What is deliberately *not* in a reason
 *
 * None of these interpolate the peer's `file_path`, `path` or
 * `display_name`. CXP §11 makes those untrusted input, and the ack we send
 * is rendered by the peer — echoing an attacker-chosen string back into
 * another app's UI is precisely the hop §11 warns about. A refusal says
 * *why*, never *what*; the path the peer asked for is already known to the
 * peer.
 */

/** No folder is open, so nothing is inside the workspace. */
export function reasonNoWorkspaceFolder(): string {
  return vscode.l10n.t('no workspace folder open');
}

/** The resolved real path escaped every open workspace folder. */
export function reasonOutsideWorkspace(): string {
  return vscode.l10n.t('path is outside the open workspace');
}

/** The path was inside the workspace but there is no such file. */
export function reasonFileNotFound(): string {
  return vscode.l10n.t('file not found in the open workspace');
}

/** `file_path` was empty or blank. */
export function reasonNoFilePath(): string {
  return vscode.l10n.t('no file path given');
}

/** `showTextDocument` rejected — a binary file, a revoked permission, … */
export function reasonEditorOpenFailed(): string {
  return vscode.l10n.t('the editor could not open the file');
}

/**
 * `request_open_artifact` named a design this window has no artifact for.
 *
 * Covers all three ways that happens — nothing recorded in the shared
 * workspace, no `path` hint, a blank hint — deliberately as one reason. The
 * distinctions are about *our* bookkeeping and would tell a sender nothing
 * it could act on, while an id-shaped reason would echo peer input (§11).
 */
export function reasonNoArtifactForDesign(): string {
  return vscode.l10n.t('no artifact for that design is available in this window');
}

/** `vscode.open` rejected the resolved artifact. */
export function reasonArtifactOpenFailed(): string {
  return vscode.l10n.t('the editor could not open the artifact');
}

/** No product surface is registered in this window at all. */
export function reasonNoSurfaceInstalled(): string {
  return vscode.l10n.t('no Crux surface is installed in this window');
}

/** Surfaces are installed, but every one of them declined this element. */
export function reasonNoSurfaceHandlesElement(): string {
  return vscode.l10n.t('no installed Crux surface handles this element');
}

/** Placeholder for the peer quick-pick when several peers are connected. */
export function pickPeerPlaceholder(): string {
  return vscode.l10n.t('Send the selection to which Crux app?');
}

/** Placeholder for the disambiguation quick-pick over candidate paths. */
export function pickElementPlaceholder(): string {
  return vscode.l10n.t('Which element did you mean?');
}

/**
 * Quick-pick description for a peer that has not advertised the capability
 * this send needs.
 *
 * Advisory, never disqualifying (CXP §8.1): the entry is still offered and
 * still selectable, because a receiver must answer correctly regardless of
 * what it advertised, and refusing to *offer* a send the user asked for
 * would make our UI less capable than the protocol.
 */
export function peerMayNotAcceptDescription(): string {
  return vscode.l10n.t('may not accept this');
}

/** Shown when the send command runs with no connected peer. */
export function noConnectedPeersMessage(): string {
  return vscode.l10n.t(
    'No Crux apps are connected. Start WaveCrux, LintCrux, SimCrux, or NetCrux to cross-probe.',
  );
}

/** Shown when the send command runs with no editor selection to send. */
export function noEditorSelectionMessage(): string {
  return vscode.l10n.t('Select an identifier in the editor first.');
}
