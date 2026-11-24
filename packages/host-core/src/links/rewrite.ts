/**
 * One link per place: the editor form is rewritten to the desktop form before
 * anything reads it.
 *
 * Documents carry the desktop link (`wavecrux://open?…`, `netcrux://open?…`).
 * The editor form, `vscode://ferrite-engineering.<product>/open?…`, takes the
 * same query, so an editor can be pointed at the same place without a second
 * link being written anywhere. Every way a link reaches an extension (the URI
 * handler, the Open Link command, a terminal link) is turned into the desktop
 * form here and then parsed by the product's one parser, so there is one
 * grammar and one set of refusals for all of them.
 *
 * ### What VS Code does to the query on the way in
 *
 * A `vscode://` link that arrives from the operating system or from a click in
 * the workbench is parsed by VS Code's `URI.parse`, which percent-decodes every
 * component once: the handler sees `file=/work/dump.vcd`, not
 * `file=%2Fwork%2Fdump.vcd`. [desktopLinkFromEditorUri] re-encodes each value
 * with the link encoder, which gives back the link the sender wrote. Two
 * spellings cannot survive that decoding and are refused rather than guessed:
 * a value that still holds `%XX` (VS Code leaves an escape it cannot decode in
 * place, so the handler cannot tell it from a file name holding those three
 * characters), and anything the decoded `&` or `#` splits differently, which
 * the parser then refuses as malformed or as an unknown key.
 */
import { encodeLinkValue } from './grammar';

/** The parts of a `vscode.Uri` the rewrite reads, as VS Code delivers them. */
export interface EditorLinkUri {
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}

/** The outcome of a rewrite: the desktop link, or why there is none. */
export type DesktopLinkRewrite =
  | { readonly ok: true; readonly link: string }
  | { readonly ok: false; readonly refusal: 'malformed' | 'bad-encoding' | 'wrong-scheme' };

/** A `%` and two hex digits: an escape VS Code did not decode. */
const LEFTOVER_ESCAPE = /%[0-9A-Fa-f]{2}/;

/**
 * The desktop link of [scheme] that a URI handler's [uri] stands for.
 *
 * The path must be `/open` (any case, optionally with a trailing `/`), as the
 * desktop link's authority must be `open`; a fragment is refused, as the
 * desktop parser refuses `#`. Keys are carried through as they are, so an
 * unknown or repeated key is refused by the parser with its own reason.
 */
export function desktopLinkFromEditorUri(uri: EditorLinkUri, scheme: string): DesktopLinkRewrite {
  const path = uri.path.toLowerCase();
  if (path !== '/open' && path !== '/open/') return { ok: false, refusal: 'malformed' };
  if (uri.fragment.length > 0) return { ok: false, refusal: 'malformed' };
  if (uri.query.length === 0) return { ok: true, link: `${scheme}://open` };
  const pairs: string[] = [];
  for (const pair of uri.query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      // Left for the parser, which says `malformed` for it.
      pairs.push(pair);
      continue;
    }
    const value = pair.slice(eq + 1);
    if (LEFTOVER_ESCAPE.test(value)) return { ok: false, refusal: 'bad-encoding' };
    pairs.push(`${pair.slice(0, eq)}=${encodeLinkValue(value)}`);
  }
  return { ok: true, link: `${scheme}://open?${pairs.join('&')}` };
}

/**
 * The desktop link a piece of text names, as the user pasted it or a terminal
 * printed it: the desktop link itself, unchanged, or the editor form written
 * out (`vscode://`, `vscode-insiders://`, or a fork's own scheme, followed by
 * [extensionId]), whose query was never decoded and is carried over as it is.
 *
 * `wrong-scheme` when the text is neither.
 */
export function desktopLinkFromText(text: string, scheme: string, extensionId: string): DesktopLinkRewrite {
  const trimmed = text.trim();
  if (trimmed.slice(0, scheme.length + 1).toLowerCase() === `${scheme}:`) return { ok: true, link: trimmed };
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(trimmed);
  if (match === null || (match[1] ?? '').toLowerCase() !== extensionId.toLowerCase()) {
    return { ok: false, refusal: 'wrong-scheme' };
  }
  // Path, query and fragment exactly as written: the desktop parser refuses
  // whatever the desktop form would not accept.
  return {
    ok: true,
    link: `${scheme}://${(match[2] ?? '').replace(/^\//, '')}${match[3] ?? ''}${match[4] ?? ''}`,
  };
}
