import type * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import {
  LintDiagnosticsPublisher,
  type LintDiagnosticSink,
  type LintResultsSource,
} from '../../src/lint/publisher';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const RESULTS = '/work/design/lintcrux.sarif';
const WAIVERS = '/work/design/.lintcrux-waivers.json';

function sarif(results: unknown[]): string {
  return JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'verilator' } }, results }],
  });
}

function result(line: number, ruleId = 'UNUSEDSIGNAL'): unknown {
  return {
    ruleId,
    level: 'warning',
    message: { text: 'message' },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: 'rtl/cpu.sv' },
          region: { startLine: line, startColumn: 1 },
        },
      },
    ],
  };
}

interface Harness {
  readonly publisher: LintDiagnosticsPublisher;
  readonly published: Map<string, readonly vscode.Diagnostic[]>;
  readonly clears: { count: number };
  readonly logs: string[];
}

function harness(files: Record<string, string>, resultsPaths = [RESULTS]): Harness {
  const published = new Map<string, readonly vscode.Diagnostic[]>();
  const clears = { count: 0 };
  const logs: string[] = [];
  const sink: LintDiagnosticSink = {
    set: (filePath, diagnostics) => published.set(filePath, diagnostics),
    clear: () => {
      clears.count += 1;
      published.clear();
    },
    dispose: () => undefined,
  };
  const source: LintResultsSource = {
    resultsPaths: () => resultsPaths,
    waiverFileFor: () => WAIVERS,
    readText: (filePath) => files[filePath],
    now: () => NOW,
    log: (line) => logs.push(line),
  };
  return { publisher: new LintDiagnosticsPublisher(sink, source), published, clears, logs };
}

describe('LintDiagnosticsPublisher.refresh', () => {
  it('publishes diagnostics for every file the results name', () => {
    const { publisher, published } = harness({ [RESULTS]: sarif([result(42), result(50)]) });
    const summary = publisher.refresh();
    expect(summary.published).toBe(2);
    expect(summary.filesWithDiagnostics).toBe(1);
    expect(published.get('/work/design/rtl/cpu.sv')).toHaveLength(2);
    expect(summary.sourcesRead).toEqual([RESULTS]);
  });

  it('remembers the violations behind the diagnostics, for the code actions', () => {
    const { publisher } = harness({ [RESULTS]: sarif([result(42)]) });
    publisher.refresh();
    expect(publisher.violationsFor('/work/design/rtl/cpu.sv').map((v) => v.line)).toEqual([42]);
    expect(publisher.violationsFor('/work/design/rtl/alu.sv')).toEqual([]);
  });

  it('reports a missing results file as the ordinary "not run yet" case', () => {
    const { publisher, logs } = harness({});
    const summary = publisher.refresh();
    expect(summary.sourcesMissing).toEqual([RESULTS]);
    expect(summary.errors).toEqual([]);
    expect(summary.published).toBe(0);
    expect(logs).toEqual([]);
  });

  it('reports a malformed results file without throwing', () => {
    const { publisher, logs } = harness({ [RESULTS]: 'not json' });
    const summary = publisher.refresh();
    expect(summary.errors).toHaveLength(1);
    expect(summary.published).toBe(0);
    expect(logs[0]).toContain('lint results unreadable');
  });

  it('clears before every publish, so a fixed violation loses its squiggle', () => {
    const files: Record<string, string> = { [RESULTS]: sarif([result(42)]) };
    const { publisher, published, clears } = harness(files);
    publisher.refresh();
    expect(published.size).toBe(1);

    files[RESULTS] = sarif([]);
    publisher.refresh();
    expect(published.size).toBe(0);
    expect(clears.count).toBe(2);
  });

  it('merges violations across several results files', () => {
    const second = '/work/design/other.sarif';
    const { publisher } = harness(
      { [RESULTS]: sarif([result(42)]), [second]: sarif([result(50)]) },
      [RESULTS, second],
    );
    expect(publisher.refresh().published).toBe(2);
  });
});

describe('LintDiagnosticsPublisher — waivers', () => {
  const waiverFile = (lineStart: number | undefined): string =>
    JSON.stringify({
      version: 1,
      waivers: [
        {
          id: 'w1',
          ruleId: 'verilator/UNUSEDSIGNAL',
          filePath: '/work/design/rtl/cpu.sv',
          ...(lineStart === undefined ? {} : { lineStart }),
          reason: 'Refactor planned',
          author: 'mfink',
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ],
    });

  it('suppresses a waived violation and counts it', () => {
    const { publisher } = harness({
      [RESULTS]: sarif([result(42), result(50)]),
      [WAIVERS]: waiverFile(42),
    });
    const summary = publisher.refresh();
    expect(summary.published).toBe(1);
    expect(summary.waived).toBe(1);
  });

  it('ignores a waiver file it must not interpret, and keeps the squiggles', () => {
    // Treating an unreadable waiver file as "everything is waived" would
    // hide findings on the strength of a file we just failed to read.
    const { publisher, logs } = harness({
      [RESULTS]: sarif([result(42)]),
      [WAIVERS]: JSON.stringify({ version: 99, waivers: [] }),
    });
    const summary = publisher.refresh();
    expect(summary.published).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(logs.some((line) => line.includes('waiver file ignored'))).toBe(true);
  });

  it('reads each waiver file once however many violations point at it', () => {
    let reads = 0;
    const sink: LintDiagnosticSink = { set: () => undefined, clear: () => undefined, dispose: () => undefined };
    const publisher = new LintDiagnosticsPublisher(sink, {
      resultsPaths: () => [RESULTS],
      waiverFileFor: () => WAIVERS,
      readText: (filePath) => {
        if (filePath === WAIVERS) reads += 1;
        return filePath === RESULTS ? sarif([result(1), result(2), result(3)]) : waiverFile(1);
      },
      now: () => NOW,
      log: () => undefined,
    });
    publisher.refresh();
    expect(reads).toBe(1);
  });
});

describe('LintDiagnosticsPublisher.clear', () => {
  it('drops the diagnostics and the remembered violations', () => {
    const { publisher, published } = harness({ [RESULTS]: sarif([result(42)]) });
    publisher.refresh();
    publisher.clear();
    expect(published.size).toBe(0);
    expect(publisher.violationsFor('/work/design/rtl/cpu.sv')).toEqual([]);
  });
});
