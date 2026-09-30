import * as vscode from 'vscode';

/**
 * The user-facing strings the cross-probe module produces.
 *
 * One audience, and it is an unusual one: these are rendered by a **Crux
 * app's own cross-probe panel**, running in a webview in this window, as the
 * `reason` on a rejected send. So they are this window's words about this
 * window's failure to deliver — not a peer's words relayed onward, and not
 * something a peer ever sees. Nothing here interpolates a path, an element
 * or a peer-supplied string; §11's rule against echoing peer input holds
 * here for the same reason it holds in `editor/strings.ts`.
 *
 * Sentence case with punctuation, unlike `editor/strings.ts`'s terse wire
 * reasons: the panel composes these into a toast a person reads, not into a
 * log line.
 */

/**
 * The panel asked to send to a peer this window has no live link to.
 *
 * The common cause is benign and worth being plain about rather than
 * cryptic: the peer's manifest is on disk (which is why it is in the list)
 * and the socket is not up — the app was quit, or is still starting, or the
 * dial is in backoff.
 */
export function reasonPeerNotConnected(): string {
  return vscode.l10n.t('This window has no live connection to that app right now.');
}

/** The send was aimed at a `peer_id` that is not in the discovered set. */
export function reasonPeerUnknown(): string {
  return vscode.l10n.t('That app is no longer running.');
}

/** The window has no CXP peer at all — no manifest directory, no socket. */
export function reasonCrossProbeUnavailable(): string {
  return vscode.l10n.t('Cross-probing is unavailable in this window.');
}
