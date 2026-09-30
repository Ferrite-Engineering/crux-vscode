/**
 * Reading and appending `.lintcrux-waivers.json`.
 *
 * The one hard requirement: **LintCrux must be able to read what we
 * write.** So this is not a general JSON store that happens to have
 * similar fields — it reproduces `JsonFileWaiverStore`'s exact behaviour
 * on all four axes that can break interoperability:
 *
 * 1. **Version policy.** `version` present and not 1 → refuse, loudly, and
 *    do not touch the file (the Dart parser throws `FormatException` on
 *    the same input, so writing anyway would produce a file *neither*
 *    build can read). `version` absent or non-integer → treated as v1,
 *    matching `if (version is int && version != schemaVersion)`.
 * 2. **Emitted shape.** `version` + `waivers`, the optional line fields
 *    omitted rather than `null`, timestamps as ISO-8601 UTC.
 * 3. **Atomic write.** Sibling `.tmp` then `rename`, exactly as
 *    `writeJsonAtomic` does, so a crash mid-write never leaves the app a
 *    half-written file. Same two-space indent, same absence of a trailing
 *    newline.
 * 4. **Existing entries are re-emitted verbatim.** The Dart round-trip
 *    drops waiver fields it does not model; this one does not, because a
 *    file written by a *newer* LintCrux and then appended to from here
 *    must not lose the newer build's fields. Unknown top-level keys are
 *    preserved for the same reason (the Dart parser tolerates them).
 *
 * No `vscode` import: this is `node:fs` and JSON, which is what lets the
 * version policy and the round-trip be tested against real files.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { WAIVER_SCHEMA_VERSION, type LintWaiver } from './model';

/** Thrown when the waiver file exists but this build must not write to it. */
export class WaiverSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaiverSchemaError';
  }
}

/**
 * A waiver file as it was found on disk.
 *
 * [entries] holds the raw JSON objects, not parsed [LintWaiver]s: they are
 * what gets re-emitted on append. [waivers] is the typed view, skipping
 * entries that are missing a required field — a malformed entry is
 * *ignored* for matching here rather than fatal, because the alternative
 * is an editor that shows no waivers at all because of one bad row it did
 * not write.
 */
export interface WaiverDocument {
  readonly version: number;
  readonly entries: readonly Record<string, unknown>[];
  readonly waivers: readonly LintWaiver[];
  /** Top-level keys other than `version`/`waivers`, preserved on write. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/** An empty document, used for a waiver file that does not exist yet. */
export const EMPTY_WAIVER_DOCUMENT: WaiverDocument = {
  version: WAIVER_SCHEMA_VERSION,
  entries: [],
  waivers: [],
  extra: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function integer(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** Typed view of one raw entry, or `undefined` if the app would reject it. */
function toWaiver(entry: Record<string, unknown>): LintWaiver | undefined {
  const id = nonEmptyString(entry, 'id');
  const ruleId = nonEmptyString(entry, 'ruleId');
  const filePath = nonEmptyString(entry, 'filePath');
  const reason = nonEmptyString(entry, 'reason');
  const author = nonEmptyString(entry, 'author');
  const createdAt = typeof entry['createdAt'] === 'string' ? entry['createdAt'] : undefined;
  if (
    id === undefined ||
    ruleId === undefined ||
    filePath === undefined ||
    reason === undefined ||
    author === undefined ||
    createdAt === undefined
  ) {
    return undefined;
  }
  const lineStart = integer(entry, 'lineStart');
  const lineEnd = integer(entry, 'lineEnd');
  const expiresAt = typeof entry['expiresAt'] === 'string' ? entry['expiresAt'] : undefined;
  return {
    id,
    ruleId,
    filePath,
    ...(lineStart === undefined ? {} : { lineStart }),
    ...(lineEnd === undefined ? {} : { lineEnd }),
    reason,
    author,
    createdAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/**
 * Parse a waiver file's text.
 *
 * Throws [WaiverSchemaError] for a document this build must not
 * interpret — a non-object top level, or a `version` it does not
 * understand — matching `JsonFileWaiverStore._parse`'s two failure modes.
 */
export function parseWaiverDocument(text: string): WaiverDocument {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new WaiverSchemaError(`waiver file is not valid JSON: ${String(error)}`);
  }
  if (!isRecord(decoded)) {
    throw new WaiverSchemaError('waiver file must be a JSON object');
  }
  const rawVersion = decoded['version'];
  if (typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion !== WAIVER_SCHEMA_VERSION) {
    throw new WaiverSchemaError(
      `unsupported waiver schema version: ${rawVersion} ` +
        `(this build understands v${WAIVER_SCHEMA_VERSION} only)`,
    );
  }
  const rawWaivers = decoded['waivers'];
  const entries = Array.isArray(rawWaivers) ? rawWaivers.filter(isRecord) : [];
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(decoded)) {
    if (key === 'version' || key === 'waivers') continue;
    extra[key] = value;
  }
  const waivers: LintWaiver[] = [];
  for (const entry of entries) {
    const waiver = toWaiver(entry);
    if (waiver !== undefined) waivers.push(waiver);
  }
  return { version: WAIVER_SCHEMA_VERSION, entries, waivers, extra };
}

/**
 * Read the waiver file at [filePath].
 *
 * A missing file is [EMPTY_WAIVER_DOCUMENT], not an error: the app treats
 * a project with no waiver file as a project with no waivers
 * (`loadFrom` skips non-existent paths), and so does this.
 */
export function readWaiverDocument(filePath: string): WaiverDocument {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') return EMPTY_WAIVER_DOCUMENT;
    throw error;
  }
  return parseWaiverDocument(text);
}

/** The exact JSON object shape `_waiverToJson` emits, key order included. */
export function waiverToJson(waiver: LintWaiver): Record<string, unknown> {
  return {
    id: waiver.id,
    ruleId: waiver.ruleId,
    filePath: waiver.filePath,
    ...(waiver.lineStart === undefined ? {} : { lineStart: waiver.lineStart }),
    ...(waiver.lineEnd === undefined ? {} : { lineEnd: waiver.lineEnd }),
    reason: waiver.reason,
    author: waiver.author,
    createdAt: waiver.createdAt,
    ...(waiver.expiresAt === undefined ? {} : { expiresAt: waiver.expiresAt }),
  };
}

/** Serialize a document + one appended waiver, in `writeJsonAtomic`'s formatting. */
export function serializeWaiverDocument(
  document: WaiverDocument,
  appended: readonly LintWaiver[],
): string {
  const payload = {
    version: WAIVER_SCHEMA_VERSION,
    waivers: [...document.entries, ...appended.map(waiverToJson)],
    ...document.extra,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Append [waiver] to the file at [filePath], creating it if absent.
 *
 * Read-modify-write, atomically. This is a last-writer-wins append: the
 * app holds its own in-memory copy and rewrites the whole file on its next
 * mutation, so a waiver filed here while the app has the same project open
 * can be overwritten by the app's next write. That is the same race the
 * app already has with a second app instance, and the alternative — a lock
 * file the Dart side does not take — would be a convention only one of the
 * two builds obeys.
 */
export function appendWaiver(filePath: string, waiver: LintWaiver): void {
  const document = readWaiverDocument(filePath);
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, serializeWaiverDocument(document, [waiver]), 'utf8');
  renameSync(temporary, filePath);
}

/** Options for [createWaiver]. */
export interface CreateWaiverOptions {
  readonly ruleId: string;
  /** Absolute path, as the violation reported it. */
  readonly filePath: string;
  /** Omit for a whole-file waiver. */
  readonly lineStart?: number;
  readonly lineEnd?: number;
  readonly reason: string;
  readonly author: string;
  readonly now?: Date;
  /** Injectable for tests; production uses `crypto.randomUUID`. */
  readonly id?: string;
}

/**
 * Build a [LintWaiver] with the fields the app requires.
 *
 * Throws on an empty `reason` or `author` rather than writing a file the
 * Dart parser will throw on — the failure belongs at the point the user
 * can still fix it, not at the point the app next opens the project. No
 * `expiresAt` is ever set from here: an expiry is a policy decision the
 * triage view is built to make, and guessing one in the editor would put
 * a silent clock on a waiver the user did not ask to be temporary.
 */
export function createWaiver(options: CreateWaiverOptions): LintWaiver {
  const reason = options.reason.trim();
  const author = options.author.trim();
  if (reason === '') throw new WaiverSchemaError('a waiver needs a reason');
  if (author === '') throw new WaiverSchemaError('a waiver needs an author');
  return {
    id: options.id ?? randomUUID(),
    ruleId: options.ruleId,
    filePath: options.filePath,
    ...(options.lineStart === undefined ? {} : { lineStart: options.lineStart }),
    ...(options.lineEnd === undefined ? {} : { lineEnd: options.lineEnd }),
    reason,
    author,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
}

/**
 * The default waiver author.
 *
 * `$USER` → `$USERNAME` → `unknown`, which is `_osUser()` in the app's own
 * waive dialog, character for character. A waiver filed from the editor
 * and one filed from the app therefore carry the same author for the same
 * person, which is the whole point of an author field.
 */
export function defaultWaiverAuthor(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return environment['USER'] ?? environment['USERNAME'] ?? 'unknown';
}
