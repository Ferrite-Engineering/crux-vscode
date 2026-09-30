import * as vscode from 'vscode';
import type { CruxDesktopProduct } from '../desktop-detect/detector';
import type { TelemetryLicenseTier } from '../telemetry/vocabulary';

/**
 * User-facing strings for the status-bar item and its capabilities panel.
 * All go through `vscode.l10n.t()` per repo policy — see
 * `editor/strings.ts` for the two-audience rationale; every string here is
 * shown only in this window, never echoed to a peer, so there is no
 * second audience to worry about the way an ack `reason` has.
 */

/**
 * Status-bar item text. Not run through `l10n.t()`: `EDACrux` is the
 * suite's own name, not a phrase, and `$(pulse)` is a codicon reference —
 * VSCode substitutes it from the icon font regardless of locale, so
 * localizing this string could not change what renders.
 */
export const STATUS_BAR_TEXT = '$(pulse) EDACrux';

export function statusBarTooltip(): string {
  return vscode.l10n.t('EDACrux — tier, desktop app, and Pro capabilities');
}

export function capabilitiesPanelTitle(): string {
  return vscode.l10n.t('EDACrux Capabilities');
}

export function tierSectionHeading(): string {
  return vscode.l10n.t('Current tier');
}

export function desktopSectionHeading(): string {
  return vscode.l10n.t('Desktop app');
}

export function proSectionHeading(): string {
  return vscode.l10n.t('Pro');
}

export function linksSectionHeading(): string {
  return vscode.l10n.t('Links');
}

const TIER_LABELS: Record<TelemetryLicenseTier, () => string> = {
  openCore: () => vscode.l10n.t('Open Core'),
  edu: () => vscode.l10n.t('EDU'),
  pro: () => vscode.l10n.t('Pro'),
  enterprise: () => vscode.l10n.t('Enterprise'),
};

export function tierLabel(tier: TelemetryLicenseTier): string {
  return TIER_LABELS[tier]();
}

/** Display name for [product] — a brand name, not translated. */
export const CRUX_PRODUCT_DISPLAY_NAMES: Record<CruxDesktopProduct, string> = {
  wavecrux: 'WaveCrux',
  netcrux: 'NetCrux',
  lintcrux: 'LintCrux',
  simcrux: 'SimCrux',
};

/**
 * Default install pitch for [product]'s desktop app, shown when no peer
 * is detected. Deliberately generic — the WaveCrux-specific funnel copy
 * (parse-time honesty, the FSDB-message voice) is WaveCrux's own, layered on
 * top via `ProductCapabilityCopy` in `panel-content.ts` rather than
 * rewritten here.
 */
export function defaultDesktopPitch(product: CruxDesktopProduct): string {
  return vscode.l10n.t(
    'Install {0} Desktop for the full experience — deeper analysis, offline use, and no editor-panel constraints.',
    CRUX_PRODUCT_DISPLAY_NAMES[product],
  );
}

/** Default handoff label shown once [product]'s desktop peer is detected. */
export function defaultHandoffLabel(product: CruxDesktopProduct): string {
  return vscode.l10n.t('Open in {0} Desktop', CRUX_PRODUCT_DISPLAY_NAMES[product]);
}

/** Shown above the handoff action, naming what was detected. */
export function desktopAlreadyInstalledNote(product: CruxDesktopProduct): string {
  return vscode.l10n.t(
    '{0} Desktop is already running — no need to install it again.',
    CRUX_PRODUCT_DISPLAY_NAMES[product],
  );
}

export function proPitch(): string {
  return vscode.l10n.t(
    'Upgrade to Pro for advanced analysis features across the EDACrux suite.',
  );
}

export function proLinkLabel(): string {
  return vscode.l10n.t('Compare plans');
}

export function suiteLinkLabel(): string {
  return vscode.l10n.t('EDACrux Suite');
}

export function documentationLinkLabel(): string {
  return vscode.l10n.t('Documentation');
}
