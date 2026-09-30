/**
 * "Waive this…" — the code actions that file a LintCrux waiver from the
 * editor.
 *
 * Two actions per violation under the cursor, and no more:
 *
 * - **Waive this violation** — scoped to the violation's own line, which
 *   is what the app's waive dialog pre-fills (`_initialLineRange` is
 *   `'${v.location.line}'`).
 * - **Waive `<rule>` in this file** — the whole file, which is the app's
 *   "empty line range means the whole file" case.
 *
 * There is deliberately no "waive everywhere", no expiry picker, and no
 * list of existing waivers. Filing one waiver about the line you are
 * looking at is an editor gesture; deciding a waiver *policy* is triage,
 * and triage is the app's half of the product boundary.
 *
 * The action carries a command rather than a `WorkspaceEdit`: a waiver is
 * a write to a JSON file that is usually not open in any editor, and it
 * needs a reason from the user first. Both are things a command does and
 * an edit cannot.
 */
import * as vscode from 'vscode';
import type { LintViolation } from '../lint/model';
import { localRuleId } from '../lint/model';

/** Command the waiver code actions invoke. Contributed by this package's manifest. */
export const WAIVE_VIOLATION_COMMAND = 'lintcrux.waiveViolation';

/** The waiver a [WAIVE_VIOLATION_COMMAND] invocation should file. */
export interface WaiveTarget {
  /** Engine-namespaced rule id — what the waiver's `ruleId` must be. */
  readonly ruleId: string;
  /** Absolute path of the source file — what the waiver's `filePath` must be. */
  readonly filePath: string;
  /** 1-based line, or `undefined` for a whole-file waiver. */
  readonly line?: number;
}

/** Title for the line-scoped action. */
export function waiveThisViolationTitle(ruleId: string): string {
  return vscode.l10n.t('Waive this {0} violation…', localRuleId(ruleId));
}

/** Title for the file-scoped action. */
export function waiveRuleInFileTitle(ruleId: string): string {
  return vscode.l10n.t('Waive {0} in this file…', localRuleId(ruleId));
}

/**
 * The code actions offered for the violations intersecting [line].
 *
 * Matching on the **line** rather than the requested range: a lint
 * violation is reported at a point, and VSCode asks for actions covering
 * the selection, which is usually an empty range at the caret. Comparing
 * ranges would make the action appear only when the caret sat exactly on
 * the engine's column.
 *
 * Duplicate `(ruleId, line)` pairs — two engines flagging the same rule
 * name at the same place, or one engine reporting twice — collapse to one
 * pair of actions, because filing the same waiver twice writes two rows
 * that match the same violation.
 */
export function buildWaiverCodeActions(
  violations: readonly LintViolation[],
  filePath: string,
  line: number,
): vscode.CodeAction[] {
  const actions: vscode.CodeAction[] = [];
  const seen = new Set<string>();
  for (const violation of violations) {
    if (violation.line !== line) continue;
    if (seen.has(violation.ruleId)) continue;
    seen.add(violation.ruleId);

    const lineScoped = new vscode.CodeAction(
      waiveThisViolationTitle(violation.ruleId),
      vscode.CodeActionKind.QuickFix,
    );
    lineScoped.command = {
      command: WAIVE_VIOLATION_COMMAND,
      title: lineScoped.title,
      arguments: [{ ruleId: violation.ruleId, filePath, line } satisfies WaiveTarget],
    };

    const fileScoped = new vscode.CodeAction(
      waiveRuleInFileTitle(violation.ruleId),
      vscode.CodeActionKind.QuickFix,
    );
    fileScoped.command = {
      command: WAIVE_VIOLATION_COMMAND,
      title: fileScoped.title,
      arguments: [{ ruleId: violation.ruleId, filePath } satisfies WaiveTarget],
    };

    actions.push(lineScoped, fileScoped);
  }
  return actions;
}

/** Narrow an untrusted command argument to a [WaiveTarget]. */
export function asWaiveTarget(raw: unknown): WaiveTarget | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  const ruleId = candidate['ruleId'];
  const filePath = candidate['filePath'];
  const line = candidate['line'];
  if (typeof ruleId !== 'string' || ruleId === '') return undefined;
  if (typeof filePath !== 'string' || filePath === '') return undefined;
  if (line !== undefined && (typeof line !== 'number' || !Number.isInteger(line) || line < 1)) {
    return undefined;
  }
  return { ruleId, filePath, ...(line === undefined ? {} : { line }) };
}

/** Supplies the violations this provider offers actions for. */
export type ViolationsForFile = (filePath: string) => readonly LintViolation[];

/**
 * The `vscode.CodeActionProvider` registered for HDL documents.
 *
 * Thin on purpose: everything decidable without a live editor lives in
 * [buildWaiverCodeActions] above, so the tested surface is the mapping
 * rather than the registration.
 */
export class WaiverCodeActionProvider implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly violationsForFile: ViolationsForFile) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    const filePath = document.uri.fsPath;
    return buildWaiverCodeActions(this.violationsForFile(filePath), filePath, range.start.line + 1);
  }
}
