/**
 * Recognising a Yosys JSON netlist by what is in the file, not by its name.
 *
 * Every netlist is a `.json`, and so is almost everything else a project
 * keeps. The preview is therefore never the default editor for `.json`: it is
 * offered through "Open With..." and a command, and this module is what lets
 * the command (and the context key behind the editor-title button) say no to a
 * file that is not a netlist instead of opening a schematic viewer onto a
 * package manifest.
 *
 * Only the start of the file is read. A netlist can be gigabytes, and what
 * identifies one sits in its first few kilobytes: `write_json` opens with a
 * `creator` string and the `modules` object, and a module's `ports`, `cells`
 * and `netnames` follow its (usually short) attributes.
 */

/** How many bytes of the file's start are read to decide. */
export const NETLIST_SNIFF_BYTES = 256 * 1024;

/** `"modules": { "<name>": {` : the shape that makes a netlist. */
const MODULES_OBJECT = /"modules"\s*:\s*\{\s*"(?:[^"\\]|\\.)*"\s*:\s*\{/;

/** A key only a module of a netlist carries. */
const MODULE_MEMBER = /"(?:ports|cells|netnames)"\s*:\s*\{/;

/** `write_json` and the tools that follow its format name themselves first. */
const CREATOR_YOSYS = /^\s*\{\s*"creator"\s*:\s*"[^"]*yosys/i;

/** An empty `modules` object: legal, and what `write_json` writes for an empty design. */
const EMPTY_MODULES = /"modules"\s*:\s*\{\s*\}/;

/**
 * Whether [head], the start of a file, is the start of a Yosys JSON netlist.
 *
 * Deliberately conservative: a false negative costs the user one "Open With..."
 * (which does not look at content at all), while a false positive puts a
 * schematic-viewer button on a file that is not a design.
 */
export function looksLikeYosysNetlist(head: string): boolean {
  const text = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head;
  if (!/^\s*\{/.test(text)) return false;
  if (MODULES_OBJECT.test(text) && MODULE_MEMBER.test(text)) return true;
  // A netlist whose first module is large enough that its members start past
  // the sniffed window, or an empty design: the creator line settles it.
  if (CREATOR_YOSYS.test(text) && (MODULES_OBJECT.test(text) || EMPTY_MODULES.test(text))) {
    return true;
  }
  return false;
}
