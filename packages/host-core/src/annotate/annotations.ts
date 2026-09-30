import type { ResolvedLine, ViewportResolution } from './model';
import { annotationAmbiguousLabel, annotationValueLabel } from './strings';
import type { SignalValueSnapshot } from './value-source';

/**
 * Joining the resolution to the values — the last pure step before
 * anything touches a `TextEditorDecorationType`.
 *
 * Separate from both halves on purpose. `model.ts` runs synchronously and
 * must not know that values are asynchronous; the renderer knows about
 * VSCode and must not know about ranking or ambiguity. This function is
 * where "what is on this line" meets "what is that worth right now", and it
 * is the piece a test can assert against without a scheduler or an editor.
 */

/** One rendered annotation on one line. */
export interface AnnotationEntry {
  /** The identifier as it is written in the file. */
  readonly identifier: string;
  /** The text to render inline, already localized. */
  readonly label: string;
  /** Design path, when exactly one was resolved. */
  readonly path?: string;
  /** Formatted value, when the app had one. */
  readonly value?: string;
  /** Every candidate path, when the identifier was ambiguous. */
  readonly ambiguousPaths?: readonly string[];
}

/** Every annotation for one 1-based line. */
export interface LineAnnotation {
  readonly line: number;
  readonly entries: readonly AnnotationEntry[];
}

/**
 * Build the annotations for a viewport.
 *
 * A `unique` identifier the snapshot has no value for is **dropped**, not
 * rendered as a blank or a dash. The design distinguishes three states that
 * look alike and are not: a signal at `x`, a signal the app declined to
 * answer for, and a signal whose value happens to be `0`. Only the app
 * knows which it produced, so the host renders exactly what it was given
 * and nothing where it was given nothing.
 *
 * Ambiguous identifiers are rendered whether or not there are values,
 * because the thing they communicate — "I will not guess between these" —
 * is true independently of the waveform.
 */
export function buildAnnotations(
  resolution: ViewportResolution,
  snapshot: SignalValueSnapshot,
): readonly LineAnnotation[] {
  const annotations: LineAnnotation[] = [];
  for (const line of resolution.lines) {
    const entries = entriesFor(line, snapshot);
    if (entries.length > 0) annotations.push({ line: line.line, entries });
  }
  return annotations;
}

function entriesFor(line: ResolvedLine, snapshot: SignalValueSnapshot): readonly AnnotationEntry[] {
  const entries: AnnotationEntry[] = [];
  for (const identifier of line.identifiers) {
    if (identifier.kind === 'ambiguous') {
      entries.push({
        identifier: identifier.identifier,
        label: annotationAmbiguousLabel(identifier.identifier, identifier.paths.length),
        ambiguousPaths: identifier.paths,
      });
      continue;
    }
    const value = snapshot.values.get(identifier.path);
    if (value === undefined || value.length === 0) continue;
    entries.push({
      identifier: identifier.identifier,
      label: annotationValueLabel(identifier.identifier, value),
      path: identifier.path,
      value,
    });
  }
  return entries;
}
