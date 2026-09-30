import * as vscode from 'vscode';
import { EDACRUX_CONFIGURATION_SECTION } from '../editor/settings';

/**
 * Settings for RTL annotation — signal values rendered into the user's source.
 *
 * `edacrux.*` and not `wavecrux.*`, for the reason `editor/settings.ts`
 * gives: host-core owns the behaviour, a VSCode window is one peer however
 * many product extensions are installed, and the day LintCrux annotates a
 * lint result into the same gutter this setting must not still be spelled
 * under WaveCrux's name.
 */

/** Fully-qualified keys, so nothing restates a literal that can then drift. */
export const RTL_ANNOTATION_SETTING_KEYS = {
  /** See [RtlAnnotationSettings.enabled]. */
  enabled: 'edacrux.rtlAnnotation.enabled',
} as const;

/** Behaviour toggles for editor-decoration annotation. */
export interface RtlAnnotationSettings {
  /**
   * Render signal values from the connected waveform as inline decorations
   * in HDL source, following the waveform cursor.
   *
   * **Off by default, and that is not timidity.** Every other setting in
   * this repo governs what happens when the user asks for something; this
   * one changes how the user's own source file *looks* while they are
   * reading it. Text appearing in someone's Verilog because they installed
   * an extension is an intrusion however good the text is, so the first
   * render has to be something they asked for — the command, the setting,
   * or the status surface. Once asked for, it stays on.
   */
  readonly enabled: boolean;
}

/** Off. See [RtlAnnotationSettings.enabled]. */
export const DEFAULT_RTL_ANNOTATION_SETTINGS: RtlAnnotationSettings = {
  enabled: false,
};

/**
 * Read a boolean setting, falling back for anything that is not a boolean.
 *
 * Same shape and same reason as `editor/settings.ts`: under the unit-test
 * `vscode` stand-in `getConfiguration()` answers with an auto-mock, and the
 * type check is what turns that into the documented default rather than a
 * truthy proxy that would make "off by default" untestable.
 */
function booleanSetting(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: boolean,
): boolean {
  const value: unknown = configuration.get(key);
  return typeof value === 'boolean' ? value : fallback;
}

/** Current [RtlAnnotationSettings] for [scope], read live. */
export function readRtlAnnotationSettings(
  scope?: vscode.ConfigurationScope,
): RtlAnnotationSettings {
  const configuration = vscode.workspace.getConfiguration(
    EDACRUX_CONFIGURATION_SECTION,
    scope ?? null,
  );
  return {
    enabled: booleanSetting(
      configuration,
      'rtlAnnotation.enabled',
      DEFAULT_RTL_ANNOTATION_SETTINGS.enabled,
    ),
  };
}

/**
 * Flip [RTL_ANNOTATION_SETTING_KEYS.enabled] and return the new value.
 *
 * Written to the **global** target: this is a reading preference, and a
 * user who turns annotation on in one repository has said something about
 * how they want to read HDL, not about that repository. Writing it into
 * `.vscode/settings.json` would also put a personal display choice into
 * whatever the team has under version control.
 */
export async function toggleRtlAnnotationEnabled(): Promise<boolean> {
  const configuration = vscode.workspace.getConfiguration(EDACRUX_CONFIGURATION_SECTION);
  const next = !readRtlAnnotationSettings().enabled;
  await configuration.update('rtlAnnotation.enabled', next, true);
  return next;
}
