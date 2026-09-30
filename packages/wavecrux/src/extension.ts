import { appendFileSync } from 'node:fs';
import * as vscode from 'vscode';
import * as hostCore from '@crux-vscode/host-core';
import type { DiagnosticSink } from './webview/panel';
import { openWaveCruxPanel } from './webview/panel';
import { WaveformEditorProvider } from './editor/waveform-editor';
import { WAVEFORM_VIEW_TYPE, waveformFormatFor } from './formats';
import { registerWaveCruxStatusSurface } from './status/surface';
import { registerRtlAnnotationSurface } from './annotate/surface';
import { createWaveCruxSurface } from './surface';
import type { WebviewHighlightTarget } from './webview/highlight-bridge';
import { WAVECRUX_PRODUCT, waveCruxCapabilityCopy } from './status/copy';

/**
 * WaveCrux — webview surface for VCD/FST waveforms.
 *
 * The surface is a `CustomEditorProvider`: double-clicking a waveform in the
 * Explorer opens WaveCrux inline (see `src/editor/waveform-editor.ts`). The
 * command below opens the same build with no document, which is what a user
 * without a file in the workspace still wants. The window's CXP peer comes
 * from `joinCruxWindow`, and stems-based name resolution from the RTL
 * annotation surface (`annotate/surface.ts`).
 */
export const OPEN_PANEL_COMMAND = 'wavecrux.openPanel';

/**
 * Environment hook used only by scripted verification runs: when set to
 * a writable path, every webview diagnostic is appended there as well as to
 * the output channel, so a scripted Extension Development Host run can be
 * read from a terminal. Unset in normal use, in which case nothing is written.
 */
const DIAGNOSTIC_LOG_ENV = 'CRUX_WEBVIEW_DIAGNOSTIC_LOG';

/** Same harness: opens the panel on activation so a scripted run needs no
 * interactive command invocation. */
const AUTO_OPEN_ENV = 'CRUX_WEBVIEW_AUTO_OPEN';

/**
 * Same harness, for the custom editor: a path opened through
 * `vscode.openWith` on activation.
 *
 * Exists because the alternative — `code -r <file>` against a running
 * Extension Development Host — depends on which window has focus and on
 * VSCode's preview-tab behaviour, both of which turn a measurement run into a
 * window-management exercise. This is the one hook that makes an end-to-end
 * byte handoff reproducible from a terminal.
 */
const AUTO_OPEN_WAVEFORM_ENV = 'CRUX_WAVEFORM_AUTO_OPEN';

/**
 * `globalState` key recording that this installation has opened a waveform.
 *
 * `file.first_opened` is a once-per-installation conversion event, so the
 * "already fired" flag has to outlive the window — a field would re-fire it on
 * every restart and turn a conversion count into a session count.
 */
const FIRST_OPEN_STATE_KEY = 'wavecrux.telemetry.hasOpenedFile';

function createSink(channel: vscode.OutputChannel): DiagnosticSink {
  const logPath = process.env[DIAGNOSTIC_LOG_ENV];
  return {
    append(line: string): void {
      channel.appendLine(line);
      if (logPath === undefined || logPath === '') return;
      try {
        appendFileSync(logPath, `${line}\n`, 'utf8');
      } catch {
        // A diagnostics sink that throws would take the panel down with it.
      }
    },
  };
}

/**
 * The product's telemetry client: one per extension, owning the queue, the
 * envelope, and the only sender in the pack. The `isTelemetryEnabled` gate is
 * checked inside it, live, at record time and again at flush time.
 */
function createTelemetryClient(
  context: vscode.ExtensionContext,
): hostCore.telemetry.TelemetryClient {
  return new hostCore.telemetry.TelemetryClient({
    product: 'wavecrux',
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

/**
 * The waveform in the active tab, if the active tab is one.
 *
 * `tabGroups` rather than `window.activeTextEditor`: a custom editor is not
 * a text editor, so `activeTextEditor` is `undefined` for exactly the tabs
 * this needs to see. Falls back to any visible waveform tab so the handoff
 * still works when the capabilities panel itself is the focused tab —
 * which it always is, since clicking the status bar is what opened it.
 */
function activeWaveformUri(): vscode.Uri | undefined {
  const isWaveform = (input: unknown): input is { uri: vscode.Uri } =>
    input instanceof vscode.TabInputCustom && input.viewType === WAVEFORM_VIEW_TYPE;
  const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (isWaveform(active)) return active.uri;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input: unknown = tab.input;
      if (isWaveform(input)) return input.uri;
      // A waveform the user opened as plain text still names a file the
      // desktop app can open, and refusing it here would make the handoff
      // depend on which editor the tab happens to be using.
      if (
        input instanceof vscode.TabInputText &&
        waveformFormatFor(input.uri.path)?.supported === true
      ) {
        return input.uri;
      }
    }
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): hostCore.window.CruxWindowApi {
  const channel = vscode.window.createOutputChannel('WaveCrux');
  context.subscriptions.push(channel);
  const sink = createSink(channel);

  const client = createTelemetryClient(context);
  client.start();
  context.subscriptions.push({ dispose: () => client.dispose() });
  client.record({ name: hostCore.telemetry.TELEMETRY_EVENTS.activated });

  // The waveform panel an inbound `request_highlight` is routed to. A stack
  // rather than a field, and released back to the previous entry rather
  // than cleared, for the same reasons `annotate/surface.ts` documents:
  // several waveform tabs can be open, only the most recently opened is
  // worth asking, and closing the second of two must leave the first
  // answering.
  const highlightTargets: WebviewHighlightTarget[] = [];
  const adoptHighlightTarget = (target: WebviewHighlightTarget): (() => void) => {
    highlightTargets.push(target);
    return () => {
      const index = highlightTargets.indexOf(target);
      if (index >= 0) highlightTargets.splice(index, 1);
    };
  };

  // RTL annotation — the one capability the extension does better than the
  // desktop app, because inside VSCode the editor already is the source view.
  // Off until the user opts in; registered unconditionally so the command and
  // the setting exist to be opted into. Registered before joining the window
  // because its stems-backed resolver is part of what WaveCrux contributes.
  const annotation = registerRtlAnnotationSurface({
    record: (event) => client.record(event),
    log: (line) => sink.append(line),
  });
  context.subscriptions.push(annotation);

  // Join the window: one CXP peer, one manifest, one status bar, however
  // many of the four extensions are installed. WaveCrux is deliberately
  // last in the host order, so in a multi-extension window it contributes
  // its surface, its panel words and its name resolver and hosts nothing —
  // see `host-core/src/window/election.ts`. The resolver is the annotation's
  // own, so the window-level send commands resolve a selection through the
  // same stems index rather than a second one.
  const membership = hostCore.window.joinCruxWindow({
    context,
    product: WAVECRUX_PRODUCT,
    surface: createWaveCruxSurface({
      target: () => highlightTargets[highlightTargets.length - 1],
      log: (line) => sink.append(line),
    }),
    copy: waveCruxCapabilityCopy,
    resolver: annotation.resolver,
    record: (event) => client.record(event),
    log: (line) => sink.append(line),
  });

  context.subscriptions.push(
    WaveformEditorProvider.register({
      extensionUri: context.extensionUri,
      sink,
      recordTelemetry: (event) => client.record(event),
      recordTelemetryFromWebview: (raw) => client.recordFromWebview(raw),
      hasOpenedBefore: () => context.globalState.get<boolean>(FIRST_OPEN_STATE_KEY) === true,
      markOpened: () => void context.globalState.update(FIRST_OPEN_STATE_KEY, true),
      adoptValueSource: (source) => annotation.adoptValueSource(source),
      adoptHighlightTarget,
      // The window's cross-probe state, for the app's Cross-Probe dock tab.
      // Read per panel rather than captured: WaveCrux is deliberately last
      // in the host order, so in a multi-extension window this resolves
      // through the *elected host's* peer — and the election has not settled
      // when this line runs.
      crossProbe: () => membership.api.crossProbe?.(),
      onWaveformSelection: (designPath, panelColumn) => {
        void followWaveformSelection(designPath, panelColumn, annotation.resolver, sink, client);
      },
      refreshAnnotations: () => {
        annotation.refreshAnnotations();
      },
    }),
  );

  // Per-product desktop detection and the waveform handoff. The ONE
  // status surface belongs to the elected window host; the
  // `copy` handed to `joinCruxWindow` above is WaveCrux's contribution to
  // its panel. There is deliberately no second upgrade affordance anywhere
  // in this extension — see `status/surface.ts`.
  context.subscriptions.push(
    registerWaveCruxStatusSurface({
      record: (event) => client.record(event),
      activeWaveformUri,
      context,
      log: (line) => sink.append(line),
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_PANEL_COMMAND, async () => {
      await openWaveCruxPanel({
        extensionUri: context.extensionUri,
        sink,
        recordTelemetryFromWebview: (raw) => client.recordFromWebview(raw),
      });
    }),
  );

  if (process.env[AUTO_OPEN_ENV]) {
    void vscode.commands.executeCommand(OPEN_PANEL_COMMAND);
  }

  const autoOpenWaveform = process.env[AUTO_OPEN_WAVEFORM_ENV];
  if (autoOpenWaveform !== undefined && autoOpenWaveform !== '') {
    for (const path of autoOpenWaveform.split(',')) {
      // `Beside`, not the active column: a scripted run usually also opens an
      // HDL file, and RTL annotations only render into a *visible* text
      // editor. Opening the waveform on top of the source would hide the
      // thing the run exists to look at. Harness-only, like the env var.
      void vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(path),
        WAVEFORM_VIEW_TYPE,
        vscode.ViewColumn.Beside,
      );
    }
  }

  return membership.api;
}

/**
 * `feature.used` token for the waveform-selection follow.
 *
 * The **only** thing this feature reports, and only when it actually
 * navigated. Design paths, file paths and line numbers are the user's own
 * design data and go nowhere — a closed token with no properties is what
 * the telemetry rules allow and all they allow. Reported on the reveal rather than on
 * the selection so the number counts uses of the feature and not clicks in a
 * waveform.
 */
export const FOLLOW_SELECTION_FEATURE = 'waveform_selection_follow';

/**
 * The editor group to reveal RTL in, given the group the waveform tab is in.
 *
 * A waveform panel **is** an editor tab, so the active group at the moment
 * the user clicks a signal is the panel's own — and `showTextDocument` with
 * no column puts the source there, on top of the waveform. Measured on the
 * first live run of this feature: the right file opened at the right line
 * and the panel vanished behind it, so the *second* click of the gesture had
 * nothing to click on.
 *
 * So: the next group to the right, or group 1 when the waveform is already
 * in group 2 or beyond. That resolves to the group RTL is usually already
 * open in (the waveform is opened `Beside` the source), and when nothing is
 * there yet VSCode creates it, which is the layout the feature wants anyway.
 *
 * A panel with no column (`undefined` — a tab in a group VSCode has not
 * assigned yet) falls back to group 1 rather than to the active group: the
 * one thing worth avoiding is landing back on the waveform.
 *
 * Exported for its own test. Plain numbers, so it needs no `vscode` import;
 * `ViewColumn.One` is 1 and `.Two` is 2 in VSCode's own API.
 */
export function revealColumnBeside(panelColumn: number | undefined): number {
  return panelColumn === 1 ? 2 : 1;
}

/**
 * Reveal the RTL declaration of a signal the user selected in the waveform.
 *
 * All of the behaviour is host-core's — the opt-in check, the stems lookup,
 * the §11 containment gate and the focus-preserving reveal — because every
 * one of those is shared with the inbound `request_open_source` path and a
 * second copy of any of them is a second thing to get wrong. This function
 * is the wiring plus the diagnostics.
 */
async function followWaveformSelection(
  designPath: string,
  panelColumn: number | undefined,
  resolver: hostCore.names.NameResolver,
  sink: DiagnosticSink,
  client: hostCore.telemetry.TelemetryClient,
): Promise<void> {
  const outcome = await hostCore.editor.revealDesignPathInEditor(designPath, {
    resolver,
    editor: hostCore.editor.vscodeEditorHost,
    // Read live, per selection: a user who turns the setting on mid-session
    // must not have to reload the window to see it work.
    enabled: () => hostCore.editor.readCrossProbeSettings().followWaveformSelection,
    viewColumn: () => revealColumnBeside(panelColumn),
  });
  // `disabled` is the overwhelmingly common case — the setting is off by
  // default — and logging it would put a line in the output channel on
  // every click in a waveform.
  if (outcome.kind === 'disabled') return;
  if (outcome.kind === 'revealed') {
    sink.append(`   follow selection: revealed line ${outcome.lineNumber}`);
    client.record({
      name: hostCore.telemetry.TELEMETRY_EVENTS.featureUsed,
      properties: { feature: FOLLOW_SELECTION_FEATURE },
    });
    return;
  }
  sink.append(`   follow selection: ${outcome.kind} (${outcome.reason})`);
}

/**
 * Give up the window's CXP peer, and **wait for it** — see
 * `window/join.ts`. A no-op when this extension is not the one hosting.
 */
export function deactivate(): Promise<void> {
  return hostCore.window.deactivateCruxWindow();
}
