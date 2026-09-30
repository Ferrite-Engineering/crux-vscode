/**
 * Which files the WaveCrux surface claims, and what it calls them.
 *
 * One table, three consumers: the `contributes.customEditors` selector in
 * `package.json` (checked against this table by a test, so the manifest and
 * the code cannot drift), the editor provider's dispatch, and the `format`
 * property on the `file.opened` telemetry event.
 *
 * Every token here is a closed vocabulary value — it must satisfy host-core's
 * `TELEMETRY_PROPERTY_VALUE_PATTERN` (`^[a-z0-9_]{1,64}$`) or the property is
 * silently dropped by `sanitizeTelemetryProperties` and the funnel loses the
 * dimension it exists to measure. A test asserts that, rather than trusting
 * that six short lowercase strings will stay that way.
 */
import { editor } from '@crux-vscode/host-core';

/**
 * The custom editor's `viewType`.
 *
 * Namespaced by the extension and named for what it edits, not for the
 * extension: this string appears in the user's `workbench.editorAssociations`
 * settings when they retarget a file type, so it is effectively public API.
 *
 * **Defined in host-core, re-exported here.** It became a genuinely
 * cross-extension contract when SimCrux's counterexample handoff needed to
 * `vscode.openWith` into this editor: SimCrux may
 * not import this package, so a second spelling of the literal would have
 * been the only alternative — and a `viewType` rename would then break the
 * handoff with nothing failing a build. WaveCrux still *contributes* the
 * editor; it no longer *owns the name alone*.
 */
export const WAVEFORM_VIEW_TYPE = editor.WAVEFORM_CUSTOM_EDITOR_VIEW_TYPE;

/** One recognised waveform container. */
export interface WaveformFormat {
  /**
   * Lowercase extension **without** the dot, and the telemetry `format`
   * token. The two are deliberately the same string: a second mapping would
   * be a second thing to keep in step for no gain.
   */
  readonly token: string;
  /** Glob for `contributes.customEditors[].selector`. */
  readonly selector: string;
  /**
   * Whether this build can actually open it. `false` means "recognised, and
   * honestly refused" — see [FSDB_FORMAT].
   */
  readonly supported: boolean;
}

/**
 * The four open formats WaveCrux's WASM engines read, plus LXT/LXT2.
 *
 * `wellen` handles VCD, FST and GHW; `lxt2fst` converts LXT and LXT2 ahead of
 * it. All five run entirely inside the webview, which is what makes them
 * openable here at all.
 */
export const SUPPORTED_WAVEFORM_FORMATS: readonly WaveformFormat[] = [
  { token: 'vcd', selector: '*.vcd', supported: true },
  { token: 'fst', selector: '*.fst', supported: true },
  { token: 'ghw', selector: '*.ghw', supported: true },
  { token: 'lxt', selector: '*.lxt', supported: true },
  { token: 'lxt2', selector: '*.lxt2', supported: true },
];

/**
 * FSDB: recognised, claimed, and refused with an explanation.
 *
 * It is claimed on purpose. WaveCrux's desktop build opens FSDB by shelling
 * out to Synopsys' own `fsdb2vcd`, which a webview cannot run — so the honest
 * answer is a sentence saying exactly that, and the only way to deliver it is
 * to be the editor VSCode opens. Leaving `.fsdb` unclaimed would hand the user
 * VSCode's binary-file editor instead, which explains nothing.
 */
export const FSDB_FORMAT: WaveformFormat = {
  token: 'fsdb',
  selector: '*.fsdb',
  supported: false,
};

/** Every format the custom editor claims, supported or not. */
export const WAVEFORM_FORMATS: readonly WaveformFormat[] = [
  ...SUPPORTED_WAVEFORM_FORMATS,
  FSDB_FORMAT,
];

/**
 * Classify a path or file name.
 *
 * Case-insensitive: Windows and macOS both hand us `TOP.VCD` regularly.
 *
 * The dot is part of the match, which is what keeps `sim.lxt2` out of the
 * `lxt` bucket — they are different containers with different converters, and
 * a suffix test without the dot would classify every LXT2 file as LXT. The
 * longest-match tie-break is belt and braces for a future format that really
 * is a suffix of another.
 *
 * Returns `undefined` for anything unrecognised — including a file with no
 * extension at all, which the selector cannot match anyway.
 */
export function waveformFormatFor(pathOrName: string): WaveformFormat | undefined {
  const lower = pathOrName.toLowerCase();
  let best: WaveformFormat | undefined;
  for (const format of WAVEFORM_FORMATS) {
    if (!lower.endsWith(`.${format.token}`)) continue;
    if (best === undefined || format.token.length > best.token.length) best = format;
  }
  return best;
}

/** The basename of a path, for the tab label and for format detection. */
export function baseName(pathOrName: string): string {
  const cleaned = pathOrName.replace(/[/\\]+$/, '');
  const index = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return index >= 0 ? cleaned.slice(index + 1) : cleaned;
}
