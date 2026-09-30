/**
 * LintCrux's own violation vocabulary, mirrored in TypeScript.
 *
 * **These are LintCrux's types, not ours.** Every name and every JSON key
 * in this file is copied from the Dart product so a document written by
 * `lintcrux --export json` or `lintcrux --sarif` round-trips through this
 * extension without reinterpretation:
 *
 * - `Severity` — `lintcrux/lib/domain/enums/severity.dart`
 * - `Violation` — `lintcrux/lib/domain/models/violation.dart`
 * - `SourceLocation` — `lintcrux/lib/domain/models/source_location.dart`
 * - the flat-JSON keys — `lib/services/export/violation_exporters.dart`
 * - the SARIF mapping — `lib/services/sarif/sarif_writer.dart` / `_reader.dart`
 *
 * The mapping onto VSCode's own `Diagnostic` vocabulary happens in
 * `severity.ts` and `diagnostics.ts`, deliberately in one place and
 * deliberately not here: a lossy translation belongs at the boundary it
 * crosses, not baked into the model on this side of it.
 */

/**
 * LintCrux's five severities, **in the product's own order** (`fatal`
 * highest). `severityCompare` in the Dart enum compares by index, so the
 * order of this array is load-bearing for any ranking done here.
 *
 * There is no `off`, `info`, or `style` level. `note` is the informational
 * level; `none` means the engine emitted something the parser could not
 * classify.
 */
export const LINT_SEVERITIES = ['fatal', 'error', 'warning', 'note', 'none'] as const;

/** One of [LINT_SEVERITIES]. Serializes as the lowercase name, everywhere. */
export type LintSeverity = (typeof LINT_SEVERITIES)[number];

/**
 * Parse a severity as it appears in LintCrux's own JSON (`severity.name`).
 *
 * Returns `undefined` for anything else — including a *future* LintCrux
 * severity this build has never heard of. The caller decides what an
 * unrecognised level becomes; silently coercing here would hide the one
 * case where the two builds have actually diverged.
 */
export function parseLintSeverity(raw: unknown): LintSeverity | undefined {
  return typeof raw === 'string' && (LINT_SEVERITIES as readonly string[]).includes(raw)
    ? (raw as LintSeverity)
    : undefined;
}

/**
 * A single lint violation, as this extension carries it.
 *
 * Field names follow the Dart model rather than VSCode's conventions
 * (`line`/`column` are **1-based**, as they are in `SourceLocation`; the
 * conversion to VSCode's 0-based `Position` happens exactly once, in
 * `diagnostics.ts`).
 */
export interface LintViolation {
  /** Engine that produced it: `verilator`, `verible`, `slang`, … */
  readonly engineId: string;
  /**
   * Engine-namespaced rule id — `<engineId>/<localRuleId>`, e.g.
   * `verilator/UNUSEDSIGNAL`. SARIF stores the *local* id and names the
   * engine on the run's driver; the reader re-namespaces it, exactly as
   * `SarifReader` does, so a waiver written from here matches a waiver
   * written by the app.
   */
  readonly ruleId: string;
  readonly severity: LintSeverity;
  /**
   * The engine's text, verbatim. Never decorated here: the app shows the
   * same string, and an engineer cross-referencing the two must not have
   * to mentally strip a prefix this extension added.
   */
  readonly message: string;
  /** Absolute filesystem path. Relative SARIF URIs are resolved before this point. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
  /** 1-based, inclusive; present only when the engine reported an extent. */
  readonly endLine?: number;
  /** 1-based; present only when the engine reported an extent. */
  readonly endColumn?: number;
  /**
   * Whether LintCrux itself already considers this violation waived —
   * `suppressed: true` in the flat JSON export, a non-empty
   * `suppressions[]` in SARIF.
   *
   * Carried rather than filtered at parse time so the count of "violations
   * in this file" and the count of "diagnostics published" can differ for
   * a stated reason.
   */
  readonly suppressed: boolean;
}

/**
 * The rule's local id, with the engine namespace stripped.
 *
 * `verilator/UNUSEDSIGNAL` → `UNUSEDSIGNAL`. Used only for display; every
 * identity comparison (waiver matching above all) uses the full namespaced
 * [LintViolation.ruleId].
 */
export function localRuleId(ruleId: string): string {
  const slash = ruleId.indexOf('/');
  return slash < 0 ? ruleId : ruleId.slice(slash + 1);
}
