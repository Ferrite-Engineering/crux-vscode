/**
 * SimCrux's result vocabulary, mirrored from the product rather than
 * invented here.
 *
 * Every name and every spelling below is the one SimCrux writes. Sources,
 * all open core:
 *
 * - `simcrux/lib/domain/enums/test_status.dart` — the nine [SimTestStatus]
 *   values. Serialized as the Dart `enum.name`, so lowercase and verbatim.
 * - `simcrux/lib/domain/models/test_result.dart` — the fields a row
 *   carries; `metrics` is `Map<String, String>`, so **every metric value
 *   is a string**, including the numeric ones. Parse, never assume.
 * - `simcrux/lib/services/result_store/streaming_results_writer.dart` —
 *   the `results.ndjson` line schema (`_encodeRow`).
 * - `simcrux/lib/services/export/json_exporter.dart` — the consolidated
 *   `simcrux-results.json` schema, whose per-row shape is the NDJSON row
 *   minus `type` and `kill_signal`.
 *
 * Nothing here imports `vscode`: this is the data, and keeping it free of
 * the editor API is what lets the mapping in `../tests/tree.ts` be tested
 * without an extension host.
 */

/**
 * `TestStatus` — SimCrux's nine terminal (and one in-flight) states.
 *
 * Deliberately **all nine**, not the subset VSCode's Test Explorer can
 * render. The projection onto VSCode's four run states is lossy and is
 * performed in exactly one place (`../tests/status.ts`), where the loss is
 * visible and documented, rather than smeared over the reader.
 */
export const SIM_TEST_STATUSES = [
  'pass',
  'fail',
  'vacuous',
  'cover',
  'running',
  'skipped',
  'timeout',
  'cancelled',
  'unknown',
] as const;

export type SimTestStatus = (typeof SIM_TEST_STATUSES)[number];

/**
 * Parse a serialized status.
 *
 * An unrecognised token becomes `unknown` — **matching the product's own
 * decoders**, which use `TestStatus.values.firstWhere(…, orElse: () =>
 * TestStatus.unknown)`. A row from a future build with a status this
 * version has never heard of must still appear in the tree; dropping it
 * would make the run look smaller than it was.
 */
export function parseSimTestStatus(raw: unknown): SimTestStatus {
  if (typeof raw !== 'string') return 'unknown';
  return (SIM_TEST_STATUSES as readonly string[]).includes(raw)
    ? (raw as SimTestStatus)
    : 'unknown';
}

/**
 * One row of a SimCrux run — a `TestResult` joined to the `TestSpec`
 * identity fields the writer flattens onto it.
 *
 * [id] is `TestSpec.id`: `<suite>/<name>`, plus `+key=value` pairs and
 * `+seed=N` when the spec was expanded from a sweep. It is the join key
 * against the config-derived tree and the argument the `--filter` re-run
 * passes back to the CLI.
 */
export interface SimTestRow {
  readonly id: string;
  readonly name: string;
  readonly suite: string;
  readonly simulator: string;
  readonly status: SimTestStatus;
  /** Wall-clock milliseconds. `runtime_ms` on the wire. */
  readonly runtimeMs: number;
  /** Absolute path to the captured waveform, when one was retained. */
  readonly waveformPath?: string;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
  readonly failureMessage?: string;
  readonly exitCode?: number;
  /** `SIGTERM` / `SIGKILL`. NDJSON only — the JSON export drops it. */
  readonly killSignal?: string;
  /**
   * `TestResult.metrics`, verbatim. String values throughout; the key is
   * **omitted entirely** rather than written as `{}` when empty, so an
   * absent map and an empty one are the same thing.
   */
  readonly metrics: Readonly<Record<string, string>>;
}

/** The `meta` line of a `results.ndjson`, or the envelope of a JSON export. */
export interface SimRunMeta {
  readonly runId?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Absolute path of the `simcrux.yaml` the run was launched from. */
  readonly configPath?: string;
}

/** A parsed results document. */
export interface SimRunDocument {
  readonly format: 'ndjson' | 'json';
  readonly meta: SimRunMeta;
  readonly rows: readonly SimTestRow[];
  /**
   * Whether the document carried its trailing `summary`.
   *
   * `false` means the run did not finish: the writer emits `summary` last
   * and only at `recordRunCompletion`, so its absence is the product's own
   * documented signal for a crashed or still-running regression. Surfaced
   * rather than smoothed over — a half-run that reads as a complete one is
   * how "only 3 failures" becomes a wrong statement about a design.
   */
  readonly complete: boolean;
}
