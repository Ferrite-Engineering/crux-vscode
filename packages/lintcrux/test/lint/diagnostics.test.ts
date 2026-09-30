import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  UNBOUNDED_END_CHARACTER,
  buildDiagnostic,
  planDiagnostics,
  rangeForViolation,
} from '../../src/lint/diagnostics';
import type { LintViolation } from '../../src/lint/model';
import type { LintWaiver } from '../../src/waivers/model';

const NOW = new Date('2026-08-10T12:00:00.000Z');

function violation(overrides: Partial<LintViolation> = {}): LintViolation {
  return {
    engineId: 'verilator',
    ruleId: 'verilator/UNUSEDSIGNAL',
    severity: 'warning',
    message: "Signal is not used: 'ready'",
    file: '/work/design/rtl/cpu.sv',
    line: 42,
    column: 7,
    suppressed: false,
    ...overrides,
  };
}

function waiver(overrides: Partial<LintWaiver> = {}): LintWaiver {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    ruleId: 'verilator/UNUSEDSIGNAL',
    filePath: '/work/design/rtl/cpu.sv',
    reason: 'Refactor planned for Q3 (LIN-321)',
    author: 'mfink',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('rangeForViolation — 1-based LintCrux to 0-based VSCode', () => {
  it('converts both axes exactly once', () => {
    const range = rangeForViolation(violation({ line: 42, column: 7 }));
    expect(range.start.line).toBe(41);
    expect(range.start.character).toBe(6);
  });

  it('runs to the end of the line when the engine reported no extent', () => {
    const range = rangeForViolation(violation({ line: 42, column: 7 }));
    expect(range.end.line).toBe(41);
    expect(range.end.character).toBe(UNBOUNDED_END_CHARACTER);
  });

  it('uses the reported extent when there is one', () => {
    const range = rangeForViolation(violation({ line: 4, column: 2, endLine: 6, endColumn: 9 }));
    expect(range.start.line).toBe(3);
    expect(range.start.character).toBe(1);
    expect(range.end.line).toBe(5);
    expect(range.end.character).toBe(8);
  });

  it('never produces an inverted range VSCode would silently reorder', () => {
    const range = rangeForViolation(violation({ line: 10, column: 20, endLine: 8, endColumn: 1 }));
    expect(range.start.line).toBe(9);
    expect(range.start.character).toBe(19);
    expect(range.end.line).toBe(9);
    expect(range.end.character).toBe(UNBOUNDED_END_CHARACTER);
  });

  it('handles an endLine with no endColumn without collapsing backwards', () => {
    const range = rangeForViolation(violation({ line: 3, column: 5, endLine: 4 }));
    expect(range.end.line).toBe(3);
    expect(range.end.character).toBe(UNBOUNDED_END_CHARACTER);
  });
});

describe('buildDiagnostic', () => {
  it('keeps the engine message verbatim', () => {
    expect(buildDiagnostic(violation()).message).toBe("Signal is not used: 'ready'");
  });

  it('uses the engine-namespaced rule id as the diagnostic code', () => {
    // What the Problems panel filters on, what a waiver names, and what
    // the app calls the same rule. A bare `UNUSEDSIGNAL` would collide.
    expect(buildDiagnostic(violation()).code).toBe('verilator/UNUSEDSIGNAL');
  });

  it('carries the severity and source from the mapping table', () => {
    const fatal = buildDiagnostic(violation({ severity: 'fatal' }));
    expect(fatal.severity).toBe(vscode.DiagnosticSeverity.Error);
    expect(fatal.source).toBe('LintCrux (fatal)');

    const note = buildDiagnostic(violation({ severity: 'note' }));
    expect(note.severity).toBe(vscode.DiagnosticSeverity.Information);
    expect(note.source).toBe('LintCrux');
  });
});

describe('planDiagnostics — grouping', () => {
  it('groups by file and counts what it published', () => {
    const plan = planDiagnostics({
      violations: [
        violation(),
        violation({ line: 50 }),
        violation({ file: '/work/design/rtl/alu.sv' }),
      ],
      waivers: [],
      now: NOW,
    });
    expect([...plan.byFile.keys()]).toEqual(['/work/design/rtl/cpu.sv', '/work/design/rtl/alu.sv']);
    expect(plan.byFile.get('/work/design/rtl/cpu.sv')).toHaveLength(2);
    expect(plan.published).toBe(3);
    expect(plan.waived).toBe(0);
  });

  it('keeps violationsByFile aligned with byFile', () => {
    const plan = planDiagnostics({
      violations: [violation(), violation({ line: 50 })],
      waivers: [],
      now: NOW,
    });
    expect(plan.violationsByFile.get('/work/design/rtl/cpu.sv')?.map((v) => v.line)).toEqual([
      42, 50,
    ]);
  });
});

describe('planDiagnostics — waived violations produce no diagnostic', () => {
  it('drops what LintCrux already suppressed', () => {
    const plan = planDiagnostics({
      violations: [violation({ suppressed: true }), violation({ line: 50 })],
      waivers: [],
      now: NOW,
    });
    expect(plan.published).toBe(1);
    expect(plan.waived).toBe(1);
  });

  it('drops what a line-scoped waiver covers, and nothing else', () => {
    const plan = planDiagnostics({
      violations: [violation({ line: 42 }), violation({ line: 43 })],
      waivers: [waiver({ lineStart: 42 })],
      now: NOW,
    });
    expect(plan.published).toBe(1);
    expect(plan.waived).toBe(1);
    expect(plan.violationsByFile.get('/work/design/rtl/cpu.sv')?.[0]?.line).toBe(43);
  });

  it('honours an inclusive line range', () => {
    const plan = planDiagnostics({
      violations: [40, 42, 48, 49].map((line) => violation({ line })),
      waivers: [waiver({ lineStart: 42, lineEnd: 48 })],
      now: NOW,
    });
    expect(plan.waived).toBe(2);
    expect(plan.violationsByFile.get('/work/design/rtl/cpu.sv')?.map((v) => v.line)).toEqual([
      40, 49,
    ]);
  });

  it('drops every line when the waiver has no range at all', () => {
    const plan = planDiagnostics({
      violations: [violation({ line: 1 }), violation({ line: 900 })],
      waivers: [waiver()],
      now: NOW,
    });
    expect(plan.published).toBe(0);
    expect(plan.waived).toBe(2);
  });

  it('does not apply a waiver for a different rule or a different file', () => {
    const plan = planDiagnostics({
      violations: [violation()],
      waivers: [
        waiver({ ruleId: 'verilator/WIDTHTRUNC' }),
        waiver({ filePath: '/work/design/rtl/alu.sv' }),
      ],
      now: NOW,
    });
    expect(plan.published).toBe(1);
  });

  it('stops applying a waiver at its expiry instant', () => {
    const expiring = waiver({ expiresAt: NOW.toISOString() });
    expect(planDiagnostics({ violations: [violation()], waivers: [expiring], now: NOW }).published)
      .toBe(1);

    const stillValid = waiver({ expiresAt: '2026-08-10T12:00:00.001Z' });
    expect(
      planDiagnostics({ violations: [violation()], waivers: [stillValid], now: NOW }).published,
    ).toBe(0);
  });
});
