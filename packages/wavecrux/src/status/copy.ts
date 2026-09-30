/**
 * WaveCrux's content for host-core's shared status surface.
 *
 * host-core owns the status-bar item, the capabilities panel, its layout and
 * its telemetry; `ProductCapabilityCopy` is the seam it left for the words.
 * Nothing here builds a second status surface, and nothing here is allowed
 * to become modal — see `host-core/src/status/status-bar.ts`.
 *
 * ### The voice, and where the same sentences live in the app
 *
 * Every note below is written in the voice of the WaveCrux app's
 * `fsdbWebUnsupportedMessage`: **what the limitation is, why it exists, and
 * what to do about it**, with no wheedling. The app carries the long form of
 * each one as an ARB entry (`editorHostSlowParseMessage`,
 * `editorHostStageMessage`, `editorHostInteractiveVcdMessage`,
 * `editorHostRtlAnnotationMessage` in `wavecrux/lib/l10n/app_en.arb`) and
 * shows it *in place*, at the moment the user meets the boundary. These are
 * the short forms of the same four facts, readable on demand.
 *
 * The duplication is deliberate and is the same trade `waveform-editor.ts`
 * already makes for the FSDB notice: the two halves run in different
 * runtimes with different localization systems, and a shared string would
 * have to cross the bridge at render time to reach a panel that is not
 * even a webview the Dart build lives in. Both audiences are real:
 * an in-place empty state teaches the person who went looking for Stage;
 * this list teaches the person deciding whether to install the desktop app.
 */
import * as vscode from 'vscode';
import { status as hostStatus } from '@crux-vscode/host-core';
import type { desktopDetect, status } from '@crux-vscode/host-core';

/** WaveCrux's own product id in host-core's four-product vocabulary. */
export const WAVECRUX_PRODUCT = 'wavecrux' as const;

/**
 * The install pitch, replacing host-core's deliberately generic default.
 *
 * Names the one thing that is measurably different rather than "the full
 * experience": the panel's parser is single-threaded because a browser
 * engine has no shared-memory threads to give it, and the desktop build's
 * is not.
 */
export function waveCruxDesktopPitch(): string {
  return vscode.l10n.t(
    'WaveCrux Desktop parses a waveform across every core on the machine and streams it from disk instead of loading it into the panel. Same viewer, no size ceiling and no single-threaded parse.',
  );
}

/** Handoff label shown once a WaveCrux desktop peer is detected. */
export function waveCruxHandoffLabel(): string {
  return vscode.l10n.t('Open this waveform in WaveCrux Desktop');
}

/**
 * The four capability boundaries, short form.
 *
 * Ordered by how likely a reader is to have already hit one: parse time is
 * felt on the first large file, Stage and RTL Source are found by opening
 * a panel, and interactive VCD is looked for rather than stumbled into.
 */
export function waveCruxCapabilityNotes(): readonly string[] {
  return [
    vscode.l10n.t(
      'Large files take longer here. The panel parses with single-threaded WebAssembly — a webview has no SharedArrayBuffer, so the parser cannot use more than one core. The desktop app uses all of them.',
    ),
    vscode.l10n.t(
      'The Stage panel opens empty. Its widgets are sized for a full window and its widget bundles load from disk, which a webview cannot read. Build a Stage in the desktop app.',
    ),
    vscode.l10n.t(
      'Interactive VCD does not run here. It reads a simulator’s output from stdin or a named pipe, and an editor panel has neither. Run the simulation with WaveCrux Desktop attached, or open the finished dump in this panel.',
    ),
    vscode.l10n.t(
      'RTL source annotation is desktop-only. It reads the HDL files a GTKWave stems file names, and the panel has no filesystem to read them from. The desktop app shows that source beside the waveform.',
    ),
  ];
}

/**
 * WaveCrux's [status.ProductCapabilityCopy].
 *
 * Guarded on the product so a window that also has the LintCrux, SimCrux or
 * NetCrux extension installed gets host-core's defaults for those rows
 * rather than WaveCrux's sentences under someone else's name. The copy
 * object is shared across all four rows — the interface is one hook, not
 * one per product — so this guard is the whole of what keeps it honest.
 */
export const waveCruxCapabilityCopy: status.ProductCapabilityCopy = {
  // `ProductCapabilityCopy`'s members are all-or-nothing per field:
  // supplying `desktopPitch` at all means host-core stops consulting its
  // own default for *every* product, so the non-WaveCrux rows have to
  // re-enter it explicitly rather than fall through. Calling host-core's
  // exported default is what keeps those rows identical to a window with
  // no WaveCrux extension in it at all.
  desktopPitch: (product: desktopDetect.CruxDesktopProduct): string =>
    product === WAVECRUX_PRODUCT ? waveCruxDesktopPitch() : hostStatus.defaultDesktopPitch(product),
  handoffLabel: (product: desktopDetect.CruxDesktopProduct): string =>
    product === WAVECRUX_PRODUCT ? waveCruxHandoffLabel() : hostStatus.defaultHandoffLabel(product),
  capabilityNotes: (product: desktopDetect.CruxDesktopProduct): readonly string[] =>
    product === WAVECRUX_PRODUCT ? waveCruxCapabilityNotes() : [],
};
