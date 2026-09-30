/**
 * SimCrux — an RTL regression as a VSCode test tree.
 *
 * The extension, in one sentence: SimCrux enumerates `TestSpec`s up front,
 * which is exactly the shape VSCode's `TestController` wants, so a
 * regression becomes a tree with per-test state, individual re-run, and
 * inline failure decoration — without a dashboard being rebuilt in an
 * editor. No webview, no Flutter payload, no CSP: a pure host extension
 * over `@crux-vscode/host-core`.
 *
 * What it does:
 *
 * - enumerates `simcrux.yaml`'s suites and tests into a `TestController`,
 *   and decorates them from the `results.ndjson` a `--ci` run writes;
 * - **preserves the formal verdict**: five SymbiYosys outcomes share one
 *   `TestStatus.fail` by design, and `formal/verdict.ts` carries
 *   `riscv.formal.verdict` into the item description, a filterable tag,
 *   and the failure message so "counterexample found" and "the engine did
 *   not decide" are different rows;
 * - **opens a counterexample in the WaveCrux tab beside the tree** — the
 *   suite demo, running inside one editor window
 *   (`counterexample/handoff.ts`);
 * - provides a `simcrux` task type to launch a regression, and terminal
 *   links over simulator output;
 * - registers as a CXP surface, so a window with this extension advertises
 *   `simcrux.regression_results` and a window without it does not;
 * - hands off to SimCrux Desktop for anything that needs a run history.
 *
 * What it deliberately does not do: flakiness, trends, run comparison, or
 * any view of a CI fleet. Those are the app's half of the boundary, and
 * `handoff.ts` is where a user who needs them is sent.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import * as hostCore from '@crux-vscode/host-core';
import { openCounterexampleInWaveCrux } from './counterexample/handoff';
import { SIMCRUX_ARTIFACT_KIND, openHistoryInDesktop, pickSimCruxProjectFile } from './handoff';
import { parseSimResults, SimResultsFormatError } from './run/results';
import { readSimProject, type SimProject } from './run/project';
import { buildSimTestTree } from './tests/tree';
import { SimTestTreeController } from './tests/controller';
import { SIMCRUX_PRODUCT, simCruxCapabilityCopy } from './status/copy';
import { SIMCRUX_SURFACE } from './surface';
import {
  DEFAULT_RESULTS_FILE,
  SIM_CONFIGURATION_SECTION,
  readSimSettings,
  resolveResultsPath,
} from './settings';
import {
  SIMCRUX_TASK_TYPE,
  SimcruxTaskProvider,
  buildRegressionTask,
  deriveRunFilter,
} from './tasks';
import { SimTerminalLinkProvider } from './terminal-links';

/** Re-read the results file and republish the tree. */
export const REFRESH_COMMAND = 'simcrux.refreshResults';

/** Launch the whole regression, from the palette. */
export const RUN_REGRESSION_COMMAND = 'simcrux.runRegression';

/** Open a failing property's counterexample in the WaveCrux tab. */
export const OPEN_COUNTEREXAMPLE_COMMAND = 'simcrux.openCounterexample';

/** Take the user to the run history (the app's side of the boundary). */
export const HISTORY_COMMAND = 'simcrux.openHistoryInDesktop';

/** `feature.used` tokens. Lowercase/underscore, per the telemetry property vocabulary. */
const FEATURES = {
  treePublished: 'sim_test_tree',
  regressionLaunched: 'sim_regression_launched',
  counterexampleOpened: 'sim_counterexample_opened',
  historyHandoff: 'sim_history_handoff',
} as const;

/**
 * The product's telemetry client: one per extension, owning the queue, the
 * envelope, and the only sender in the pack. The `isTelemetryEnabled` gate
 * is checked inside it, live, at record time and again at flush time.
 */
function createTelemetryClient(
  context: vscode.ExtensionContext,
): hostCore.telemetry.TelemetryClient {
  return new hostCore.telemetry.TelemetryClient({
    product: SIMCRUX_PRODUCT,
    appVersion: () =>
      typeof context.extension.packageJSON === 'object' && context.extension.packageJSON !== null
        ? (context.extension.packageJSON as { version?: string }).version
        : undefined,
    installationId: () =>
      hostCore.telemetry.readOrMintTelemetryInstallationId(context.globalState),
    locale: () => vscode.env.language,
    endpoint: hostCore.telemetry.telemetryEndpointFor(
      context.extensionMode !== vscode.ExtensionMode.Production,
    ),
    gate: hostCore.telemetry.vscodeTelemetryGateHost,
    sender: hostCore.telemetry.fetchTelemetrySender,
  });
}

function readTextOrUndefined(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    // Absent is the ordinary case — the regression has not run yet — and
    // unreadable is indistinguishable from absent for our purposes.
    return undefined;
  }
}

/**
 * The `simcrux.yaml` this window works against.
 *
 * An absolute setting names exactly one file. A relative one is resolved
 * against each workspace folder and the **first existing** match wins:
 * unlike LintCrux's results file, a project config is not something a
 * multi-root workspace meaningfully has several of at once — the CLI takes
 * one config per invocation, and the tree, the task and the handoff all
 * have to agree on which.
 */
function resolveConfigPath(projectFile: string): string | undefined {
  if (path.isAbsolute(projectFile)) {
    return existsSync(projectFile) ? path.normalize(projectFile) : undefined;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = path.normalize(path.resolve(folder.uri.fsPath, projectFile));
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): hostCore.window.CruxWindowApi {
  const channel = vscode.window.createOutputChannel('SimCrux');
  context.subscriptions.push(channel);
  const log = (line: string): void => channel.appendLine(line);

  const client = createTelemetryClient(context);
  client.start();
  context.subscriptions.push({ dispose: () => client.dispose() });
  client.record({ name: hostCore.telemetry.TELEMETRY_EVENTS.activated });
  const recordFeature = (feature: string): void =>
    client.record({
      name: hostCore.telemetry.TELEMETRY_EVENTS.featureUsed,
      properties: { feature },
    });

  // Join the window: one CXP peer, one manifest, one status bar, however
  // many of the four extensions are installed. What this window can do is
  // composed by host-core from the surfaces actually installed; the api
  // returned from `activate` is how the others find us.
  const membership = hostCore.window.joinCruxWindow({
    context,
    product: SIMCRUX_PRODUCT,
    surface: SIMCRUX_SURFACE,
    copy: simCruxCapabilityCopy,
    record: (event) => client.record(event),
    log,
  });

  const configPath = (): string | undefined => resolveConfigPath(readSimSettings().projectFile);

  /** The config skeleton and where its results land. */
  const loadProject = (): { config?: string; project: SimProject; resultsPath?: string } => {
    const config = configPath();
    if (config === undefined) return { project: { suites: [], tests: [] } };
    const text = readTextOrUndefined(config);
    const project = text === undefined ? { suites: [], tests: [] } : readSimProject(text);
    return {
      config,
      project,
      resultsPath: resolveResultsPath(config, readSimSettings().resultsPath, project.resultsPath),
    };
  };

  const controller = new SimTestTreeController({
    runTests: (selectedIds, token) => runRegression(selectedIds, token),
    refresh: () => {
      refresh();
    },
    log,
  });
  context.subscriptions.push(controller);

  const refresh = (): void => {
    const { config, project, resultsPath } = loadProject();
    if (config === undefined) {
      log('   no simcrux.yaml found in this workspace — the tree is empty');
    }
    const text = resultsPath === undefined ? undefined : readTextOrUndefined(resultsPath);
    let document;
    if (text !== undefined) {
      try {
        document = parseSimResults(text);
      } catch (error) {
        const detail = error instanceof SimResultsFormatError ? error.message : String(error);
        log(`   results not read: ${resultsPath ?? ''}: ${detail}`);
      }
    }
    const tree = buildSimTestTree({
      project,
      ...(document === undefined ? {} : { document }),
      pathExists: existsSync,
    });
    controller.apply(tree);
    const tests = tree.suites.reduce((total, suite) => total + suite.tests.length, 0);
    log(
      `   tree: ${tests} test(s) in ${tree.suites.length} suite(s), ${tree.decorated} with results` +
        (tree.ranElsewhere ? ' (recorded on another machine)' : '') +
        (tree.incomplete ? ' (run did not finish)' : ''),
    );
    if (tests > 0) recordFeature(FEATURES.treePublished);
  };

  /**
   * Launch one regression for a run request and wait for it to finish.
   *
   * One process per request — see `tasks.ts` for why a per-test loop is
   * not an option (the results file is recreated by every run).
   */
  const runRegression = async (
    selectedIds: readonly string[],
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const settings = readSimSettings();
    const config = configPath();
    if (config === undefined) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'No simcrux.yaml found in this workspace, so there is no regression to run. Point edacrux.sim.projectFile at your config if it is named something else.',
        ),
      );
      return;
    }
    const suiteIds = selectedIds.filter((id) => controller.isSuite(id));
    const { filter, widened } = deriveRunFilter(selectedIds, suiteIds);
    if (widened) {
      log(
        '   several tests selected: SimCrux takes one --filter substring, so the whole regression runs',
      );
    }
    const task = buildRegressionTask(settings.executable, config, filter);
    log(`   running: ${config}${filter === undefined ? '' : ` --filter ${filter}`}`);
    recordFeature(FEATURES.regressionLaunched);

    const execution = await vscode.tasks.executeTask(task);
    await new Promise<void>((resolve) => {
      const ended = vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution !== execution) return;
        ended.dispose();
        cancelled.dispose();
        resolve();
      });
      // Cancelling from the Test Explorer terminates the task rather than
      // orphaning it — the process holds simulator licences and machine
      // resources, and "stop" must mean stop.
      const cancelled = token.onCancellationRequested(() => {
        execution.terminate();
      });
    });
  };

  /** Open the counterexample for a `TestItem` id. */
  const openCounterexample = async (id: string | undefined): Promise<void> => {
    const node = id === undefined ? undefined : controller.nodeFor(id);
    const outcome = await openCounterexampleInWaveCrux({
      waveformPath: node?.counterexamplePath,
      pathExists: existsSync,
      isExtensionInstalled: (extensionId) =>
        vscode.extensions.getExtension(extensionId) !== undefined,
      openWith: async (waveformPath, viewType) => {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(waveformPath),
          viewType,
          // Beside, not the active column: the point of the gesture is the trace
          // next to the failing property, not on top of it.
          vscode.ViewColumn.Beside,
        );
      },
      openUrl: async (url) => {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      },
      showMessage: async (message, ...actions) =>
        vscode.window.showInformationMessage(message, ...actions),
    });
    log(`   counterexample: ${outcome.kind}`);
    if (outcome.kind === 'opened') recordFeature(FEATURES.counterexampleOpened);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(REFRESH_COMMAND, refresh),
    vscode.commands.registerCommand(RUN_REGRESSION_COMMAND, async () => {
      const source = new vscode.CancellationTokenSource();
      try {
        await runRegression([], source.token);
      } finally {
        source.dispose();
        refresh();
      }
    }),
    // Invoked from the Test Explorer's context menu, where VSCode passes
    // the `TestItem` itself, and from the palette, where it passes
    // nothing — both land on the same "no counterexample" message.
    vscode.commands.registerCommand(OPEN_COUNTEREXAMPLE_COMMAND, async (raw: unknown) => {
      const id =
        typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string'
          ? (raw as { id: string }).id
          : undefined;
      await openCounterexample(id);
    }),
  );

  context.subscriptions.push(
    vscode.tasks.registerTaskProvider(
      SIMCRUX_TASK_TYPE,
      new SimcruxTaskProvider({
        configPath,
        executable: () => readSimSettings().executable,
      }),
    ),
  );

  context.subscriptions.push(
    vscode.window.registerTerminalLinkProvider(
      new SimTerminalLinkProvider({
        openSource: async ({ path: sourcePath, line, column }) => {
          // Resolved against the project directory, which is the cwd a
          // regression runs in and therefore what a relative path in
          // simulator output means.
          const config = configPath();
          const absolute = path.isAbsolute(sourcePath)
            ? sourcePath
            : path.resolve(config === undefined ? process.cwd() : path.dirname(config), sourcePath);
          if (!existsSync(absolute)) {
            void vscode.window.showWarningMessage(
              vscode.l10n.t('No file at {0}.', absolute),
            );
            return;
          }
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
          const position = new vscode.Position(line - 1, (column ?? 1) - 1);
          await vscode.window.showTextDocument(document, {
            selection: new vscode.Range(position, position),
          });
        },
        openTrace: async (tracePath) => {
          const config = configPath();
          const absolute = path.isAbsolute(tracePath)
            ? tracePath
            : path.resolve(config === undefined ? process.cwd() : path.dirname(config), tracePath);
          const outcome = await openCounterexampleInWaveCrux({
            waveformPath: absolute,
            pathExists: existsSync,
            isExtensionInstalled: (extensionId) =>
              vscode.extensions.getExtension(extensionId) !== undefined,
            openWith: async (waveformPath, viewType) => {
              await vscode.commands.executeCommand(
                'vscode.openWith',
                vscode.Uri.file(waveformPath),
                viewType,
                vscode.ViewColumn.Beside,
              );
            },
            openUrl: async (url) => {
              await vscode.env.openExternal(vscode.Uri.parse(url));
            },
            showMessage: async (message, ...actions) =>
              vscode.window.showInformationMessage(message, ...actions),
          });
          log(`   terminal trace link: ${outcome.kind}`);
          if (outcome.kind === 'opened') recordFeature(FEATURES.counterexampleOpened);
        },
      }),
    ),
  );

  // Per-product desktop detection and this product's handoff. The
  // ONE status surface belongs to the elected window host;
  // `copy` above is SimCrux's contribution to its panel. There is
  // deliberately no second upgrade affordance anywhere in this extension.
  // Annotated rather than inferred: `handoff` closes over `statusSurface`.
  const statusSurface: hostCore.status.ProductStatusSurface =
    hostCore.status.registerProductStatusSurface({
      product: SIMCRUX_PRODUCT,
      record: (event) => client.record(event),
      log,
      handoff: () => history(statusSurface, context, log, recordFeature),
    });
  context.subscriptions.push(statusSurface);

  context.subscriptions.push(
    vscode.commands.registerCommand(HISTORY_COMMAND, () =>
      history(statusSurface, context, log, recordFeature),
    ),
  );

  // Re-read when the config or the results file changes. A watcher per
  // workspace folder rather than one global glob, matching LintCrux: an
  // absolute path outside the workspace falls through to the explicit
  // refresh command.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const settings = readSimSettings();
    for (const pattern of [settings.projectFile, `**/${DEFAULT_RESULTS_FILE}`]) {
      if (path.isAbsolute(pattern)) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, pattern),
      );
      watcher.onDidCreate(refresh);
      watcher.onDidChange(refresh);
      watcher.onDidDelete(refresh);
      context.subscriptions.push(watcher);
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SIM_CONFIGURATION_SECTION)) refresh();
    }),
  );

  refresh();

  return membership.api;
}

/** Run the history handoff with the real environment behind it. */
async function history(
  statusSurface: hostCore.status.ProductStatusSurface,
  context: vscode.ExtensionContext,
  log: (line: string) => void,
  recordFeature: (feature: string) => void,
): Promise<void> {
  const outcome = await openHistoryInDesktop({
    desktopPeerPresent: () => statusSurface.detector?.isPresent(SIMCRUX_PRODUCT) ?? false,
    // A file SimCrux opens as a project, not in an editor: see
    // `pickSimCruxProjectFile`.
    projectFile: () =>
      pickSimCruxProjectFile(resolveConfigPath(readSimSettings().projectFile), async () => {
        const found = await vscode.workspace.findFiles('**/simcrux.yaml', '**/node_modules/**', 1);
        return found[0]?.fsPath;
      }),
    handOff: hostCore.desktopDetect.createVscodeArtifactHandoff({
      product: SIMCRUX_PRODUCT,
      artifactKind: SIMCRUX_ARTIFACT_KIND,
      context,
      log,
    }),
    openUrl: async (url) => {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
    showMessage: async (message, ...actions) =>
      vscode.window.showInformationMessage(message, ...actions),
  });
  log(
    `   history: ${outcome.kind}` +
      (outcome.kind === 'handed-off' ? ` (${outcome.handoff.kind})` : ''),
  );
  recordFeature(FEATURES.historyHandoff);
}

/**
 * Give up the window's CXP peer, and **wait for it** — see
 * `window/join.ts`. A no-op when this extension is not the one hosting.
 */
export function deactivate(): Promise<void> {
  return hostCore.window.deactivateCruxWindow();
}
