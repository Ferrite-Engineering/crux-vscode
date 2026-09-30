/**
 * Every user-facing string this extension's cross-probe surfaces produce.
 *
 * Same two audiences `host-core/src/editor/strings.ts` describes, and the
 * same rule about the second one:
 *
 * - **UI strings** are shown in this window.
 * - **Ack reasons** travel on the wire in `request_highlight_ack.reason`
 *   (CXP §9.5) and are rendered by the *peer* — a Dart Crux app's
 *   cross-probe panel — and written to its log.
 *
 * These live here rather than in host-core because host-core must never
 * import a surface and these are statements only WaveCrux can make. They
 * are in this extension's own `l10n/bundle.l10n.*.json`, which is what
 * `vscode.l10n.t()` resolves against for code running inside this VSIX;
 * host-core's shared entries are seeded into the same files by
 * `tool/sync-l10n.mjs`.
 *
 * ### What is deliberately *not* in a reason
 *
 * None of these interpolate the peer's `path`, its element `kind`, or the
 * app's own answer. The Dart handler's reasons are good sentences that
 * sometimes quote exactly those (`wavecrux does not handle X elements`,
 * and the miss reasons quote the signal path), and CXP §11 makes all of it
 * untrusted peer input; echoing it back into another application's UI is
 * the hop §11 warns about. The app's words go to the output channel, where
 * they are a diagnostic; the peer gets one of the phrases below.
 */
import * as vscode from 'vscode';

/** The app looked, and the element is not in the waveform it has loaded. */
export function reasonNotInWaveform(): string {
  return vscode.l10n.t('the element is not in the loaded waveform');
}

/** WaveCrux is installed, but this window has no waveform tab open. */
export function reasonNoWaveformOpen(): string {
  return vscode.l10n.t('no waveform is open in this window');
}

/** The waveform panel did not acknowledge inside the timeout. */
export function reasonWaveformDidNotAnswer(): string {
  return vscode.l10n.t('the waveform panel did not answer');
}

/** The panel answered, but with an error rather than an acknowledgement. */
export function reasonHighlightFailed(): string {
  return vscode.l10n.t('the waveform panel could not highlight it');
}
