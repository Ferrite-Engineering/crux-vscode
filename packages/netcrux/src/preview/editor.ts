/**
 * The schematic preview: a custom editor that shows a Yosys JSON netlist with
 * the NetCrux web viewer.
 *
 * ### Never the default
 *
 * Registered with priority `option`, so it appears under "Open With..." and
 * behind the "Open Schematic Preview" command, and never takes a `.json` that
 * the user did not ask to see as a schematic. The command also checks the file's
 * content (`netlist-detect.ts`) and refuses one that is not a netlist, so the
 * explorer entry on every `.json` cannot open a viewer onto a package manifest.
 *
 * ### Read-only
 *
 * A netlist is a synthesis tool's output; nothing in the viewer writes one back,
 * and claiming the editable interface would put a dirty indicator and a Save
 * command on a document with no edits to save.
 *
 * ### The four paths out of `resolveCustomEditor`
 *
 * 1. **A netlist within the size threshold**: the viewer, handed the text once
 *    its listener is installed.
 * 2. **A netlist over the threshold**: a notice offering the desktop app, which
 *    has no size limit. The page is not loaded at all; a document it cannot hold
 *    would freeze the window.
 * 3. **Empty, or not a netlist**: a notice saying so.
 * 4. **The viewer is not packaged**: a developer-only case the shared renderer
 *    explains.
 *
 * ### `resolveCustomEditor` must not wait for the page
 *
 * VS Code builds a custom editor's webview content only after the provider's
 * promise resolves, so waiting there for the viewer's first frame deadlocks: a
 * blank tab and no diagnostic, because the page that would have reported the
 * failure is the thing that never ran. Sending the document therefore starts in
 * a floating promise.
 */
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { looksLikeYosysNetlist, NETLIST_SNIFF_BYTES } from './netlist-detect';
import { planNetlist, type NetlistPlan } from './size-plan';
import {
  formatDiagnostic,
  isFailure,
  openNetlistFrame,
  parseWebviewMessage,
  type NoticeAction,
} from './messages';
import { renderNotice, renderViewer, type DiagnosticSink } from './panel';

/** The custom editor's view type. */
export const NETLIST_VIEW_TYPE = 'netcrux.schematic';

/** How long to wait for the viewer's `ready` before sending the document anyway. */
export const READY_WAIT_MS = 30_000;

/** Quiet period after a file change before the preview reloads it. */
export const RELOAD_DEBOUNCE_MS = 400;

/** What the provider needs from the extension. */
export interface NetlistEditorDependencies {
  readonly extensionUri: vscode.Uri;
  readonly sink: DiagnosticSink;
  /** The `netcrux.preview.maxFileSizeMB` setting, read live. */
  readonly maxFileSizeMb: () => unknown;
  /** Show a source location the viewer asked for. */
  readonly goToSource: (
    netlist: vscode.Uri,
    file: string,
    line: number,
    column: number | undefined,
  ) => Promise<void>;
  /** Hand the netlist to NetCrux Desktop. */
  readonly openInNetCrux: (netlist: vscode.Uri) => Promise<void>;
  /** Record that a preview opened. */
  readonly recordOpened: (outcome: 'preview' | 'too-large' | 'empty' | 'not-netlist') => void;
}

/** What the preview will do with one file. */
export type NetlistDisposition = NetlistPlan | { readonly kind: 'not-netlist' };

/** One open netlist. Holds no file handle: it is read on demand. */
export class NetlistDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    readonly sizeBytes: number,
    readonly disposition: NetlistDisposition,
  ) {}

  /** The tab label and the name the viewer shows. */
  get displayName(): string {
    return path.posix.basename(this.uri.path);
  }

  dispose(): void {
    // Nothing is held open.
  }
}

/** The file's size in bytes, or 0 when it cannot be read. */
export async function netlistSizeBytes(uri: vscode.Uri): Promise<number> {
  try {
    if (uri.scheme === 'file') return (await fsPromises.stat(uri.fsPath)).size;
    return (await vscode.workspace.fs.stat(uri)).size;
  } catch {
    return 0;
  }
}

/**
 * The first [NETLIST_SNIFF_BYTES] of the file as text, or `undefined` when they
 * cannot be had cheaply. A local file is read from its start without reading the
 * rest, so a multi-gigabyte netlist costs a 256 KiB read; another scheme is read
 * whole only when [sizeBytes] is small enough that doing so is cheap.
 */
export async function readNetlistHead(
  uri: vscode.Uri,
  sizeBytes: number,
): Promise<string | undefined> {
  try {
    if (uri.scheme === 'file') {
      const handle = await fsPromises.open(uri.fsPath, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(NETLIST_SNIFF_BYTES, Math.max(sizeBytes, 1)));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    }
    if (sizeBytes > NETLIST_SNIFF_BYTES * 8) return undefined;
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes.subarray(0, NETLIST_SNIFF_BYTES));
  } catch {
    return undefined;
  }
}

/** Decide what to do with [uri], reading as little of it as possible. */
export async function classifyNetlist(
  uri: vscode.Uri,
  maxFileSizeMb: unknown,
): Promise<{ readonly sizeBytes: number; readonly disposition: NetlistDisposition }> {
  const sizeBytes = await netlistSizeBytes(uri);
  const plan = planNetlist(sizeBytes, maxFileSizeMb);
  if (plan.kind === 'empty') return { sizeBytes, disposition: plan };
  const head = await readNetlistHead(uri, sizeBytes);
  // A head that could not be read says nothing either way, so the plan stands.
  if (head !== undefined && !looksLikeYosysNetlist(head)) {
    return { sizeBytes, disposition: { kind: 'not-netlist' } };
  }
  return { sizeBytes, disposition: plan };
}

/** The whole file as text, without a byte-order mark. */
async function readNetlistText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0);
}

/** The notice for a disposition that is not the viewer. */
export function noticeFor(
  document: NetlistDocument,
  disposition: NetlistDisposition = document.disposition,
  sizeBytes: number = document.sizeBytes,
): { title: string; message: string; actions: { action: NoticeAction; label: string }[] } | undefined {
  switch (disposition.kind) {
    case 'preview':
      return undefined;
    case 'empty':
      return {
        title: vscode.l10n.t('This netlist is empty'),
        message: vscode.l10n.t(
          'The file has no contents. A synthesis run that failed before its first write leaves a file like this; check the tool’s log, then reopen it once it has a design.',
        ),
        actions: [],
      };
    case 'not-netlist':
      return {
        title: vscode.l10n.t('This is not a Yosys netlist'),
        message: vscode.l10n.t(
          'The schematic preview draws the JSON that Yosys writes with write_json. This file does not look like one. It can still be opened as text.',
        ),
        actions: [{ action: 'open-as-text', label: vscode.l10n.t('Open as Text') }],
      };
    case 'too-large':
      return {
        title: vscode.l10n.t('This netlist is too large for the preview'),
        message: vscode.l10n.t(
          'The preview loads a netlist into the editor’s memory, so it stops at {0} MB, and this file is {1} MB. NetCrux Desktop reads a netlist from disk and has no such limit. Raise the limit in the settings to try the preview anyway.',
          disposition.limitMb,
          mib(sizeBytes),
        ),
        actions: [
          { action: 'open-in-netcrux', label: vscode.l10n.t('Open in NetCrux') },
          { action: 'change-size-limit', label: vscode.l10n.t('Change the Size Limit') },
        ],
      };
  }
}

/** What one open panel is doing. */
interface PanelState {
  /** Whether the panel holds the viewer, as opposed to a notice. */
  mounted: boolean;
  /** Settles when the viewer is listening. Replaced each time the viewer is mounted. */
  ready: Deferred;
  disposed: boolean;
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve: () => resolve() };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class NetlistEditorProvider implements vscode.CustomReadonlyEditorProvider<NetlistDocument> {
  constructor(private readonly deps: NetlistEditorDependencies) {}

  /**
   * Register the provider. `retainContextWhenHidden` is fixed at registration:
   * the viewer's cold start (CanvasKit, a multi-megabyte dart2js bundle, a
   * layout engine) is seconds, and tearing the page down on every tab switch
   * would pay it again each time the user looked at their RTL.
   */
  static register(deps: NetlistEditorDependencies): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      NETLIST_VIEW_TYPE,
      new NetlistEditorProvider(deps),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    );
  }

  async openCustomDocument(uri: vscode.Uri): Promise<NetlistDocument> {
    const { sizeBytes, disposition } = await classifyNetlist(uri, this.deps.maxFileSizeMb());
    return new NetlistDocument(uri, sizeBytes, disposition);
  }

  /** Synchronous on purpose; see the module docs. */
  resolveCustomEditor(document: NetlistDocument, panel: vscode.WebviewPanel): void {
    const { sink } = this.deps;
    const name = document.displayName;
    sink.append(`   ${name}: resolving (${document.disposition.kind}, ${document.sizeBytes} bytes)`);
    this.deps.recordOpened(document.disposition.kind);

    const state: PanelState = { mounted: false, ready: deferred(), disposed: false };
    // The ONE message listener for this panel. A webview delivers to every
    // registered listener, so a second one would act on each message twice.
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (message === undefined) return;
      switch (message.type) {
        case 'diagnostic':
          sink.append(formatDiagnostic(message.diagnostic));
          if (isFailure(message.diagnostic)) {
            console.error(`[netcrux webview] ${formatDiagnostic(message.diagnostic)}`);
          }
          // First frame is as good as `ready`: the viewer installs its
          // listener before it draws, so either means a posted frame arrives.
          if (message.diagnostic.kind === 'first-frame') state.ready.resolve();
          return;
        case 'ready':
          state.ready.resolve();
          return;
        case 'open-source':
          void this.deps.goToSource(document.uri, message.file, message.line, message.column);
          return;
        case 'status':
          sink.append(
            `   ${name}: ${message.phase}` +
              (message.modules !== undefined ? ` ${message.modules} module(s)` : '') +
              (message.cells !== undefined ? ` ${message.cells} cell(s)` : '') +
              (message.phase === 'failed' && message.message !== undefined ? `: ${message.message}` : ''),
          );
          return;
        case 'notice-action':
          void this.runNoticeAction(message.action, document);
          return;
      }
    });

    const first = noticeFor(document);
    if (first !== undefined) {
      this.showNotice(panel, document, first);
    } else {
      void this.mountAndSend(panel, document, state);
    }

    // The preview follows the file: a synthesis run that rewrites the netlist
    // shows up without reopening. Only a local file can be watched.
    const watcher =
      document.uri.scheme === 'file'
        ? vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(
              vscode.Uri.file(path.dirname(document.uri.fsPath)),
              path.basename(document.uri.fsPath),
            ),
          )
        : undefined;
    let reloadTimer: NodeJS.Timeout | undefined;
    const reload = (): void => {
      if (reloadTimer !== undefined) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined;
        void this.reload(panel, document, state);
      }, RELOAD_DEBOUNCE_MS);
    };
    const subscriptions = [watcher?.onDidChange(reload), watcher?.onDidCreate(reload)];

    panel.onDidDispose(() => {
      state.disposed = true;
      if (reloadTimer !== undefined) clearTimeout(reloadTimer);
      for (const subscription of subscriptions) subscription?.dispose();
      watcher?.dispose();
      state.ready.resolve();
      sink.append(`   ${name}: panel disposed`);
    });
  }

  /** Read the file and hand it to the viewer. */
  private async sendDocument(panel: vscode.WebviewPanel, document: NetlistDocument): Promise<void> {
    const name = document.displayName;
    try {
      const text = await readNetlistText(document.uri);
      const delivered = await panel.webview.postMessage(openNetlistFrame(name, text));
      this.deps.sink.append(
        `   ${name}: ${text.length} characters ${delivered ? 'sent to the viewer' : 'NOT delivered'}`,
      );
    } catch (error) {
      this.deps.sink.append(`   ${name}: could not read the file (${String(error)})`);
    }
  }

  /**
   * Put the viewer into the panel, wait for it to say it is listening, and hand
   * it the file. The wait is a race with a timeout, not a design: posting into a
   * page that never booted is harmless, and never posting because one message
   * went missing would not be.
   */
  private async mountAndSend(
    panel: vscode.WebviewPanel,
    document: NetlistDocument,
    state: PanelState,
  ): Promise<void> {
    state.ready = deferred();
    const staged = await renderViewer(panel.webview, this.deps.extensionUri, this.deps.sink);
    if (!staged) return;
    state.mounted = true;
    await Promise.race([state.ready.promise, delay(READY_WAIT_MS)]);
    if (state.disposed) return;
    await this.sendDocument(panel, document);
  }

  /** The file changed on disk: classify it again and show what it now is. */
  private async reload(
    panel: vscode.WebviewPanel,
    document: NetlistDocument,
    state: PanelState,
  ): Promise<void> {
    if (state.disposed) return;
    const { sizeBytes, disposition } = await classifyNetlist(document.uri, this.deps.maxFileSizeMb());
    if (state.disposed) return;
    this.deps.sink.append(`   ${document.displayName}: changed on disk (${disposition.kind}, ${sizeBytes} bytes)`);
    if (disposition.kind === 'preview') {
      // The viewer may not be there: the file may have been a notice's subject
      // (empty, too large) a moment ago and is a netlist now.
      if (state.mounted) await this.sendDocument(panel, document);
      else await this.mountAndSend(panel, document, state);
      return;
    }
    // It is now empty, too large, or not a netlist: the viewer would be showing
    // a design the file no longer holds.
    const notice = noticeFor(document, disposition, sizeBytes);
    if (notice === undefined) return;
    state.mounted = false;
    this.showNotice(panel, document, notice);
  }

  private showNotice(
    panel: vscode.WebviewPanel,
    document: NetlistDocument,
    notice: NonNullable<ReturnType<typeof noticeFor>>,
  ): void {
    renderNotice(panel.webview, notice);
    this.deps.sink.append(`   ${document.displayName}: ${notice.title}`);
  }

  private async runNoticeAction(action: NoticeAction, document: NetlistDocument): Promise<void> {
    switch (action) {
      case 'open-in-netcrux':
        await this.deps.openInNetCrux(document.uri);
        return;
      case 'open-as-text':
        await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
        return;
      case 'change-size-limit':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'netcrux.preview.maxFileSizeMB',
        );
        return;
    }
  }
}
