/**
 * The pure `TestSpec` → `TestItem` / `TestResult` → `TestRun` mapping.
 *
 * No `TestController`, no `TestItem`, no `vscode.tests` — this module
 * produces a description of the tree and every VSCode call is made from it
 * in `controller.ts`. That split is what makes the interesting assertions
 * ("an `UNKNOWN` row and a `FAIL` row read differently in the tree")
 * testable in plain Node, the same way LintCrux's publisher is testable
 * behind its diagnostic sink.
 *
 * ### The shape of the mapping
 *
 * - **A suite becomes a parent `TestItem`.** `TestSpec.suiteName` is
 *   already the only grouping SimCrux has, and it is the one the config
 *   declares, so nothing is invented.
 * - **A test becomes a leaf `TestItem`** whose `id` is `TestSpec.id`
 *   verbatim — `<suite>/<name>`, plus `+key=value` and `+seed=N` on an
 *   expanded sweep child. Verbatim because that id is also the string the
 *   individual re-run passes to `simcrux --filter`, which is a plain
 *   substring test against `spec.id` (`CiRunner._matchesFilter`). An id
 *   this extension prettified would be an id that no longer selects the
 *   test it names.
 * - **The backbone is the config; results decorate it.** See
 *   `../run/project.ts` for why: a `--filter` run rewrites
 *   `results.ndjson` with only the tests it ran, so a results-only tree
 *   would delete everything else on the first re-run.
 * - **Rows with no config declaration are still added.** Sweep children,
 *   tests from an `includes:` file, and tests declared in a config this
 *   extension never found all arrive this way. Showing them is strictly
 *   better than hiding a test that demonstrably ran.
 */
import * as vscode from 'vscode';
import type { SimRunDocument, SimTestRow } from '../run/model';
import type { SimProject } from '../run/project';
import {
  hasCounterexample,
  isFormalPropertyRow,
  verdictDetail,
  verdictOf,
  verdictSummary,
  verdictTagId,
} from '../formal/verdict';
import { simStatusLabel, vscodeRunStateFor, type VscodeRunState } from './status';

/** One leaf in the tree. */
export interface SimTestNode {
  /** `TestSpec.id`, verbatim. Also the `--filter` argument for a re-run. */
  readonly id: string;
  readonly label: string;
  readonly suite: string;
  /**
   * The greyed text VSCode renders beside the label.
   *
   * This is where the formal verdict lands, and it is the mechanism that
   * makes "counterexample at step 7" and "the engine did not decide"
   * different rows *in the tree* rather than different log lines.
   */
  readonly description?: string;
  /** `TestTag` ids — the verdict tag, so the tree is filterable by it. */
  readonly tagIds: readonly string[];
  /** Absent when this test has not run in the loaded document. */
  readonly runState?: VscodeRunState;
  readonly durationMs?: number;
  /** Lines of the `TestMessage`. Empty when there is nothing to say. */
  readonly messages: readonly string[];
  /**
   * The counterexample VCD, when this row is a failing bounded proof that
   * recorded one. Present iff [hasCounterexample] — the exact mirror of
   * the CXP producer's gate.
   */
  readonly counterexamplePath?: string;
  /** The row this node was decorated from, for command handlers. */
  readonly row?: SimTestRow;
}

/** One suite parent. */
export interface SimSuiteNode {
  readonly id: string;
  readonly label: string;
  readonly tests: readonly SimTestNode[];
}

/** The whole tree, plus what the run's provenance permits us to claim. */
export interface SimTestTree {
  readonly suites: readonly SimSuiteNode[];
  /** How many nodes carry a run state. */
  readonly decorated: number;
  /**
   * The run's `results.ndjson` had no trailing `summary` line, so the
   * regression did not finish. Reported rather than smoothed over.
   */
  readonly incomplete: boolean;
  /**
   * The results document records a `config_path` that does not exist on
   * this machine, so **the regression did not run here**.
   *
   * This is the honest half of the local-loop boundary: a regression
   * frequently runs on CI or a farm, and this surface serves the local
   * loop. When a results file was fetched from elsewhere the tree still
   * shows it — it is real data — but the UI says where it came from
   * instead of offering a re-run that would silently run something else.
   */
  readonly ranElsewhere: boolean;
}

/** Injected environment for [buildSimTestTree]. */
export interface SimTestTreeOptions {
  /** The config-declared skeleton. Pass an empty project when there is none. */
  readonly project: SimProject;
  /** The loaded results, or `undefined` when nothing has run yet. */
  readonly document?: SimRunDocument;
  /**
   * Whether a path exists on this machine. Production: `existsSync`.
   * Injected so the provenance rules are testable without a filesystem.
   */
  readonly pathExists: (fsPath: string) => boolean;
}

/** The description for a decorated node: SimCrux's own words, joined. */
function describe(row: SimTestRow): string | undefined {
  const parts: string[] = [];
  const verdict = verdictOf(row);
  // The formal verdict comes first: on a formal row it is *the* fact, and
  // a description is truncated from the right in a narrow panel.
  if (verdict !== undefined) parts.push(verdictSummary(row, verdict));
  const status = simStatusLabel(row.status);
  if (status !== undefined) parts.push(status);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/** The `TestMessage` body: the failure, then the formal detail. */
function messagesFor(row: SimTestRow): readonly string[] {
  const lines: string[] = [];
  if (row.failureMessage !== undefined) lines.push(row.failureMessage);

  const verdict = verdictOf(row);
  if (verdict !== undefined) {
    lines.push(...verdictDetail(row, verdict));
  } else if (isFormalPropertyRow(row)) {
    // The key is present but its value is not one of the six. Said out
    // loud rather than rendered as a plain failure: an unreadable verdict
    // is a different problem from a failed proof, and silently dropping
    // it is how a build that added a seventh outcome would look like a
    // build that lost its formal reporting.
    lines.push(
      vscode.l10n.t(
        'This row carries a riscv.formal.verdict this version of the extension does not recognise: {0}',
        row.metrics['riscv.formal.verdict'] ?? '',
      ),
    );
  }

  if (row.killSignal !== undefined) {
    lines.push(vscode.l10n.t('The process was terminated with {0}.', row.killSignal));
  }
  if (row.exitCode !== undefined && row.status !== 'pass') {
    lines.push(vscode.l10n.t('Exit code: {0}', row.exitCode));
  }
  return lines;
}

function nodeFor(id: string, label: string, suite: string, row: SimTestRow | undefined): SimTestNode {
  if (row === undefined) {
    return { id, label, suite, tagIds: [], messages: [] };
  }
  const verdict = verdictOf(row);
  const description = describe(row);
  const counterexamplePath = hasCounterexample(row) ? row.waveformPath : undefined;
  return {
    id,
    label,
    suite,
    ...(description === undefined ? {} : { description }),
    tagIds: verdict === undefined ? [] : [verdictTagId(verdict)],
    runState: vscodeRunStateFor(row.status),
    durationMs: row.runtimeMs,
    messages: messagesFor(row),
    ...(counterexamplePath === undefined ? {} : { counterexamplePath }),
    row,
  };
}

/**
 * Build the tree from the config skeleton and the loaded results.
 *
 * Deterministic: suites in config-declaration order, then any suite seen
 * only in results, alphabetically; tests likewise. A tree that reorders
 * itself between refreshes is one the user cannot keep their place in.
 */
export function buildSimTestTree(options: SimTestTreeOptions): SimTestTree {
  const { project, document } = options;
  const rowsById = new Map<string, SimTestRow>();
  for (const row of document?.rows ?? []) rowsById.set(row.id, row);

  // Suite → tests, seeded from the config so declaration order survives.
  const bySuite = new Map<string, Map<string, SimTestNode>>();
  const suiteOrder: string[] = [];
  const suiteFor = (suite: string): Map<string, SimTestNode> => {
    let tests = bySuite.get(suite);
    if (tests === undefined) {
      tests = new Map<string, SimTestNode>();
      bySuite.set(suite, tests);
      suiteOrder.push(suite);
    }
    return tests;
  };

  for (const suite of project.suites) suiteFor(suite);
  for (const test of project.tests) {
    suiteFor(test.suite).set(test.id, nodeFor(test.id, test.name, test.suite, rowsById.get(test.id)));
  }

  // Rows with no config declaration: sweep children, `includes:` tests, or
  // a results file from a project this window never opened.
  const extra = [...rowsById.values()]
    .filter((row) => !(bySuite.get(row.suite)?.has(row.id) ?? false))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const row of extra) {
    suiteFor(row.suite).set(row.id, nodeFor(row.id, row.name, row.suite, row));
  }

  let decorated = 0;
  const suites: SimSuiteNode[] = [];
  for (const suite of suiteOrder) {
    const tests = [...(bySuite.get(suite)?.values() ?? [])];
    for (const test of tests) if (test.runState !== undefined) decorated += 1;
    suites.push({ id: suite, label: suite, tests });
  }

  // Provenance. `config_path` is written by the process that ran the
  // regression; if it names a file this machine does not have, the run was
  // not here. Absent `config_path` proves nothing either way, so it is not
  // treated as evidence of anything.
  const configPath = document?.meta.configPath;
  const ranElsewhere = configPath !== undefined && !options.pathExists(configPath);

  return {
    suites,
    decorated,
    incomplete: document !== undefined && !document.complete,
    ranElsewhere,
  };
}
