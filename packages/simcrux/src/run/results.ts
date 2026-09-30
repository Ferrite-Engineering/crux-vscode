/**
 * Reading a SimCrux run's results off disk.
 *
 * ### Why this reads a file instead of driving the app
 *
 * Established by reading the product, exactly as LintCrux's reader was:
 *
 * - `simcrux <config>.yaml --ci` **always** writes
 *   `<dir of simcrux.yaml>/results.ndjson` plus a `results.summary.json`
 *   beside it (`CiRunner._resolveStreamingPath`); an interactive GUI run
 *   opts in with `output: { streaming: true }`. Either way the path is a
 *   *convention*, not a name the user has to supply — which is what makes
 *   a zero-configuration default possible here where LintCrux needed a
 *   setting.
 * - `simcrux export-dashboard <out-dir>` writes the consolidated
 *   `simcrux-results.json`, whose per-row shape is the NDJSON row minus
 *   `type` and `kill_signal`.
 *
 * So the file exists precisely when someone ran a regression, which is
 * exactly when the Test Explorer should show results — and reading it
 * costs no process spawn, no simulator discovery, and gives this extension
 * no way to run a simulation the user did not ask for. Launching is a
 * separate, explicit act, and it lives in `../tasks.ts`.
 *
 * Both shapes are accepted and **sniffed from the content**, mirroring the
 * product's own `WebResultsDocument.decode`, so a file named `.json` that
 * happens to be NDJSON still parses.
 *
 * ### Forward compatibility is a documented contract, not politeness
 *
 * The writer's own header says readers "tolerate unknown line types and
 * unknown keys". This one does: an unparseable line is skipped rather than
 * failing the document, an unrecognised `type` is ignored, and a row
 * missing its `id` is dropped because it cannot be joined to anything.
 * A truncated tail — the crash case `NdjsonRecovery` repairs in the app —
 * therefore costs the truncated line and nothing more.
 */
import { parseSimTestStatus, type SimRunDocument, type SimRunMeta, type SimTestRow } from './model';

/** Thrown when a results document cannot be understood at all. */
export class SimResultsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimResultsFormatError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readInt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/**
 * `metrics` → a plain string map.
 *
 * Non-string values are dropped rather than coerced: the Dart side's map
 * is `Map<String, String>`, so a number here means the document did not
 * come from SimCrux, and `String(42)` would launder that into something
 * indistinguishable from a real metric.
 */
function readMetrics(source: Record<string, unknown>): Record<string, string> {
  const raw = source['metrics'];
  if (!isRecord(raw)) return {};
  const metrics: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') metrics[key] = value;
  }
  return metrics;
}

/**
 * One result row, from either envelope.
 *
 * Returns `undefined` for a row with no `id`: the id is the join key
 * against the config-derived tree and the `--filter` argument for a
 * re-run, and a row that can be neither placed nor replayed is not a row.
 */
function readRow(source: Record<string, unknown>): SimTestRow | undefined {
  const id = readString(source, 'id');
  if (id === undefined) return undefined;
  const name = readString(source, 'name');
  const suite = readString(source, 'suite');
  const waveformPath = readString(source, 'waveform_path');
  const stdoutPath = readString(source, 'stdout_path');
  const stderrPath = readString(source, 'stderr_path');
  const failureMessage = readString(source, 'failure_message');
  const killSignal = readString(source, 'kill_signal');
  const exitCode = readInt(source, 'exit_code');
  return {
    id,
    // A row is always written with both, but the id carries the same
    // information (`<suite>/<name>`), so falling back to splitting it
    // keeps a hand-trimmed document usable rather than nameless.
    name: name ?? id.slice(id.indexOf('/') + 1),
    suite: suite ?? (id.includes('/') ? id.slice(0, id.indexOf('/')) : ''),
    simulator: readString(source, 'simulator') ?? '',
    status: parseSimTestStatus(source['status']),
    runtimeMs: readInt(source, 'runtime_ms') ?? 0,
    ...(waveformPath === undefined ? {} : { waveformPath }),
    ...(stdoutPath === undefined ? {} : { stdoutPath }),
    ...(stderrPath === undefined ? {} : { stderrPath }),
    ...(failureMessage === undefined ? {} : { failureMessage }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(killSignal === undefined ? {} : { killSignal }),
    metrics: readMetrics(source),
  };
}

function readMeta(source: Record<string, unknown>): SimRunMeta {
  const runId = readString(source, 'run_id') ?? readString(source, 'id');
  const startedAt = readString(source, 'started_at');
  const finishedAt = readString(source, 'finished_at');
  const configPath = readString(source, 'config_path');
  return {
    ...(runId === undefined ? {} : { runId }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(configPath === undefined ? {} : { configPath }),
  };
}

/** `results.ndjson` — one JSON object per line, `meta` / `result` / `summary`. */
function parseNdjson(text: string): SimRunDocument {
  let meta: SimRunMeta = {};
  const rows: SimTestRow[] = [];
  let complete = false;
  // Whether any line was one of the three types this format defines. An
  // unknown type *alongside* known ones is the documented extension point
  // and is ignored; a file made only of unknown types is not a SimCrux
  // results document, and saying so beats reporting a run of zero tests to
  // someone who pointed a setting at the wrong file.
  let sawKnownLine = false;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      // A truncated tail is the ordinary crash case the app's
      // `NdjsonRecovery` repairs in place. Skipping the line costs that
      // one result; failing the document would cost the whole run.
      continue;
    }
    if (!isRecord(decoded)) continue;
    switch (decoded['type']) {
      case 'meta':
        sawKnownLine = true;
        meta = { ...readMeta(decoded), ...meta };
        break;
      case 'result': {
        sawKnownLine = true;
        const row = readRow(decoded);
        if (row !== undefined) rows.push(row);
        break;
      }
      case 'summary': {
        sawKnownLine = true;
        complete = true;
        const finishedAt = readString(decoded, 'finished_at');
        if (finishedAt !== undefined) meta = { ...meta, finishedAt };
        break;
      }
      default:
        // Unknown line type — the writer's documented forward-compatible
        // extension point. Ignored, never fatal.
        break;
    }
  }

  if (!sawKnownLine) {
    throw new SimResultsFormatError(
      'no "meta", "result" or "summary" line — this is not a SimCrux results document',
    );
  }
  return { format: 'ndjson', meta, rows, complete };
}

/** `simcrux-results.json` — one object with `run` and `tests`. */
function parseConsolidated(document: Record<string, unknown>): SimRunDocument {
  const tests = document['tests'];
  if (!Array.isArray(tests)) {
    throw new SimResultsFormatError('SimCrux JSON export has no "tests" array');
  }
  const run = document['run'];
  const configPath = readString(document, 'config_path');
  const meta: SimRunMeta = {
    ...(isRecord(run) ? readMeta(run) : {}),
    ...(configPath === undefined ? {} : { configPath }),
  };
  const rows: SimTestRow[] = [];
  for (const entry of tests as readonly unknown[]) {
    if (!isRecord(entry)) continue;
    const row = readRow(entry);
    if (row !== undefined) rows.push(row);
  }
  // The consolidated export is written once, at the end of a run, from a
  // completed `TestRun` — there is no partial form of it, so unlike the
  // NDJSON there is nothing to be incomplete about.
  return { format: 'json', meta, rows, complete: true };
}

/**
 * Parse a SimCrux results document, sniffing the consolidated JSON export
 * from the NDJSON stream by shape.
 */
export function parseSimResults(text: string): SimRunDocument {
  const trimmed = text.trim();
  if (trimmed === '') throw new SimResultsFormatError('the results file is empty');
  if (trimmed.startsWith('{')) {
    // One object *may* still be a one-line NDJSON, so the discriminator is
    // the consolidated envelope's own key rather than the leading brace.
    try {
      const decoded: unknown = JSON.parse(trimmed);
      if (isRecord(decoded) && Array.isArray(decoded['tests'])) {
        return parseConsolidated(decoded);
      }
    } catch {
      // Not a single JSON document — fall through to the line reader,
      // which is what a multi-line NDJSON always lands in.
    }
  }
  return parseNdjson(text);
}
