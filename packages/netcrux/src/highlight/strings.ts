/**
 * User-facing strings for "what drives this".
 *
 * A few reuse host-core's exact source strings on purpose — matching the
 * string that already ships (and is already translated in every extension's
 * bundle, via `tool/sync-l10n.mjs`) rather than writing a near-duplicate
 * that would need its own translation and would read as a second voice for
 * the same situation.
 */
import * as vscode from 'vscode';

/** Reuses `editor/strings.ts`'s exact source string — same situation, same words. */
export function noEditorSelectionMessage(): string {
  return vscode.l10n.t('Select an identifier in the editor first.');
}

/** Reuses `editor/strings.ts`'s exact source string for the same quick-pick. */
export function pickElementPlaceholder(): string {
  return vscode.l10n.t('Which element did you mean?');
}

/** NetCrux acked but declined to show [path]. [reason] is NetCrux's own explanation, if it gave one. */
export function netCruxDeclinedMessage(path: string, reason: string | undefined): string {
  return reason === undefined
    ? vscode.l10n.t('NetCrux could not show {0}.', path)
    : vscode.l10n.t('NetCrux could not show {0}: {1}', path, reason);
}

/** The socket connected but no ack ever arrived. */
export function netCruxAckTimeoutMessage(): string {
  return vscode.l10n.t('NetCrux did not respond in time. It may be busy — try again in a moment.');
}

/** The peer's manifest was found but the socket could not be reached. */
export function netCruxUnreachableMessage(): string {
  return vscode.l10n.t('Could not reach NetCrux. It may have just closed.');
}

/**
 * No peer, but NetCrux is installed locally. This states
 * the outcome plainly rather than apologising for the missing peer.
 */
export function netCruxInstalledOfferLaunchMessage(path: string): string {
  return vscode.l10n.t(
    'NetCrux Desktop is installed but not running. Launch it and {0} opens straight on the canvas.',
    path,
  );
}

/** Label on the "installed, offer to launch" message's one button. */
export function launchNetCruxLabel(): string {
  return vscode.l10n.t('Launch NetCrux');
}

/** Shown after the user asks to launch NetCrux. */
export function launchingNetCruxMessage(): string {
  return vscode.l10n.t(
    'Launching NetCrux — run this again once it is up to jump straight to the cone of influence.',
  );
}

/**
 * No peer, and NetCrux is not installed. This states what NetCrux Desktop
 * is *for* rather than apologising for the editor's lack of a canvas:
 * sending the user to it is the outcome, not a consolation prize.
 */
export function netCruxNotInstalledBoundaryMessage(path: string): string {
  return vscode.l10n.t(
    'NetCrux Desktop draws the schematic and traces the cone of influence. Install it and {0} opens straight on the canvas.',
    path,
  );
}

/** Label on the boundary message's one button. */
export function getNetCruxLabel(): string {
  return vscode.l10n.t('Get NetCrux');
}
