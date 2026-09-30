/**
 * Violations → `vscode.Diagnostic`s, grouped by file.
 *
 * This is the whole of the extension's argument in code: reading RTL lint
 * output today is "the equivalent of reading compiler warnings by
 * scrolling a terminal — which is exactly what software engineers did
 * before IDEs integrated lint results", and VSCode's Diagnostic API *is*
 * that integration. Nothing here builds a list, a table, a filter, or a
 * trend: the Problems panel is the list, and the squiggle is the point.
 *
 * Pure except for constructing `vscode` value objects, so the mapping —
 * ranges, severities, rule ids, and which violations are suppressed — is
 * testable without an extension host.
 */
import * as vscode from 'vscode';
import { findWaiver, type LintWaiver } from '../waivers/model';
import type { LintViolation } from './model';
import { presentLintSeverity } from './severity';

/**
 * End column for a violation the engine gave no extent for.
 *
 * VSCode clamps a `Position` to the document when it renders, so this
 * squiggles from the reported column to the end of that line. The
 * alternative — a zero-width range at the exact column — renders as a
 * caret most people never notice, and inventing a token width here would
 * mean guessing at HDL lexing this extension deliberately does not do.
 * The exact `line:column` the engine reported is still what the Problems
 * panel entry shows.
 */
export const UNBOUNDED_END_CHARACTER = Number.MAX_SAFE_INTEGER;

/**
 * The range a violation occupies.
 *
 * LintCrux's `SourceLocation` is 1-based in both axes (it asserts
 * `line >= 1, column >= 1`); `vscode.Position` is 0-based in both. This
 * function is the only place that conversion happens.
 */
export function rangeForViolation(violation: LintViolation): vscode.Range {
  const startLine = violation.line - 1;
  const startCharacter = violation.column - 1;
  const endLine = (violation.endLine ?? violation.line) - 1;
  const endCharacter =
    violation.endColumn === undefined ? UNBOUNDED_END_CHARACTER : violation.endColumn - 1;
  // An engine that reports an end *before* the start (or an `endLine`
  // with no `endColumn`) must not produce an inverted range: VSCode
  // silently reorders those, which would put the squiggle somewhere the
  // engine never pointed at.
  if (endLine < startLine || (endLine === startLine && endCharacter < startCharacter)) {
    return new vscode.Range(startLine, startCharacter, startLine, UNBOUNDED_END_CHARACTER);
  }
  return new vscode.Range(startLine, startCharacter, endLine, endCharacter);
}

/**
 * One violation as a `vscode.Diagnostic`.
 *
 * `code` is the **engine-namespaced** rule id (`verilator/UNUSEDSIGNAL`),
 * not the local one: it is what the Problems panel lets the user filter
 * on, what a waiver has to name, and what the app calls the same rule. A
 * bare `UNUSEDSIGNAL` would collide across engines that share a rule name.
 */
export function buildDiagnostic(violation: LintViolation): vscode.Diagnostic {
  const presentation = presentLintSeverity(violation.severity);
  const diagnostic = new vscode.Diagnostic(
    rangeForViolation(violation),
    violation.message,
    presentation.severity,
  );
  diagnostic.source = presentation.source;
  diagnostic.code = violation.ruleId;
  return diagnostic;
}

/** What [planDiagnostics] needs. */
export interface DiagnosticPlanOptions {
  readonly violations: readonly LintViolation[];
  /** Waivers read from `.lintcrux-waivers.json`, applied live. */
  readonly waivers: readonly LintWaiver[];
  /** Evaluated against waiver expiry; injected so tests are not clock-dependent. */
  readonly now: Date;
}

/** The diagnostics to publish, and the counts behind them. */
export interface DiagnosticPlan {
  /** Absolute file path → its diagnostics. Only files with at least one. */
  readonly byFile: ReadonlyMap<string, readonly vscode.Diagnostic[]>;
  /**
   * The violations behind [byFile], same grouping and same order — what
   * the waiver code actions are offered for. A waived violation appears in
   * neither map: there is nothing to squiggle and nothing left to waive.
   */
  readonly violationsByFile: ReadonlyMap<string, readonly LintViolation[]>;
  /** How many diagnostics [byFile] holds in total. */
  readonly published: number;
  /** How many violations were dropped as waived. */
  readonly waived: number;
}

/**
 * Decide what to publish.
 *
 * A waived violation produces **no diagnostic**. Two ways to be waived,
 * and both are honoured:
 *
 * - LintCrux said so — `suppressed` in the flat JSON export, a non-empty
 *   `suppressions[]` in SARIF. This covers source pragmas
 *   (`// verilator lint_off …`) as well as managed waivers, since the app
 *   applies both before it exports.
 * - a waiver in `.lintcrux-waivers.json` matches. Applied here rather than
 *   waiting for the next lint run so the squiggle disappears the moment
 *   the code action writes the waiver — the immediate feedback *is* the
 *   code action; without it, filing a waiver would appear to do nothing.
 *
 * Applying waivers is not waiver *management*: nothing here lists, edits,
 * expires or reports on them. That is the app's job, and the
 * boundary is held deliberately.
 */
export function planDiagnostics(options: DiagnosticPlanOptions): DiagnosticPlan {
  const byFile = new Map<string, vscode.Diagnostic[]>();
  const violationsByFile = new Map<string, LintViolation[]>();
  let published = 0;
  let waived = 0;
  for (const violation of options.violations) {
    if (violation.suppressed) {
      waived += 1;
      continue;
    }
    const waiver = findWaiver(
      options.waivers,
      violation.ruleId,
      violation.file,
      violation.line,
      options.now,
    );
    if (waiver !== undefined) {
      waived += 1;
      continue;
    }
    const existing = byFile.get(violation.file);
    const diagnostic = buildDiagnostic(violation);
    if (existing === undefined) {
      byFile.set(violation.file, [diagnostic]);
      violationsByFile.set(violation.file, [violation]);
    } else {
      existing.push(diagnostic);
      violationsByFile.get(violation.file)?.push(violation);
    }
    published += 1;
  }
  return { byFile, violationsByFile, published, waived };
}
