import { localNameOf, stripBitRange, type StemsEntry } from './stems-parser';

/**
 * The bidirectional signal ↔ source index.
 *
 * ### Why both directions exist from the first commit
 *
 * The two features that read this index want opposite lookups, and an index
 * built for one of them cannot serve the other without a scan:
 *
 * - **`request_open_source`** (and "jump to declaration") asks
 *   *design path → file + line*.
 * - **"show this signal in WaveCrux"** and, more demandingly, the RTL
 *   annotation ask *file + line + identifier → design
 *   path(s)*. Annotation recomputes that on **every cursor move and every
 *   scroll**, over the whole visible range — 40-odd lines, many times a
 *   second.
 *
 * Retrofitting the reverse direction onto a forward-only map means walking
 * every entry per query, which at a few hundred thousand entries is a
 * dropped frame per scroll tick. So the reverse direction is a real index,
 * not a derived scan.
 *
 * ### Why a visible-range query is a lookup, not a scan
 *
 * The reverse direction is stored as a **map of files, each holding a map
 * keyed by line number**. `declarationsAt(file, line)` is therefore two
 * hash lookups and returns an already-built bucket; a visible range of *n*
 * lines costs *n* bucket lookups — proportional to what is on screen, and
 * independent of how large the design is. The same per-file shard also
 * carries an identifier map, so "what is `alu_result` in this file" is one
 * lookup rather than a walk of the file's lines.
 *
 * ### Why the index is sharded by stems file
 *
 * Every record remembers which stems file produced it, and every bucket
 * key is recomputable from the record. Re-indexing one regenerated stems
 * file therefore costs O(entries in *that* file) — remove its records from
 * the buckets they are in, parse, insert the new ones — and never touches
 * the other stems files in the workspace. A regeneration run in a large
 * repo rewrites one file at a time; a full rebuild per write would make the
 * watcher quadratic in the number of stems files.
 *
 * Nothing here is async and nothing here does I/O: the service layer reads
 * and watches files, this holds the answer.
 */

/** A file + line pair, 1-based, as stems and CXP both write it. */
export interface SourceLocation {
  /** Source file path exactly as the stems file gave it; may be relative. */
  readonly fsPath: string;
  /** 1-based line number. */
  readonly lineNumber: number;
}

/**
 * How a candidate was arrived at — ranked from most to least certain.
 *
 * This is what lets the quick-pick say *why* an entry is being offered,
 * which is the whole pedagogical point: a user who sees "name match — no
 * stems file" learns that generating stems would have made the answer
 * exact, and a user who sees "from stems" knows not to second-guess it.
 */
export type NameMatchOrigin =
  /** The queried file+line *is* the declaration site in a stems file. */
  | 'stems-declaration'
  /** A stems entry declared in the queried file with this identifier. */
  | 'stems-file'
  /** A stems entry with this identifier, declared in some other file. */
  | 'stems-name'
  /**
   * Name-matched against the design hierarchy loaded in a peer, with no
   * stems entry involved. A guess — a good one, but a guess.
   */
  | 'hierarchy-name';

const ORIGIN_RANK: Readonly<Record<NameMatchOrigin, number>> = {
  'stems-declaration': 0,
  'stems-file': 1,
  'stems-name': 2,
  'hierarchy-name': 3,
};

/**
 * Whether [origin] came from a stems file, i.e. is an exact mapping rather
 * than a name match.
 *
 * All three stems origins are exact in the sense that matters: the
 * hierarchical path is one a generator wrote down from the RTL, not one
 * inferred from an identifier colliding across instantiations.
 */
export function isExactMatch(origin: NameMatchOrigin): boolean {
  return origin !== 'hierarchy-name';
}

/** One possible design path for what the user selected. */
export interface NameCandidate {
  /** Full hierarchical path, e.g. `top.cpu.alu.result`. */
  readonly path: string;
  /** How it was found. See [isExactMatch]. */
  readonly origin: NameMatchOrigin;
  /** Declaration site, when a stems entry supplied one. */
  readonly declaredAt?: SourceLocation;
}

/** What the user has selected, as the reverse direction wants it. */
export interface NameQuery {
  /** File the selection is in. */
  readonly fsPath: string;
  /** 1-based line of the selection, when known. */
  readonly line?: number;
  /** The selected identifier. Bit ranges and case are normalised away. */
  readonly identifier: string;
}

/** An indexed stems entry, tagged with the file that produced it. */
interface StemsRecord {
  /** Path of the stems file this came from — the shard id. */
  readonly stemsFile: string;
  readonly entry: StemsEntry;
  /** `entry.path`'s trailing component, bit-range stripped and lowercased. */
  readonly localName: string;
}

/** The reverse index for one source file. */
interface SourceFileIndex {
  /** 1-based line → entries declared on it. The visible-range lookup. */
  readonly byLine: Map<number, StemsRecord[]>;
  /** Normalised identifier → entries declared anywhere in this file. */
  readonly byName: Map<string, StemsRecord[]>;
}

function newSourceFileIndex(): SourceFileIndex {
  return { byLine: new Map(), byName: new Map() };
}

/** Normalise an identifier for matching: bit range dropped, case folded. */
function normalizeIdentifier(identifier: string): string {
  return stripBitRange(identifier.trim()).toLowerCase();
}

/**
 * Case-fold a path key on the platforms whose filesystems do.
 *
 * Same rule as `editor/workspace-paths.ts`, and for the same reason: on
 * macOS and Windows a stems file and the editor can legitimately spell the
 * same file with different casing, and refusing to match them would make
 * the index miss on exactly the machines most users are on.
 */
function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Full-path key: separators normalised, case folded where appropriate. */
function fullPathKey(fsPath: string, platform: NodeJS.Platform): string {
  const slashed = fsPath.replaceAll('\\', '/');
  return foldsCase(platform) ? slashed.toLowerCase() : slashed;
}

/** Basename key, for the relative-vs-absolute fallback described below. */
function baseNameKey(fsPath: string, platform: NodeJS.Platform): string {
  const key = fullPathKey(fsPath, platform);
  const slash = key.lastIndexOf('/');
  return slash < 0 ? key : key.slice(slash + 1);
}

/** Codepoint order — stable across locales, unlike `localeCompare`. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function push<K>(map: Map<K, StemsRecord[]>, key: K, record: StemsRecord): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [record]);
  else bucket.push(record);
}

function drop<K>(map: Map<K, StemsRecord[]>, key: K, stemsFile: string): void {
  const bucket = map.get(key);
  if (bucket === undefined) return;
  const kept = bucket.filter((record) => record.stemsFile !== stemsFile);
  if (kept.length === 0) map.delete(key);
  else map.set(key, kept);
}

export class NameIndex {
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /** Records per stems file — the shard, and what `remove` replays. */
  private readonly shards = new Map<string, StemsRecord[]>();

  // ── forward: design path → declaration ──────────────────────────────────
  private readonly byPath = new Map<string, StemsRecord[]>();
  private readonly byLowerPath = new Map<string, StemsRecord[]>();
  /** Trailing path component → records. Tier 3 forward, and global reverse. */
  private readonly byLocalName = new Map<string, StemsRecord[]>();

  // ── reverse: source file → line/identifier → design paths ───────────────
  private readonly bySourceFile = new Map<string, SourceFileIndex>();
  /**
   * Basename → the same per-file index, consulted only when the full path
   * misses.
   *
   * Stems generators write whatever path they were invoked with — often
   * relative to the build directory — while the editor always has an
   * absolute real path. Matching on basename recovers those cases. It is a
   * *fallback*, in its own map rather than a second key in the primary one,
   * so an exact full-path match can never be diluted by a same-named file
   * in another directory.
   */
  private readonly byBaseName = new Map<string, SourceFileIndex>();

  /** Stems files currently indexed. */
  get stemsFiles(): readonly string[] {
    return [...this.shards.keys()];
  }

  /** Total indexed entries across every stems file. */
  get size(): number {
    let total = 0;
    for (const records of this.shards.values()) total += records.length;
    return total;
  }

  /** Whether anything at all is indexed. */
  get isEmpty(): boolean {
    return this.shards.size === 0 || this.size === 0;
  }

  /**
   * Index [entries] as the contents of the stems file [stemsFile],
   * replacing whatever that file contributed before.
   *
   * O(entries in this file plus entries previously in this file) — see the
   * sharding note at the top of the file.
   */
  replace(stemsFile: string, entries: readonly StemsEntry[]): void {
    this.remove(stemsFile);
    const records: StemsRecord[] = entries.map((entry) => ({
      stemsFile,
      entry,
      localName: normalizeIdentifier(localNameOf(entry.path)),
    }));
    this.shards.set(stemsFile, records);
    for (const record of records) this.insert(record);
  }

  /** Drop everything [stemsFile] contributed. Unknown files are ignored. */
  remove(stemsFile: string): void {
    const records = this.shards.get(stemsFile);
    if (records === undefined) return;
    this.shards.delete(stemsFile);
    for (const record of records) this.erase(record);
  }

  /** Drop every shard. */
  clear(): void {
    for (const stemsFile of [...this.shards.keys()]) this.remove(stemsFile);
  }

  // ── forward direction ───────────────────────────────────────────────────

  /**
   * Declaration sites for the design path [path], best first.
   *
   * Three tiers, matching wavecrux's `StemsFile.lookup` so both apps answer
   * the same question the same way:
   *
   * 1. exact path, variables before scopes;
   * 2. case-insensitive path;
   * 3. trailing component, bit range stripped — which is where a waveform
   *    that names a signal `data[7:0]` meets a stems file that calls it
   *    `data`.
   *
   * Every match at the winning tier is returned rather than only the first:
   * two instantiations of one module genuinely are two answers, and the
   * caller disambiguates.
   */
  locationsFor(path: string): readonly StemsEntry[] {
    const trimmed = path.trim();
    if (trimmed.length === 0) return [];

    const exact = this.byPath.get(trimmed);
    if (exact !== undefined) return orderEntries(preferVariables(exact));

    const insensitive = this.byLowerPath.get(trimmed.toLowerCase());
    if (insensitive !== undefined) return orderEntries(preferVariables(insensitive));

    const local = this.byLocalName.get(normalizeIdentifier(localNameOf(trimmed)));
    if (local !== undefined) return orderEntries(preferVariables(local));

    return [];
  }

  // ── reverse direction ───────────────────────────────────────────────────

  /**
   * Entries declared at [fsPath]:[line] — the per-visible-line query.
   *
   * Two hash lookups and no allocation beyond the returned array. RTL
   * annotation calls this once per visible line on every scroll, so it must stay that
   * way.
   */
  declarationsAt(fsPath: string, line: number): readonly StemsEntry[] {
    const file = this.sourceFileIndex(fsPath);
    if (file === undefined) return [];
    return (file.byLine.get(line) ?? []).map((record) => record.entry);
  }

  /**
   * Entries declared anywhere in [startLine]..[endLine] inclusive.
   *
   * A loop of [declarationsAt], i.e. one hash lookup per visible line —
   * proportional to the viewport, not to the design. The range is clamped
   * so a caller cannot make this walk a million empty lines by passing a
   * reversed or absurd range.
   */
  declarationsInRange(
    fsPath: string,
    startLine: number,
    endLine: number,
  ): readonly StemsEntry[] {
    const file = this.sourceFileIndex(fsPath);
    if (file === undefined) return [];
    const first = Math.max(1, Math.trunc(startLine));
    const last = Math.trunc(endLine);
    if (last < first) return [];
    const found: StemsEntry[] = [];
    for (let line = first; line <= last; line++) {
      for (const record of file.byLine.get(line) ?? []) found.push(record.entry);
    }
    return found;
  }

  /**
   * Every design path the selection described by [query] could mean, most
   * certain first, never collapsed to one.
   *
   * Ambiguity is the normal case, not the exception: `result` inside a
   * module instantiated four times is four correct answers, and a picker
   * that silently chose one would send the user to the wrong instance with
   * no sign that a choice was made. The ordering is deterministic — by
   * origin, then by path in codepoint order — so the same selection offers
   * the same list in the same order every time.
   *
   * Returns stems answers only. The hierarchy fallback lives in
   * `NameResolver`, because it needs a peer and this must stay synchronous.
   */
  candidatesFor(query: NameQuery): readonly NameCandidate[] {
    const identifier = normalizeIdentifier(query.identifier);
    if (identifier.length === 0) return [];

    const found = new Map<string, NameCandidate>();
    const offer = (record: StemsRecord, origin: NameMatchOrigin): void => {
      const existing = found.get(record.entry.path);
      if (existing !== undefined && ORIGIN_RANK[existing.origin] <= ORIGIN_RANK[origin]) return;
      found.set(record.entry.path, {
        path: record.entry.path,
        origin,
        declaredAt: {
          fsPath: record.entry.sourceFile,
          lineNumber: record.entry.lineNumber,
        },
      });
    };

    const file = this.sourceFileIndex(query.fsPath);
    if (file !== undefined) {
      if (query.line !== undefined) {
        for (const record of file.byLine.get(query.line) ?? []) {
          if (record.localName === identifier) offer(record, 'stems-declaration');
        }
      }
      for (const record of file.byName.get(identifier) ?? []) offer(record, 'stems-file');
    }
    for (const record of this.byLocalName.get(identifier) ?? []) offer(record, 'stems-name');

    return [...found.values()].sort(compareCandidates);
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** Full-path index if there is one, else the basename fallback. */
  private sourceFileIndex(fsPath: string): SourceFileIndex | undefined {
    return (
      this.bySourceFile.get(fullPathKey(fsPath, this.platform)) ??
      this.byBaseName.get(baseNameKey(fsPath, this.platform))
    );
  }

  private insert(record: StemsRecord): void {
    push(this.byPath, record.entry.path, record);
    push(this.byLowerPath, record.entry.path.toLowerCase(), record);
    push(this.byLocalName, record.localName, record);

    for (const [map, key] of this.sourceKeys(record)) {
      let file = map.get(key);
      if (file === undefined) {
        file = newSourceFileIndex();
        map.set(key, file);
      }
      push(file.byLine, record.entry.lineNumber, record);
      push(file.byName, record.localName, record);
    }
  }

  /**
   * The inverse of [insert].
   *
   * Every key is recomputed from the record rather than remembered in a
   * side table: the derivation is pure, so replaying it is exactly as
   * correct and there is no bookkeeping structure to fall out of step with
   * the index it describes.
   */
  private erase(record: StemsRecord): void {
    drop(this.byPath, record.entry.path, record.stemsFile);
    drop(this.byLowerPath, record.entry.path.toLowerCase(), record.stemsFile);
    drop(this.byLocalName, record.localName, record.stemsFile);

    for (const [map, key] of this.sourceKeys(record)) {
      const file = map.get(key);
      if (file === undefined) continue;
      drop(file.byLine, record.entry.lineNumber, record.stemsFile);
      drop(file.byName, record.localName, record.stemsFile);
      if (file.byLine.size === 0 && file.byName.size === 0) map.delete(key);
    }
  }

  /** The (map, key) pairs [record] belongs under, full path and basename. */
  private sourceKeys(record: StemsRecord): [Map<string, SourceFileIndex>, string][] {
    const full = fullPathKey(record.entry.sourceFile, this.platform);
    const base = baseNameKey(record.entry.sourceFile, this.platform);
    const keys: [Map<string, SourceFileIndex>, string][] = [[this.bySourceFile, full]];
    if (base !== full) keys.push([this.byBaseName, base]);
    return keys;
  }
}

/** Variables win over scopes at the same tier — matching wavecrux. */
function preferVariables(records: readonly StemsRecord[]): readonly StemsRecord[] {
  const variables = records.filter((record) => record.entry.kind === 'variable');
  return variables.length > 0 ? variables : records;
}

/** Deterministic ordering: by path, then by file, then by line. */
function orderEntries(records: readonly StemsRecord[]): readonly StemsEntry[] {
  return records
    .map((record) => record.entry)
    .sort(
      (a, b) =>
        compareStrings(a.path, b.path) ||
        compareStrings(a.sourceFile, b.sourceFile) ||
        a.lineNumber - b.lineNumber,
    );
}

function compareCandidates(a: NameCandidate, b: NameCandidate): number {
  return ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || compareStrings(a.path, b.path);
}
