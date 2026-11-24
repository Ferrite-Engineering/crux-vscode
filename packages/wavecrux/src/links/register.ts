/**
 * `wavecrux://` links, and `vscode://ferrite-engineering.wavecrux/open?…`,
 * opened in this window's waveform editor.
 *
 * The flow (parse, file check, confirmation, open) is host-core's
 * (`links/flow.ts`); this file is WaveCrux's half: its parser and file kinds,
 * its sentences, and what "place what the link names" means here, which is
 * the waveform tab's own `request_highlight` (`waveform-panels.ts`).
 */
import * as vscode from 'vscode';
import { editor, links } from '@crux-vscode/host-core';
import { WAVEFORM_VIEW_TYPE } from '../formats';
import { parseWaveCruxLink, vetWaveCruxLinkTarget, WAVECRUX_LINK_SCHEME, type WaveCruxLink } from './wavecrux-link';
import {
  placeWaveCruxLink,
  waveformPanelKey,
  type WaveformPanelRegistry,
  type WaveformPlacement,
} from './waveform-panels';

/** The Open Link command. */
export const OPEN_LINK_COMMAND = 'wavecrux.openLink';

/** Every sentence a link can show. */
export const waveCruxLinkStrings: links.CruxLinkStrings = {
  confirmTitle: () => vscode.l10n.t('Open a waveform from a link?'),
  confirmBody: (fileName) =>
    vscode.l10n.t(
      'A link asks WaveCrux to open {0}, which is not open in this window. Open it only if you trust where the link came from.',
      fileName,
    ),
  confirmPathLabel: () => vscode.l10n.t('Full path'),
  confirmOpen: () => vscode.l10n.t('Open'),
  refusedInvalid: () => vscode.l10n.t('WaveCrux did not open the link because it is not a valid WaveCrux link.'),
  refusedPath: () =>
    vscode.l10n.t('WaveCrux did not open the link because the file is not given as a full local path.'),
  refusedWrongKind: (fileName) =>
    vscode.l10n.t(
      'WaveCrux did not open the link because {0} is not a waveform file a link can open.',
      fileName,
    ),
  refusedNotFound: (fileName) =>
    vscode.l10n.t('WaveCrux did not open the link because {0} was not found.', fileName),
  terminalLinkTooltip: () => vscode.l10n.t('Open the link in WaveCrux'),
  inputPrompt: () => vscode.l10n.t('Paste a wavecrux:// link, or the same link in its vscode:// form.'),
};

/** The sentence for a placement that needs one, or `undefined`. */
export function placementMessage(
  placement: WaveformPlacement,
  fileName: string,
  signal: string | undefined,
): string | undefined {
  switch (placement.kind) {
    case 'opened':
    case 'selected':
      return undefined;
    case 'time-not-exact':
      return vscode.l10n.t(
        'Opened {0}, but the cursor is not at the time the link gives. The WaveCrux output says why.',
        fileName,
      );
    case 'signal-not-found':
      return vscode.l10n.t('Opened {0}, but it has no signal named {1}.', fileName, signal ?? '');
    case 'time-needs-signal':
      return vscode.l10n.t(
        'Opened {0}. In the editor panel a link places the cursor only when it also names a signal.',
        fileName,
      );
    case 'load-failed':
      return vscode.l10n.t('WaveCrux could not read {0}. The tab shows why.', fileName);
    case 'not-answered':
      return vscode.l10n.t('Opened {0}, but the waveform panel did not select {1}.', fileName, signal ?? '');
  }
}

/** Register the handler, the command and the terminal links. */
export function registerWaveCruxLinks(options: {
  readonly context: vscode.ExtensionContext;
  readonly panels: WaveformPanelRegistry;
  readonly log: (line: string) => void;
}): void {
  const { context, panels, log } = options;
  links.registerCruxLinks<WaveCruxLink>({
    context,
    scheme: WAVECRUX_LINK_SCHEME,
    extensionId: editor.cruxExtensionId('wavecrux'),
    command: OPEN_LINK_COMMAND,
    parse: parseWaveCruxLink,
    vet: (file) => vetWaveCruxLinkTarget(file),
    strings: waveCruxLinkStrings,
    log,
    open: async (path, link) => {
      const uri = vscode.Uri.file(path);
      // Focuses the tab when the file is open already; never a second one.
      await vscode.commands.executeCommand('vscode.openWith', uri, WAVEFORM_VIEW_TYPE, { preview: false });
      const panel = link.signal === undefined ? undefined : await panels.waitFor(waveformPanelKey(uri.fsPath));
      const placement = await placeWaveCruxLink(link, panel);
      log(`   link: ${placement.kind}${placement.kind === 'time-not-exact' ? ` (${placement.detail})` : ''}`);
      const message = placementMessage(placement, uri.path.split('/').pop() ?? path, link.signal);
      if (message === undefined) return;
      if (placement.kind === 'load-failed') {
        void vscode.window.showErrorMessage(message);
      } else {
        void vscode.window.showInformationMessage(message);
      }
    },
  });
}
