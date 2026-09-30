import { existsSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import * as hostCore from '@crux-vscode/host-core';
import {
  NETCRUX_ARTIFACT_KIND,
  NETCRUX_DESIGN_GLOB,
  openDesignInNetCrux,
  pickNetCruxDesignFile,
} from './handoff';
import { discoverNetCruxPeer } from './highlight/discover-peer';
import { locateNetCruxExecutable } from './highlight/locate-desktop';
import { sendHighlightToNetCrux } from './highlight/send-request';
import { whatDrivesThis, type WhatDrivesThisOutcome } from './highlight/what-drives-this';
import { NETCRUX_PRODUCT, netCruxCapabilityCopy } from './status/copy';
import { NETCRUX_SURFACE } from './surface';

/**
 * NetCrux — cross-probe-send surface for schematic/netlist browsing.
 *
 * The extension, in one sentence: a schematic browser needs a canvas this
 * editor cannot give it, so this extension embeds nothing and is instead a
 * CXP client — one context-menu command that resolves a right-clicked
 * register through host-core's stems index and sends `request_highlight`
 * to a running NetCrux desktop, launching or pointing at one when none is
 * running. See `highlight/what-drives-this.ts` for the whole of what it
 * does; this file only wires host-core's pieces together, the same shape
 * `lintcrux/src/extension.ts` and `simcrux/src/extension.ts` use.
 */

/** The context-menu / palette command. */
export const WHAT_DRIVES_THIS_COMMAND = 'netcrux.whatDrivesThis';

/** `feature.used` tokens. Lowercase/underscore, per the telemetry property vocabulary. */
const FEATURES = {
  whatDrivesThis: 'netcrux_what_drives_this',
} as const;

/** The product's telemetry client — one per extension, the only sender in the pack. */
function createTelemetryClient(context: vscode.ExtensionContext): hostCore.telemetry.TelemetryClient {
  return new hostCore.telemetry.TelemetryClient({
    product: NETCRUX_PRODUCT,
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

/** Index every stems file in the open folders, bounded. Mirrors `wavecrux/src/annotate/surface.ts`. */
const MAX_STEMS_FILES = 500;
async function scanStems(
  stems: hostCore.names.StemsIndexService,
  log: (line: string) => void,
): Promise<void> {
  try {
    const found = await vscode.workspace.findFiles(
      hostCore.names.STEMS_GLOB,
      '**/node_modules/**',
      MAX_STEMS_FILES,
    );
    await stems.load(found.map((uri) => uri.fsPath));
    log(`   stems: ${found.length} file(s), ${stems.index.size} entries indexed`);
  } catch {
    // A workspace that cannot be searched (no folder open, a provider that
    // refused) leaves an empty index, which is exactly "nothing to resolve".
  }
}

/**
 * The live NetCrux peer manifest, or `undefined` when discovery is
 * unavailable on this machine (no resolvable application-data root) or no
 * peer is up. See `highlight/discover-peer.ts` for why this is a fresh,
 * one-shot scan rather than a second continuous poller.
 */
async function discoverPeer(): Promise<hostCore.cxp.CxpPeerManifest | undefined> {
  try {
    return await discoverNetCruxPeer({ manifestDirectory: hostCore.cxp.sharedCxpManifestDirectory() });
  } catch {
    return undefined;
  }
}

export function activate(context: vscode.ExtensionContext): hostCore.window.CruxWindowApi {
  const channel = vscode.window.createOutputChannel('NetCrux');
  context.subscriptions.push(channel);
  const log = (line: string): void => channel.appendLine(line);

  const client = createTelemetryClient(context);
  client.start();
  context.subscriptions.push({ dispose: () => client.dispose() });
  client.record({ name: hostCore.telemetry.TELEMETRY_EVENTS.activated });

  // The stems index that resolves a right-clicked identifier to a design
  // path. No `hierarchy` fallback is supplied: unlike WaveCrux, this
  // extension never has a design loaded in-process to fall back to, so
  // "resolve from stems or not at all" (`NameResolver`'s own documented
  // behaviour for that case) is exactly right here, not a limitation.
  const stems = new hostCore.names.StemsIndexService({
    readFile: hostCore.names.vscodeStemsReader,
    fileSize: hostCore.names.vscodeStemsFileSize,
    watcher: hostCore.names.vscodeStemsWatcher(),
  });
  context.subscriptions.push(stems);
  void scanStems(stems, log);
  const resolver = new hostCore.names.NameResolver({
    index: stems.index,
    workspaceFolders: workspaceFolderPaths,
  });

  // Join the window: one CXP peer, one manifest, one status bar, however
  // many of the four extensions are installed. NetCrux contributes no
  // capabilities of its own (see `surface.ts`) — joining still makes the
  // capabilities panel show NetCrux as installed without ever claiming
  // this window can honour an inbound request it cannot. It does contribute
  // the resolver above, so the window-level `edacrux.sendSelectionToPeer` /
  // `edacrux.highlightSelectionInPeer` commands resolve a selection through
  // the same stems index "what drives this" uses, whichever extension hosts.
  const membership = hostCore.window.joinCruxWindow({
    context,
    product: NETCRUX_PRODUCT,
    surface: NETCRUX_SURFACE,
    copy: netCruxCapabilityCopy,
    resolver,
    record: (event) => client.record(event),
    log,
  });

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(WHAT_DRIVES_THIS_COMMAND, (textEditor) => {
      void runWhatDrivesThis(textEditor, resolver, context, client, log);
    }),
  );

  // Per-product desktop detection and the panel handoff for when a
  // peer is already running. The ONE status surface belongs to
  // the elected window host; `copy` above is NetCrux's contribution to its
  // panel. There is deliberately no second upgrade affordance anywhere in
  // this extension — the launch offer in `highlight/what-drives-this.ts`
  // is reached only from the context-menu command, never duplicated here.
  const statusSurface: hostCore.status.ProductStatusSurface = hostCore.status.registerProductStatusSurface({
    product: NETCRUX_PRODUCT,
    record: (event) => client.record(event),
    log,
    handoff: () => handoffToDesktop(context, log),
  });
  context.subscriptions.push(statusSurface);

  return membership.api;
}

/** Run the command against the real environment. */
async function runWhatDrivesThis(
  textEditor: vscode.TextEditor,
  resolver: hostCore.names.NameResolver,
  context: vscode.ExtensionContext,
  client: hostCore.telemetry.TelemetryClient,
  log: (line: string) => void,
): Promise<void> {
  const outcome = await whatDrivesThis({
    currentSelection: () => hostCore.editor.vscodeCurrentSelectionSnapshot(textEditor),
    resolver,
    ui: hostCore.editor.vscodeUserInterface,
    discoverPeer,
    sendHighlight: (manifest, element) =>
      sendHighlightToNetCrux(
        manifest,
        { kind: hostCore.cxp.CxpMessageKind.requestHighlight, element, metadata: {} },
        {
          selfIdentity: hostCore.cxp.createVscodePeerIdentity({
            workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
            productVersion: extensionVersion(context) ?? '0.0.0',
          }),
        },
      ),
    locateInstalled: () =>
      locateNetCruxExecutable({
        exists: existsSync,
        platform: process.platform,
        env: process.env,
        pathDelimiter: path.delimiter,
        join: (...segments) => path.join(...segments),
      }),
    launch: async (executablePath) => {
      await vscode.env.openExternal(vscode.Uri.file(executablePath));
    },
    openInstallUrl: async () => {
      await vscode.env.openExternal(vscode.Uri.parse(hostCore.status.cruxProductInstallUrl('netcrux')));
    },
    showMessage: async (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
    log,
  });
  recordOutcome(outcome, client);
}

/** This extension's own version, for the CXP identity we hand off with. */
function extensionVersion(context: vscode.ExtensionContext): string | undefined {
  return typeof context.extension.packageJSON === 'object' && context.extension.packageJSON !== null
    ? (context.extension.packageJSON as { version?: string }).version
    : undefined;
}

/** Record `feature.used` for any invocation that reached a real target — never for a dismissed pick. */
function recordOutcome(outcome: WhatDrivesThisOutcome, client: hostCore.telemetry.TelemetryClient): void {
  if (outcome.kind === 'no-selection' || outcome.kind === 'no-candidates' || outcome.kind === 'cancelled') {
    return;
  }
  client.record({
    name: hostCore.telemetry.TELEMETRY_EVENTS.featureUsed,
    properties: { feature: FEATURES.whatDrivesThis },
  });
}

/** The active editor's file, when it is a file on disk. */
function activeEditorFile(): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  return uri?.scheme === 'file' ? uri.fsPath : undefined;
}

/**
 * Behaviour for `edacrux.openInDesktop.netcrux` — the capabilities panel's
 * handoff. See `handoff.ts` for why it hands over an HDL design file.
 */
async function handoffToDesktop(
  context: vscode.ExtensionContext,
  log: (line: string) => void,
): Promise<void> {
  const outcome = await openDesignInNetCrux({
    designFile: () =>
      pickNetCruxDesignFile(activeEditorFile(), async () => {
        const found = await vscode.workspace.findFiles(NETCRUX_DESIGN_GLOB, '**/node_modules/**', 1);
        return found[0]?.fsPath;
      }),
    handOff: hostCore.desktopDetect.createVscodeArtifactHandoff({
      product: NETCRUX_PRODUCT,
      artifactKind: NETCRUX_ARTIFACT_KIND,
      context,
      log,
    }),
    showMessage: (message) => {
      void vscode.window.showInformationMessage(message);
    },
  });
  log(
    `   handoff: ${outcome.kind}` +
      (outcome.kind === 'handed-off' ? ` (${outcome.handoff.kind})` : ''),
  );
}

/**
 * Give up the window's CXP peer, and **wait for it** — see
 * `window/join.ts`. A no-op when this extension is not the one hosting.
 */
export function deactivate(): Promise<void> {
  return hostCore.window.deactivateCruxWindow();
}
