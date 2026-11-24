/**
 * The three ways a link reaches an extension, wired to one flow.
 *
 * - **The URI handler.** `vscode://ferrite-engineering.<product>/open?…`
 *   (`vscode.window.registerUriHandler`). VS Code asks the user before it
 *   hands a link from outside the window to an extension; the flow's own
 *   confirmation is the second question, about the file.
 * - **The Open Link command**, with a link as its argument or pasted into an
 *   input box: the desktop form or the editor form.
 * - **A terminal link.** The desktop form or the editor form printed in a
 *   terminal, which VS Code would otherwise leave as plain text.
 *
 * Each is rewritten to the desktop form (`rewrite.ts`) and handed to
 * [openCruxLink]; nothing here decides anything about a link. The file check
 * is the product's `vetLinkTarget` (`target.ts`).
 */
import * as vscode from 'vscode';
import { findCruxLinks } from './detect';
import { openCruxLink, type CruxLinkFlow, type CruxLinkNotice, type CruxLinkParse } from './flow';
import { findOpenedPath } from './opened-before';
import { desktopLinkFromEditorUri, desktopLinkFromText, type DesktopLinkRewrite } from './rewrite';
import type { LinkTargetResult } from './target';

/** Every sentence the flow shows, in the product's voice and its l10n bundle. */
export interface CruxLinkStrings {
  readonly confirmTitle: () => string;
  readonly confirmBody: (fileName: string) => string;
  readonly confirmPathLabel: () => string;
  readonly confirmOpen: () => string;
  readonly refusedInvalid: () => string;
  readonly refusedPath: () => string;
  readonly refusedWrongKind: (fileName: string) => string;
  readonly refusedNotFound: (fileName: string) => string;
  readonly terminalLinkTooltip: () => string;
  readonly inputPrompt: () => string;
}

/** One product's links. */
export interface CruxLinkRegistration<L extends { readonly file: string }> {
  readonly context: vscode.ExtensionContext;
  /** The desktop scheme: `wavecrux`, `netcrux`. */
  readonly scheme: string;
  /** `ferrite-engineering.<product>`, the editor form's authority. */
  readonly extensionId: string;
  /** The Open Link command id. */
  readonly command: string;
  readonly parse: (link: string) => CruxLinkParse<L>;
  /** The product's file check: [vetLinkTarget] with the kinds a link may open. */
  readonly vet: (file: string) => Promise<LinkTargetResult>;
  /** Open [path] and place what [link] names. */
  readonly open: (path: string, link: L) => Promise<void>;
  readonly strings: CruxLinkStrings;
  readonly log: (line: string) => void;
}

/** The files open in a tab of this window, by path. */
export function openTabFilePaths(): string[] {
  const paths: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input: unknown = tab.input;
      if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
        if (input.uri.scheme === 'file') paths.push(input.uri.fsPath);
      }
    }
  }
  return paths;
}

/** Base name of a path written on any host. */
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The flow over the real window. Exported for the products' own wiring tests. */
export function vscodeCruxLinkFlow<L extends { readonly file: string }>(
  registration: CruxLinkRegistration<L>,
): CruxLinkFlow<L> {
  const { strings } = registration;
  return {
    parse: registration.parse,
    vet: registration.vet,
    openTabPath: (resolved) => findOpenedPath(resolved, openTabFilePaths()),
    confirm: async (resolved) => {
      const open = strings.confirmOpen();
      // Modal, so nothing else in the window can be clicked past it; VS Code
      // adds Cancel, and Escape or closing the dialog is Cancel too.
      const answer = await vscode.window.showWarningMessage(
        strings.confirmTitle(),
        {
          modal: true,
          detail: `${strings.confirmBody(fileNameOf(resolved))}\n\n${strings.confirmPathLabel()}\n${resolved}`,
        },
        open,
      );
      return answer === open;
    },
    open: registration.open,
    notify: (notice: CruxLinkNotice) => {
      void vscode.window.showErrorMessage(noticeText(notice, strings));
    },
    log: registration.log,
  };
}

/** The sentence for [notice]. */
export function noticeText(notice: CruxLinkNotice, strings: CruxLinkStrings): string {
  switch (notice.kind) {
    case 'invalid':
      return strings.refusedInvalid();
    case 'path':
      return strings.refusedPath();
    case 'wrong-kind':
      return strings.refusedWrongKind(notice.fileName);
    case 'not-found':
      return strings.refusedNotFound(notice.fileName);
  }
}

/** A terminal link carrying its text through to the handler. */
interface CruxTerminalLink extends vscode.TerminalLink {
  readonly text: string;
}

/** Register the URI handler, the command and the terminal links for one product. */
export function registerCruxLinks<L extends { readonly file: string }>(
  registration: CruxLinkRegistration<L>,
): void {
  const { context, scheme, extensionId, strings } = registration;
  const flow = vscodeCruxLinkFlow(registration);
  const run = (rewrite: DesktopLinkRewrite): Promise<unknown> => openCruxLink(rewrite, flow);
  const terminalLinks: vscode.TerminalLinkProvider<CruxTerminalLink> = {
    provideTerminalLinks: (terminalContext) =>
      findCruxLinks(terminalContext.line, scheme, extensionId).map((found) => {
        const link = new vscode.TerminalLink(
          found.startIndex,
          found.length,
          strings.terminalLinkTooltip(),
        ) as vscode.TerminalLink & { text: string };
        link.text = found.text;
        return link;
      }),
    handleTerminalLink: async (link) => {
      registration.log('   link: from a terminal');
      await run(desktopLinkFromText(link.text, scheme, extensionId));
    },
  };

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri: vscode.Uri) => {
        registration.log('   link: from the URI handler');
        void run(desktopLinkFromEditorUri(uri, scheme));
      },
    }),
    vscode.commands.registerCommand(registration.command, async (argument?: unknown) => {
      const text =
        typeof argument === 'string'
          ? argument
          : await vscode.window.showInputBox({ prompt: strings.inputPrompt(), ignoreFocusOut: true });
      if (text === undefined || text.trim().length === 0) return;
      registration.log('   link: from the Open Link command');
      await run(desktopLinkFromText(text, scheme, extensionId));
    }),
    vscode.window.registerTerminalLinkProvider(terminalLinks),
  );
}
