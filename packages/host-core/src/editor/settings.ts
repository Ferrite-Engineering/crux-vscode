import * as vscode from 'vscode';

/**
 * Configuration section for settings **host-core** owns.
 *
 * Deliberately `edacrux`, not `wavecrux`. host-core is shared by all four
 * product extensions and a VSCode window is one CXP peer no matter how many
 * of them are installed, so a setting that governs the window's cross-probe
 * behaviour cannot sensibly live under one product's namespace — a user
 * with only LintCrux installed would be configuring cross-probing under
 * `wavecrux.*`. Product-owned settings keep their product namespace;
 * anything host-core reads lives here.
 */
export const EDACRUX_CONFIGURATION_SECTION = 'edacrux';

/**
 * Fully-qualified keys of the settings this module reads.
 *
 * Exported so the extension packages can contribute the matching
 * `contributes.configuration` entries and reference them from tests without
 * restating string literals that would then drift.
 */
export const CROSS_PROBE_SETTING_KEYS = {
  /** See [CrossProbeSettings.revealSelection]. */
  revealSelection: 'edacrux.crossProbe.revealSelection',
  /** See [CrossProbeSettings.openSourceFocusesEditor]. */
  openSourceFocusesEditor: 'edacrux.crossProbe.openSourceFocusesEditor',
  /** See [CrossProbeSettings.followWaveformSelection]. */
  followWaveformSelection: 'edacrux.crossProbe.followWaveformSelection',
} as const;

/** Behaviour toggles for inbound cross-probe messages. */
export interface CrossProbeSettings {
  /**
   * Bring the matching editor tab forward when a connected Crux app
   * announces a selection (`notify_selection`, CXP §9.3).
   *
   * A cross-probe message may request attention but never steal focus —
   * a rule about the **cross-process** case, where raising one app's window over another's is hostile and
   * unportable. Inside a single VSCode window, revealing a tab is not that:
   * no window is raised, no other application loses focus, and the reveal
   * happens with `preserveFocus` so the caret does not move out from under
   * a typing user. That is why this defaults to `true` while the
   * cross-process rule still holds absolutely — nothing in this module
   * calls anything that focuses the VSCode window itself.
   */
  readonly revealSelection: boolean;
  /**
   * Move the cursor into the editor when a connected Crux app asks to open
   * a source location (`request_open_source`, CXP §9.6).
   *
   * Unlike a selection announcement, this one is a *request the user just
   * made* in the other app ("open this in my editor"), so landing the caret
   * on the line is the point of it. Still window-local: the VSCode window
   * is never raised, and a user who prefers the gentler behaviour turns
   * this off and gets a background tab with the selection already set.
   */
  readonly openSourceFocusesEditor: boolean;
  /**
   * Reveal a signal's RTL declaration in the editor when you select it in a
   * waveform panel **in this window**.
   *
   * The inverse of RTL annotation: instead of bringing waveform
   * values to the source, it brings the source to the waveform's selection.
   * Design path → `file` + `line` comes from the stems index, so it only
   * ever lands on a declaration a tool wrote down; with no stems file it
   * does nothing at all.
   *
   * ### Off by default, and the two above are on — why the difference
   *
   * [revealSelection] and [openSourceFocusesEditor] are *responses to an act
   * in another application*: the user did something in the WaveCrux desktop
   * app and the whole point of it was to land here. Each inbound message is
   * one deliberate cross-probe.
   *
   * This one fires on *every* selection change inside a waveform panel the
   * user is already looking at, and most of those clicks are not a request
   * to go anywhere — they are scrubbing, comparing two traces, reading a
   * bus. Replacing the editor beside the panel on each of them is the
   * hostile version of a genuinely useful gesture. So it is opt-in, for the
   * same reason `edacrux.rtlAnnotation.enabled` is: a feature that changes
   * what the user's own source view is showing has to be something they
   * asked for.
   *
   * Deliberately **not** in `restrictedConfigurations` (see `window/trust.ts`):
   * a workspace-provided `true` can at most reveal a file that is already
   * inside that workspace — `resolveWorkspacePath` is between the stems
   * entry and the editor — which is precisely what the already-default-on
   * [revealSelection] does for a `source` element. Nothing is executed and
   * no read is redirected.
   */
  readonly followWaveformSelection: boolean;
}

/** See each field's docs for why it defaults the way it does. */
export const DEFAULT_CROSS_PROBE_SETTINGS: CrossProbeSettings = {
  revealSelection: true,
  openSourceFocusesEditor: true,
  followWaveformSelection: false,
};

/**
 * Read a boolean setting, falling back to [fallback] for anything that is
 * not actually a boolean.
 *
 * The type check is not paranoia about the settings schema: it is what lets
 * host-core call this under the unit-test `vscode` stand-in, where
 * `getConfiguration()` returns an auto-mock rather than a configuration
 * object, and get documented defaults instead of a truthy proxy.
 */
function booleanSetting(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: boolean,
): boolean {
  const value: unknown = configuration.get(key);
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Current [CrossProbeSettings] for [scope], read live.
 *
 * Read at use time rather than cached: VSCode applies a settings change
 * immediately and a cached copy would leave the window behaving by the old
 * value until reload, which reads as the setting being broken.
 */
export function readCrossProbeSettings(scope?: vscode.ConfigurationScope): CrossProbeSettings {
  const configuration = vscode.workspace.getConfiguration(
    EDACRUX_CONFIGURATION_SECTION,
    scope ?? null,
  );
  return {
    revealSelection: booleanSetting(
      configuration,
      'crossProbe.revealSelection',
      DEFAULT_CROSS_PROBE_SETTINGS.revealSelection,
    ),
    openSourceFocusesEditor: booleanSetting(
      configuration,
      'crossProbe.openSourceFocusesEditor',
      DEFAULT_CROSS_PROBE_SETTINGS.openSourceFocusesEditor,
    ),
    followWaveformSelection: booleanSetting(
      configuration,
      'crossProbe.followWaveformSelection',
      DEFAULT_CROSS_PROBE_SETTINGS.followWaveformSelection,
    ),
  };
}
