/**
 * SimCrux's content for host-core's shared status surface.
 *
 * host-core owns the status-bar item, the capabilities panel, its layout
 * and its telemetry; `ProductCapabilityCopy` is the seam it left for the
 * words. Nothing here builds a second status surface and nothing here is
 * allowed to become modal.
 *
 * The notes below are the capability boundaries **stated as facts about the
 * editor**, and the first of them is the product boundary said out
 * loud: regressions frequently run on CI or a farm, this surface serves
 * the local loop, and it is better for the panel to say so than for an
 * engineer to go looking for a fleet view that was never built.
 */
import * as vscode from 'vscode';
import { status as hostStatus } from '@crux-vscode/host-core';
import type { desktopDetect, status } from '@crux-vscode/host-core';

/** SimCrux's own product id in host-core's four-product vocabulary. */
export const SIMCRUX_PRODUCT = 'simcrux' as const;

/**
 * The install pitch, replacing host-core's generic default.
 *
 * Names the thing that is actually different rather than "the full
 * experience": the editor runs the loop you are in right now; the app
 * holds the history that makes a flaky test visible as flaky.
 */
export function simCruxDesktopPitch(): string {
  return vscode.l10n.t(
    'SimCrux Desktop keeps the run history: flakiness across seeds, trends per test and per suite, and comparison between runs. The editor runs the regression in front of you; the app tells you whether this failure is new, old, or intermittent.',
  );
}

/** Handoff label shown once a SimCrux desktop peer is detected. */
export function simCruxHandoffLabel(): string {
  return vscode.l10n.t('Open this project in SimCrux Desktop');
}

/**
 * The capability boundaries, short form.
 *
 * Ordered by how likely a reader is to have already hit one: the local
 * scope is felt the first time a colleague asks about the nightly, history
 * on the second run, flakiness the first time a test fails intermittently,
 * comparison last.
 */
export function simCruxCapabilityNotes(): readonly string[] {
  return [
    vscode.l10n.t(
      'This is the local-iteration surface. It shows the results of a run whose results file is on this machine — it is not a view of a CI fleet or a simulation farm, and it cannot tell you what the nightly did.',
    ),
    vscode.l10n.t(
      'There is no run history here. The tree shows one results file: the latest run. Trends, per-test and per-suite history, and retention are the app’s database, not a file in your workspace.',
    ),
    vscode.l10n.t(
      'Flakiness detection is desktop-only. Deciding that a test is intermittent rather than broken needs many runs across many seeds, which is exactly the state a single results file does not have.',
    ),
    vscode.l10n.t(
      'Run-to-run comparison and regression baselines live in the app. A results file is recreated by every run, so there is nothing here to compare a run against.',
    ),
  ];
}

/**
 * SimCrux's [status.ProductCapabilityCopy].
 *
 * Guarded on the product, exactly as WaveCrux's and LintCrux's are: a
 * window that also has another Crux extension installed gets host-core's
 * defaults for those rows rather than SimCrux's sentences under someone
 * else's name.
 */
export const simCruxCapabilityCopy: status.ProductCapabilityCopy = {
  desktopPitch: (product: desktopDetect.CruxDesktopProduct): string =>
    product === SIMCRUX_PRODUCT ? simCruxDesktopPitch() : hostStatus.defaultDesktopPitch(product),
  handoffLabel: (product: desktopDetect.CruxDesktopProduct): string =>
    product === SIMCRUX_PRODUCT ? simCruxHandoffLabel() : hostStatus.defaultHandoffLabel(product),
  capabilityNotes: (product: desktopDetect.CruxDesktopProduct): readonly string[] =>
    product === SIMCRUX_PRODUCT ? simCruxCapabilityNotes() : [],
};
