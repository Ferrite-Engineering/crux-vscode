import * as vscode from 'vscode';

/**
 * Every user-facing string the annotation module produces.
 *
 * These are read *inside the user's own source file*, at a glance, while
 * they are doing something else. That constrains them harder than any
 * other copy in the pack: an annotation that needs a second read has cost
 * more attention than the value it carried was worth. Hence no sentences in
 * the decorations themselves — the sentences live in the hover, where
 * someone has already decided to look.
 *
 * As everywhere in host-core the source string is the bundle key, and
 * `tool/sync-l10n.mjs` copies these outward into each extension's bundle.
 */

/**
 * The inline decoration for a resolved identifier: `alu_result = 32'hdead`.
 *
 * Localized rather than concatenated because the separator is not universal
 * — and because a bundle entry is the only place a translator can see that
 * `{0}` is an identifier from the user's file and `{1}` a formatted value,
 * neither of which may be reordered into nonsense.
 */
export function annotationValueLabel(identifier: string, value: string): string {
  return vscode.l10n.t('{0} = {1}', identifier, value);
}

/**
 * The inline decoration for an identifier the index answered ambiguously.
 *
 * Names the count rather than showing a path, because the count is the
 * actionable part: "this word means four different signals in the loaded
 * design, and I will not choose for you". Clicking the hover's link opens
 * the picker.
 */
export function annotationAmbiguousLabel(identifier: string, count: number): string {
  return vscode.l10n.t('{0} = ? ({1} signals)', identifier, count);
}

/** Hover heading over a resolved annotation. */
export function annotationHoverTitle(): string {
  return vscode.l10n.t('WaveCrux — value at the cursor');
}

/** Hover heading over an ambiguous annotation. */
export function annotationAmbiguousHoverTitle(): string {
  return vscode.l10n.t('WaveCrux — this name matches more than one signal');
}

/**
 * Hover body under an ambiguous annotation.
 *
 * Says why there is no value rather than only that there is none: an
 * identifier under several instantiations is the *normal* case in RTL, and
 * a user who reads this once learns the shape of the whole feature.
 */
export function annotationAmbiguousHoverBody(): string {
  return vscode.l10n.t(
    'This identifier is declared under more than one instance in the loaded design, so no single value is correct. Choose the one you are debugging and the choice is remembered for this file.',
  );
}

/** Link label in the ambiguous hover, opening the quick-pick. */
export function annotationPickLabel(): string {
  return vscode.l10n.t('Choose which signal this is');
}

/** Confirmation after the command turns annotation on. */
export function annotationEnabledMessage(): string {
  return vscode.l10n.t(
    'RTL annotation is on. Open a waveform and signal values follow the cursor into your HDL source.',
  );
}

/** Confirmation after the command turns annotation off. */
export function annotationDisabledMessage(): string {
  return vscode.l10n.t('RTL annotation is off.');
}

/**
 * Shown when annotation is turned on with no waveform open.
 *
 * The setting is now on and nothing visible happened, which without this
 * reads as the feature being broken. It names the missing input rather
 * than apologising.
 */
export function annotationNoWaveformMessage(): string {
  return vscode.l10n.t(
    'RTL annotation is on, but no waveform is open in this window. Open a VCD or FST file and the values appear.',
  );
}
