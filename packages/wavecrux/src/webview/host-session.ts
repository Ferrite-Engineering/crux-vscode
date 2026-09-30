/**
 * The one fact the webview cannot work out for itself: whether this
 * *installation* has ever opened a waveform before.
 *
 * ### Why this frame exists at all
 *
 * The frequency discipline for capability nudges says one must never fire
 * on the first file a user opens — the first experience must be the
 * product working. Deciding that needs state that outlives the window,
 * and the two halves of this extension have exactly one of those between
 * them:
 *
 * - the **host** has `ExtensionContext.globalState`, which is where the
 *   custom editor already persists `wavecrux.telemetry.hasOpenedFile` for
 *   `file.first_opened`;
 * - the **webview** has neither. It is a fresh Flutter app on every open,
 *   and `retainContextWhenHidden` does not survive a window reload — nor
 *   the deliberate context release a >64 MiB document triggers.
 *
 * So the host owns the durable fact and states it; the Dart side owns the
 * per-session policy built on top of it (at most one nudge, dismissible).
 * That split is deliberate: inventing a second persisted first-open flag
 * on the Dart side would give the two halves independent notions of "first
 * file" that drift the moment one of them is cleared.
 *
 * ### Read before the flag is flipped
 *
 * `WaveformEditorProvider.recordOpen` *marks* the installation as having
 * opened a file, so the value has to be sampled before that runs — see the
 * `openedFileBefore` capture in `waveform-editor.ts`. Sampling afterwards
 * would report `true` for the very first open and put the nudge exactly
 * where it must never appear.
 */
import { hostBridgeFrame, type HostBridgeFrame } from './open-waveform';

/**
 * Mirrors `kHostBridgeHostSessionKind` in
 * `wavecrux/lib/services/host_bridge/host_bridge_messages.dart`.
 *
 * Renaming it on one side and not the other fails **silently**: the Dart
 * decoder answers `unknown_kind`, the session provider keeps its default,
 * and the default is the conservative one (`openedFileBefore: false`), so
 * the only symptom is a nudge that never appears. Both sides name the
 * constant and a test on each side pins the literal.
 */
export const HOST_SESSION_KIND = 'crux.host_session';

/** What the host tells the webview about the installation it is running in. */
export interface HostSessionFacts {
  /**
   * Whether this installation had already opened a waveform *before* the
   * one now being delivered. `false` on the very first open of a fresh
   * install, and on every open thereafter `true`.
   */
  readonly openedFileBefore: boolean;
}

/**
 * Build the frame.
 *
 * Deliberately carries facts, not policy. "Do not nudge" would be shorter,
 * but it would put the first-file rule in the half that cannot see the other two
 * inputs to it (has a nudge already fired this session, did the user
 * dismiss one), and a policy split across two runtimes is a policy nobody
 * can read.
 */
export function hostSessionFrame(facts: HostSessionFacts): HostBridgeFrame {
  return hostBridgeFrame({
    kind: HOST_SESSION_KIND,
    payload: { opened_file_before: facts.openedFileBefore },
  });
}
