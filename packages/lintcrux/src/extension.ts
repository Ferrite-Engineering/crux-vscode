/**
 * LintCrux — RTL lint results as VSCode diagnostics.
 *
 * The extension, in one sentence: reading RTL lint output today is "the
 * equivalent of reading compiler warnings by scrolling a terminal
 * — which is exactly what software engineers did before IDEs integrated
 * lint results", and VSCode's Diagnostic API **is** that integration. So
 * this extension has no webview, no Flutter payload and no CSP: it is a
 * pure host extension over `@crux-vscode/host-core`, and everything it
 * shares with the other three products it imports rather than reimplements.
 *
 * What it does:
 *
 * - reads a LintCrux results file (SARIF or the flat JSON export) and
 *   publishes every unwaived violation as a `vscode.Diagnostic` — squiggles
 *   in the engineer's own RTL, entries in the Problems panel;
 * - offers a code action to file a waiver into the same
 *   `.lintcrux-waivers.json` the app reads and writes;
 * - registers as a CXP surface, so a window with this extension advertises
 *   `lintcrux.diagnostics` and a window without it does not;
 * - hands off to LintCrux Desktop for anything across the whole design.
 *
 * What it deliberately does not do: triage, new-vs-old tracking, waiver
 * management, or trends. Those are the app's half of the boundary, and
 * `handoff.ts` is where a user who needs them is sent.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import * as hostCore from '@crux-vscode/host-core';
import { LintDiagnosticsPublisher, type LintDiagnosticSink } from './lint/publisher';
import {
  LINTCRUX_ARTIFACT_KIND,
  LINTCRUX_PROJECT_GLOB,
  LINTCRUX_PROJECT_SEARCH_LIMIT,
  openTriageInDesktop,
  pickLintCruxProjectFile,
} from './handoff';
import { LINTCRUX_PRODUCT, lintCruxCapabilityCopy } from './status/copy';
import { LINTCRUX_SURFACE } from './surface';
import {
  LINT_CONFIGURATION_SECTION,
  readLintSettings,
  resolveResultsPaths,
} from './settings';
import {
  WAIVE_VIOLATION_COMMAND,
  WaiverCodeActionProvider,
  asWaiveTarget,
} from './waivers/code-actions';
import { resolveWaiverFile } from './waivers/location';
import { WAIVER_FILE_NAME } from './waivers/model';
import { appendWaiver, createWaiver, defaultWaiverAuthor, WaiverSchemaError } from './waivers/store';

/** Re-read the results file and republish. */
export const REFRESH_COMMAND = 'lintcrux.refreshDiagnostics';

/** Take the user to the cross-design view (the app's side of the boundary). */
export const TRIAGE_COMMAND = 'lintcrux.openTriageInDesktop';

/** `feature.used` tokens. Lowercase/underscore, per the telemetry property vocabulary. */
const FEATURES = {
  diagnosticsPublished: 'lint_diagnostics',
  waiverFiled: 'lint_waiver_filed',
  triageHandoff: 'lint_triage_handoff',
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
    product: LINTCRUX_PRODUCT,
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

/** Absolute paths of the open workspace folders, or an empty list. */
function workspaceFolderPaths(): readonly string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

/** Whether [directory] holds a `*.lintcrux` project file. */
function hasProjectFile(directory: string): boolean {
  try {
    return readdirSync(directory).some((entry) => entry.endsWith('.lintcrux'));
  } catch {
    // An unreadable directory is not a project root as far as we are
    // concerned; the walk simply continues upward.
    return false;
  }
}

/** The real diagnostic collection, keyed by path so the publisher never sees a `Uri`. */
function createDiagnosticSink(): LintDiagnosticSink {
  const collection = vscode.languages.createDiagnosticCollection('lintcrux');
  return {
    set: (filePath, diagnostics) => collection.set(vscode.Uri.file(filePath), [...diagnostics]),
    clear: () => collection.clear(),
    dispose: () => collection.dispose(),
  };
}

export function activate(context: vscode.ExtensionContext): hostCore.window.CruxWindowApi {
  const channel = vscode.window.createOutputChannel('LintCrux');
  context.subscriptions.push(channel);
  const log = (line: string): void => channel.appendLine(line);

  const client = createTelemetryClient(context);
  client.start();
  context.subscriptions.push({ dispose: () => client.dispose() });
  client.record({ name: hostCore.telemetry.TELEMETRY_EVENTS.activated });

  // Join the window: one CXP peer, one manifest, one status bar, however
  // many of the four extensions are installed. Whichever of them the
  // election in host-core's `window/` picks builds the singletons; the
  // rest contribute their surface to it. The api returned from `activate`
  // is how the others find us — see `window/api.ts`.
  const membership = hostCore.window.joinCruxWindow({
    context,
    product: LINTCRUX_PRODUCT,
    surface: LINTCRUX_SURFACE,
    copy: lintCruxCapabilityCopy,
    record: (event) => client.record(event),
    log,
  });

  const waiverFileFor = (sourceFilePath: string): string | undefined =>
    resolveWaiverFile({
      filePath: sourceFilePath,
      workspaceFolders: workspaceFolderPaths(),
      lookup: {
        hasWaiverFile: (directory) => existsSync(path.join(directory, WAIVER_FILE_NAME)),
        hasProjectFile,
      },
    });

  const publisher = new LintDiagnosticsPublisher(createDiagnosticSink(), {
    resultsPaths: () => resolveResultsPaths(readLintSettings().resultsPath, workspaceFolderPaths()),
    waiverFileFor,
    readText: (filePath) => {
      try {
        return readFileSync(filePath, 'utf8');
      } catch {
        // Absent is the ordinary case — lint has not been run yet — and
        // unreadable is indistinguishable from absent for our purposes.
        return undefined;
      }
    },
    now: () => new Date(),
    log,
  });
  context.subscriptions.push({ dispose: () => publisher.dispose() });

  const refresh = (): void => {
    const summary = publisher.refresh();
    log(
      `   lint: ${summary.published} diagnostic(s) in ${summary.filesWithDiagnostics} file(s), ` +
        `${summary.waived} waived, from ${summary.sourcesRead.length} results file(s)`,
    );
    if (summary.published > 0) {
      client.record({
        name: hostCore.telemetry.TELEMETRY_EVENTS.featureUsed,
        properties: { feature: FEATURES.diagnosticsPublished },
      });
    }
  };

  context.subscriptions.push(vscode.commands.registerCommand(REFRESH_COMMAND, refresh));

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      // Every file scheme rather than a language id list: Verilog, VHDL
      // and SystemVerilog have no built-in VSCode language ids, so a
      // selector by language would silently offer nothing in a workspace
      // without a third-party HDL extension installed. The provider
      // returns actions only for files that actually have violations, so
      // the broad selector costs nothing anywhere else.
      { scheme: 'file' },
      new WaiverCodeActionProvider((filePath) => publisher.violationsFor(filePath)),
      WaiverCodeActionProvider.metadata,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(WAIVE_VIOLATION_COMMAND, async (raw: unknown) => {
      await fileWaiver(raw, waiverFileFor, log, refresh, (feature) =>
        client.record({
          name: hostCore.telemetry.TELEMETRY_EVENTS.featureUsed,
          properties: { feature },
        }),
      );
    }),
  );

  // Per-product desktop detection and the `edacrux.openInDesktop.lintcrux`
  // handoff, host-core's. The ONE status surface is the window
  // host's — `copy` above is LintCrux's contribution to its panel. There is
  // deliberately no second upgrade affordance anywhere in this extension.
  // Annotated rather than inferred: `handoff` closes over `statusSurface`,
  // and TypeScript refuses to infer a type that references itself.
  const statusSurface: hostCore.status.ProductStatusSurface =
    hostCore.status.registerProductStatusSurface({
      product: LINTCRUX_PRODUCT,
      record: (event) => client.record(event),
      log,
      handoff: () => triage(statusSurface, context, client, log),
    });
  context.subscriptions.push(statusSurface);

  context.subscriptions.push(
    vscode.commands.registerCommand(TRIAGE_COMMAND, () => triage(statusSurface, context, client, log)),
  );

  // Re-read when the results file or a waiver file changes, and when the
  // settings that name them change. A watcher per workspace folder rather
  // than one global glob: `RelativePattern` is what makes an absolute
  // results path outside the workspace still work, since that case falls
  // through to the explicit refresh command.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const settings = readLintSettings();
    for (const pattern of [settings.resultsPath, `**/${WAIVER_FILE_NAME}`]) {
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
      if (event.affectsConfiguration(LINT_CONFIGURATION_SECTION)) refresh();
    }),
  );

  refresh();

  return membership.api;
}

/** The active editor's file, when it is a file on disk. */
function activeEditorFile(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === 'file' ? uri.fsPath : undefined;
}

/** Run the triage handoff with the real environment behind it. */
async function triage(
  statusSurface: hostCore.status.ProductStatusSurface,
  context: vscode.ExtensionContext,
  client: hostCore.telemetry.TelemetryClient,
  log: (line: string) => void,
): Promise<void> {
  const handOff = hostCore.desktopDetect.createVscodeArtifactHandoff({
    product: LINTCRUX_PRODUCT,
    artifactKind: LINTCRUX_ARTIFACT_KIND,
    context,
    log,
  });
  const outcome = await openTriageInDesktop({
    desktopPeerPresent: () => statusSurface.detector?.isPresent(LINTCRUX_PRODUCT) ?? false,
    // The project related to the file being edited, not the first one a
    // search happens to return: see `pickLintCruxProjectFile`.
    projectFile: () =>
      pickLintCruxProjectFile(activeEditorFile(), async () => {
        const found = await vscode.workspace.findFiles(
          LINTCRUX_PROJECT_GLOB,
          '**/node_modules/**',
          LINTCRUX_PROJECT_SEARCH_LIMIT,
        );
        return found.map((uri) => uri.fsPath);
      }),
    handOff,
    openUrl: async (url) => {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
    showMessage: async (message, ...actions) =>
      vscode.window.showInformationMessage(message, ...actions),
  });
  log(
    `   triage: ${outcome.kind}` +
      (outcome.kind === 'handed-off' ? ` (${outcome.handoff.kind})` : ''),
  );
  client.record({
    name: hostCore.telemetry.TELEMETRY_EVENTS.featureUsed,
    properties: { feature: FEATURES.triageHandoff },
  });
}

/**
 * Ask for a reason and append the waiver.
 *
 * The reason prompt is not optional: `reason` is a required non-empty
 * string on the Dart side, and a waiver file with an empty one throws on
 * load and takes every *other* waiver in the file with it. Cancelling the
 * prompt cancels the waiver.
 */
async function fileWaiver(
  raw: unknown,
  waiverFileFor: (sourceFilePath: string) => string | undefined,
  log: (line: string) => void,
  refresh: () => void,
  recordFeature: (feature: string) => void,
): Promise<void> {
  const target = asWaiveTarget(raw);
  if (target === undefined) return;

  const waiverFile = waiverFileFor(target.filePath);
  if (waiverFile === undefined) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t('That file is outside the open workspace, so there is nowhere to file a waiver.'),
    );
    return;
  }

  const reason = await vscode.window.showInputBox({
    title: vscode.l10n.t('Waive {0}', target.ruleId),
    prompt: vscode.l10n.t('Why is this violation acceptable? LintCrux records the reason with the waiver.'),
    placeHolder: vscode.l10n.t('Refactor planned for Q3 (LIN-321)'),
    validateInput: (value) =>
      value.trim() === '' ? vscode.l10n.t('A waiver needs a reason.') : undefined,
  });
  if (reason === undefined || reason.trim() === '') return;

  const configured = readLintSettings().waiverAuthor;
  try {
    appendWaiver(
      waiverFile,
      createWaiver({
        ruleId: target.ruleId,
        filePath: target.filePath,
        ...(target.line === undefined ? {} : { lineStart: target.line }),
        reason,
        author: configured === '' ? defaultWaiverAuthor() : configured,
      }),
    );
  } catch (error) {
    const detail = error instanceof WaiverSchemaError ? error.message : String(error);
    log(`   waiver not written: ${waiverFile}: ${detail}`);
    void vscode.window.showErrorMessage(
      vscode.l10n.t('Could not write the waiver: {0}', detail),
    );
    return;
  }

  log(`   waiver filed: ${target.ruleId} → ${waiverFile}`);
  recordFeature(FEATURES.waiverFiled);
  // Republish immediately: the squiggle disappearing is the feedback that
  // the waiver landed. Waiting for the file watcher would work too, but
  // only when the waiver file is inside a watched folder.
  refresh();
}

/**
 * Give up the window's CXP peer, and **wait for it**.
 *
 * `deactivate()` is the only teardown hook VSCode awaits;
 * `context.subscriptions` disposal is fire-and-forget. Deleting the
 * published manifest is a filesystem write, and a manifest left behind
 * points every Crux app on the machine at a closed port until they reap
 * it. A no-op when this extension is not the one hosting.
 */
export function deactivate(): Promise<void> {
  return hostCore.window.deactivateCruxWindow();
}
