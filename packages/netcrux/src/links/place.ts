/**
 * Where a NetCrux link's cell or net is, in the file it opened.
 *
 * The desktop app elaborates the design and selects the element in its
 * schematic. Inside the editor there are two cases:
 *
 * - **A Yosys JSON netlist** opens in the schematic preview, which runs the
 *   NetCrux viewer. Once the preview reports the netlist loaded, it is sent a
 *   `select` frame with the link's cell or net, and the viewer finds it by
 *   the desktop app's own rules (the name rooted at the top or written from
 *   just below it), selects and frames it, and says whether it found it.
 * - **An HDL source** opens as text. There is no elaboration, so the line
 *   that declares the element is found through the netlist index (`.stems`)
 *   the "What drives this?" command already reads. The answer is used only
 *   when the index places the element **in the file the link opened**; an
 *   element the index puts in another file, or does not know, is said, never
 *   guessed at.
 *
 * No `vscode` import: tested directly.
 */
import { links } from '@crux-vscode/host-core';
import { LINK_LOAD_TIMEOUT_MS, type NetlistLinkPanel } from './netlist-panels';

/** What a link did once its file was open. */
export type NetCruxPlacement =
  /** The link names no element: the file is open, which is all it asked. */
  | { readonly kind: 'opened' }
  /** The element's declaration is at [line] (1-based) of the opened source. */
  | { readonly kind: 'line'; readonly line: number }
  /** The index does not place the element in this source. */
  | { readonly kind: 'not-placed' }
  /** The preview selected and framed the element; in a Cone View when [coneView]. */
  | { readonly kind: 'selected'; readonly coneView: boolean }
  /** The netlist has no such cell or net (or does not draw it). */
  | { readonly kind: 'element-not-found' }
  /** The preview could not show the netlist; its tab says why. */
  | { readonly kind: 'load-failed' }
  /** No preview, no load, or no answer in time. */
  | { readonly kind: 'not-answered' };

/** The index's answer for a name, as `names.NameResolver.sourceLocationFor` gives it. */
export interface NetCruxNameLocator {
  sourceLocationFor(path: string): Promise<{
    readonly ok: boolean;
    readonly fsPath?: string;
    readonly lineNumber?: number;
  }>;
}

/** Whether [path] is a netlist (opened in the preview) rather than an HDL source. */
export function isNetlistPath(path: string): boolean {
  return path.toLowerCase().endsWith('.json');
}

/**
 * Select [link]'s element in [panel], the schematic preview its netlist opened
 * in (`undefined` when that preview never appeared), once the netlist has
 * loaded.
 */
export async function placeNetCruxLinkInPreview(
  link: { readonly kind?: 'cell' | 'net'; readonly name?: string },
  panel: NetlistLinkPanel | undefined,
  timeoutMs: number = LINK_LOAD_TIMEOUT_MS,
): Promise<NetCruxPlacement> {
  if (link.kind === undefined || link.name === undefined) return { kind: 'opened' };
  if (panel === undefined) return { kind: 'not-answered' };
  const load = await panel.load.wait(timeoutMs);
  if (load === 'failed') return { kind: 'load-failed' };
  if (load !== 'loaded') return { kind: 'not-answered' };
  const answer = await panel.selector.select({ element: link.kind, name: link.name }, timeoutMs);
  switch (answer.outcome) {
    case 'selected':
      return { kind: 'selected', coneView: answer.coneView };
    case 'not-found':
      return { kind: 'element-not-found' };
    case 'no-design':
      return { kind: 'load-failed' };
    case 'unavailable':
      return { kind: 'not-answered' };
  }
}

/**
 * Place [link]'s element in [openedPath], an HDL source. [sameFile] compares
 * two paths by file identity (defaults to host-core's link path key).
 */
export async function placeNetCruxLink(
  link: { readonly name?: string },
  openedPath: string,
  locator: NetCruxNameLocator,
  sameFile: (a: string, b: string) => Promise<boolean> = async (a, b) =>
    (await links.linkPathKey(a)) === (await links.linkPathKey(b)),
): Promise<NetCruxPlacement> {
  if (link.name === undefined) return { kind: 'opened' };
  // A netlist is placed by its preview (`placeNetCruxLinkInPreview`); the
  // index places names in sources only.
  if (isNetlistPath(openedPath)) return { kind: 'not-placed' };
  let location: Awaited<ReturnType<NetCruxNameLocator['sourceLocationFor']>>;
  try {
    location = await locator.sourceLocationFor(link.name);
  } catch {
    return { kind: 'not-placed' };
  }
  if (!location.ok || location.fsPath === undefined || location.lineNumber === undefined) {
    return { kind: 'not-placed' };
  }
  if (!Number.isInteger(location.lineNumber) || location.lineNumber < 1) return { kind: 'not-placed' };
  if (!(await sameFile(location.fsPath, openedPath))) return { kind: 'not-placed' };
  return { kind: 'line', line: location.lineNumber };
}
