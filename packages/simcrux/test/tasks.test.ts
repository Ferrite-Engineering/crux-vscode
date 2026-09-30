import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  SIMCRUX_TASK_TYPE,
  SimcruxTaskProvider,
  buildRegressionTask,
  deriveRunFilter,
  regressionArgs,
  regressionShellArgs,
} from '../src/tasks';

const CONFIG = '/work/design/simcrux.yaml';

/** The argv a built task will actually run, unwrapped from its quoting. */
function argvOf(task: vscode.Task): readonly string[] {
  const execution = task.execution as unknown as {
    command: { value: string };
    args: ReadonlyArray<{ value: string }>;
  };
  return [execution.command.value, ...execution.args.map((arg) => arg.value)];
}

describe('regressionArgs', () => {
  it('always passes --ci, because that is what writes results.ndjson', () => {
    // Without it `output.streaming` stays false for an interactive run and
    // nothing lands on disk — a task that appears to succeed and a tree
    // that never updates.
    expect(regressionArgs(CONFIG, undefined)).toEqual([CONFIG, '--ci']);
  });

  it('passes --filter as a separate argument when there is one', () => {
    expect(regressionArgs(CONFIG, 'insn/add')).toEqual([CONFIG, '--ci', '--filter', 'insn/add']);
  });
});

describe('regressionShellArgs — VSCode does the quoting, not us', () => {
  it('asks for strong quoting on every argument', () => {
    // The correct escape differs per shell (sh, PowerShell, cmd.exe).
    // Marking the argument and letting VSCode apply the launching shell's
    // rule is the only way to be right on all three.
    for (const arg of regressionShellArgs('/Users/a b/simcrux.yaml', "it's")) {
      expect(arg.quoting).toBe(vscode.ShellQuoting.Strong);
    }
  });

  it('leaves the values themselves untouched — no hand-rolled escaping', () => {
    expect(regressionShellArgs('/Users/a b/simcrux.yaml', undefined).map((arg) => arg.value)).toEqual(
      ['/Users/a b/simcrux.yaml', '--ci'],
    );
  });
});

describe('deriveRunFilter — one launch per run request', () => {
  it('runs everything when nothing is selected', () => {
    expect(deriveRunFilter([], [])).toEqual({ widened: false });
  });

  it('filters by the test id when one leaf is selected', () => {
    // The id is passed verbatim because `--filter` is a plain substring
    // test against `TestSpec.id`; a prettified id would select nothing.
    expect(deriveRunFilter(['insn/insn_add_pass'], ['insn'])).toEqual({
      filter: 'insn/insn_add_pass',
      widened: false,
    });
  });

  it('filters by the id prefix when a suite is selected', () => {
    // `insn/` and not `insn`: a bare suite name would also select a suite
    // called `insn_extra`.
    expect(deriveRunFilter(['insn'], ['insn', 'reg'])).toEqual({
      filter: 'insn/',
      widened: false,
    });
  });

  it('widens to the whole regression for a multi-selection, and says so', () => {
    // SimCrux takes one filter substring, and the streaming writer
    // recreates results.ndjson per run — so running each selection in turn
    // would erase the previous one's results.
    expect(deriveRunFilter(['insn/a', 'reg/b'], ['insn', 'reg'])).toEqual({ widened: true });
  });
});

describe('buildRegressionTask', () => {
  it('carries the config and filter in the task definition', () => {
    const task = buildRegressionTask('simcrux', CONFIG, 'insn/');
    expect(task.definition).toEqual({ type: SIMCRUX_TASK_TYPE, config: CONFIG, filter: 'insn/' });
  });

  it('omits filter from the definition rather than writing undefined', () => {
    expect(buildRegressionTask('simcrux', CONFIG, undefined).definition).toEqual({
      type: SIMCRUX_TASK_TYPE,
      config: CONFIG,
    });
  });

  it('names the filter in the task label, so two runs are distinguishable', () => {
    expect(buildRegressionTask('simcrux', CONFIG, undefined).name).toBe('Run regression');
    expect(buildRegressionTask('simcrux', CONFIG, 'insn/').name).toBe('Run regression (insn/)');
  });

  it('runs the configured executable', () => {
    expect(argvOf(buildRegressionTask('/opt/simcrux/bin/simcrux', CONFIG, undefined))).toEqual([
      '/opt/simcrux/bin/simcrux',
      CONFIG,
      '--ci',
    ]);
  });

  it('declares no problem matcher — the Test Explorer carries the failures', () => {
    expect(buildRegressionTask('simcrux', CONFIG, undefined).problemMatchers).toEqual([]);
  });

  it('does not clear the terminal, because the links live in its scrollback', () => {
    expect(buildRegressionTask('simcrux', CONFIG, undefined).presentationOptions.clear).toBe(false);
  });
});

describe('SimcruxTaskProvider', () => {
  const provider = new SimcruxTaskProvider({
    configPath: () => CONFIG,
    executable: () => 'simcrux',
  });

  it('provides one task per project, not one per suite', () => {
    const tasks = provider.provideTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.definition).toEqual({ type: SIMCRUX_TASK_TYPE, config: CONFIG });
  });

  it('provides nothing when the workspace has no config', () => {
    const empty = new SimcruxTaskProvider({
      configPath: () => undefined,
      executable: () => 'simcrux',
    });
    expect(empty.provideTasks()).toEqual([]);
  });

  it('rebuilds a task the user wrote in tasks.json, honouring its filter', () => {
    const resolved = provider.resolveTask({
      definition: { type: SIMCRUX_TASK_TYPE, filter: 'reg/' },
    } as never);
    expect(resolved).toBeDefined();
    expect(argvOf(resolved as vscode.Task)).toEqual(['simcrux', CONFIG, '--ci', '--filter', 'reg/']);
  });

  it('honours an explicit config in the definition over the resolved one', () => {
    const resolved = provider.resolveTask({
      definition: { type: SIMCRUX_TASK_TYPE, config: '/other/simcrux.yaml' },
    } as never);
    expect(argvOf(resolved as vscode.Task)).toContain('/other/simcrux.yaml');
  });

  it('declines a definition of another type', () => {
    expect(provider.resolveTask({ definition: { type: 'npm' } } as never)).toBeUndefined();
  });

  it('declines when there is no config to run', () => {
    const empty = new SimcruxTaskProvider({
      configPath: () => undefined,
      executable: () => 'simcrux',
    });
    expect(empty.resolveTask({ definition: { type: SIMCRUX_TASK_TYPE } } as never)).toBeUndefined();
  });
});
