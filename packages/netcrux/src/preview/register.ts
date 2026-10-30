/**
 * Wires the schematic preview into the extension: the custom editor, the two
 * commands, the context key that decides where the editor-title button shows,
 * and the real environment behind "Go to Source" and "Open in NetCrux".
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import * as hostCore from '@crux-vscode/host-core';
import { locateNetCruxExecutable } from '../highlight/locate-desktop';
import { classifyNetlist, NETLIST_VIEW_TYPE, NetlistEditorProvider, readNetlistHead } from './editor';
import { looksLikeYosysNetlist } from './netlist-detect';
import { openInNetCrux, type OpenInNetCruxDeps } from './open-in-netcrux';
import { DEFAULT_MAX_FILE_SIZE_MB } from './size-plan';
import { resolveNetlistSourcePath } from './source-path';

/** The commands. */
export const OPEN_PREVIEW_COMMAND = 'netcrux.openSchematicPreview';
export const OPEN_IN_NETCRUX_COMMAND = 'netcrux.openInNetCrux';

/** Context key: the active text editor holds a Yosys netlist. */
export const IS_NETLIST_CONTEXT_KEY = 'netcrux.isYosysNetlist';

/** The `feature.used` tokens. */
export const PREVIEW_FEATURES = {
  preview: 'netcrux_schematic_preview',
  goToSource: 'netcrux_preview_go_to_source',
  openInNetCrux: 'netcrux_open_in_desktop',
} as const;

/** What the registration needs from `activate()`. */
export interface PreviewRegistration {
  readonly context: vscode.ExtensionContext;
  readonly log: (line: string) => void;
  readonly recordFeature: (feature: string) => void;
  /** Hand a file to a running NetCrux over CXP, or fall back. See `open-in-netcrux.ts`. */
  readonly handOff: OpenInNetCruxDeps['handOff'];
  readonly peerRunning: OpenInNetCruxDeps['peerRunning'];
}

/** The setting, read live so a change applies to the next file opened. */
function maxFileSizeMb(): unknown {
  return vscode.workspace
    .getConfiguration('netcrux.preview')
    .get<number>('maxFileSizeMB', DEFAULT_MAX_FILE_SIZE_MB);
}

/** Absolute paths of the open workspace folders. */
function workspaceFolderPaths(): readonly string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

/** The URI a command acts on: its argument, else the file in the active editor. */
export function targetUri(argument: unknown): vscode.Uri | undefined {
  if (argument instanceof vscode.Uri) return argument;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

function isJson(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.json');
}

/** Escape nothing: a base name is looked up by glob only when it is plain. */
const PLAIN_BASE_NAME = /^[\w.\- ]+$/;

async function findByBaseName(baseName: string): Promise<readonly string[]> {
  const exclude = '**/{node_modules,.git}/**';
  if (PLAIN_BASE_NAME.test(baseName)) {
    return (await vscode.workspace.findFiles(`**/${baseName}`, exclude, 50)).map((uri) => uri.fsPath);
  }
  // A name with glob characters in it: search by extension and compare exactly.
  const extension = path.extname(baseName);
  const found = await vscode.workspace.findFiles(
    extension.length > 0 ? `**/*${extension}` : '**/*',
    exclude,
    2000,
  );
  return found.map((uri) => uri.fsPath).filter((fsPath) => path.basename(fsPath) === baseName);
}

async function fileExists(fsPath: string): Promise<boolean> {
  try {
    return (await stat(fsPath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Show the RTL a netlist's `src` attribute names, in the editor.
 *
 * The path is found first ([resolveNetlistSourcePath]) and then opened through
 * host-core's containment-checked open: a netlist is data from a tool run, and
 * one that names `/etc/passwd:1` must not make the editor open it just because
 * a button was pressed. Only files inside a folder the user has opened are shown.
 */
export async function goToSource(
  netlist: vscode.Uri,
  file: string,
  line: number,
  column: number | undefined,
  log: (line: string) => void,
): Promise<void> {
  const resolved = await resolveNetlistSourcePath(
    file,
    { netlistDirectory: path.dirname(netlist.fsPath), workspaceFolders: workspaceFolderPaths() },
    { exists: fileExists, findByBaseName },
  );
  let fsPath: string | undefined;
  if (resolved.kind === 'found') {
    fsPath = resolved.fsPath;
  } else if (resolved.kind === 'ambiguous') {
    const picked = await vscode.window.showQuickPick(
      resolved.candidates.map((candidate) => ({
        label: path.basename(candidate),
        description: vscode.workspace.asRelativePath(candidate),
        candidate,
      })),
      { placeHolder: vscode.l10n.t('Which {0} did the netlist mean?', path.basename(file)) },
    );
    fsPath = picked?.candidate;
  } else {
    log(`   go to source: ${file} not found in the open folders`);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('{0} was not found in the open folders.', path.basename(file)),
    );
    return;
  }
  if (fsPath === undefined) return;
  const outcome = await hostCore.editor.openContainedSourceLocation(
    { filePath: fsPath, line, ...(column !== undefined ? { column } : {}) },
    {
      editor: hostCore.editor.vscodeEditorHost,
      // Beside the preview, so the schematic stays where it is to be clicked
      // again; and focused, because the click asked to go there.
      presentation: { preserveFocus: false, preview: false, viewColumn: vscode.ViewColumn.Beside },
    },
  );
  if (!outcome.honored) {
    log(`   go to source: refused (${outcome.reason ?? 'no reason'})`);
    void vscode.window.showInformationMessage(
      outcome.reason ?? vscode.l10n.t('The file could not be opened.'),
    );
  }
}

/** Start the installed desktop app with [fsPath] as its argument, detached. */
function launchDesktop(installed: string, fsPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // macOS names an application bundle; everything else names an executable.
    const darwin = process.platform === 'darwin';
    const command = darwin ? 'open' : installed;
    const args = darwin ? ['-a', installed, fsPath] : [fsPath];
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Register everything. */
export function registerSchematicPreview(registration: PreviewRegistration): void {
  const { context, log, recordFeature, handOff, peerRunning } = registration;

  const openInDesktop = async (netlist: vscode.Uri): Promise<void> => {
    if (netlist.scheme !== 'file') {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('NetCrux Desktop opens files on this computer, and this netlist is not one.'),
      );
      return;
    }
    recordFeature(PREVIEW_FEATURES.openInNetCrux);
    const outcome = await openInNetCrux(netlist.fsPath, {
      handOff,
      peerRunning,
      locateInstalled: () =>
        locateNetCruxExecutable({
          exists: existsSync,
          platform: process.platform,
          env: process.env,
          pathDelimiter: path.delimiter,
          join: (...segments) => path.join(...segments),
        }),
      launch: launchDesktop,
      offerInstall: async () => {
        const download = vscode.l10n.t('Download NetCrux');
        const answer = await vscode.window.showInformationMessage(
          vscode.l10n.t(
            'NetCrux Desktop was not found on this computer. It opens netlists of any size and has the Pro features.',
          ),
          download,
        );
        if (answer === download) {
          await vscode.env.openExternal(vscode.Uri.parse(hostCore.status.cruxProductInstallUrl('netcrux')));
        }
      },
      showMessage: (message) => {
        void vscode.window.showInformationMessage(message);
      },
      launchedMessage: () => vscode.l10n.t('Opening the netlist in NetCrux Desktop.'),
      log,
    });
    log(`   open in NetCrux: ${outcome.kind}`);
    if (outcome.kind === 'launch-failed') {
      void vscode.window.showErrorMessage(vscode.l10n.t('NetCrux Desktop could not be started.'));
    }
  };

  const channel = { append: log };
  context.subscriptions.push(
    NetlistEditorProvider.register({
      extensionUri: context.extensionUri,
      sink: channel,
      maxFileSizeMb,
      goToSource: (netlist, file, line, column) => {
        recordFeature(PREVIEW_FEATURES.goToSource);
        return goToSource(netlist, file, line, column, log);
      },
      openInNetCrux: openInDesktop,
      recordOpened: (outcome) => {
        if (outcome === 'preview') recordFeature(PREVIEW_FEATURES.preview);
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_PREVIEW_COMMAND, async (argument?: unknown) => {
      const uri = targetUri(argument);
      if (uri === undefined || !isJson(uri)) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Select a Yosys JSON netlist (a .json file written by write_json) to preview.'),
        );
        return;
      }
      const { disposition } = await classifyNetlist(uri, maxFileSizeMb());
      if (disposition.kind === 'not-netlist') {
        const openAnyway = vscode.l10n.t('Preview Anyway');
        const answer = await vscode.window.showInformationMessage(
          vscode.l10n.t(
            '{0} does not look like a Yosys netlist. The preview draws the JSON that Yosys writes with write_json.',
            path.basename(uri.path),
          ),
          openAnyway,
        );
        if (answer !== openAnyway) return;
      }
      // Beside the file when it is the text editor in front, so the netlist and
      // its schematic can be read together; in place when it comes from the explorer.
      const fromEditor = vscode.window.activeTextEditor?.document.uri.toString() === uri.toString();
      await vscode.commands.executeCommand('vscode.openWith', uri, NETLIST_VIEW_TYPE, {
        viewColumn: fromEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
      });
    }),
    vscode.commands.registerCommand(OPEN_IN_NETCRUX_COMMAND, async (argument?: unknown) => {
      const uri = targetUri(argument);
      if (uri === undefined || !isJson(uri)) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Select a Yosys JSON netlist (a .json file written by write_json) to open in NetCrux.'),
        );
        return;
      }
      await openInDesktop(uri);
    }),
  );

  trackNetlistContextKey(context);
}

/**
 * Keep [IS_NETLIST_CONTEXT_KEY] true while the active text editor holds a Yosys
 * netlist, so the editor-title button appears on a netlist and on no other JSON.
 * Only a `.json` file is read, only its first 256 KiB, and only on a switch of
 * editor, never per keystroke.
 */
function trackNetlistContextKey(context: vscode.ExtensionContext): void {
  let generation = 0;
  const update = async (editor: vscode.TextEditor | undefined): Promise<void> => {
    const mine = ++generation;
    const uri = editor?.document.uri;
    let value = false;
    if (uri !== undefined && isJson(uri) && !editor?.document.isUntitled) {
      try {
        const size = (await vscode.workspace.fs.stat(uri)).size;
        const head = await readNetlistHead(uri, size);
        value = head !== undefined && looksLikeYosysNetlist(head);
      } catch {
        value = false;
      }
    }
    // A newer switch of editor has started; its answer is the one that counts.
    if (mine !== generation) return;
    await vscode.commands.executeCommand('setContext', IS_NETLIST_CONTEXT_KEY, value);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => void update(editor)),
  );
  void update(vscode.window.activeTextEditor);
}
