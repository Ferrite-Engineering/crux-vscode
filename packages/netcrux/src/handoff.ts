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
 * ### What it hands over, and as which artifact kind
 *
 * CXP 1.3 §9.10.2 (Working Draft rev. 9) registers two kinds for a design,
 * and NetCrux's `request_open_artifact` handler
 * (`CxpInboundHandler` in the NetCrux open core,
 * `lib/services/remote/cxp/cxp_inbound_handler.dart`) opens both:
 *
 * - **`project`**: the design's project definition in NetCrux's own format,
 *   a `.netcrux-project` or a `<design>.crux-project` manifest. NetCrux opens
 *   it through the same loader as Open Project, so a multi-file design arrives
 *   with its source list, top module and elaboration settings. This is what is
 *   sent whenever the workspace has one.
 * - **`source`**: one HDL file, and nothing else. The fallback when the
 *   workspace has no project file. NetCrux loads that single file with no
 *   library search, so a top module that instantiates modules from other
 *   files will not elaborate from it; a leaf module or a design kept in one
 *   file opens.
 *
 * A project file is never sent as `source` (it would be parsed as HDL and
 * fail), and an HDL file is never sent as `project`. A `.netcrux` file is a
 * per-tab **session** export in NetCrux, neither kind, and is never sent.
 *
 * ### Which file
 *
 * 1. A project file: the one in the active editor when it is one, otherwise
 *    the workspace's closest ([pickNetCruxProjectFile]).
 * 2. Otherwise an HDL design file ([NETCRUX_DESIGN_EXTENSIONS]): the active
 *    editor's when it is one, otherwise the first the workspace search finds
 *    ([pickNetCruxDesignFile]). Headers (`.vh`, `.svh`) are passed over:
 *    included text, not a design Yosys can elaborate on its own.
 *
 * ### The path rules
 *
 * A project names other files by relative path, so a project file outside
 * the workspace would make the receiver read a tree the user never opened
 * here. Every project path therefore goes through `resolveInWorkspace`
 * (production: host-core's `editor.resolveWorkspacePath`, CXP §11.3's
 * containment tier: symlinks resolved, `..` interpreted by the filesystem, a
 * missing file judged by its deepest existing ancestor, whole path
 * components compared) and what is sent is the **real path that check
 * returned**, never another spelling of it. A project file that fails it is
 * not sent, and the handoff falls back to `source`, never to the OS.
 *
 * The path is absolute, carries no NUL and no surrounding white space (the
 * §11.3 floor, which `resolveWorkspacePath` yields for any path it admits).
 *
 * ### The no-answer fallback
 *
 * When a NetCrux peer is present but does not answer, host-core hands the
 * file to the OS. A project file is a file NetCrux owns (`.netcrux-project`,
 * `.crux-project`), so that fallback reaches NetCrux again, which a `.v`
 * handed to the OS never did.
 *
 * NetCrux's *live send* in `highlight/send-request.ts` remains a separate
 * path for a separate gesture — that one carries an element, not an
 * artifact — but the two share one dial-and-await implementation
 * (`cxp.sendOneShotRequest`).
 */
import * as vscode from 'vscode';
import type { desktopDetect } from '@crux-vscode/host-core';

/** `source`: one HDL file, and nothing else (CXP §9.10.2). */
export const NETCRUX_SOURCE_ARTIFACT_KIND = 'source';

/** `project`: the design's project definition in NetCrux's own format (CXP §9.10.2). */
export const NETCRUX_PROJECT_ARTIFACT_KIND = 'project';

/**
 * The kind of a single-file design handoff, kept under its earlier name.
 * See [NETCRUX_SOURCE_ARTIFACT_KIND].
 */
export const NETCRUX_ARTIFACT_KIND = NETCRUX_SOURCE_ARTIFACT_KIND;

/** The two kinds this handoff sends. */
export type NetCruxArtifactKind =
  | typeof NETCRUX_SOURCE_ARTIFACT_KIND
  | typeof NETCRUX_PROJECT_ARTIFACT_KIND;

/**
 * The HDL design files NetCrux can load from a `source` artifact: Verilog,
 * SystemVerilog and VHDL sources, lowercase and with the dot. NetCrux's own
 * source picker also accepts the `.vh` / `.svh` headers, which are left out
 * here because a header alone is not a design.
 */
export const NETCRUX_DESIGN_EXTENSIONS: readonly string[] = ['.v', '.sv', '.vhd', '.vhdl'];

/** The workspace search for a design file, matching [NETCRUX_DESIGN_EXTENSIONS]. */
export const NETCRUX_DESIGN_GLOB = '**/*.{v,sv,vhd,vhdl}';

/**
 * The project files NetCrux reads as a `project` artifact: its own
 * `.netcrux-project` and the suite's `<design>.crux-project` manifest.
 * NetCrux also reads a `.f` filelist as a project; that extension is too
 * common to claim for the design, so a filelist is not offered here.
 */
export const NETCRUX_PROJECT_EXTENSIONS: readonly string[] = ['.netcrux-project', '.crux-project'];

/** The workspace search for a project file, matching [NETCRUX_PROJECT_EXTENSIONS]. */
export const NETCRUX_PROJECT_GLOB = '**/*.{netcrux-project,crux-project}';

/** Whether [fsPath] is an HDL design file NetCrux can load as a `source` artifact. */
export function isNetCruxDesignFile(fsPath: string): boolean {
  const lower = fsPath.toLowerCase();
  return NETCRUX_DESIGN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Whether [fsPath] is a project file NetCrux can open as a `project` artifact. */
export function isNetCruxProjectFile(fsPath: string): boolean {
  const lower = fsPath.toLowerCase();
  return NETCRUX_PROJECT_EXTENSIONS.some((extension) => lower.endsWith(extension));
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

/** Directory of [fsPath], with its separator, for a whole-component prefix test. */
function directoryPrefix(fsPath: string): string {
  const cut = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'));
  return cut < 0 ? '' : fsPath.slice(0, cut + 1);
}

/**
 * The project file to hand over, as the real path of a file inside the
 * workspace, or `undefined` when there is none.
 *
 * [activeFile] wins when it is a project file. Otherwise the candidates
 * [searchWorkspace] returns are ordered so the answer does not depend on the
 * search's own order: a project in a directory that holds the active file
 * first (the deepest such directory), then the shallowest path, then
 * alphabetical. Every candidate must pass [resolveInWorkspace], which
 * returns the real path to send or `undefined` to refuse; a refused one is
 * skipped, never sent.
 */
export async function pickNetCruxProjectFile(
  activeFile: string | undefined,
  searchWorkspace: () => Promise<readonly string[]>,
  resolveInWorkspace: (fsPath: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (activeFile !== undefined && isNetCruxProjectFile(activeFile)) {
    const resolved = await resolveInWorkspace(activeFile);
    if (resolved !== undefined) return resolved;
  }
  const found = (await searchWorkspace()).filter(isNetCruxProjectFile);
  const near = (candidate: string): number =>
    activeFile !== undefined && activeFile.startsWith(directoryPrefix(candidate))
      ? directoryPrefix(candidate).length
      : -1;
  const ordered = [...found].sort(
    (a, b) =>
      near(b) - near(a) ||
      a.split(/[\\/]/).length - b.split(/[\\/]/).length ||
      (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const candidate of ordered) {
    const resolved = await resolveInWorkspace(candidate);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** What to hand NetCrux: the artifact kind and the absolute path it names. */
export interface NetCruxHandoffTarget {
  readonly kind: NetCruxArtifactKind;
  readonly path: string;
}

/** Where [pickNetCruxHandoffTarget] looks. */
export interface NetCruxHandoffSources {
  /** The active editor's file on disk, if any. */
  readonly activeFile: string | undefined;
  /** Project files the workspace holds. */
  readonly searchProjects: () => Promise<readonly string[]>;
  /** An HDL design file the workspace holds. */
  readonly searchDesign: () => Promise<string | undefined>;
  /**
   * The real path to send for [fsPath], when it lies inside an open
   * workspace folder; `undefined` otherwise. Production:
   * `hostCore.editor.resolveWorkspacePath`.
   */
  readonly resolveInWorkspace: (fsPath: string) => Promise<string | undefined>;
}

/**
 * A `project` artifact when the workspace has a NetCrux project file inside
 * it, else a `source` artifact for one HDL file, else nothing.
 */
export async function pickNetCruxHandoffTarget(
  sources: NetCruxHandoffSources,
): Promise<NetCruxHandoffTarget | undefined> {
  const project = await pickNetCruxProjectFile(
    sources.activeFile,
    sources.searchProjects,
    sources.resolveInWorkspace,
  );
  if (project !== undefined) return { kind: NETCRUX_PROJECT_ARTIFACT_KIND, path: project };
  const design = await pickNetCruxDesignFile(sources.activeFile, sources.searchDesign);
  return design === undefined ? undefined : { kind: NETCRUX_SOURCE_ARTIFACT_KIND, path: design };
}

/** What [openDesignInNetCrux] did, for tests and telemetry. */
export type NetCruxDesignHandoffOutcome =
  /** The file was handed over. [handoff] records over CXP vs. via the OS. */
  | {
      readonly kind: 'handed-off';
      readonly artifactKind: NetCruxArtifactKind;
      readonly designFile: string;
      readonly handoff: desktopDetect.ArtifactHandoffOutcome;
    }
  /** No project file and no Verilog, SystemVerilog or VHDL design file is in the open workspace. */
  | { readonly kind: 'no-design' };

/** Injected environment for [openDesignInNetCrux]. */
export interface NetCruxDesignHandoffDeps {
  /**
   * What to hand over, if there is anything. Production:
   * [pickNetCruxHandoffTarget] over the active editor and workspace searches.
   */
  readonly target: () => Promise<NetCruxHandoffTarget | undefined>;
  /**
   * Hand the file to the running desktop peer as [kind]. Production:
   * `desktopDetect.createVscodeArtifactHandoff({ artifactKind: kind, … })`.
   */
  readonly handOff: (
    kind: NetCruxArtifactKind,
    fsPath: string,
  ) => Promise<desktopDetect.ArtifactHandoffOutcome>;
  /** Non-modal message. */
  readonly showMessage: (message: string) => void;
}

/** Shown when the panel's handoff is clicked but there is nothing to hand it. */
export function noNetCruxDesignMessage(): string {
  return vscode.l10n.t(
    'NetCrux Desktop is running, but this workspace has no Verilog, SystemVerilog or VHDL file for it to open. Open the design file you want in an editor and try again.',
  );
}

/** Hand the project, or failing that the design file, to the already-running desktop peer. */
export async function openDesignInNetCrux(
  deps: NetCruxDesignHandoffDeps,
): Promise<NetCruxDesignHandoffOutcome> {
  const target = await deps.target();
  if (target === undefined) {
    deps.showMessage(noNetCruxDesignMessage());
    return { kind: 'no-design' };
  }
  const handoff = await deps.handOff(target.kind, target.path);
  return { kind: 'handed-off', artifactKind: target.kind, designFile: target.path, handoff };
}
