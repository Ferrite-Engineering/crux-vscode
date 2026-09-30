import * as vscode from 'vscode';
import { CRUX_PRODUCT_DISPLAY_NAMES } from '../status/strings';
import type { CruxDesktopProduct } from './detector';

/**
 * What the window says after a desktop handoff — and the point of these
 * particular sentences is that they are **honest about which mechanism ran**.
 *
 * Two very different things can happen behind one button:
 *
 * - the running app was asked over CXP to open the artifact, and answered;
 * - the file was handed to the operating system, which opens it with
 *   whatever it thinks owns that extension.
 *
 * The second is what every one of these handoffs used to do unconditionally,
 * and a user whose default `.vcd` handler is GTKWave got GTKWave from a
 * button labelled "Open in WaveCrux Desktop". Saying "opened it with your
 * system's default application" is not an apology, it is the difference
 * between a working feature and a confusing one — and it is the sentence
 * that tells the user *why* they are looking at GTKWave.
 */

/** The peer accepted and opened it. */
export function handoffOpenedInDesktopMessage(product: CruxDesktopProduct): string {
  return vscode.l10n.t('Opened in {0} Desktop.', CRUX_PRODUCT_DISPLAY_NAMES[product]);
}

/**
 * The peer is running and refused, with its own words.
 *
 * The peer's `reason` is deliberately **not** interpolated. It is untrusted
 * input under CXP §11 — it arrives from any process that can bind a socket —
 * and it is written for the peer's own log, not for a toast in another
 * application. The reason goes to the output channel where a developer can
 * read it; the user gets a sentence they can act on.
 */
export function handoffRefusedByDesktopMessage(product: CruxDesktopProduct): string {
  return vscode.l10n.t(
    '{0} Desktop is running but would not open this — see the EDACrux output channel for what it said.',
    CRUX_PRODUCT_DISPLAY_NAMES[product],
  );
}

/**
 * No peer answered, so the file went to the OS.
 *
 * Covers a genuinely absent app, a stale manifest, a peer too old to know
 * `request_open_artifact`, and one that never replied. The user does not
 * care which; they care that what comes up may not be the Crux app.
 */
export function handoffLaunchedExternallyMessage(product: CruxDesktopProduct): string {
  return vscode.l10n.t(
    '{0} Desktop is not answering, so this was opened with your system’s default application for it.',
    CRUX_PRODUCT_DISPLAY_NAMES[product],
  );
}

/** Even the OS handoff failed. */
export function handoffFailedMessage(): string {
  return vscode.l10n.t('This file could not be opened.');
}
