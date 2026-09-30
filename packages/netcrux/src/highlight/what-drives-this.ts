/**
 * "What drives this?" — NetCrux's one gesture.
 *
 * The motivating workflow: *right-click a register, ask what drives this,
 * and follow the cone of influence back.*
 * Right-clicking that register in the Verilog source is where the engineer
 * already is, so this module is the whole of what the command does: resolve
 * the identifier through host-core's stems index (asking when it is
 * ambiguous, never guessing), find a running NetCrux peer,
 * and send it `request_highlight`.
 *
 * The no-peer branch needs something the other three products' handoffs do
 * not have: NetCrux Desktop **is** the outcome here (sending the user to it
 * is the outcome, not a consolation prize),
 * so absence gets an *offer*, not only a pitch — launch it if it is
 * installed, and only fall back to the install boundary when it genuinely
 * is not.
 *
 * Every dependency is injected — network I/O, the filesystem probe, the
 * quick-pick, the launch — so the whole decision tree (selection → resolve
 * → ambiguity → peer found/missing/installed/not) is exercised without a
 * real socket or an extension host.
 */
import type { cxp, editor } from '@crux-vscode/host-core';
import { NETCRUX_HIGHLIGHT_ELEMENT_KIND } from './element-kind';
import type { SendHighlightResult } from './send-request';
import {
  getNetCruxLabel,
  launchNetCruxLabel,
  launchingNetCruxMessage,
  netCruxAckTimeoutMessage,
  netCruxDeclinedMessage,
  netCruxInstalledOfferLaunchMessage,
  netCruxNotInstalledBoundaryMessage,
  netCruxUnreachableMessage,
  noEditorSelectionMessage,
  pickElementPlaceholder,
} from './strings';

/** What one invocation of "what drives this" did. Test and telemetry observability. */
export type WhatDrivesThisOutcome =
  /** Nothing selected and no word under the caret. */
  | { readonly kind: 'no-selection' }
  /** The stems index has no candidate path for the selection. */
  | { readonly kind: 'no-candidates' }
  /** The user dismissed the element or the launch/boundary quick-pick. */
  | { readonly kind: 'cancelled' }
  /** A peer was found and acked the request. */
  | { readonly kind: 'sent'; readonly path: string; readonly honored: boolean; readonly reason?: string }
  /** A peer was found but never acked within the timeout. */
  | { readonly kind: 'ack-timeout'; readonly path: string }
  /** A peer's manifest was found but the socket could not be reached. */
  | { readonly kind: 'unreachable'; readonly path: string }
  /** No peer; NetCrux is installed locally. [launched] is whether the user asked to launch it. */
  | { readonly kind: 'offered-launch'; readonly launched: boolean }
  /** No peer and NetCrux is not installed. [followed] is whether the install link was taken. */
  | { readonly kind: 'boundary'; readonly followed: boolean };

/** Injected environment for [whatDrivesThis]. */
export interface WhatDrivesThisDeps {
  /** The editor selection right now. Production: `vscodeCurrentSelectionSnapshot(editor)`. */
  readonly currentSelection: () => editor.EditorSelectionSnapshot | undefined;
  /** Identifier resolution. Production: a `names.NameResolver` over the stems index. */
  readonly resolver: editor.ElementPathResolver;
  /** Quick-pick / info-toast surface for element disambiguation. */
  readonly ui: editor.UserInterface;
  /** The live NetCrux peer manifest, if any. Production: `discoverNetCruxPeer(...)`. */
  readonly discoverPeer: () => Promise<cxp.CxpPeerManifest | undefined>;
  /** Dial, send, and await the ack. Production: `sendHighlightToNetCrux(...)`. */
  readonly sendHighlight: (
    manifest: cxp.CxpPeerManifest,
    element: cxp.ElementId,
  ) => Promise<SendHighlightResult>;
  /** Best-effort local install path. Production: `locateNetCruxExecutable(...)`. */
  readonly locateInstalled: () => string | undefined;
  /** Hand [executablePath] to the OS. Production: `vscode.env.openExternal(Uri.file(...))`. */
  readonly launch: (executablePath: string) => Promise<void>;
  /** Open the NetCrux install page. Production: `vscode.env.openExternal(Uri.parse(...))`. */
  readonly openInstallUrl: () => Promise<void>;
  /** Non-modal message with optional buttons; resolves to the chosen label. */
  readonly showMessage: (
    message: string,
    ...actions: readonly string[]
  ) => Promise<string | undefined>;
  /** Diagnostics, so a failed send is visible rather than silent. */
  readonly log: (line: string) => void;
}

/**
 * Resolve the right-clicked register, find NetCrux, and send it.
 *
 * Never throws: every branch — no selection, ambiguous candidates, no peer,
 * a peer that refuses or never answers — resolves to a value, because this
 * runs from a context-menu command where an unhandled rejection is invisible
 * to the user.
 */
export async function whatDrivesThis(deps: WhatDrivesThisDeps): Promise<WhatDrivesThisOutcome> {
  const snapshot = deps.currentSelection();
  if (snapshot === undefined) {
    deps.ui.showInformationMessage(noEditorSelectionMessage());
    return { kind: 'no-selection' };
  }

  const candidates = await deps.resolver.resolve(snapshot);
  if (candidates.length === 0) {
    deps.ui.showInformationMessage(noEditorSelectionMessage());
    return { kind: 'no-candidates' };
  }

  const path = await pickPath(candidates, deps.ui);
  if (path === undefined) return { kind: 'cancelled' };

  const manifest = await deps.discoverPeer();
  if (manifest !== undefined) {
    return await sendTo(manifest, path, deps);
  }

  return await offerNetCruxDesktop(path, deps);
}

/** Path disambiguation: single candidate auto-picks, several ask, never guess. */
async function pickPath(
  candidates: readonly (string | editor.ElementPathChoice)[],
  ui: editor.UserInterface,
): Promise<string | undefined> {
  const [only] = candidates;
  if (candidates.length === 1 && only !== undefined) return pathOf(only);
  const choices = candidates.map((candidate) => {
    const p = pathOf(candidate);
    const description = typeof candidate === 'string' ? undefined : candidate.description;
    return { label: p, ...(description !== undefined ? { description } : {}), path: p };
  });
  const picked = await ui.showQuickPick(choices, pickElementPlaceholder());
  return picked?.path;
}

function pathOf(candidate: string | editor.ElementPathChoice): string {
  return typeof candidate === 'string' ? candidate : candidate.path;
}

/** A peer is present: send and report what its ack said. */
async function sendTo(
  manifest: cxp.CxpPeerManifest,
  path: string,
  deps: WhatDrivesThisDeps,
): Promise<WhatDrivesThisOutcome> {
  const element: cxp.ElementId = { kind: NETCRUX_HIGHLIGHT_ELEMENT_KIND, path };
  const result = await deps.sendHighlight(manifest, element);
  switch (result.kind) {
    case 'acked':
      deps.log(
        `   what drives this: ${path} → NetCrux (${result.honored ? 'honored' : 'declined'})`,
      );
      if (!result.honored) {
        deps.ui.showInformationMessage(netCruxDeclinedMessage(path, result.reason));
      }
      return {
        kind: 'sent',
        path,
        honored: result.honored,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      };
    case 'ack-timeout':
      deps.log(`   what drives this: ${path} → NetCrux (no ack)`);
      deps.ui.showInformationMessage(netCruxAckTimeoutMessage());
      return { kind: 'ack-timeout', path };
    case 'unreachable':
      deps.log(`   what drives this: ${path} → NetCrux unreachable: ${String(result.error)}`);
      deps.ui.showInformationMessage(netCruxUnreachableMessage());
      return { kind: 'unreachable', path };
  }
}

/**
 * No peer is running. Offer to launch NetCrux if it is installed locally;
 * otherwise explain the boundary and offer to install it. Neither message
 * apologises: NetCrux Desktop is the outcome, not a
 * fallback the editor settles for.
 */
async function offerNetCruxDesktop(
  path: string,
  deps: WhatDrivesThisDeps,
): Promise<WhatDrivesThisOutcome> {
  const executablePath = deps.locateInstalled();
  if (executablePath !== undefined) {
    const choice = await deps.showMessage(
      netCruxInstalledOfferLaunchMessage(path),
      launchNetCruxLabel(),
    );
    if (choice !== launchNetCruxLabel()) return { kind: 'offered-launch', launched: false };
    await deps.launch(executablePath);
    deps.log(`   what drives this: launching NetCrux (${executablePath})`);
    deps.ui.showInformationMessage(launchingNetCruxMessage());
    return { kind: 'offered-launch', launched: true };
  }

  const choice = await deps.showMessage(netCruxNotInstalledBoundaryMessage(path), getNetCruxLabel());
  if (choice !== getNetCruxLabel()) return { kind: 'boundary', followed: false };
  await deps.openInstallUrl();
  return { kind: 'boundary', followed: true };
}
