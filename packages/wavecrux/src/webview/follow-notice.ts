/**
 * The one line the output channel carries about waveform selections that are
 * not followed.
 *
 * Selecting a signal in a WaveCrux panel announces `notify_selection` from
 * the webview to this extension, and the only in-window consumer is the
 * reveal of the signal's RTL declaration, which is opt-in
 * (`edacrux.crossProbe.followWaveformSelection`, off by default). While the
 * setting is off every announcement is claimed and dropped, silently, and
 * that silence reads as "the selection reached nobody" to someone watching
 * the logs. Logging each one would bury the channel, since the app announces
 * on every cursor move, so this says it once per session and then stops.
 *
 * Other extensions in the window do not receive the announcement: a window
 * is one CXP peer, so it goes to peers in other applications only when sent
 * with the Cross-Probe panel or `EDACrux: Send Selection to Crux App`.
 */

/** The sentence logged, once. */
export const FOLLOW_DISABLED_NOTICE =
  '   waveform selection: not followed in the editor, because ' +
  'edacrux.crossProbe.followWaveformSelection is off (it is off by default). ' +
  'Other extensions in this window do not receive waveform selections; send one to a Crux app with the Cross-Probe panel.';

/** A function that logs [FOLLOW_DISABLED_NOTICE] the first time it is called, and never again. */
export function createFollowDisabledNotice(log: (line: string) => void): () => void {
  let said = false;
  return () => {
    if (said) return;
    said = true;
    log(FOLLOW_DISABLED_NOTICE);
  };
}
