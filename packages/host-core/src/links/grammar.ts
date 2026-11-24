/**
 * The link convention the desktop products open: `<scheme>://open?key=value&…`.
 *
 * WaveCrux reads `wavecrux://open?file=…&signal=…&t=…` and NetCrux reads
 * `netcrux://open?file=…&cell=…` (or `&net=…`). Both desktop parsers share one
 * grammar, one encoding and one set of bounds (WaveCrux's
 * `lib/services/links/wavecrux_link.dart`, NetCrux's
 * `lib/services/links/netcrux_link.dart`), and this file is that grammar,
 * ported refusal for refusal, so a link means the same place in the editor as
 * it does in the desktop app.
 *
 * A link can arrive from anywhere: a chat message, a CI log, a terminal, a
 * coding agent's answer. Everything here treats it as hostile input, and
 * nothing here touches the filesystem: whether the file a link names may be
 * opened is `target.ts`'s question, and whether the user agrees is the flow's.
 */

/** The longest link accepted, in UTF-16 code units, before any decoding. */
export const CRUX_LINK_MAX_LENGTH = 8192;

/** The longest decoded `file` value accepted. */
export const CRUX_LINK_MAX_FILE_LENGTH = 4096;

/** The longest decoded element name (`signal`, `cell`, `net`) accepted. */
export const CRUX_LINK_MAX_NAME_LENGTH = 1024;

/**
 * Why a link was refused before anything was opened, for the refusals every
 * product shares. A product's own parser adds its own (`bad-time`,
 * `relative-path`, `cell-and-net`).
 *
 * The distinctions are for tests and the output channel. The user is told the
 * same sentence for all of them ("not a valid … link"), as the desktop apps
 * do: the sender of a hostile link learns nothing from the difference.
 */
export type CruxLinkGrammarRefusal =
  /** Longer than [CRUX_LINK_MAX_LENGTH], or a value longer than its bound. */
  | 'too-long'
  /** The scheme is not the product's. */
  | 'wrong-scheme'
  /** Not `<scheme>://open?…`: another action, a user name, a port, a path, a fragment. */
  | 'malformed'
  /** A key this build does not know. Refused, not ignored, so a later link fails visibly. */
  | 'unknown-key'
  /** The same key twice. */
  | 'duplicate-key'
  /** No `file`, no query, or an empty value. */
  | 'missing-value'
  /** A broken percent-escape, bytes that are not UTF-8, or a raw non-ASCII character. */
  | 'bad-encoding'
  /** White space, a control or a bidirectional-text control in the link or a value. */
  | 'forbidden-character';

/** What one product's links look like. */
export interface CruxLinkGrammar {
  /** The URL scheme, lower case: `wavecrux`, `netcrux`. */
  readonly scheme: string;
  /** Every key the product reads, with the longest decoded value it accepts. */
  readonly keys: Readonly<Record<string, number>>;
}

/** The outcome of [parseCruxLinkQuery]. */
export type CruxLinkQueryResult =
  | { readonly ok: true; readonly values: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly refusal: CruxLinkGrammarRefusal };

/** The key every link carries. */
export const CRUX_LINK_FILE_KEY = 'file';

/**
 * Whether [raw] is spelled as a link of [scheme]: it begins with the scheme and
 * a colon, in any case. Says nothing about whether it is a valid one.
 */
export function looksLikeCruxLink(raw: string, scheme: string): boolean {
  return raw.length > scheme.length && raw.slice(0, scheme.length + 1).toLowerCase() === `${scheme}:`;
}

/**
 * Parses [raw] strictly against [grammar]. Never throws.
 *
 * Accepted: `<scheme>://open?file=…` with the grammar's other keys, in any
 * order, each at most once, each percent-encoded. The authority is exactly
 * `open` (any case), optionally followed by a single `/`. `+` is a literal
 * plus, not a space: a path such as `/work/c++/dump.vcd` must survive, and a
 * space is written `%20`.
 */
export function parseCruxLinkQuery(raw: string, grammar: CruxLinkGrammar): CruxLinkQueryResult {
  const refuse = (refusal: CruxLinkGrammarRefusal): CruxLinkQueryResult => ({ ok: false, refusal });
  if (raw.length > CRUX_LINK_MAX_LENGTH) return refuse('too-long');
  if (!looksLikeCruxLink(raw, grammar.scheme)) return refuse('wrong-scheme');
  if (hasForbiddenLinkCharacter(raw)) return refuse('forbidden-character');
  if (raw.includes('#')) return refuse('malformed');
  const rest = raw.slice(grammar.scheme.length + 1);
  if (!rest.startsWith('//')) return refuse('malformed');
  const afterSlashes = rest.slice(2);
  const queryAt = afterSlashes.indexOf('?');
  const head = (queryAt === -1 ? afterSlashes : afterSlashes.slice(0, queryAt)).toLowerCase();
  if (head !== 'open' && head !== 'open/') return refuse('malformed');
  if (queryAt === -1) return refuse('missing-value');
  const query = afterSlashes.slice(queryAt + 1);
  if (query.length === 0) return refuse('missing-value');

  const values = new Map<string, string>();
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return refuse('malformed');
    const key = pair.slice(0, eq);
    const limit = Object.prototype.hasOwnProperty.call(grammar.keys, key) ? grammar.keys[key] : undefined;
    if (limit === undefined) return refuse('unknown-key');
    if (values.has(key)) return refuse('duplicate-key');
    const decoded = decodeLinkValue(pair.slice(eq + 1));
    if (decoded === undefined) return refuse('bad-encoding');
    if (decoded.length === 0) return refuse('missing-value');
    // A malformed UTF-8 sequence decodes to the replacement character in some
    // decoders, which would name a different file than the sender's bytes did;
    // the character itself is refused for the same reason.
    if (decoded.includes('�')) return refuse('bad-encoding');
    if (decoded.length > limit) return refuse('too-long');
    if (hasForbiddenLinkCharacter(decoded, { allowSpace: key === CRUX_LINK_FILE_KEY })) {
      return refuse('forbidden-character');
    }
    values.set(key, decoded);
  }
  if (!values.has(CRUX_LINK_FILE_KEY)) return refuse('missing-value');
  return { ok: true, values };
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Percent-decodes one value as Dart's `Uri.decodeComponent` does, or returns
 * `undefined` where it throws: a raw character above U+007F, a `%` not
 * followed by two hex digits, or bytes that are not UTF-8. `+` stays `+`.
 *
 * `ignoreBOM` keeps a leading U+FEFF in the result, where the forbidden
 * character check refuses it, rather than letting the decoder drop it.
 */
export function decodeLinkValue(raw: string): string | undefined {
  if (!raw.includes('%')) {
    for (let i = 0; i < raw.length; i += 1) {
      if (raw.charCodeAt(i) > 0x7f) return undefined;
    }
    return raw;
  }
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code > 0x7f) return undefined;
    if (code !== 0x25) {
      bytes.push(code);
      continue;
    }
    const pair = raw.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(pair)) return undefined;
    bytes.push(Number.parseInt(pair, 16));
    i += 2;
  }
  try {
    return utf8.decode(Uint8Array.from(bytes));
  } catch {
    return undefined;
  }
}

/**
 * Percent-encodes one value the way every Crux link builder does: each byte
 * of its UTF-8 except `A-Z a-z 0-9 - . _ ~` becomes `%XX` in upper-case hex.
 */
export function encodeLinkValue(value: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(value)) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      byte === 0x2d ||
      byte === 0x2e ||
      byte === 0x5f ||
      byte === 0x7e;
    out += unreserved ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * Whether [value] holds a character no link or link value may carry: a C0 or
 * C1 control, DEL, a bidirectional-text control (which can make a file name
 * read differently from the file it is), a line or paragraph separator, or
 * white space (allowed only as a plain U+0020 inside a decoded path when
 * [allowSpace]). The desktop parsers' set, code point for code point.
 */
export function hasForbiddenLinkCharacter(
  value: string,
  options: { readonly allowSpace?: boolean } = {},
): boolean {
  for (const char of value) {
    const unit = char.codePointAt(0) ?? 0;
    if (unit === 0x20) {
      if (options.allowSpace === true) continue;
      return true;
    }
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) return true;
    if (unit === 0x200e || unit === 0x200f) return true;
    if (unit >= 0x202a && unit <= 0x202e) return true;
    if (unit >= 0x2066 && unit <= 0x2069) return true;
    if (unit === 0x061c || unit === 0x2028 || unit === 0x2029) return true;
    if (unit === 0x00a0 || unit === 0x1680 || unit === 0x3000) return true;
    if (unit >= 0x2000 && unit <= 0x200b) return true;
    if (unit === 0x202f || unit === 0x205f || unit === 0xfeff) return true;
  }
  return false;
}
