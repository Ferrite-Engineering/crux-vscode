/**
 * Where the numbers come from.
 *
 * The waveform, the cursor, the per-signal radix and the translators that
 * turn a raw bit string into `32'hdead_beef` all live in the **webview** —
 * a Flutter app that owns the loaded design. The decorations live in the
 * **host**. So the annotation loop cannot compute a value; it can only ask
 * for one, and this interface is that question in the smallest form that
 * still admits an honest answer.
 *
 * ### Why the host does not send a time
 *
 * The obvious signature is `valuesAt(paths, time)`. It is wrong. The cursor
 * belongs to the app: it moves when the user drags it, when a peer sends a
 * `request_highlight`, and when a waveform loads and the cursor lands at
 * `startTime`. A host that sampled the cursor, then sent it back, would be
 * quoting a value it read a moment ago — and the one moment that matters is
 * the one where the user is dragging the cursor, i.e. exactly when the
 * quoted time is stalest. Asking "at the cursor" and being told which time
 * that was keeps one owner for the cursor and makes the answer
 * self-describing.
 *
 * ### Why values never touch telemetry
 *
 * Everything crossing this interface is the user's design data: signal
 * paths from their RTL and values from their simulation. It is rendered
 * locally into their own editor, which is the whole point, and it goes
 * nowhere else. The only thing RTL annotation reports is `feature.used
 * {feature: 'rtl_annotation'}` — a closed token, no properties derived from
 * anything here. See `controller.ts`, which is the only caller.
 */

/** Whether a still-useful answer is still wanted. */
export interface AnnotationCancellation {
  isCancelled(): boolean;
}

/** Never cancelled. */
export const NEVER_CANCELLED: AnnotationCancellation = { isCancelled: () => false };

/** Values for the paths that were asked about, at one instant. */
export interface SignalValueSnapshot {
  /**
   * Formatted value per design path, already rendered by the app's own
   * translators so the annotation reads exactly like the waveform's value
   * column — same radix, same enum names, same x/z propagation.
   *
   * A path the app could not answer for (not in the design, not loaded, no
   * transition before the cursor) is simply absent. Absence is a normal
   * answer and annotates nothing; it is never an error.
   */
  readonly values: ReadonlyMap<string, string>;
  /**
   * The cursor time the values were sampled at, formatted by the app with
   * its timescale. Shown in the hover so an annotation can never be read
   * as "now" when it means "at the cursor".
   */
  readonly cursorLabel?: string;
}

/** An empty answer — no waveform, no cursor, nothing to say. */
export const EMPTY_VALUE_SNAPSHOT: SignalValueSnapshot = { values: new Map() };

/**
 * The waveform this window can ask about.
 *
 * One interface, four possible implementations: WaveCrux's webview bridge
 * is the one that exists, a CXP peer over `wavecrux.getValues` is the one
 * that will, and the tests use a fake. None of them belongs in the
 * annotation loop, which is why this is the only thing it knows about
 * them.
 */
export interface SignalValueSource {
  /**
   * Whether asking is worth it right now: a waveform is loaded and the
   * channel is up. Checked before a resolution pass, so a window with no
   * waveform open costs nothing per keystroke.
   */
  isReady(): boolean;
  /**
   * Values for [paths] at the current cursor.
   *
   * Never rejects: a dead webview, a query that timed out, and an app that
   * answered with nonsense are all "no values", because none of them is
   * something an editor decoration can usefully do anything about.
   */
  valuesAt(
    paths: readonly string[],
    cancellation: AnnotationCancellation,
  ): Promise<SignalValueSnapshot>;
}

/** A [SignalValueSource] that is never ready. The default. */
export const noSignalValueSource: SignalValueSource = {
  isReady: () => false,
  valuesAt: async () => await Promise.resolve(EMPTY_VALUE_SNAPSHOT),
};
