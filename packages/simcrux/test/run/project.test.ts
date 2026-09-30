import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readSimProject } from '../../src/run/project';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function demoConfig(): string {
  return readFileSync(path.join(fixtures, 'riscv-formal-demo.simcrux.yaml'), 'utf8');
}

describe('readSimProject — the shipped riscv-formal demo', () => {
  it('finds every suite, in declaration order', () => {
    expect(readSimProject(demoConfig()).suites).toEqual([
      'insn',
      'pc_fwd',
      'reg',
      'causal',
      'liveness',
      'cover',
    ]);
  });

  it('finds every test, with the id the loader would synthesize', () => {
    expect(readSimProject(demoConfig()).tests.map((test) => test.id)).toEqual([
      'insn/insn_add_pass',
      'insn/insn_sub_counterexample',
      'pc_fwd/pc_fwd_unknown',
      'reg/reg_timeout',
      'causal/causal_error',
      'liveness/liveness_no_outcome',
      'cover/cover_multi_trace',
    ]);
  });

  it('matches the ids the results file records — the join the tree depends on', () => {
    const configured = new Set(readSimProject(demoConfig()).tests.map((test) => test.id));
    const recorded = readFileSync(
      path.join(fixtures, 'riscv-formal-demo.results.ndjson'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; id?: string })
      .filter((entry) => entry.type === 'result')
      .map((entry) => entry.id);
    for (const id of recorded) expect(configured.has(id ?? '')).toBe(true);
  });

  it('is not confused by a nested riscv:/formal: sub-map under a test', () => {
    // `check:` and `group:` are indented deeper than `name:` and must not
    // be read as sibling test items or as suite names.
    const project = readSimProject(demoConfig());
    expect(project.suites).not.toContain('formal');
    expect(project.tests.map((test) => test.name)).not.toContain('insn_add_ch0');
  });

  it('is not confused by defaults: — only suites: contributes tests', () => {
    const project = readSimProject(demoConfig());
    expect(project.suites).not.toContain('riscv');
    expect(project.suites).not.toContain('pass_fail');
  });

  it('marks no test as fanning out — the demo declares no sweeps', () => {
    expect(readSimProject(demoConfig()).tests.every((test) => !test.mayFanOut)).toBe(true);
  });
});

describe('readSimProject — the shapes it must survive', () => {
  it('reads output.results_path when the config overrides it', () => {
    const project = readSimProject(
      ['version: "1"', 'output:', '  streaming: true', '  results_path: build/run.ndjson'].join(
        '\n',
      ),
    );
    expect(project.resultsPath).toBe('build/run.ndjson');
  });

  it('leaves resultsPath undefined when the config does not declare one', () => {
    expect(readSimProject('version: "1"\nsuites:\n  a:\n    tests:\n      - name: t').resultsPath)
      .toBeUndefined();
  });

  it('strips a trailing comment but not a "#" inside a quoted scalar', () => {
    const project = readSimProject(
      [
        'version: "1"',
        'suites:',
        '  insn:   # the per-instruction checks',
        '    tests:',
        "      - name: add   # a proof",
        "        pass_string: 'DONE (PASS'",
      ].join('\n'),
    );
    expect(project.tests.map((test) => test.id)).toEqual(['insn/add']);
  });

  it('unquotes a quoted test name', () => {
    const project = readSimProject(
      ['version: "1"', 'suites:', '  s:', '    tests:', '      - name: "my test"'].join('\n'),
    );
    expect(project.tests[0]?.name).toBe('my test');
  });

  it('flags a parameter sweep as fanning out, because its id is not the run id', () => {
    const project = readSimProject(
      [
        'version: "1"',
        'suites:',
        '  s:',
        '    tests:',
        '      - name: swept',
        '        parameters: {MEM_SIZE: [1024, 4096]}',
        '      - name: plain',
        '        parameters: {MEM_SIZE: 1024}',
      ].join('\n'),
    );
    expect(project.tests.map((test) => [test.name, test.mayFanOut])).toEqual([
      ['swept', true],
      ['plain', false],
    ]);
  });

  it('flags a seed sweep, and leaves a single seed alone', () => {
    const project = readSimProject(
      [
        'version: "1"',
        'suites:',
        '  s:',
        '    tests:',
        '      - name: swept',
        '        seeds: [1, 2, 3]',
        '      - name: fixed',
        '        seed: 7',
      ].join('\n'),
    );
    expect(project.tests.map((test) => [test.name, test.mayFanOut])).toEqual([
      ['swept', true],
      ['fixed', false],
    ]);
  });

  it('records a suite with no tests — "this suite is empty" is worth seeing', () => {
    const project = readSimProject(
      ['version: "1"', 'suites:', '  empty:', '    description: nothing here yet'].join('\n'),
    );
    expect(project.suites).toEqual(['empty']);
    expect(project.tests).toEqual([]);
  });

  it('returns an empty project for a config it cannot make sense of', () => {
    // Degrades to the results-only view rather than to an error the user
    // cannot act on.
    expect(readSimProject('!!! not yaml at all !!!')).toEqual({ suites: [], tests: [] });
  });

  it('returns an empty project for an empty file', () => {
    expect(readSimProject('')).toEqual({ suites: [], tests: [] });
  });

  it('does not invent a test from a sequence item without a name', () => {
    const project = readSimProject(
      ['version: "1"', 'suites:', '  s:', '    tests:', '      - top: tb_only'].join('\n'),
    );
    expect(project.tests).toEqual([]);
  });

  it('survives CRLF line endings', () => {
    const project = readSimProject(
      ['version: "1"', 'suites:', '  s:', '    tests:', '      - name: t'].join('\r\n'),
    );
    expect(project.tests.map((test) => test.id)).toEqual(['s/t']);
  });

  it('handles several suites each with several tests', () => {
    const project = readSimProject(
      [
        'version: "1"',
        'suites:',
        '  alpha:',
        '    tests:',
        '      - name: one',
        '      - name: two',
        '  beta:',
        '    sources: [b.sv]',
        '    tests:',
        '      - name: three',
      ].join('\n'),
    );
    expect(project.suites).toEqual(['alpha', 'beta']);
    expect(project.tests.map((test) => test.id)).toEqual(['alpha/one', 'alpha/two', 'beta/three']);
  });
});
