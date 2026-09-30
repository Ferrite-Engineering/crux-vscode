import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SimResultsFormatError, parseSimResults } from '../../src/run/results';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function demoNdjson(): string {
  return readFileSync(path.join(fixtures, 'riscv-formal-demo.results.ndjson'), 'utf8');
}

/** One `result` line, with the fixture's shape and the given overrides. */
function resultLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    id: 'axi/burst',
    name: 'burst',
    suite: 'axi',
    simulator: 'verilator',
    status: 'pass',
    runtime_ms: 1234,
    started_at: '2026-08-10T09:00:00.000Z',
    finished_at: '2026-08-10T09:00:01.234Z',
    exit_code: 0,
    waveform_path: null,
    stdout_path: null,
    stderr_path: null,
    failure_message: null,
    kill_signal: null,
    ...overrides,
  });
}

describe('parseSimResults — the shipped demo run', () => {
  it('reads every row, in file order', () => {
    const document = parseSimResults(demoNdjson());
    expect(document.format).toBe('ndjson');
    expect(document.rows.map((row) => row.id)).toEqual([
      'insn/insn_add_pass',
      'insn/insn_sub_counterexample',
      'pc_fwd/pc_fwd_unknown',
      'reg/reg_timeout',
      'causal/causal_error',
      'liveness/liveness_no_outcome',
      'cover/cover_multi_trace',
    ]);
  });

  it('carries the meta line through, including config_path', () => {
    const { meta } = parseSimResults(demoNdjson());
    expect(meta.runId).toBe('1754812800000');
    expect(meta.configPath).toBe('/work/riscv-formal-demo/simcrux.yaml');
    expect(meta.startedAt).toBe('2026-08-10T09:00:00.000Z');
  });

  it('reports the run as complete when the summary line is present', () => {
    expect(parseSimResults(demoNdjson()).complete).toBe(true);
    // `finished_at` is taken from the summary, which is written last and is
    // the only line that knows when the run actually ended.
    expect(parseSimResults(demoNdjson()).meta.finishedAt).toBe('2026-08-10T09:01:47.000Z');
  });

  it('keeps every riscv.formal metric as the string the writer wrote', () => {
    const row = parseSimResults(demoNdjson()).rows[1];
    expect(row?.id).toBe('insn/insn_sub_counterexample');
    // Numbers stay strings: `TestResult.metrics` is Map<String, String> and
    // coercing here would hide a document that is not SimCrux's.
    expect(row?.metrics['riscv.formal.depth_reached']).toBe('7');
    expect(row?.metrics['riscv.formal.verdict']).toBe('FAIL');
    expect(row?.waveformPath).toBe('/work/riscv-formal-demo/insn_sub_ch0/engine_0/trace.vcd');
  });

  it('leaves waveform_path absent rather than empty when the row has none', () => {
    const row = parseSimResults(demoNdjson()).rows[0];
    expect(row?.waveformPath).toBeUndefined();
  });

  it('preserves the five-verdicts-one-status collapse the reader must not undo', () => {
    const rows = parseSimResults(demoNdjson()).rows;
    const failing = rows.filter((row) => row.status === 'fail');
    expect(failing).toHaveLength(5);
    expect(failing.map((row) => row.metrics['riscv.formal.verdict'])).toEqual([
      'FAIL',
      'UNKNOWN',
      'TIMEOUT',
      'ERROR',
      'NO_OUTCOME',
    ]);
  });
});

describe('parseSimResults — NDJSON edge cases', () => {
  it('treats a missing summary line as an unfinished run', () => {
    const lines = demoNdjson().trim().split('\n').slice(0, -1);
    expect(parseSimResults(lines.join('\n')).complete).toBe(false);
  });

  it('skips a truncated tail rather than failing the document', () => {
    // What a crash leaves behind, and what `NdjsonRecovery` repairs in the
    // app. One line lost, six rows kept.
    const lines = demoNdjson().trim().split('\n').slice(0, 7);
    const truncated = `${lines.join('\n')}\n{"type":"result","id":"cover/cover_mul`;
    const document = parseSimResults(truncated);
    expect(document.rows).toHaveLength(6);
    expect(document.complete).toBe(false);
  });

  it('ignores an unknown line type — the writer’s documented extension point', () => {
    const text = [
      '{"type":"meta","version":1,"run_id":"r1"}',
      '{"type":"coverage","version":2,"points":17}',
      resultLine(),
      '{"type":"summary","version":1,"total":1}',
    ].join('\n');
    const document = parseSimResults(text);
    expect(document.rows.map((row) => row.id)).toEqual(['axi/burst']);
    expect(document.complete).toBe(true);
  });

  it('ignores unknown keys on a row', () => {
    const text = resultLine({ retry_attempt: 3, provenance: { farm: 'zone-b' } });
    expect(parseSimResults(text).rows).toHaveLength(1);
  });

  it('drops a row with no id, because it can be neither placed nor re-run', () => {
    const text = [resultLine(), resultLine({ id: undefined })].join('\n');
    expect(parseSimResults(text).rows).toHaveLength(1);
  });

  it('degrades an unrecognised status to unknown, matching the product’s decoders', () => {
    const row = parseSimResults(resultLine({ status: 'quarantined' })).rows[0];
    expect(row?.status).toBe('unknown');
  });

  it('drops a non-string metric value rather than laundering it into one', () => {
    const row = parseSimResults(resultLine({ metrics: { 'a.b': 42, 'c.d': 'ok' } })).rows[0];
    expect(row?.metrics).toEqual({ 'c.d': 'ok' });
  });

  it('reads kill_signal, which only the NDJSON carries', () => {
    const row = parseSimResults(resultLine({ status: 'timeout', kill_signal: 'SIGKILL' })).rows[0];
    expect(row?.killSignal).toBe('SIGKILL');
  });

  it('recovers name and suite from the id when the writer omitted them', () => {
    const row = parseSimResults(resultLine({ name: undefined, suite: undefined })).rows[0];
    expect(row?.suite).toBe('axi');
    expect(row?.name).toBe('burst');
  });

  it('rejects an empty file', () => {
    expect(() => parseSimResults('   \n  ')).toThrow(SimResultsFormatError);
  });

  it('rejects a file with no JSON object on any line', () => {
    expect(() => parseSimResults('not json\nstill not json\n')).toThrow(SimResultsFormatError);
  });
});

describe('parseSimResults — the consolidated JSON export', () => {
  const consolidated = JSON.stringify({
    version: 1,
    config_path: '/work/simcrux.yaml',
    run: { id: 'r7', started_at: 'a', finished_at: 'b', total: 1 },
    tests: [
      {
        id: 'axi/burst',
        name: 'burst',
        suite: 'axi',
        simulator: 'verilator',
        status: 'fail',
        runtime_ms: 90,
        exit_code: 1,
        waveform_path: '/work/dump.fst',
        failure_message: 'Expected 0x42, got 0x41',
        metrics: { 'cov.lines': '91' },
      },
    ],
  });

  it('is sniffed from the "tests" array rather than the leading brace', () => {
    const document = parseSimResults(consolidated);
    expect(document.format).toBe('json');
    expect(document.rows).toHaveLength(1);
    expect(document.rows[0]?.failureMessage).toBe('Expected 0x42, got 0x41');
  });

  it('takes config_path from the envelope and the run id from run', () => {
    const { meta } = parseSimResults(consolidated);
    expect(meta.configPath).toBe('/work/simcrux.yaml');
    expect(meta.runId).toBe('r7');
  });

  it('is always complete — there is no partial form of it', () => {
    expect(parseSimResults(consolidated).complete).toBe(true);
  });

  it('still reads a one-line NDJSON that happens to start with a brace', () => {
    const document = parseSimResults(resultLine());
    expect(document.format).toBe('ndjson');
    expect(document.rows).toHaveLength(1);
  });

  it('rejects an object that is neither shape', () => {
    expect(() => parseSimResults('{"version":1,"run":{}}')).toThrow(SimResultsFormatError);
  });
});
