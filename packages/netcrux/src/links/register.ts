/**
 * `netcrux://` links, and `vscode://ferrite-engineering.netcrux/open?…`,
 * opened in this window.
 *
 * The flow (parse, file check, confirmation, open) is host-core's
 * (`links/flow.ts`); this file is NetCrux's half: its parser and file kinds,
 * its sentences, and what opening means in the editor. A Yosys JSON netlist
 * opens in the schematic preview, which selects the cell or net once it has
 * loaded (`netlist-panels.ts`); an HDL source opens as text, at the line the
 * netlist index gives for the cell or net (`place.ts`).
 */
import * as vscode from 'vscode';
import { editor, links } from '@crux-vscode/host-core';
import { NETLIST_VIEW_TYPE } from '../preview/editor';
import { NETCRUX_LINK_SCHEME, parseNetCruxLink, vetNetCruxLinkTarget, type NetCruxLink } from './netcrux-link';
import { netlistPanelKey, type NetlistPanelRegistry } from './netlist-panels';
import {
  isNetlistPath,
  placeNetCruxLink,
  placeNetCruxLinkInPreview,
  type NetCruxNameLocator,
  type NetCruxPlacement,
} from './place';

/** The Open Link command. */
export const OPEN_LINK_COMMAND = 'netcrux.openLink';

/** Every sentence a link can show. */
export const netCruxLinkStrings: links.CruxLinkStrings = {
  confirmTitle: () => vscode.l10n.t('Open a design from a link?'),
  confirmBody: (fileName) =>
    vscode.l10n.t(
      'A link asks NetCrux to open {0}, which is not open in this window. Open it only if you trust where the link came from.',
      fileName,
    ),
  confirmPathLabel: () => vscode.l10n.t('Full path'),
  confirmOpen: () => vscode.l10n.t('Open'),
  refusedInvalid: () => vscode.l10n.t('NetCrux did not open the link because it is not a valid NetCrux link.'),
  refusedPath: () =>
    vscode.l10n.t('NetCrux did not open the link because the file is not given as a full local path.'),
  refusedWrongKind: (fileName) =>
    vscode.l10n.t('NetCrux did not open the link because {0} is not a design file a link can open.', fileName),
  refusedNotFound: (fileName) => vscode.l10n.t('NetCrux did not open the link because {0} was not found.', fileName),
  terminalLinkTooltip: () => vscode.l10n.t('Open the link in NetCrux'),
  inputPrompt: () => vscode.l10n.t('Paste a netcrux:// link, or the same link in its vscode:// form.'),
};

/**
 * The sentence for a placement that needs one, or `undefined`. A cell or net
 * the netlist does not have is said in the desktop app's words
 * (`linkCellNotFound`, `linkNetNotFound`), as is a netlist that did not load
 * (`linkRefusedLoadFailed`).
 */
export function placementMessage(
  placement: NetCruxPlacement,
  fileName: string,
  link: { readonly kind?: 'cell' | 'net'; readonly name?: string },
): string | undefined {
  const name = link.name ?? '';
  switch (placement.kind) {
    case 'opened':
    case 'line':
    case 'selected':
      return undefined;
    case 'not-placed':
      return vscode.l10n.t(
        'Opened {0}, but the netlist index (.stems) in this workspace does not place {1} in it.',
        fileName,
        name,
      );
    case 'element-not-found':
      return link.kind === 'net'
        ? vscode.l10n.t('Opened {0}, but it has no net named {1}.', fileName, name)
        : vscode.l10n.t('Opened {0}, but it has no cell named {1}.', fileName, name);
    case 'load-failed':
      return vscode.l10n.t('NetCrux could not read {0}. The tab shows why.', fileName);
    case 'not-answered':
      return vscode.l10n.t('Opened {0}, but the schematic preview did not select {1}.', fileName, name);
  }
}

/** Register the handler, the command and the terminal links. */
export function registerNetCruxLinks(options: {
  readonly context: vscode.ExtensionContext;
  readonly locator: NetCruxNameLocator;
  readonly panels: NetlistPanelRegistry;
  readonly log: (line: string) => void;
}): void {
  const { context, locator, panels, log } = options;
  links.registerCruxLinks<NetCruxLink>({
    context,
    scheme: NETCRUX_LINK_SCHEME,
    extensionId: editor.cruxExtensionId('netcrux'),
    command: OPEN_LINK_COMMAND,
    parse: (raw) => parseNetCruxLink(raw),
    vet: (file) => vetNetCruxLinkTarget(file),
    strings: netCruxLinkStrings,
    log,
    open: async (path, link) => {
      const uri = vscode.Uri.file(path);
      let textEditor: vscode.TextEditor | undefined;
      let placement: NetCruxPlacement;
      if (isNetlistPath(path)) {
        // Focuses the preview when the netlist is open in it already; never a
        // second one. The preview is asked to select once it has loaded.
        await vscode.commands.executeCommand('vscode.openWith', uri, NETLIST_VIEW_TYPE, { preview: false });
        const panel = link.name === undefined ? undefined : await panels.waitFor(netlistPanelKey(uri.fsPath));
        placement = await placeNetCruxLinkInPreview(link, panel);
      } else {
        textEditor = await vscode.window.showTextDocument(uri, { preview: false });
        placement = await placeNetCruxLink(link, path, locator);
      }
      log(`   link: ${placement.kind}${placement.kind === 'selected' && placement.coneView ? ' (cone view)' : ''}`);
      if (placement.kind === 'line' && textEditor !== undefined) {
        const position = new vscode.Position(placement.line - 1, 0);
        textEditor.selection = new vscode.Selection(position, position);
        textEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        return;
      }
      const message = placementMessage(placement, uri.path.split('/').pop() ?? path, link);
      if (message === undefined) return;
      if (placement.kind === 'load-failed') {
        void vscode.window.showErrorMessage(message);
      } else {
        void vscode.window.showInformationMessage(message);
      }
    },
  });
}
