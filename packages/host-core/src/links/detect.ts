/**
 * Finding links in a line of terminal output.
 *
 * VS Code's own link detection knows `http`, `https` and `file` only, so a
 * `wavecrux://` link printed by a command line, a CI log or a coding agent in
 * the terminal is plain text until a product claims it. This finds the
 * desktop form and the editor form of one product's links; what the click
 * does is the flow's, through the same parser as every other way in.
 *
 * Pure: no `vscode` types, so the matching is tested directly.
 */

/** One link found in a line. */
export interface DetectedCruxLink {
  /** Offset of the link within the line. */
  readonly startIndex: number;
  readonly length: number;
  /** The link as written. */
  readonly text: string;
}

/**
 * Characters that end a link in running text: white space, quotes, brackets
 * and the shell's own delimiters. A link written by a Crux builder holds none
 * of them (every value is percent-encoded), so stopping here never cuts a
 * valid link short.
 */
const LINK_BODY = String.raw`[^\s"'<>\x60()[\]{}|\\^]*`;

/** Punctuation a sentence puts after a link, which is not part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The links of [scheme] in [line], and the editor form for [extensionId]
 * under any editor scheme (`vscode`, `vscode-insiders`, a fork's own).
 * In order, never overlapping.
 */
export function findCruxLinks(line: string, scheme: string, extensionId: string): readonly DetectedCruxLink[] {
  const pattern = new RegExp(
    String.raw`(?<![A-Za-z0-9+.-])(?:${escapeRegExp(scheme)}:\/\/|[A-Za-z][A-Za-z0-9+.-]*:\/\/${escapeRegExp(extensionId)}\/)${LINK_BODY}`,
    'gi',
  );
  const links: DetectedCruxLink[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const text = match[0].replace(TRAILING_PUNCTUATION, '');
    if (text.length === 0) continue;
    links.push({ startIndex: match.index, length: text.length, text });
  }
  return links;
}
