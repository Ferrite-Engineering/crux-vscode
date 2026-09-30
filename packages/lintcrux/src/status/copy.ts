/**
 * LintCrux's content for host-core's shared status surface.
 *
 * host-core owns the status-bar item, the capabilities panel, its layout
 * and its telemetry; `ProductCapabilityCopy` is the seam it left for the
 * words. Nothing here builds a second status surface and nothing here is
 * allowed to become modal.
 *
 * The four notes below are the capability boundaries **stated as facts about the
 * editor**, in the same voice the rest of the suite uses: what the
 * limitation is, why it exists, and what to do about it. They are shown
 * whether or not the desktop peer is present, because a user who already
 * has the app is exactly the one for whom "that is why this list only
 * covers the open file" is information rather than a pitch.
 *
 * They are also the honest statement of the product boundary: this
 * extension does not do triage, and the panel says so rather than letting
 * an engineer discover it by looking for a view that is not there.
 */
import * as vscode from 'vscode';
import { status as hostStatus } from '@crux-vscode/host-core';
import type { desktopDetect, status } from '@crux-vscode/host-core';

/** LintCrux's own product id in host-core's four-product vocabulary. */
export const LINTCRUX_PRODUCT = 'lintcrux' as const;

/**
 * The install pitch, replacing host-core's generic default.
 *
 * Names the thing that is actually different rather than "the full
 * experience": the editor answers "what is wrong with this file", the app
 * answers "what is wrong with this design, and what changed".
 */
export function lintCruxDesktopPitch(): string {
  return vscode.l10n.t(
    'LintCrux Desktop runs the engines across the whole design and tracks what changed between runs. The editor tells you what is wrong with the file in front of you; the app tells you whether the design is getting better.',
  );
}

/** Handoff label shown once a LintCrux desktop peer is detected. */
export function lintCruxHandoffLabel(): string {
  return vscode.l10n.t('Triage this design in LintCrux Desktop');
}

/**
 * The capability boundaries, short form.
 *
 * Ordered by how likely a reader is to have already hit one: the file
 * scope is felt immediately, new-vs-old on the second run, waiver
 * management the first time a waiver needs revisiting, trends last.
 */
export function lintCruxCapabilityNotes(): readonly string[] {
  return [
    vscode.l10n.t(
      'Diagnostics here cover the files a lint run reported on, one file at a time in your editor. Triage across the whole design — grouping, filtering, and sorting thousands of violations — is the app’s table, and a Problems panel is not one.',
    ),
    vscode.l10n.t(
      'New-vs-old tracking is desktop-only. It compares a run against a stored baseline of fingerprinted violations, which is state that belongs with the design rather than with an editor window.',
    ),
    vscode.l10n.t(
      'Waivers can be filed from here but not managed here. Listing, editing, expiring and auditing them is the app’s job; this extension only appends to the same .lintcrux-waivers.json the app reads.',
    ),
    vscode.l10n.t(
      'Trends need a run history. The app records every run to its own database and charts violation counts over time; a single results file has nothing to compare against.',
    ),
  ];
}

/**
 * LintCrux's [status.ProductCapabilityCopy].
 *
 * Guarded on the product, exactly as WaveCrux's is: a window that also has
 * another Crux extension installed gets host-core's defaults for those
 * rows rather than LintCrux's sentences under someone else's name. The
 * copy object is shared across all four rows — the interface is one hook,
 * not one per product — so this guard is the whole of what keeps it
 * honest.
 */
export const lintCruxCapabilityCopy: status.ProductCapabilityCopy = {
  desktopPitch: (product: desktopDetect.CruxDesktopProduct): string =>
    product === LINTCRUX_PRODUCT ? lintCruxDesktopPitch() : hostStatus.defaultDesktopPitch(product),
  handoffLabel: (product: desktopDetect.CruxDesktopProduct): string =>
    product === LINTCRUX_PRODUCT ? lintCruxHandoffLabel() : hostStatus.defaultHandoffLabel(product),
  capabilityNotes: (product: desktopDetect.CruxDesktopProduct): readonly string[] =>
    product === LINTCRUX_PRODUCT ? lintCruxCapabilityNotes() : [],
};
