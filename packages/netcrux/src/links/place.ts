/**
 * Where a NetCrux link's cell or net is, in the file it opened.
 *
 * The desktop app elaborates the design and selects the element in its
 * schematic. Inside the editor there is no elaboration: an HDL source opens as
 * text, and the line that declares the element is found through the netlist
 * index (`.stems`) the "What drives this?" command already reads. The answer
 * is used only when the index places the element **in the file the link
 * opened**; an element the index puts in another file, or does not know, is
 * said, never guessed at. A Yosys JSON netlist opens in the schematic
 * preview, which has no way to be told to select an element.
 *
 * No `vscode` import: tested directly.
 */
import { links } from '@crux-vscode/host-core';

/** What a link did once its file was open. */
export type NetCruxPlacement =
  /** The link names no element: the file is open, which is all it asked. */
  | { readonly kind: 'opened' }
  /** The element's declaration is at [line] (1-based) of the opened source. */
  | { readonly kind: 'line'; readonly line: number }
  /** The index does not place the element in this file. */
  | { readonly kind: 'not-placed' }
  /** A netlist in the schematic preview, which cannot select from a link. */
  | { readonly kind: 'preview-cannot-select' };

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
 * Place [link]'s element in [openedPath]. [sameFile] compares two paths by
 * file identity (defaults to host-core's link path key).
 */
export async function placeNetCruxLink(
  link: { readonly name?: string },
  openedPath: string,
  locator: NetCruxNameLocator,
  sameFile: (a: string, b: string) => Promise<boolean> = async (a, b) =>
    (await links.linkPathKey(a)) === (await links.linkPathKey(b)),
): Promise<NetCruxPlacement> {
  if (link.name === undefined) return { kind: 'opened' };
  if (isNetlistPath(openedPath)) return { kind: 'preview-cannot-select' };
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
