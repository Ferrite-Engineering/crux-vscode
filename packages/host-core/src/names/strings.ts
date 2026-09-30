import * as vscode from 'vscode';

/**
 * User-facing strings for name resolution.
 *
 * All of two, and both exist to answer the same question in a quick-pick:
 * *how sure is this?* An exact stems mapping and a name match are offered
 * side by side and look identical without them, and the difference is the
 * one the user needs — a name match that turns out wrong is indistinguishable
 * from a bug unless the UI said it was a guess.
 *
 * As everywhere in host-core, the source string is the bundle key, and the
 * bundle lives in `packages/host-core/l10n/` and is copied outward by
 * `tool/sync-l10n.mjs` (see `editor/strings.ts` for why).
 */

/** Description for a candidate that came from a stems file. */
export function fromStemsDescription(): string {
  return vscode.l10n.t('from stems');
}

/**
 * Description for a candidate name-matched against the loaded hierarchy.
 *
 * Says what would fix it. A user who has never heard of stems files learns
 * here that they exist and that they are the difference between a guess and
 * an answer — which is worth more than the one send this message appears in.
 */
export function nameMatchDescription(): string {
  return vscode.l10n.t('name match — a stems file would make this exact');
}
