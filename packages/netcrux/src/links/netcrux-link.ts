/**
 * `netcrux://open?file=<path>&cell=<name>` (or `&net=<name>`): the parser.
 *
 * The port of NetCrux's `lib/services/links/netcrux_link.dart`: the same keys,
 * bounds and refusals, over host-core's shared link grammar (WaveCrux's, so
 * one convention covers both products). No `vscode` import and no filesystem.
 */
import { links } from '@crux-vscode/host-core';

/** The URL scheme the NetCrux desktop app registers. */
export const NETCRUX_LINK_SCHEME = 'netcrux';

/**
 * The design files a link may open, as the desktop app: Verilog,
 * SystemVerilog and VHDL sources and a Yosys JSON netlist. Never a
 * `.netcrux-project` (it carries Yosys commands), a session, a workspace, a
 * `.crux-project` manifest or a `.f` filelist (they name further files the
 * confirmation never shows).
 */
export const NETCRUX_LINK_EXTENSIONS: ReadonlySet<string> = new Set([
  '.v',
  '.sv',
  '.vh',
  '.svh',
  '.vhd',
  '.vhdl',
  '.json',
]);

/** Why a NetCrux link was refused. */
export type NetCruxLinkRefusal =
  | links.CruxLinkGrammarRefusal
  /** Both `cell` and `net`. One link names one element. */
  | 'cell-and-net'
  /**
   * A `file` that is not absolute as written: `/…`, `\\…`, `C:\…` or `C:/…`.
   * A relative path would be resolved against whatever directory the editor
   * happened to start in, which the sender cannot know.
   */
  | 'relative-path';

/** A parsed link. */
export interface NetCruxLink {
  /** The local path, exactly as decoded. Absolute as text; not yet checked against the filesystem. */
  readonly file: string;
  /** Whether [name] is a cell or a net, when the link names one. */
  readonly kind?: 'cell' | 'net';
  /** The dot-separated hierarchical name, when the link names one. */
  readonly name?: string;
}

const GRAMMAR: links.CruxLinkGrammar = {
  scheme: NETCRUX_LINK_SCHEME,
  keys: {
    file: links.CRUX_LINK_MAX_FILE_LENGTH,
    cell: links.CRUX_LINK_MAX_NAME_LENGTH,
    net: links.CRUX_LINK_MAX_NAME_LENGTH,
  },
};

/**
 * Whether the file a link names may be opened, and which file that is once
 * symbolic links resolve: host-core's `vetLinkTarget` with
 * [NETCRUX_LINK_EXTENSIONS]. [options] exist for tests.
 */
export function vetNetCruxLinkTarget(
  file: string,
  options: Omit<links.LinkTargetOptions, 'extensions'> = {},
): Promise<links.LinkTargetResult> {
  return links.vetLinkTarget(file, { ...options, extensions: NETCRUX_LINK_EXTENSIONS });
}

/**
 * Parses [raw], a link in the desktop form, strictly. Never throws, never
 * touches the filesystem.
 *
 * [isAbsolute] is the absolute-path rule, replaceable only so a test can show
 * that a handler which accepts a relative path is caught.
 */
export function parseNetCruxLink(
  raw: string,
  options: { readonly isAbsolute?: (path: string) => boolean } = {},
): { readonly ok: true; readonly link: NetCruxLink } | { readonly ok: false; readonly refusal: NetCruxLinkRefusal } {
  const query = links.parseCruxLinkQuery(raw, GRAMMAR);
  if (!query.ok) return query;
  const file = query.values.get('file') ?? '';
  if (!(options.isAbsolute ?? links.isAbsolutePathText)(file)) return { ok: false, refusal: 'relative-path' };
  const cell = query.values.get('cell');
  const net = query.values.get('net');
  if (cell !== undefined && net !== undefined) return { ok: false, refusal: 'cell-and-net' };
  if (cell !== undefined) return { ok: true, link: { file, kind: 'cell', name: cell } };
  if (net !== undefined) return { ok: true, link: { file, kind: 'net', name: net } };
  return { ok: true, link: { file } };
}
