/**
 * GTKWave-compatible RTL stems parser.
 *
 * A line-for-line port of wavecrux's
 * `lib/services/rtl_source/stems_parser.dart`. The Dart implementation is
 * the **conformance target**, not merely the inspiration: both parsers are
 * run over the same fixture corpus (`test/fixtures/stems/`) and compared
 * against goldens the Dart parser produced, because the two halves of a
 * cross-probe have to agree on what a signal's declaration site is. A
 * divergence here does not fail loudly — it sends the user to a different
 * line in the same file depending on which app they asked.
 *
 * ### Line forms
 *
 * ```text
 * # comment                                also `// comment`
 * ++ comp <id> file <path>                 file-table entry, path may be quoted
 * ++ module <full.path> <fileRef> <line>   sets the current scope
 * ++ scope  <full.path> <fileRef> <line>   sets the current scope
 * ++ var    <full.path> <fileRef> <line>   variable, full path given
 * +++ var   <localName> <fileRef> <line>   variable inside the current scope
 * ```
 *
 * `fileRef` is either a non-negative integer indexing the `comp` file table
 * or an inline path. Double-quoted runs are one token and are unquoted.
 *
 * ### Tolerance is a feature
 *
 * Unrecognised keywords (`param`, `arch`, vendor extensions), short lines,
 * unparseable line numbers and unresolvable file references all **skip the
 * line silently**. Third-party stems generators emit extra directives, and
 * a parser that throws on the first one it has not seen makes the format
 * unadoptable. Nothing in this file throws.
 */

/** What kind of HDL element a stems entry refers to. */
export const StemsEntryKind = {
  /** A scope (module/architecture/process) declaration site. */
  scope: 'scope',
  /** A variable (signal/wire/reg/port) declaration site. */
  variable: 'variable',
} as const;

/** One of [StemsEntryKind]'s values. */
export type StemsEntryKind = (typeof StemsEntryKind)[keyof typeof StemsEntryKind];

/**
 * A single signal-or-scope → source-location mapping.
 *
 * Field-for-field the Dart `StemsEntry`, including the 1-based
 * [lineNumber]: the wire is 1-based (CXP §9.6) and so is every stems
 * generator, so the conversion to VSCode's 0-based positions happens once,
 * at the editor boundary, and never here.
 */
export interface StemsEntry {
  /** Full hierarchical dot-separated path, e.g. `top.cpu.clk`. */
  readonly path: string;
  /** Path of the source file containing the declaration; may be relative. */
  readonly sourceFile: string;
  /** 1-based line number of the declaration. Always ≥ 1. */
  readonly lineNumber: number;
  /** Whether this refers to a variable or to its enclosing scope. */
  readonly kind: StemsEntryKind;
}

/**
 * How a parse ended.
 *
 * A stems file is workspace content, not a trusted manifest (CXP §11 puts
 * peer input in the same class and this is no better): it can be
 * arbitrarily large, machine-generated, and wrong. So the parse is bounded
 * and says which bound it hit rather than pretending it read everything.
 */
export type StemsParseOutcome =
  /** The whole file was parsed. */
  | 'complete'
  /** `maxEntries` was reached; [StemsParseResult.entries] is a prefix. */
  | 'truncated'
  /** The content exceeded `maxLength` and was not parsed at all. */
  | 'too-large';

/** Result of [parseStems]. */
export interface StemsParseResult {
  /** Entries in declaration order — the same order the Dart parser emits. */
  readonly entries: readonly StemsEntry[];
  /** Whether every entry in the file is present. */
  readonly outcome: StemsParseOutcome;
}

/** Bounds on what [parseStems] will accept. */
export interface StemsParseLimits {
  /**
   * Longest content, in characters, that will be parsed at all.
   *
   * Defaults to 16 MiB. Real stems for a large SoC run to a few MB; a file
   * an order of magnitude past that is a generator bug or a wedge, and
   * either way parsing it would block the extension host.
   */
  readonly maxLength?: number;
  /**
   * Most entries that will be indexed from one file. Defaults to 500 000.
   *
   * Bounds memory independently of [maxLength], since a pathological file
   * can be almost entirely entries.
   */
  readonly maxEntries?: number;
}

/** Defaults for [StemsParseLimits]. */
export const DEFAULT_STEMS_PARSE_LIMITS = {
  maxLength: 16 * 1024 * 1024,
  maxEntries: 500_000,
} as const;

/**
 * Dart's `int.tryParse` semantics, which JavaScript has no equivalent of.
 *
 * Neither `Number.parseInt` nor `Number` is close enough:
 * `Number.parseInt('5abc')` is 5 and `Number('')` is 0, both of which would
 * accept lines the Dart parser drops. And Dart accepts two forms that look
 * like they should not be here at all — both were found by running the two
 * parsers over the same corpus rather than by reading the docs:
 *
 * - **`0x` is hexadecimal.** With no explicit radix, `int.tryParse('0x10')`
 *   is 16, not null. A stems file whose `comp` ids are hex therefore builds
 *   a *different file table* in the two implementations, and every entry
 *   that references one resolves to a different file — or to none. That is
 *   a silent, total divergence, and it is why `numeric-forms.stems` exists.
 * - **Surrounding whitespace is allowed.** `int.tryParse(' 5')` is 5. It
 *   cannot arise from the tokenizer (which splits on space and tab) but is
 *   matched anyway, because "the port differs only where nothing can reach"
 *   is a claim that stops being true the moment the tokenizer changes.
 *
 * One deliberate divergence remains: Dart's `int` is 64-bit and JavaScript's
 * numbers are not, so a value above 2^53 is rejected here rather than
 * silently rounded. A line number that large is not a real input, and a
 * wrong line is worse than a dropped one.
 */
const DECIMAL = /^[+-]?[0-9]+$/;
const HEXADECIMAL = /^([+-]?)0[xX]([0-9a-fA-F]+)$/;

function tryParseInt(source: string): number | undefined {
  const trimmed = source.trim();
  const hex = HEXADECIMAL.exec(trimmed);
  const value = hex
    ? Number.parseInt(hex[2] ?? '', 16) * (hex[1] === '-' ? -1 : 1)
    : DECIMAL.test(trimmed)
      ? Number(trimmed)
      : Number.NaN;
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Split a stems-line body into whitespace-separated tokens, treating
 * double-quoted runs as one token.
 *
 * The quote characters are **kept** in the token and stripped later by
 * [unquote] — that is what the Dart tokenizer does, and it matters for
 * `comp`, whose path is rejoined from several tokens before being
 * unquoted once.
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let buffer = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      buffer += ch;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t')) {
      if (buffer.length > 0) {
        tokens.push(buffer);
        buffer = '';
      }
      continue;
    }
    buffer += ch;
  }
  if (buffer.length > 0) tokens.push(buffer);
  return tokens;
}

/** Strip one pair of wrapping double quotes, if both are present. */
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/**
 * Resolve a `fileRef` token: an integer indexes the `comp` table, anything
 * else is an inline path.
 *
 * An integer that is *not* in the table resolves to nothing, and the line
 * is dropped — it does not fall back to treating `7` as a filename called
 * `7`. That is the Dart behaviour and it is the right one: a dangling file
 * id means the stems file is internally inconsistent.
 */
function resolveFileRef(token: string, fileTable: Map<number, string>): string | undefined {
  const id = tryParseInt(token);
  return id !== undefined ? fileTable.get(id) : unquote(token);
}

/** Shared tail decoding for `module` / `scope` / `var`: `… <fileRef> <line>`. */
function decodeLocation(
  tokens: readonly string[],
  fileTable: Map<number, string>,
): { readonly name: string; readonly sourceFile: string; readonly lineNumber: number } | undefined {
  // Fewer than four tokens cannot carry name + fileRef + line, so the line
  // is dropped rather than half-read.
  if (tokens.length < 4) return undefined;
  const name = unquote(tokens[1] ?? '');
  if (name.length === 0) return undefined;
  const lineNumber = tryParseInt(tokens[tokens.length - 1] ?? '');
  if (lineNumber === undefined || lineNumber < 1) return undefined;
  const sourceFile = resolveFileRef(tokens[tokens.length - 2] ?? '', fileTable);
  if (sourceFile === undefined || sourceFile.length === 0) return undefined;
  return { name, sourceFile, lineNumber };
}

/**
 * Parse [content] into stems entries.
 *
 * Never throws and never rejects a file wholesale for a bad line: the worst
 * a malformed stems file produces is fewer entries than its author
 * intended.
 */
export function parseStems(content: string, limits: StemsParseLimits = {}): StemsParseResult {
  const maxLength = limits.maxLength ?? DEFAULT_STEMS_PARSE_LIMITS.maxLength;
  const maxEntries = limits.maxEntries ?? DEFAULT_STEMS_PARSE_LIMITS.maxEntries;
  if (content.length > maxLength) return { entries: [], outcome: 'too-large' };

  const fileTable = new Map<number, string>();
  const entries: StemsEntry[] = [];
  let currentScopePath: string | undefined;

  // Split on `\n` and trim: a CRLF file loses its `\r` at the trim, which is
  // how the Dart parser handles Windows line endings too.
  for (const rawLine of content.split('\n')) {
    if (entries.length >= maxEntries) return { entries, outcome: 'truncated' };

    let line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#') || line.startsWith('//')) continue;

    // `+++` is tested first: the longer prefix wins, or every nested-var
    // line would be read as a scope line with a stray `+`.
    const isVar = line.startsWith('+++');
    const isScope = !isVar && line.startsWith('++');
    if (!isVar && !isScope) continue;
    line = line.slice(isVar ? 3 : 2).trim();
    if (line.length === 0) continue;

    const tokens = tokenize(line);
    const keyword = tokens[0]?.toLowerCase();
    if (keyword === undefined) continue;

    // ── file table: `comp <id> file <path>` ──────────────────────────────
    if (keyword === 'comp' && tokens.length >= 4 && tokens[2]?.toLowerCase() === 'file') {
      const id = tryParseInt(tokens[1] ?? '');
      if (id === undefined) continue;
      // Everything after `file` is the path. Rejoined with single spaces
      // because the tokenizer has already collapsed runs of whitespace —
      // a path that needs its spacing preserved has to be quoted, and then
      // it arrives as one token anyway.
      const path = unquote(tokens.slice(3).join(' '));
      if (path.length === 0) continue;
      fileTable.set(id, path);
      continue;
    }

    // ── module / scope ──────────────────────────────────────────────────
    // Only under `++`. A `+++ module` line is not a thing any generator
    // emits, and the Dart parser ignores it; so does this one.
    if (!isVar && (keyword === 'module' || keyword === 'scope')) {
      const decoded = decodeLocation(tokens, fileTable);
      if (decoded === undefined) continue;
      entries.push({
        path: decoded.name,
        sourceFile: decoded.sourceFile,
        lineNumber: decoded.lineNumber,
        kind: StemsEntryKind.scope,
      });
      // A dropped scope line leaves the previous scope current — matching
      // the Dart parser, and the only choice that does not silently
      // reparent the variables that follow it.
      currentScopePath = decoded.name;
      continue;
    }

    // ── variable ────────────────────────────────────────────────────────
    if (keyword === 'var') {
      const decoded = decodeLocation(tokens, fileTable);
      if (decoded === undefined) continue;
      // `+++` gives a name local to the current scope; `++` gives the full
      // path already. With no scope yet seen, the local name stands alone
      // rather than being dropped — a partial answer beats none.
      const path =
        isVar && currentScopePath !== undefined
          ? `${currentScopePath}.${decoded.name}`
          : decoded.name;
      entries.push({
        path,
        sourceFile: decoded.sourceFile,
        lineNumber: decoded.lineNumber,
        kind: StemsEntryKind.variable,
      });
      continue;
    }

    // Every other keyword is ignored on purpose. See the file comment.
  }

  return { entries, outcome: 'complete' };
}

/**
 * The trailing component of a dotted path — `top.cpu.clk` → `clk`.
 *
 * Shared with the index so both halves agree on what "the identifier" in a
 * path is.
 */
export function localNameOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? path : path.slice(dot + 1);
}

/**
 * Drop a bit-range suffix — `data[7:0]` → `data`.
 *
 * Waveform tools disagree about whether a vector signal's name carries its
 * range, and a user selecting `data` in the RTL must still match a stems
 * entry written `data[7:0]`.
 */
export function stripBitRange(name: string): string {
  const bracket = name.indexOf('[');
  return bracket < 0 ? name : name.slice(0, bracket);
}
