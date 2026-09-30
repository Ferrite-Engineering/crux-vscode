/**
 * The `TestController` adapter: the tree description from `tree.ts`,
 * applied to VSCode's testing API.
 *
 * The split is deliberate and mirrors LintCrux's publisher/sink shape.
 * Everything that *decides* anything — which item, which state, which
 * message, which tag — is in `tree.ts` and [buildRunReport] below, both
 * pure. This file only walks that description into `TestItem`s and
 * `TestRun` calls. What is left untested here is the VSCode API surface
 * itself, which is the correct thing to leave to an extension-host run.
 *
 * ### Why results are published through a `TestRun` at all
 *
 * VSCode has no way to set a `TestItem`'s state outside a run. The results
 * file *is* the record of a run that already happened, so this opens a run,
 * reports every row into it, and ends it immediately. The alternative —
 * leaving every item stateless and putting the outcome in the description —
 * would give up the inline failure decoration in the editor, which is half
 * of what the extension is for.
 */
import * as vscode from 'vscode';
import type { SimSuiteNode, SimTestNode, SimTestTree } from './tree';
import type { VscodeRunState } from './status';

/** The `TestController` id. Namespaced by product, like every other id here. */
export const SIM_TEST_CONTROLLER_ID = 'simcrux.regression';

/** One outcome, in the order it is reported into a `TestRun`. */
export interface SimRunReportEntry {
  readonly id: string;
  readonly state: VscodeRunState;
  readonly durationMs?: number;
  readonly messages: readonly string[];
}

/**
 * Flatten a tree into the run report.
 *
 * Nodes with no `runState` are omitted entirely rather than reported as
 * skipped: "has not run in the results I can see" and "the run decided to
 * skip this" are different facts, and VSCode renders the first correctly
 * as *no state at all*.
 */
export function buildRunReport(tree: SimTestTree): readonly SimRunReportEntry[] {
  const entries: SimRunReportEntry[] = [];
  for (const suite of tree.suites) {
    for (const test of suite.tests) {
      if (test.runState === undefined) continue;
      entries.push({
        id: test.id,
        state: test.runState,
        ...(test.durationMs === undefined ? {} : { durationMs: test.durationMs }),
        messages: test.messages,
      });
    }
  }
  return entries;
}

/**
 * The lines that go at the top of a run's output, stating what the results
 * are and are not.
 *
 * This is where the local-loop boundary is honoured concretely: a
 * regression that ran on a farm is *shown*, because the data is real, but
 * the run says where it came from. Silence here would let a stale or
 * foreign results file read as "what my working tree does right now".
 */
export function runProvenanceLines(tree: SimTestTree): readonly string[] {
  const lines: string[] = [];
  if (tree.ranElsewhere) {
    lines.push(
      vscode.l10n.t(
        'These results were produced on another machine — the project file they name is not on this one. They are shown as recorded; re-running from here runs against your working tree instead.',
      ),
    );
  }
  if (tree.incomplete) {
    lines.push(
      vscode.l10n.t(
        'This results file has no completion record, so the regression did not finish. Tests that had not reported yet are missing rather than passing.',
      ),
    );
  }
  return lines;
}

/** What [SimTestTreeController] needs from `activate()`. */
export interface SimTestTreeControllerOptions {
  /** Start a regression for a run request; resolves when the run has finished. */
  readonly runTests: (
    selectedIds: readonly string[],
    token: vscode.CancellationToken,
  ) => Promise<void>;
  /** Re-read the results file. Called after a run and on demand. */
  readonly refresh: () => void | Promise<void>;
  readonly log: (line: string) => void;
}

/**
 * Owns the `TestController`, its items, and its one run profile.
 *
 * Suite items are created with no `uri`: SimCrux suites are a config
 * grouping, not a file, and pointing them at the `simcrux.yaml` would put
 * a "go to test" affordance on the wrong line of the wrong file.
 */
export class SimTestTreeController implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly nodesById = new Map<string, SimTestNode>();
  private readonly suiteIds = new Set<string>();
  private readonly tags = new Map<string, vscode.TestTag>();

  constructor(private readonly options: SimTestTreeControllerOptions) {
    this.controller = vscode.tests.createTestController(
      SIM_TEST_CONTROLLER_ID,
      vscode.l10n.t('SimCrux Regression'),
    );
    this.controller.refreshHandler = async (): Promise<void> => {
      await options.refresh();
    };
    this.controller.createRunProfile(
      vscode.l10n.t('Run Regression'),
      vscode.TestRunProfileKind.Run,
      (request, token) => {
        void this.startRun(request, token);
      },
      true,
    );
  }

  /** The node behind a `TestItem`, for the counterexample command. */
  nodeFor(id: string): SimTestNode | undefined {
    return this.nodesById.get(id);
  }

  /** Every leaf node, in tree order. */
  get nodes(): readonly SimTestNode[] {
    return [...this.nodesById.values()];
  }

  /** Whether [id] names a suite rather than a test. */
  isSuite(id: string): boolean {
    return this.suiteIds.has(id);
  }

  /**
   * Rebuild the tree and publish the results it carries.
   *
   * `replace` on the root collection rather than an incremental diff: the
   * tree is small (a regression is hundreds of tests, not millions), the
   * source of truth is re-read whole anyway, and a diff would be a second
   * place for the item set to be wrong.
   */
  apply(tree: SimTestTree): void {
    this.nodesById.clear();
    this.suiteIds.clear();
    const suiteItems = tree.suites.map((suite) => this.buildSuiteItem(suite));
    this.controller.items.replace(suiteItems);
    this.publishResults(tree);
  }

  private buildSuiteItem(suite: SimSuiteNode): vscode.TestItem {
    const suiteItem = this.controller.createTestItem(suite.id, suite.label);
    this.suiteIds.add(suite.id);
    suiteItem.children.replace(
      suite.tests.map((test) => {
        this.nodesById.set(test.id, test);
        const item = this.controller.createTestItem(test.id, test.label);
        if (test.description !== undefined) item.description = test.description;
        if (test.tagIds.length > 0) item.tags = test.tagIds.map((id) => this.tagFor(id));
        return item;
      }),
    );
    return suiteItem;
  }

  /** `TestTag`s must be reused by identity for filtering to group them. */
  private tagFor(id: string): vscode.TestTag {
    const existing = this.tags.get(id);
    if (existing !== undefined) return existing;
    const tag = new vscode.TestTag(id);
    this.tags.set(id, tag);
    return tag;
  }

  private itemFor(id: string): vscode.TestItem | undefined {
    for (const [, suiteItem] of this.controller.items) {
      const found = suiteItem.children.get(id);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Open a run, report every decorated row into it, and end it. */
  private publishResults(tree: SimTestTree): void {
    const entries = buildRunReport(tree);
    if (entries.length === 0) return;
    const run = this.controller.createTestRun(
      new vscode.TestRunRequest(),
      vscode.l10n.t('SimCrux results'),
      false,
    );
    for (const line of runProvenanceLines(tree)) run.appendOutput(`${line}\r\n`);
    for (const entry of entries) {
      const item = this.itemFor(entry.id);
      if (item === undefined) continue;
      this.report(run, item, entry);
    }
    run.end();
  }

  private report(
    run: vscode.TestRun,
    item: vscode.TestItem,
    entry: SimRunReportEntry,
  ): void {
    const messages = entry.messages.map((message) => new vscode.TestMessage(message));
    switch (entry.state) {
      case 'passed':
        run.passed(item, entry.durationMs);
        break;
      case 'failed':
        run.failed(item, messages, entry.durationMs);
        break;
      case 'errored':
        run.errored(item, messages, entry.durationMs);
        break;
      case 'skipped':
        run.skipped(item);
        break;
      case 'started':
        run.started(item);
        break;
    }
  }

  /**
   * Launch a regression for [request], then re-read the results.
   *
   * The run this opens reports nothing itself — it exists so the Test
   * Explorer shows activity while the process runs. The outcomes arrive
   * through `apply` when the results file is re-read, which is the only
   * path that ever sets a state and therefore the only one that can be
   * inconsistent with the file on disk.
   */
  private async startRun(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const selectedIds = (request.include ?? []).map((item) => item.id);
    const run = this.controller.createTestRun(request);
    for (const id of selectedIds) {
      const item = this.itemFor(id);
      if (item !== undefined) run.enqueued(item);
    }
    try {
      await this.options.runTests(selectedIds, token);
    } catch (error) {
      this.options.log(`   regression failed to launch: ${String(error)}`);
    } finally {
      run.end();
      await this.options.refresh();
    }
  }

  dispose(): void {
    this.controller.dispose();
  }
}
