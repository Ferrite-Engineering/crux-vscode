/**
 * LintCrux's managed-waiver file, mirrored exactly.
 *
 * Source of truth, read field by field before this was written:
 *
 * - filename — `lintcrux_pro/lib/services/waivers/waiver_file_name.dart`
 *   (`kWaiverFileName`), resolved against `LintProject.rootPath`
 * - schema + parser + writer — `.../waivers/json_file_waiver_store.dart`
 * - matching — `.../waivers/waiver_matcher.dart`
 * - the model — `lintcrux/lib/domain/models/waiver.dart`
 *
 * ```json
 * {
 *   "version": 1,
 *   "waivers": [
 *     {
 *       "id": "uuid-v4",
 *       "ruleId": "verilator/UNUSEDSIGNAL",
 *       "filePath": "/abs/path/to/cpu.sv",
 *       "lineStart": 42,
 *       "lineEnd": 48,
 *       "reason": "Refactor planned for Q3 (LIN-321)",
 *       "author": "mfink",
 *       "createdAt": "2026-05-25T18:30:00Z",
 *       "expiresAt": "2026-08-25T00:00:00Z"
 *     }
 *   ]
 * }
 * ```
 *
 * A waiver this extension writes that the app cannot read is worse than no
 * code action at all, so the shape is matched byte for byte rather than
 * approximated: `id`, `ruleId`, `filePath`, `reason` and `author` are
 * required **non-empty** strings on the Dart side (`_readString` throws
 * otherwise, taking the whole file's parse with it), `createdAt` is a
 * required ISO-8601 string, the two line fields are emitted only when
 * present, and `expiresAt` is omitted rather than `null` when absent.
 */

/** `kWaiverFileName` — always at the project root, next to the `.lintcrux` project file. */
export const WAIVER_FILE_NAME = '.lintcrux-waivers.json';

/** `JsonFileWaiverStore.schemaVersion`. */
export const WAIVER_SCHEMA_VERSION = 1;

/** One managed waiver, in the on-disk vocabulary. */
export interface LintWaiver {
  /** UUID v4. */
  readonly id: string;
  /** Engine-namespaced, e.g. `verilator/UNUSEDSIGNAL`. */
  readonly ruleId: string;
  /** Absolute path. The Dart matcher compares this by string equality. */
  readonly filePath: string;
  /** 1-based, inclusive. Absent means "the whole file". */
  readonly lineStart?: number;
  /** 1-based, inclusive. Absent with [lineStart] present means "that one line". */
  readonly lineEnd?: number;
  /** Required, non-empty — the justification. */
  readonly reason: string;
  /** Required, non-empty — the owner. */
  readonly author: string;
  /** ISO-8601, UTC. */
  readonly createdAt: string;
  /** ISO-8601, UTC. Omitted entirely when the waiver does not expire. */
  readonly expiresAt?: string;
}

/**
 * Whether [waiver] covers a violation of [ruleId] at [file]:[line].
 *
 * A transcription of `WaiverMatcher._matches`, in its order, with one
 * documented divergence: the Dart matcher resolves both rule ids through
 * an **alias table** first, and this extension has no alias table — the
 * table lives in the app's rule database, which is a Flutter asset, not a
 * file on disk this process can read. The consequence is bounded and
 * one-directional: a waiver written against a rule's *old* id keeps
 * matching in the app and stops matching here, so a violation the app
 * hides may still be squiggled in the editor. Showing a violation that is
 * waived elsewhere is the safe failure; hiding one that is not is not.
 *
 * Expiry uses the Dart rule exactly — `expiresAt` at or in the past means
 * no match, so a waiver expires at its instant rather than after it.
 */
export function waiverCovers(
  waiver: LintWaiver,
  ruleId: string,
  file: string,
  line: number,
  now: Date,
): boolean {
  if (waiver.ruleId !== ruleId) return false;
  if (waiver.filePath !== file) return false;
  if (waiver.lineStart !== undefined) {
    const start = waiver.lineStart;
    const end = waiver.lineEnd ?? start;
    if (line < start || line > end) return false;
  }
  if (waiver.expiresAt !== undefined) {
    const expiry = Date.parse(waiver.expiresAt);
    // An unparseable expiry is treated as no expiry rather than as an
    // instant expiry: `DateTime.parse` would have thrown on the Dart side
    // and the file would not have loaded at all, so the only way to see
    // one here is a file this build reads more leniently than the app.
    if (!Number.isNaN(expiry) && now.getTime() >= expiry) return false;
  }
  return true;
}

/**
 * The first waiver in [waivers] covering the violation, or `undefined`.
 *
 * First match wins in insertion order, matching
 * `WaiverMatcher.matchFirstIndexed` — which indexes by
 * `(ruleId, filePath)` for speed but preserves insertion order within a
 * bucket.
 */
export function findWaiver(
  waivers: readonly LintWaiver[],
  ruleId: string,
  file: string,
  line: number,
  now: Date,
): LintWaiver | undefined {
  return waivers.find((waiver) => waiverCovers(waiver, ruleId, file, line, now));
}
