/**
 * The `simcrux` task type — how a regression gets launched from the
 * editor, and the *only* way this extension starts a process.
 *
 * The Task provider sits beside the Test Explorer, and the two
 * are not independent: `simcrux <config> --ci` always writes
 * `<dir of config>/results.ndjson`, which is exactly the file the tree
 * reads. So the task is not a convenience wrapper around a terminal — it
 * is the half of the loop that produces what the other half consumes.
 * That is why `--ci` is not optional here: without it `output.streaming`
 * stays false for an interactive run and **nothing is written to disk at
 * all**, leaving a task that appears to succeed and a tree that never
 * updates.
 *
 * ### One launch per run request, and why
 *
 * SimCrux's `--filter` is a single plain substring test against
 * `TestSpec.id` (`CiRunner._matchesFilter`) — there is no filter list. And
 * the streaming writer is one-shot: each run **recreates** `results.ndjson`
 * rather than appending. Those two facts together rule out "run each
 * selected test in turn": the second run would erase the first one's
 * results.
 *
 * So a run request becomes exactly one process:
 *
 * - one leaf selected → `--filter <TestSpec.id>`;
 * - one suite selected → `--filter <suite>/`, which is the id prefix every
 *   test in that suite shares;
 * - anything else (several items, or the whole tree) → no filter, the
 *   whole regression, and the run log says so rather than quietly running
 *   more than was asked.
 *
 * [deriveRunFilter] is pure and holds that rule on its own so it can be
 * asserted directly.
 */
import * as vscode from 'vscode';

/** The `type` in a `tasks.json` entry, and this provider's registration id. */
export const SIMCRUX_TASK_TYPE = 'simcrux';

/** A `simcrux` task definition, as it appears in `tasks.json`. */
export interface SimcruxTaskDefinition extends vscode.TaskDefinition {
  readonly type: typeof SIMCRUX_TASK_TYPE;
  /** Path to the `simcrux.yaml`. Absolute, or relative to the workspace folder. */
  readonly config?: string;
  /** `--filter` substring. Omitted runs the whole regression. */
  readonly filter?: string;
}

/**
 * The filter for a run request over [selectedIds] within [allIds].
 *
 * `undefined` means "no `--filter`": run everything. See the module doc for
 * why this is one filter or none rather than a list.
 */
export function deriveRunFilter(
  selectedIds: readonly string[],
  suiteIds: readonly string[],
): { readonly filter?: string; readonly widened: boolean } {
  if (selectedIds.length === 0) return { widened: false };
  if (selectedIds.length === 1) {
    const only = selectedIds[0] ?? '';
    // A suite node's id has no `/`; a test's is `<suite>/<name>`. Filtering
    // by `<suite>/` selects every test in it and nothing in a suite whose
    // name merely starts the same way, which a bare `<suite>` would not.
    return suiteIds.includes(only) ? { filter: `${only}/`, widened: false } : { filter: only, widened: false };
  }
  return { widened: true };
}

/** The argv for a regression run. Pure, so the command line is assertable. */
export function regressionArgs(configPath: string, filter: string | undefined): readonly string[] {
  // `--ci` first so it is visible in the terminal title; the config is
  // positional and `--filter` takes its value as a separate argument.
  return filter === undefined
    ? [configPath, '--ci']
    : [configPath, '--ci', '--filter', filter];
}

/**
 * The argv as `ShellQuotedString`s, so **VSCode** does the quoting.
 *
 * Deliberately not a hand-built command-line string. A project path with a
 * space in it is ordinary on macOS and Windows, and the correct escape
 * differs by shell — POSIX `sh` wants `'…'\''…'`, PowerShell wants `''`,
 * `cmd.exe` wants `"`. VSCode knows which shell it is about to launch and
 * `ShellQuoting.Strong` asks it to apply that shell's rule; a string
 * assembled here would have to guess, and would be wrong on some
 * developer's machine rather than on ours.
 */
export function regressionShellArgs(
  configPath: string,
  filter: string | undefined,
): vscode.ShellQuotedString[] {
  return regressionArgs(configPath, filter).map((value) => ({
    value,
    quoting: vscode.ShellQuoting.Strong,
  }));
}

/** What [SimcruxTaskProvider] needs from `activate()`. */
export interface SimcruxTaskProviderOptions {
  /** The resolved `simcrux.yaml`, or undefined when the workspace has none. */
  readonly configPath: () => string | undefined;
  /** The `simcrux` binary, from settings. */
  readonly executable: () => string;
}

/**
 * Contributes one task per project: "Run regression".
 *
 * A single provided task rather than one per suite: the suite list changes
 * whenever the config does, and a task list that reshuffles under the user
 * is worse than a task they parameterize once in `tasks.json`. Per-test
 * launching is what the Test Explorer's run button is for, and it goes
 * through [buildRegressionTask] too, so there is one way to start a run.
 */
export class SimcruxTaskProvider implements vscode.TaskProvider {
  constructor(private readonly options: SimcruxTaskProviderOptions) {}

  provideTasks(): vscode.Task[] {
    const configPath = this.options.configPath();
    if (configPath === undefined) return [];
    return [buildRegressionTask(this.options.executable(), configPath, undefined)];
  }

  /**
   * Complete a task the user wrote in `tasks.json`.
   *
   * VSCode calls this with the definition only — `task.execution` is
   * always undefined here even if `provideTasks` set one — so the task is
   * rebuilt from the definition rather than patched.
   */
  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const definition = task.definition as SimcruxTaskDefinition;
    if (definition.type !== SIMCRUX_TASK_TYPE) return undefined;
    const configPath = definition.config ?? this.options.configPath();
    if (configPath === undefined) return undefined;
    return buildRegressionTask(this.options.executable(), configPath, definition.filter);
  }
}

/** Build the task that runs [configPath], optionally filtered. */
export function buildRegressionTask(
  executable: string,
  configPath: string,
  filter: string | undefined,
): vscode.Task {
  const definition: SimcruxTaskDefinition = {
    type: SIMCRUX_TASK_TYPE,
    config: configPath,
    ...(filter === undefined ? {} : { filter }),
  };
  const task = new vscode.Task(
    definition,
    vscode.TaskScope.Workspace,
    filter === undefined
      ? vscode.l10n.t('Run regression')
      : vscode.l10n.t('Run regression ({0})', filter),
    'SimCrux',
    new vscode.ShellExecution(
      { value: executable, quoting: vscode.ShellQuoting.Strong },
      regressionShellArgs(configPath, filter),
    ),
    // No problem matcher. Simulator diagnostics are not this extension's
    // job — the Test Explorer carries the results, and a matcher would put
    // the same failures in the Problems panel in a second, worse form.
    [],
  );
  task.group = vscode.TaskGroup.Test;
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    // The terminal is where the terminal-link provider does its work, and
    // a cleared scrollback would take the links with it.
    clear: false,
  };
  return task;
}
