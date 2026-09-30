/**
 * When to keep a hidden waveform's webview alive, and when to throw it away.
 *
 * `retainContextWhenHidden` is on for the custom editor: without it VSCode
 * destroys the webview the moment its tab stops being visible, and coming back
 * to the tab means a Flutter cold start *plus* a re-parse of the whole
 * waveform. For the file sizes people actually double-click that trade is
 * obviously wrong — the retained context costs tens of megabytes and saves
 * seconds on every tab switch.
 *
 * It stops being obviously wrong somewhere. A retained context holds the
 * parsed waveform, the signal index, and CanvasKit's surfaces for a tab the
 * user is not looking at, and a person triaging a regression has several such
 * tabs. So above [RELEASE_CONTEXT_ABOVE_BYTES] the editor tears the webview
 * down on hide and rebuilds it on show, re-sending the bytes from the still
 * open file descriptor.
 *
 * ### The measurements the threshold is picked from
 *
 * macOS 15 (Apple M4 Pro), VSCode 1.130.0 (Electron 42.6.0, Chrome 148),
 * Extension Development Host, `--disable-extensions`. RSS per process, read
 * from `ps`. A webview gets its **own renderer process** here, so the cost is
 * directly attributable rather than inferred:
 *
 * | state | webview renderer | whole EDH |
 * |---|---|---|
 * | no waveform open | *no webview renderer exists* | 1558 MB |
 * | 900 KB VCD, visible | 289 MB | 1944 MB |
 * | 900 KB VCD, hidden (retained) | 290 MB | 1959 MB |
 * | 100 MB VCD, visible | 659 MB | 2323 MB |
 * | 100 MB VCD, hidden (released) | 263 MB | 1819 MB |
 * | 100 MB VCD, shown again (reloaded) | 568 MB | 2033 MB |
 *
 * Two numbers decide it. Releasing a **100 MB** waveform gives back **396 MB**
 * of resident memory; releasing a **900 KB** one gives back about **27 MB**,
 * because ~263 MB of that renderer is the floor an empty webview costs anyway
 * and most of the rest is CanvasKit and the Flutter engine, which every
 * waveform pays regardless of size.
 *
 * The price of releasing, measured on the way back in: 223 ms to Flutter's
 * first frame, and **3.2 s** from tab-switch to the waveform being on screen
 * again for the 100 MB file (26 chunks re-sent from the still-open file
 * descriptor, then re-parsed by wellen). For the 900 KB file the same round
 * trip is ~0.4 s.
 *
 * So: ~400 MB for 3 s is worth taking; ~27 MB for anything is not. The
 * threshold sits between the two measured points, at the round number closest
 * to where the saving stops being dominated by the fixed engine cost.
 *
 * **Not measured:** GPU memory (the `gpu-process` figure moved by ±8 MB across
 * every state, which is noise at this scale), and how the numbers behave over
 * a multi-hour session with many tabs — resize behaviour under
 * `retainContextWhenHidden` over long sessions is still unmeasured.
 */

/**
 * Above this size, a hidden waveform's webview is released rather than
 * retained. See the module docs for the measurements behind the number.
 */
export const RELEASE_CONTEXT_ABOVE_BYTES = 64 * 1024 * 1024;

/** Whether a document of [sizeBytes] gives up its context when hidden. */
export function releaseContextWhenHidden(
  sizeBytes: number,
  threshold: number = RELEASE_CONTEXT_ABOVE_BYTES,
): boolean {
  return Number.isFinite(sizeBytes) && sizeBytes > threshold;
}
