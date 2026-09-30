import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { LINT_SEVERITIES, type LintSeverity } from '../../src/lint/model';
import { presentLintSeverity } from '../../src/lint/severity';

describe('presentLintSeverity — the mapping table', () => {
  it('maps fatal and error onto Error, since VSCode has nothing above it', () => {
    expect(presentLintSeverity('fatal').severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(presentLintSeverity('error').severity).toBe(vscode.DiagnosticSeverity.Error);
  });

  it('maps warning onto Warning', () => {
    expect(presentLintSeverity('warning').severity).toBe(vscode.DiagnosticSeverity.Warning);
  });

  it('maps note onto Information, not Hint', () => {
    // A Hint produces no Problems panel entry: a note the app lists would
    // vanish. This assertion is the whole reason the mapping is explicit.
    expect(presentLintSeverity('note').severity).toBe(vscode.DiagnosticSeverity.Information);
    expect(presentLintSeverity('note').severity).not.toBe(vscode.DiagnosticSeverity.Hint);
  });

  it('maps none onto Warning, matching SarifReader’s own fallback', () => {
    expect(presentLintSeverity('none').severity).toBe(vscode.DiagnosticSeverity.Warning);
  });

  it('never maps anything to Hint', () => {
    for (const severity of LINT_SEVERITIES) {
      expect(presentLintSeverity(severity).severity).not.toBe(vscode.DiagnosticSeverity.Hint);
    }
  });
});

describe('presentLintSeverity — collapsed distinctions are visible, not silent', () => {
  it('flags exactly the two levels VSCode has no counterpart for', () => {
    const collapsed = LINT_SEVERITIES.filter((s) => presentLintSeverity(s).collapsed);
    expect(collapsed).toEqual(['fatal', 'none']);
  });

  it('carries the collapsed level in `source`, so the Problems panel still shows it', () => {
    expect(presentLintSeverity('fatal').source).toBe('LintCrux (fatal)');
    expect(presentLintSeverity('none').source).toBe('LintCrux (unclassified)');
  });

  it('uses the plain product name for every level that maps cleanly', () => {
    for (const severity of ['error', 'warning', 'note'] satisfies LintSeverity[]) {
      expect(presentLintSeverity(severity).source).toBe('LintCrux');
      expect(presentLintSeverity(severity).collapsed).toBe(false);
    }
  });

  it('gives fatal a different source from error, so the two are distinguishable', () => {
    // Both are `Error`; if the sources matched too, the distinction the
    // app makes would be gone from the editor entirely.
    expect(presentLintSeverity('fatal').source).not.toBe(presentLintSeverity('error').source);
  });

  it('covers every severity the product declares', () => {
    expect(LINT_SEVERITIES).toEqual(['fatal', 'error', 'warning', 'note', 'none']);
    for (const severity of LINT_SEVERITIES) {
      expect(typeof presentLintSeverity(severity).source).toBe('string');
    }
  });
});
