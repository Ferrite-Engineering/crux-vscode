import { describe, expect, it } from 'vitest';
import { REFRESH_COMMAND, TRIAGE_COMMAND, activate, deactivate } from '../src/extension';
import { WAIVE_VIOLATION_COMMAND } from '../src/waivers/code-actions';

describe('lintcrux extension entry points', () => {
  it('exports activate and deactivate', () => {
    expect(typeof activate).toBe('function');
    expect(typeof deactivate).toBe('function');
  });
});

describe('command ids', () => {
  it('namespaces product commands under `lintcrux.` and shared ones under `edacrux.`', () => {
    expect(REFRESH_COMMAND).toBe('lintcrux.refreshDiagnostics');
    expect(TRIAGE_COMMAND).toBe('lintcrux.openTriageInDesktop');
    expect(WAIVE_VIOLATION_COMMAND).toBe('lintcrux.waiveViolation');
  });
});
