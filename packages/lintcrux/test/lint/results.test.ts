import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LintResultsFormatError, parseLintResults } from '../../src/lint/results';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const RESULTS_DIRECTORY = '/work/design';

function sarif(runs: unknown[]): string {
  return JSON.stringify({ version: '2.1.0', runs });
}

function run(results: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { tool: { driver: { name: 'verilator' } }, results, ...extra };
}

function result(overrides: Record<string, unknown> = {}): unknown {
  return {
    ruleId: 'UNUSEDSIGNAL',
    level: 'warning',
    message: { text: "Signal is not used: 'ready'" },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: 'rtl/cpu.sv' },
          region: { startLine: 42, startColumn: 7 },
        },
      },
    ],
    ...overrides,
  };
}

describe('parseLintResults — the real product fixture', () => {
  it('reads a `lintcrux --sarif` document end to end', () => {
    const text = readFileSync(path.join(fixtures, 'getting-started.sarif'), 'utf8');
    const parsed = parseLintResults(text, '/work/getting-started');

    expect(parsed.format).toBe('sarif');
    // Two runs (verible + verilator) folded into one violation list.
    expect(parsed.violations.length).toBeGreaterThan(0);
    expect(new Set(parsed.violations.map((v) => v.engineId))).toEqual(
      new Set(['verible', 'verilator']),
    );
    // The engine namespace is re-added: SARIF stores the local id and
    // names the engine on the driver.
    expect(parsed.violations.map((v) => v.ruleId)).toContain(
      'verible/explicit-parameter-storage-type',
    );
    expect(parsed.violations.map((v) => v.ruleId)).toContain('verilator/UNUSEDSIGNAL');
    // `%SRCROOT%` is declared as `./` in this document, which is not an
    // absolute base — so the results file's own directory anchors it.
    for (const violation of parsed.violations) {
      expect(path.isAbsolute(violation.file)).toBe(true);
      expect(violation.file.startsWith('/work/getting-started/')).toBe(true);
    }
  });
});

describe('parseLintResults — SARIF', () => {
  it('maps every level onto LintCrux’s own severity names', () => {
    const parsed = parseLintResults(
      sarif([
        run([
          result({ level: 'error' }),
          result({ level: 'warning' }),
          result({ level: 'note' }),
          result({ level: 'none' }),
        ]),
      ]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations.map((v) => v.severity)).toEqual(['error', 'warning', 'note', 'none']);
  });

  it('defaults an absent or unrecognised level to warning, as SarifReader does', () => {
    const parsed = parseLintResults(
      sarif([run([result({ level: undefined }), result({ level: 'catastrophe' })])]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations.map((v) => v.severity)).toEqual(['warning', 'warning']);
  });

  it('honours the `properties.lintcrux.severity` fatal extension', () => {
    const parsed = parseLintResults(
      sarif([
        run([result({ level: 'error', properties: { lintcrux: { severity: 'fatal' } } })]),
      ]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.severity).toBe('fatal');
  });

  it('ignores a lintcrux property that is not a severity name', () => {
    const parsed = parseLintResults(
      sarif([run([result({ level: 'note', properties: { lintcrux: { severity: 'urgent' } } })])]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.severity).toBe('note');
  });

  it('treats a non-empty suppressions array as waived by LintCrux', () => {
    const parsed = parseLintResults(
      sarif([
        run([
          result({ suppressions: [{ kind: 'inSource' }] }),
          result({ suppressions: [] }),
          result({}),
        ]),
      ]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations.map((v) => v.suppressed)).toEqual([true, false, false]);
  });

  it('leaves an already-namespaced ruleId alone', () => {
    const parsed = parseLintResults(
      sarif([run([result({ ruleId: 'cdc/unsync-multi-bit' })])]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.ruleId).toBe('cdc/unsync-multi-bit');
  });

  it('lowercases the engine id, as the reader does', () => {
    const parsed = parseLintResults(
      sarif([{ tool: { driver: { name: 'Verilator' } }, results: [result()] }]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.engineId).toBe('verilator');
    expect(parsed.violations[0]?.ruleId).toBe('verilator/UNUSEDSIGNAL');
  });

  it('resolves a relative uri against an absolute uriBaseId', () => {
    const parsed = parseLintResults(
      sarif([
        run(
          [
            result({
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'rtl/cpu.sv', uriBaseId: '%SRCROOT%' },
                    region: { startLine: 3, startColumn: 1 },
                  },
                },
              ],
            }),
          ],
          { originalUriBaseIds: { '%SRCROOT%': { uri: 'file:///abs/project/' } } },
        ),
      ]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.file).toBe('/abs/project/rtl/cpu.sv');
  });

  it('falls back to the results file’s directory when the base is relative', () => {
    const parsed = parseLintResults(
      sarif([run([result()], { originalUriBaseIds: { '%SRCROOT%': { uri: './' } } })]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.file).toBe('/work/design/rtl/cpu.sv');
  });

  it('keeps an absolute uri as-is — the in-app exporter emits those', () => {
    const parsed = parseLintResults(
      sarif([
        run([
          result({
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: '/elsewhere/lib/fifo.sv' },
                  region: { startLine: 1, startColumn: 1 },
                },
              },
            ],
          }),
        ]),
      ]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.file).toBe('/elsewhere/lib/fifo.sv');
  });

  it('carries endLine/endColumn when the engine reported an extent', () => {
    const parsed = parseLintResults(
      sarif([
        run([
          result({
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'a.sv' },
                  region: { startLine: 4, startColumn: 2, endLine: 4, endColumn: 9 },
                },
              },
            ],
          }),
        ]),
      ]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.endLine).toBe(4);
    expect(parsed.violations[0]?.endColumn).toBe(9);
  });

  it('drops a result with no physical location rather than inventing one', () => {
    const parsed = parseLintResults(
      sarif([run([result({ locations: [] }), result()])]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations).toHaveLength(1);
  });

  it('defaults a missing region to line 1, column 1', () => {
    const parsed = parseLintResults(
      sarif([
        run([
          result({
            locations: [{ physicalLocation: { artifactLocation: { uri: 'a.sv' } } }],
          }),
        ]),
      ]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.line).toBe(1);
    expect(parsed.violations[0]?.column).toBe(1);
  });
});

describe('parseLintResults — the flat JSON export', () => {
  const entry = {
    engineId: 'verible',
    ruleId: 'verible/case-missing-default',
    severity: 'note',
    message: 'Explicitly define a default case.',
    location: { file: '/work/design/alu.sv', line: 36, column: 5 },
    relatedLocations: [],
    suppressed: false,
  };

  it('reads the array `ViolationExporters.toJson` writes', () => {
    const parsed = parseLintResults(JSON.stringify([entry]), RESULTS_DIRECTORY);
    expect(parsed.format).toBe('json');
    expect(parsed.violations).toEqual([
      {
        engineId: 'verible',
        ruleId: 'verible/case-missing-default',
        severity: 'note',
        message: 'Explicitly define a default case.',
        file: '/work/design/alu.sv',
        line: 36,
        column: 5,
        suppressed: false,
      },
    ]);
  });

  it('honours `suppressed`', () => {
    const parsed = parseLintResults(
      JSON.stringify([{ ...entry, suppressed: true }]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.suppressed).toBe(true);
  });

  it('reads every severity name the product emits', () => {
    const parsed = parseLintResults(
      JSON.stringify(
        ['fatal', 'error', 'warning', 'note', 'none'].map((severity) => ({ ...entry, severity })),
      ),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations.map((v) => v.severity)).toEqual([
      'fatal',
      'error',
      'warning',
      'note',
      'none',
    ]);
  });

  it('keeps an unknown severity visible as a warning rather than dropping the row', () => {
    const parsed = parseLintResults(
      JSON.stringify([{ ...entry, severity: 'blocker' }]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.severity).toBe('warning');
  });

  it('resolves a relative file against the results directory', () => {
    const parsed = parseLintResults(
      JSON.stringify([{ ...entry, location: { file: 'alu.sv', line: 1, column: 1 } }]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations[0]?.file).toBe('/work/design/alu.sv');
  });

  it('skips rows with no rule id or no file', () => {
    const parsed = parseLintResults(
      JSON.stringify([
        { ...entry, ruleId: '' },
        { ...entry, location: { line: 1, column: 1 } },
        entry,
      ]),
      RESULTS_DIRECTORY,
    );
    expect(parsed.violations).toHaveLength(1);
  });
});

describe('parseLintResults — refusals', () => {
  it('rejects text that is not JSON', () => {
    expect(() => parseLintResults('not json', RESULTS_DIRECTORY)).toThrow(LintResultsFormatError);
  });

  it('rejects a JSON object that is neither shape', () => {
    expect(() => parseLintResults('{"violations": []}', RESULTS_DIRECTORY)).toThrow(
      LintResultsFormatError,
    );
  });

  it('accepts a SARIF document with no results at all', () => {
    expect(parseLintResults(sarif([]), RESULTS_DIRECTORY).violations).toEqual([]);
  });

  it('accepts an empty JSON export', () => {
    expect(parseLintResults('[]', RESULTS_DIRECTORY).violations).toEqual([]);
  });
});
