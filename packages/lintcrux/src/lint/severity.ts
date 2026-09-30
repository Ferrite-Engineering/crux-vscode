/**
 * LintCrux's five severities → VSCode's four, deliberately and in one
 * place.
 *
 * ### The table, and what it costs
 *
 * | LintCrux  | `DiagnosticSeverity` | `Diagnostic.source`      |
 * |-----------|----------------------|--------------------------|
 * | `fatal`   | `Error`              | `LintCrux (fatal)`       |
 * | `error`   | `Error`              | `LintCrux`               |
 * | `warning` | `Warning`            | `LintCrux`               |
 * | `note`    | `Information`        | `LintCrux`               |
 * | `none`    | `Warning`            | `LintCrux (unclassified)`|
 *
 * Two of these have no natural counterpart, and neither is allowed to
 * disappear quietly:
 *
 * **`fatal`** — VSCode has nothing above `Error`, exactly as SARIF has
 * nothing above `level: "error"`. LintCrux already solved this once, for
 * SARIF, by writing `properties.lintcrux.severity = "fatal"` alongside the
 * downgraded level; this is the same move in VSCode's vocabulary, carrying
 * the distinction in [Diagnostic.source] — which the Problems panel renders
 * beside the rule id, and which is filterable — rather than in the message,
 * which must stay byte-identical to what the app shows.
 *
 * **`none`** — the engine emitted something LintCrux's own parser could not
 * classify. It becomes `Warning`, not `Hint`: a `Hint` produces no Problems
 * panel entry and renders as a nearly invisible underline, so a violation
 * the app lists in its table would vanish here. `Warning` is also what
 * `SarifReader._levelToSeverity` falls back to for an unrecognised level,
 * so an unclassifiable violation is ranked the same on both sides.
 *
 * `note` maps to `Information` for the same visibility reason: it is
 * LintCrux's informational level, and `Hint` is reserved in VSCode for
 * affordances the user is not meant to read as findings.
 */
import * as vscode from 'vscode';
import type { LintSeverity } from './model';

/** The diagnostic source for a violation whose severity maps cleanly. */
function plainSource(): string {
  // Not localized as a *name*: "LintCrux" is the product's name in every
  // locale. Only the parenthetical qualifiers below are translated.
  return 'LintCrux';
}

/**
 * How one LintCrux severity is presented in VSCode.
 *
 * [collapsed] is true exactly when VSCode has no counterpart for the
 * LintCrux level and [source] is carrying the difference — the flag exists
 * so a test can assert the set of collapsed levels rather than infer it
 * from a string.
 */
export interface LintSeverityPresentation {
  readonly severity: vscode.DiagnosticSeverity;
  readonly source: string;
  readonly collapsed: boolean;
}

/** Map one LintCrux severity onto VSCode's vocabulary. See the table above. */
export function presentLintSeverity(severity: LintSeverity): LintSeverityPresentation {
  switch (severity) {
    case 'fatal':
      return {
        severity: vscode.DiagnosticSeverity.Error,
        source: vscode.l10n.t('LintCrux (fatal)'),
        collapsed: true,
      };
    case 'error':
      return { severity: vscode.DiagnosticSeverity.Error, source: plainSource(), collapsed: false };
    case 'warning':
      return {
        severity: vscode.DiagnosticSeverity.Warning,
        source: plainSource(),
        collapsed: false,
      };
    case 'note':
      return {
        severity: vscode.DiagnosticSeverity.Information,
        source: plainSource(),
        collapsed: false,
      };
    case 'none':
      return {
        severity: vscode.DiagnosticSeverity.Warning,
        source: vscode.l10n.t('LintCrux (unclassified)'),
        collapsed: true,
      };
  }
}
