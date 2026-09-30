import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSimResults } from '../../src/run/results';
import { readSimProject } from '../../src/run/project';
import { buildSimTestTree, type SimTestNode, type SimTestTree } from '../../src/tests/tree';
import { buildRunReport, runProvenanceLines } from '../../src/tests/controller';
import { simStatusLabel, vscodeRunStateFor } from '../../src/tests/status';
import { SIM_TEST_STATUSES } from '../../src/run/model';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixture(name: string): string {
  return readFileSync(path.join(fixtures, name), 'utf8');
}

/** The demo tree, with nothing on the local filesystem (the honest default). */
function demoTree(pathExists: (fsPath: string) => boolean = () => false): SimTestTree {
  return buildSimTestTree({
    project: readSimProject(fixture('riscv-formal-demo.simcrux.yaml')),
    document: parseSimResults(fixture('riscv-formal-demo.results.ndjson')),
    pathExists,
  });
}

function nodeById(tree: SimTestTree, id: string): SimTestNode | undefined {
  return tree.suites.flatMap((suite) => suite.tests).find((test) => test.id === id);
}

describe('vscodeRunStateFor — the lossy projection, stated once', () => {
  it('is total over every SimTestStatus', () => {
    for (const status of SIM_TEST_STATUSES) {
      expect(typeof vscodeRunStateFor(status)).toBe('string');
    }
  });

  it('maps the four buckets as documented', () => {
    expect(vscodeRunStateFor('pass')).toBe('passed');
    expect(vscodeRunStateFor('cover')).toBe('passed');
    expect(vscodeRunStateFor('fail')).toBe('failed');
    expect(vscodeRunStateFor('skipped')).toBe('skipped');
    expect(vscodeRunStateFor('cancelled')).toBe('skipped');
    expect(vscodeRunStateFor('running')).toBe('started');
  });

  it('puts vacuous in errored, not passed — a testbench that tests nothing is not green', () => {
    expect(vscodeRunStateFor('vacuous')).toBe('errored');
  });

  it('puts timeout and unknown in errored — no trustworthy verdict was produced', () => {
    expect(vscodeRunStateFor('timeout')).toBe('errored');
    expect(vscodeRunStateFor('unknown')).toBe('errored');
  });

  it('gives back SimCrux’s own word wherever the icon is narrower than the truth', () => {
    expect(simStatusLabel('pass')).toBeUndefined();
    expect(simStatusLabel('fail')).toBeUndefined();
    for (const status of ['vacuous', 'cover', 'running', 'skipped', 'timeout', 'cancelled', 'unknown'] as const) {
      expect(simStatusLabel(status)).toBeTypeOf('string');
    }
  });
});

describe('buildSimTestTree — the demo run', () => {
  it('places every configured test under its suite, in declaration order', () => {
    const tree = demoTree();
    expect(tree.suites.map((suite) => suite.id)).toEqual([
      'insn',
      'pc_fwd',
      'reg',
      'causal',
      'liveness',
      'cover',
    ]);
    expect(tree.suites[0]?.tests.map((test) => test.id)).toEqual([
      'insn/insn_add_pass',
      'insn/insn_sub_counterexample',
    ]);
  });

  it('decorates every test the results file carries', () => {
    expect(demoTree().decorated).toBe(7);
  });

  it('uses TestSpec.id verbatim as the node id — it is also the --filter argument', () => {
    expect(nodeById(demoTree(), 'insn/insn_sub_counterexample')?.label).toBe(
      'insn_sub_counterexample',
    );
  });
});

describe('buildSimTestTree — the formal verdict survives into the tree', () => {
  it('gives the five TestStatus.fail rows five different descriptions', () => {
    const tree = demoTree();
    const failing = tree.suites
      .flatMap((suite) => suite.tests)
      .filter((test) => test.row?.status === 'fail');
    expect(failing).toHaveLength(5);
    // Same run state for all five...
    expect(new Set(failing.map((test) => test.runState))).toEqual(new Set(['failed']));
    // ...and five distinct things said about them in the tree itself.
    expect(new Set(failing.map((test) => test.description)).size).toBe(5);
  });

  it('says "counterexample" only on the row that has one', () => {
    const tree = demoTree();
    const withCounterexampleWording = tree.suites
      .flatMap((suite) => suite.tests)
      .filter((test) => (test.description ?? '').includes('counterexample'));
    expect(withCounterexampleWording.map((test) => test.id)).toEqual([
      'insn/insn_sub_counterexample',
    ]);
  });

  it('tags each row with its verbatim verdict, so the tree filters by it', () => {
    const tree = demoTree();
    expect(nodeById(tree, 'pc_fwd/pc_fwd_unknown')?.tagIds).toEqual([
      'riscv.formal.verdict=UNKNOWN',
    ]);
    expect(nodeById(tree, 'reg/reg_timeout')?.tagIds).toEqual(['riscv.formal.verdict=TIMEOUT']);
    expect(nodeById(tree, 'liveness/liveness_no_outcome')?.tagIds).toEqual([
      'riscv.formal.verdict=NO_OUTCOME',
    ]);
  });

  it('puts the verdict detail in the message, with the depth pair', () => {
    const messages = nodeById(demoTree(), 'insn/insn_sub_counterexample')?.messages ?? [];
    expect(messages[0]).toContain('counterexample at step 7');
    expect(messages).toContain('SymbiYosys verdict: FAIL');
    expect(messages).toContain('Depth: reached 7 of 20 configured');
    expect(messages).toContain('Engine: smtbmc boolector');
  });

  it('offers the counterexample handoff on the FAIL row and nowhere else', () => {
    const tree = demoTree();
    const offered = tree.suites
      .flatMap((suite) => suite.tests)
      .filter((test) => test.counterexamplePath !== undefined);
    expect(offered.map((test) => test.id)).toEqual(['insn/insn_sub_counterexample']);
    expect(offered[0]?.counterexamplePath).toBe(
      '/work/riscv-formal-demo/insn_sub_ch0/engine_0/trace.vcd',
    );
  });

  it('does NOT offer it for the cover row, which has a trace but verdict PASS', () => {
    // A cover trace is not a counterexample. The gate is verdict FAIL,
    // exactly as the CXP producer's is.
    const cover = nodeById(demoTree(), 'cover/cover_multi_trace');
    expect(cover?.row?.waveformPath).toBeTypeOf('string');
    expect(cover?.counterexamplePath).toBeUndefined();
  });

  it('says out loud when a verdict token is one this version does not know', () => {
    const document = parseSimResults(
      JSON.stringify({
        type: 'result',
        id: 's/t',
        name: 't',
        suite: 's',
        status: 'fail',
        runtime_ms: 1,
        metrics: { 'riscv.formal.verdict': 'INCONCLUSIVE' },
      }),
    );
    const tree = buildSimTestTree({ project: { suites: [], tests: [] }, document, pathExists: () => false });
    expect(nodeById(tree, 's/t')?.messages.join('\n')).toContain('does not recognise');
  });
});

describe('buildSimTestTree — the config is the backbone', () => {
  const project = readSimProject(fixture('riscv-formal-demo.simcrux.yaml'));

  it('keeps every configured test present when a filtered run rewrote the results', () => {
    // The failure this design exists to prevent: a `--filter` run recreates
    // results.ndjson with only what it ran, so a results-only tree would
    // delete the other six tests.
    const filtered = parseSimResults(
      fixture('riscv-formal-demo.results.ndjson')
        .split('\n')
        .filter((line) => !line.includes('"type":"result"') || line.includes('insn_sub'))
        .join('\n'),
    );
    const tree = buildSimTestTree({ project, document: filtered, pathExists: () => false });
    expect(tree.suites.flatMap((suite) => suite.tests)).toHaveLength(7);
    expect(tree.decorated).toBe(1);
  });

  it('leaves an un-run test with no run state at all, rather than calling it skipped', () => {
    const tree = buildSimTestTree({ project, pathExists: () => false });
    const node = nodeById(tree, 'reg/reg_timeout');
    expect(node).toBeDefined();
    expect(node?.runState).toBeUndefined();
    expect(node?.description).toBeUndefined();
    expect(buildRunReport(tree)).toEqual([]);
  });

  it('adds a row the config never declared — a sweep child or an includes: test', () => {
    const document = parseSimResults(
      JSON.stringify({
        type: 'result',
        id: 'insn/insn_add_pass+seed=3',
        name: 'insn_add_pass',
        suite: 'insn',
        status: 'pass',
        runtime_ms: 10,
      }),
    );
    const tree = buildSimTestTree({ project, document, pathExists: () => false });
    expect(nodeById(tree, 'insn/insn_add_pass+seed=3')).toBeDefined();
    // ...without displacing the declared one.
    expect(nodeById(tree, 'insn/insn_add_pass')).toBeDefined();
  });
});

describe('buildSimTestTree — provenance, honestly', () => {
  it('reports a run whose config file is not on this machine as run elsewhere', () => {
    expect(demoTree(() => false).ranElsewhere).toBe(true);
    expect(demoTree(() => true).ranElsewhere).toBe(false);
  });

  it('does not claim a run happened elsewhere when config_path was never recorded', () => {
    const document = parseSimResults(
      ['{"type":"meta","version":1,"run_id":"r"}', '{"type":"summary","version":1,"total":0}'].join(
        '\n',
      ),
    );
    expect(
      buildSimTestTree({ project: { suites: [], tests: [] }, document, pathExists: () => false })
        .ranElsewhere,
    ).toBe(false);
  });

  it('reports a results file with no summary line as an unfinished run', () => {
    const truncated = parseSimResults(
      fixture('riscv-formal-demo.results.ndjson').trim().split('\n').slice(0, -1).join('\n'),
    );
    const tree = buildSimTestTree({
      project: readSimProject(fixture('riscv-formal-demo.simcrux.yaml')),
      document: truncated,
      pathExists: () => true,
    });
    expect(tree.incomplete).toBe(true);
  });

  it('is not incomplete when nothing has been loaded at all', () => {
    expect(buildSimTestTree({ project: { suites: [], tests: [] }, pathExists: () => false }).incomplete)
      .toBe(false);
  });

  it('states both facts in the run output rather than smoothing them over', () => {
    const lines = runProvenanceLines({
      suites: [],
      decorated: 0,
      incomplete: true,
      ranElsewhere: true,
    });
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('another machine');
    expect(lines.join('\n')).toContain('did not finish');
  });

  it('says nothing when the run is local and complete', () => {
    expect(
      runProvenanceLines({ suites: [], decorated: 0, incomplete: false, ranElsewhere: false }),
    ).toEqual([]);
  });
});

describe('buildRunReport', () => {
  it('reports every decorated node and omits the rest', () => {
    const report = buildRunReport(demoTree());
    expect(report).toHaveLength(7);
    expect(report.filter((entry) => entry.state === 'failed')).toHaveLength(5);
    expect(report.filter((entry) => entry.state === 'passed')).toHaveLength(2);
  });

  it('carries the duration through from runtime_ms', () => {
    const entry = buildRunReport(demoTree()).find(
      (candidate) => candidate.id === 'insn/insn_sub_counterexample',
    );
    expect(entry?.durationMs).toBe(7000);
  });

  it('carries the message lines, so the failure decorates inline', () => {
    const entry = buildRunReport(demoTree()).find(
      (candidate) => candidate.id === 'pc_fwd/pc_fwd_unknown',
    );
    expect(entry?.messages.join('\n')).toContain('SymbiYosys verdict: UNKNOWN');
  });
});

describe('SimTestTreeController', () => {
  it('constructs and disposes without touching a live extension host', async () => {
    // A smoke check on the wiring only. Everything that *decides* anything
    // is in `tree.ts` and `buildRunReport`, both asserted above; what is
    // left here is the VSCode API surface, which belongs to an
    // extension-host run rather than to vitest.
    const { SimTestTreeController } = await import('../../src/tests/controller');
    const controller = new SimTestTreeController({
      runTests: () => Promise.resolve(),
      refresh: () => undefined,
      log: () => undefined,
    });
    expect(controller.nodeFor('insn/insn_add_pass')).toBeUndefined();
    expect(controller.isSuite('insn')).toBe(false);
    expect(() => controller.dispose()).not.toThrow();
  });
});
