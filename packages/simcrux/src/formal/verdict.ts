/**
 * `riscv.formal.verdict` — the distinction the whole formal track exists
 * to preserve, carried into the Test Explorer.
 *
 * ### The problem, stated once
 *
 * SymbiYosys reports six outcomes. **Five of them map to one
 * `TestStatus.fail`, by design** (`riscv_formal_verdict.dart`): `unknown`
 * would hand the verdict back to the exit code, and `vacuous` would delete
 * the work directory holding the counterexample VCD, so every non-`PASS`
 * outcome is a plain `fail` and the *shape* of the failure survives in the
 * `riscv.formal.verdict` metric instead.
 *
 * That means a test tree driven by `TestStatus` alone renders these five
 * rows identically:
 *
 * - a **counterexample was found** — the property is false, and there is a
 *   trace showing exactly how;
 * - the **engine could not decide** — nothing was proved and nothing was
 *   refuted;
 * - the engine's **own solver budget expired**;
 * - **SymbiYosys errored** and the proof never ran at all;
 * - **no verdict was reported** — the trap: `sby` exited 0 having
 *   concluded nothing.
 *
 * Collapsing those into one red icon deletes the only information a formal
 * run produces. B7's dashboard exists because of this distinction; the
 * editor surface must not be the place it is lost.
 *
 * ### How it is preserved here — three mechanisms, deliberately
 *
 * 1. **`TestItem.description`** ([verdictSummary]). VSCode renders the
 *    description greyed beside the label, always, with nothing to expand
 *    or hover. This is the mechanism that satisfies "distinguishable *in
 *    the tree*": the five rows above read as five different sentences at a
 *    glance.
 * 2. **`TestTag`** ([verdictTagId]). Tags are filterable in the Test
 *    Explorer, so "show me only the counterexamples" is a filter rather
 *    than a read-through. The tag id carries [RiscvFormalVerdict] verbatim
 *    — uppercase, unlocalized — because it is the same token the Pro
 *    dashboard and the exported report key off, and a localized tag would
 *    make the filter mean different things in different locales.
 * 3. **`TestMessage`** ([verdictDetail]). The failure detail names the
 *    verdict and, for a counterexample, the `depth_reached` /
 *    `depth_configured` **pair** rather than one depth number — B7's
 *    finding: "reached 7" and "reached 7 of 20" are different claims — plus
 *    the engine and the wall time *with its provenance*, because a figure
 *    that might be either the solver's or a stopwatch's is not a
 *    measurement.
 *
 * All three are driven from the same [RiscvFormalVerdict], so they cannot
 * disagree with each other.
 */
import * as vscode from 'vscode';
import type { SimTestRow } from '../run/model';

/**
 * Metric keys, mirroring `RiscvFormalDriver`'s constants exactly.
 *
 * Spelled here as a frozen table rather than inline, for the same reason
 * the Dart side made them constants: two readers of one convention drift,
 * and the CXP producer, the Pro dashboard and this extension are now
 * three.
 */
export const FORMAL_METRICS = {
  verdict: 'riscv.formal.verdict',
  check: 'riscv.formal.check',
  group: 'riscv.formal.group',
  channel: 'riscv.formal.channel',
  proofMode: 'riscv.formal.proof_mode',
  depthReached: 'riscv.formal.depth_reached',
  depthConfigured: 'riscv.formal.depth_configured',
  wallTimeMs: 'riscv.formal.wall_time_ms',
  wallTimeSource: 'riscv.formal.wall_time_source',
  engine: 'riscv.formal.engine',
  traceCount: 'riscv.formal.trace_count',
  traceUnresolved: 'riscv.formal.trace_unresolved',
  returnCode: 'riscv.formal.rc',
  /** Shared with `riscv_arch` **by reference** on the Dart side. */
  mode: 'riscv.mode',
  isa: 'riscv.isa',
} as const;

/** `riscv.formal.wall_time_source` values. */
export const WALL_TIME_SOURCE_ENGINE = 'engine';
export const WALL_TIME_SOURCE_MEASURED = 'measured';

/**
 * The six `riscv.formal.verdict` values, spelled as `sby` prints them.
 *
 * `NO_OUTCOME` is SimCrux's own synthetic sixth: it is what a log with no
 * `DONE (…)` line at all becomes, and it carries the key precisely so the
 * run that learned nothing cannot disappear from the set of runs.
 */
export const RISCV_FORMAL_VERDICTS = [
  'PASS',
  'FAIL',
  'UNKNOWN',
  'ERROR',
  'TIMEOUT',
  'NO_OUTCOME',
] as const;

export type RiscvFormalVerdict = (typeof RISCV_FORMAL_VERDICTS)[number];

/**
 * Parse a verdict token, or `undefined` when it is not one we recognise.
 *
 * Trimmed and uppercased, matching `RiscvFormalVerdict.fromWireName`.
 * Unlike the status parser this does **not** fall back to a value: an
 * unrecognised verdict must not be rendered as `NO_OUTCOME`, which is a
 * specific claim about the log rather than a shrug.
 */
export function parseRiscvFormalVerdict(raw: unknown): RiscvFormalVerdict | undefined {
  if (typeof raw !== 'string') return undefined;
  const upper = raw.trim().toUpperCase();
  return (RISCV_FORMAL_VERDICTS as readonly string[]).includes(upper)
    ? (upper as RiscvFormalVerdict)
    : undefined;
}

/**
 * Whether [row] came from the bounded-proof driver.
 *
 * **`riscv.formal.verdict` present — and only that.** The exact mirror of
 * open core's `RiscvResultKind.isFormalPropertyRow`, which is the single
 * definition the CXP producer and both Pro dashboards share. A `riscv.`
 * prefix test would fold architectural-compatibility rows in, and those
 * carry no trace at all.
 */
export function isFormalPropertyRow(row: SimTestRow): boolean {
  return FORMAL_METRICS.verdict in row.metrics;
}

/** [row]'s verdict, when it is a formal property row with a legible one. */
export function verdictOf(row: SimTestRow): RiscvFormalVerdict | undefined {
  return parseRiscvFormalVerdict(row.metrics[FORMAL_METRICS.verdict]);
}

/** An integer-valued metric, or `undefined` when absent or unparseable. */
export function metricInt(row: SimTestRow, key: string): number | undefined {
  const raw = row.metrics[key];
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

/** The `TestTag` id for a verdict. Verbatim token — never localized. */
export function verdictTagId(verdict: RiscvFormalVerdict): string {
  return `${FORMAL_METRICS.verdict}=${verdict}`;
}

/**
 * The one-line sentence that goes in `TestItem.description`.
 *
 * These are the five distinctions rendered as words. Localized — this is
 * prose the user reads, not a token anything keys off — while
 * [verdictTagId] stays verbatim for exactly that reason.
 */
export function verdictSummary(row: SimTestRow, verdict: RiscvFormalVerdict): string {
  const reached = metricInt(row, FORMAL_METRICS.depthReached);
  switch (verdict) {
    case 'PASS': {
      const configured = metricInt(row, FORMAL_METRICS.depthConfigured);
      return configured === undefined
        ? vscode.l10n.t('proved')
        : vscode.l10n.t('proved to depth {0}', configured);
    }
    case 'FAIL':
      return reached === undefined
        ? vscode.l10n.t('counterexample found')
        : vscode.l10n.t('counterexample at step {0}', reached);
    case 'UNKNOWN':
      return vscode.l10n.t('the engine did not decide');
    case 'TIMEOUT':
      return vscode.l10n.t('the solver budget expired');
    case 'ERROR':
      return vscode.l10n.t('SymbiYosys errored — the proof never ran');
    case 'NO_OUTCOME':
      return vscode.l10n.t('no verdict reported');
  }
}

/**
 * The detail block for the `TestMessage` on a failing property.
 *
 * Depth is reported as the **pair** or not at all: a bare "depth 7" reads
 * as a property of the proof when it is a property of where the engine got
 * to. Wall time always carries its provenance for the same reason.
 */
export function verdictDetail(row: SimTestRow, verdict: RiscvFormalVerdict): readonly string[] {
  const lines: string[] = [vscode.l10n.t('SymbiYosys verdict: {0}', verdict)];

  const check = row.metrics[FORMAL_METRICS.check];
  if (check !== undefined) lines.push(vscode.l10n.t('Check: {0}', check));
  const group = row.metrics[FORMAL_METRICS.group];
  if (group !== undefined) lines.push(vscode.l10n.t('Check group: {0}', group));

  const reached = metricInt(row, FORMAL_METRICS.depthReached);
  const configured = metricInt(row, FORMAL_METRICS.depthConfigured);
  if (reached !== undefined && configured !== undefined) {
    lines.push(vscode.l10n.t('Depth: reached {0} of {1} configured', reached, configured));
  } else if (reached !== undefined) {
    lines.push(vscode.l10n.t('Depth reached: {0} (the configured bound was not recorded)', reached));
  } else if (configured !== undefined) {
    lines.push(vscode.l10n.t('Depth configured: {0} (the engine reported no depth)', configured));
  }

  const engine = row.metrics[FORMAL_METRICS.engine];
  if (engine !== undefined) lines.push(vscode.l10n.t('Engine: {0}', engine));

  const wallTimeMs = metricInt(row, FORMAL_METRICS.wallTimeMs);
  if (wallTimeMs !== undefined) {
    const seconds = (wallTimeMs / 1000).toFixed(1);
    const source = row.metrics[FORMAL_METRICS.wallTimeSource];
    lines.push(
      source === WALL_TIME_SOURCE_ENGINE
        ? vscode.l10n.t('Wall time: {0}s, as reported by the engine', seconds)
        : source === WALL_TIME_SOURCE_MEASURED
          ? vscode.l10n.t('Wall time: {0}s, measured around the job', seconds)
          : vscode.l10n.t('Wall time: {0}s (source not recorded)', seconds),
    );
  }

  // A trace `sby` announced but SimCrux could not find is recorded rather
  // than silently becoming "no counterexample" — the same judgement B4
  // made writing the metric in the first place.
  const unresolved = row.metrics[FORMAL_METRICS.traceUnresolved];
  if (unresolved !== undefined) {
    lines.push(
      vscode.l10n.t(
        'SymbiYosys announced a counterexample trace at {0}, but SimCrux could not find that file. There is nothing to open.',
        unresolved,
      ),
    );
  }

  // `riscv.mode: demo` is a replay of committed fixtures. It must never be
  // mistaken on screen for a solver that ran, which is the same reason the
  // exported report carries a provenance banner.
  if (row.metrics[FORMAL_METRICS.mode] === 'demo') {
    lines.push(
      vscode.l10n.t(
        'This row was replayed from committed demo fixtures — no solver ran for it.',
      ),
    );
  }

  if (verdict === 'UNKNOWN' || verdict === 'TIMEOUT' || verdict === 'NO_OUTCOME') {
    lines.push(
      vscode.l10n.t(
        'Nothing was proved and nothing was refuted. This is not a counterexample: there is no trace, because the engine never found one.',
      ),
    );
  }

  return lines;
}

/**
 * Whether a counterexample can actually be opened for [row].
 *
 * **The exact mirror of open core's `riscvStreamCoordinateFor` gate**: a
 * formal property row, verdict exactly `FAIL`, and a non-empty
 * `waveformPath`. Offering the handoff for `UNKNOWN` or `TIMEOUT` would
 * imply a counterexample exists — the one thing the formal surface is
 * built never to say.
 *
 * Deliberately not a filesystem check: whether the file is *there* is a
 * separate question with a separate answer (the regression may have run on
 * a farm), and `../counterexample/handoff.ts` asks it at the point of use.
 */
export function hasCounterexample(row: SimTestRow): boolean {
  return (
    isFormalPropertyRow(row) &&
    verdictOf(row) === 'FAIL' &&
    row.waveformPath !== undefined &&
    row.waveformPath !== ''
  );
}
