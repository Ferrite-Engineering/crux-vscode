/**
 * The capabilities panel's "Open in NetCrux Desktop" handoff
 * (`edacrux.openInDesktop.netcrux`, host-core's `desktopHandoffCommandId`).
 *
 * host-core's panel only ever shows this action once a NetCrux desktop peer
 * is already present (`desktopAdvertisingDecision` — a window with no peer
 * gets an install link instead), so unlike "what drives this" this handoff
 * never needs to offer a launch: presence is its precondition. It exists at
 * all so that button is wired to something rather than a command id nothing
 * registered — `status.registerProductStatusSurface`'s own docs: "better an
 * absent command than a palette entry that errors."
 *
 * ### What it hands over: an HDL design file, as `source`
 *
 * `desktopDetect.openArtifactInDesktop` publishes the file into the shared
 * workspace, sends `request_open_artifact`, and falls back to `openExternal`
 * only when nothing answers. What NetCrux does with that request decides what
 * this module may send, so here is its handler (`CxpInboundHandler` in the
 * NetCrux open core, `lib/services/remote/cxp/cxp_inbound_handler.dart`):
 *
 * - it honours exactly one artifact kind, `source`, and refuses the rest;
 * - it resolves the file through its own copy of the shared workspace,
 *   falling back to the request's `path` hint;
 * - it loads that one file into the active tab's source list, where Yosys
 *   reads it as Verilog, SystemVerilog or VHDL and elaborates it. There is
 *   no artifact kind for a project, and the handler never routes a path
 *   through the app's project-open flow.
 *
 * This used to hand over the first `.netcrux` file in the workspace. In
 * NetCrux that extension is a per-tab **session** export — a project is a
 * `.netcrux-project`, and the suite manifest a `<design>.crux-project` — and
 * either one would have reached Yosys as HDL. So the handoff now sends what
 * the handler opens: an HDL design file ([NETCRUX_DESIGN_EXTENSIONS]).
 *
 * Which one: the file in the active editor when it is one — the design the
 * user is looking at when they click — and otherwise the first the workspace
 * search finds ([pickNetCruxDesignFile]). Headers (`.vh`, `.svh`) are passed
 * over: included text, not a design Yosys can elaborate on its own.
 *
 * ### The contract with the receiver
 *
 * Asserted here by `test/handoff.test.ts` and on the NetCrux side by
 * `test/services/remote/cxp/cxp_open_artifact_test.dart`:
 *
 * 1. the artifact kind is `source` ([NETCRUX_ARTIFACT_KIND]);
 * 2. the path is absolute, carries no NUL, and is spelled exactly as it is
 *    on disk — no surrounding white space. That is the floor NetCrux holds
 *    this request to, and the only rule: it is not rooted in the directories
 *    NetCrux has opened, so a design NetCrux has never seen is honoured;
 * 3. the path names an existing file NetCrux can read as HDL.
 *
 * ### What one file cannot carry
 *
 * The request names one artifact and NetCrux loads just that file, with no
 * library search: a top module that instantiates modules from other files
 * fails to elaborate. A leaf module, or a design kept in one file, opens.
 * Handing over a whole design needs an artifact kind for a project on the
 * NetCrux side, which does not exist yet; this module does not invent one.
 *
 * NetCrux's *live send* in `highlight/send-request.ts` remains a separate
 * path for a separate gesture — that one carries an element, not an
 * artifact — but the two share one dial-and-await implementation
 * (`cxp.sendOneShotRequest`).
 */
import * as vscode from 'vscode';
import type { desktopDetect } from '@crux-vscode/host-core';

/**
 * The artifact kind NetCrux hands over: `source`, the one kind its
 * `request_open_artifact` handler accepts, and what `publishDesignSourceArtifact`
 * writes as `kCxpSourceArtifactKind`.
 */
export const NETCRUX_ARTIFACT_KIND = 'source';

/**
 * The HDL design files NetCrux can load from a `source` artifact: Verilog,
 * SystemVerilog and VHDL sources, lowercase and with the dot. NetCrux's own
 * source picker also accepts the `.vh` / `.svh` headers, which are left out
 * here because a header alone is not a design.
 */
export const NETCRUX_DESIGN_EXTENSIONS: readonly string[] = ['.v', '.sv', '.vhd', '.vhdl'];

/** The workspace search for a design file, matching [NETCRUX_DESIGN_EXTENSIONS]. */
export const NETCRUX_DESIGN_GLOB = '**/*.{v,sv,vhd,vhdl}';

/** Whether [fsPath] is an HDL design file NetCrux can load as a `source` artifact. */
export function isNetCruxDesignFile(fsPath: string): boolean {
  const lower = fsPath.toLowerCase();
  return NETCRUX_DESIGN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/**
 * The design file to hand over: [activeFile] when it is one, otherwise
 * whatever [searchWorkspace] finds.
 *
 * [activeFile] is the active editor's path when that editor shows a file on
 * disk, and `undefined` otherwise (no editor, an untitled buffer, a remote
 * scheme NetCrux cannot read). The search result is checked too, so a glob
 * that drifts from [NETCRUX_DESIGN_EXTENSIONS] cannot put a session file
 * back on the wire.
 */
export async function pickNetCruxDesignFile(
  activeFile: string | undefined,
  searchWorkspace: () => Promise<string | undefined>,
): Promise<string | undefined> {
  if (activeFile !== undefined && isNetCruxDesignFile(activeFile)) return activeFile;
  const found = await searchWorkspace();
  return found !== undefined && isNetCruxDesignFile(found) ? found : undefined;
}

/** What [openDesignInNetCrux] did, for tests and telemetry. */
export type NetCruxDesignHandoffOutcome =
  /** The design file was handed over. [handoff] records over CXP vs. via the OS. */
  | {
      readonly kind: 'handed-off';
      readonly designFile: string;
      readonly handoff: desktopDetect.ArtifactHandoffOutcome;
    }
  /** No Verilog, SystemVerilog or VHDL design file is in the open workspace. */
  | { readonly kind: 'no-design' };

/** Injected environment for [openDesignInNetCrux]. */
export interface NetCruxDesignHandoffDeps {
  /**
   * Absolute path of the design file to hand over, if there is one.
   * Production: [pickNetCruxDesignFile] over the active editor and a
   * workspace search.
   */
  readonly designFile: () => Promise<string | undefined>;
  /**
   * Hand the file to the running desktop peer. Production:
   * `desktopDetect.createVscodeArtifactHandoff({ artifactKind: 'source', … })`.
   */
  readonly handOff: (fsPath: string) => Promise<desktopDetect.ArtifactHandoffOutcome>;
  /** Non-modal message. */
  readonly showMessage: (message: string) => void;
}

/** Shown when the panel's handoff is clicked but there is no design file to hand it. */
export function noNetCruxDesignMessage(): string {
  return vscode.l10n.t(
    'NetCrux Desktop is running, but this workspace has no Verilog, SystemVerilog or VHDL file for it to open. Open the design file you want in an editor and try again.',
  );
}

/** Hand the design file to the already-running desktop peer. */
export async function openDesignInNetCrux(
  deps: NetCruxDesignHandoffDeps,
): Promise<NetCruxDesignHandoffOutcome> {
  const designFile = await deps.designFile();
  if (designFile === undefined) {
    deps.showMessage(noNetCruxDesignMessage());
    return { kind: 'no-design' };
  }
  const handoff = await deps.handOff(designFile);
  return { kind: 'handed-off', designFile, handoff };
}
