import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  WAIVE_VIOLATION_COMMAND,
  asWaiveTarget,
  buildWaiverCodeActions,
  type WaiveTarget,
} from '../../src/waivers/code-actions';
import type { LintViolation } from '../../src/lint/model';

const FILE = '/work/design/rtl/cpu.sv';

function violation(overrides: Partial<LintViolation> = {}): LintViolation {
  return {
    engineId: 'verilator',
    ruleId: 'verilator/UNUSEDSIGNAL',
    severity: 'warning',
    message: "Signal is not used: 'ready'",
    file: FILE,
    line: 42,
    column: 7,
    suppressed: false,
    ...overrides,
  };
}

function targetsOf(actions: readonly vscode.CodeAction[]): WaiveTarget[] {
  return actions.map((action) => action.command?.arguments?.[0] as WaiveTarget);
}

describe('buildWaiverCodeActions', () => {
  it('offers a line-scoped and a file-scoped waiver for the violation on that line', () => {
    const actions = buildWaiverCodeActions([violation()], FILE, 42);
    expect(actions).toHaveLength(2);
    expect(targetsOf(actions)).toEqual([
      { ruleId: 'verilator/UNUSEDSIGNAL', filePath: FILE, line: 42 },
      { ruleId: 'verilator/UNUSEDSIGNAL', filePath: FILE },
    ]);
  });

  it('titles them with the local rule id, not the namespaced one', () => {
    const [lineScoped, fileScoped] = buildWaiverCodeActions([violation()], FILE, 42);
    expect(lineScoped?.title).toBe('Waive this UNUSEDSIGNAL violation…');
    expect(fileScoped?.title).toBe('Waive UNUSEDSIGNAL in this file…');
  });

  it('marks them as quick fixes and routes them through the waive command', () => {
    for (const action of buildWaiverCodeActions([violation()], FILE, 42)) {
      expect(action.kind).toBe(vscode.CodeActionKind.QuickFix);
      expect(action.command?.command).toBe(WAIVE_VIOLATION_COMMAND);
    }
  });

  it('offers nothing for a line with no violation', () => {
    expect(buildWaiverCodeActions([violation()], FILE, 41)).toEqual([]);
  });

  it('offers one pair per rule when several rules fire on the same line', () => {
    const actions = buildWaiverCodeActions(
      [violation(), violation({ ruleId: 'verilator/WIDTHTRUNC' })],
      FILE,
      42,
    );
    expect(actions).toHaveLength(4);
    expect(new Set(targetsOf(actions).map((t) => t.ruleId))).toEqual(
      new Set(['verilator/UNUSEDSIGNAL', 'verilator/WIDTHTRUNC']),
    );
  });

  it('collapses a duplicate rule on the same line to one pair', () => {
    // Filing the same waiver twice writes two rows matching the same
    // violation, which is noise in a file the app also edits.
    const actions = buildWaiverCodeActions([violation(), violation({ column: 20 })], FILE, 42);
    expect(actions).toHaveLength(2);
  });
});

describe('asWaiveTarget — the command argument is untrusted', () => {
  it('accepts a line-scoped target', () => {
    expect(asWaiveTarget({ ruleId: 'r/x', filePath: '/f.sv', line: 3 })).toEqual({
      ruleId: 'r/x',
      filePath: '/f.sv',
      line: 3,
    });
  });

  it('accepts a whole-file target', () => {
    expect(asWaiveTarget({ ruleId: 'r/x', filePath: '/f.sv' })).toEqual({
      ruleId: 'r/x',
      filePath: '/f.sv',
    });
  });

  it('rejects anything missing, empty, or the wrong shape', () => {
    expect(asWaiveTarget(undefined)).toBeUndefined();
    expect(asWaiveTarget('a string')).toBeUndefined();
    expect(asWaiveTarget({ filePath: '/f.sv' })).toBeUndefined();
    expect(asWaiveTarget({ ruleId: '', filePath: '/f.sv' })).toBeUndefined();
    expect(asWaiveTarget({ ruleId: 'r/x', filePath: '' })).toBeUndefined();
    expect(asWaiveTarget({ ruleId: 'r/x', filePath: '/f.sv', line: 0 })).toBeUndefined();
    expect(asWaiveTarget({ ruleId: 'r/x', filePath: '/f.sv', line: 1.5 })).toBeUndefined();
    expect(asWaiveTarget({ ruleId: 'r/x', filePath: '/f.sv', line: '3' })).toBeUndefined();
  });
});
