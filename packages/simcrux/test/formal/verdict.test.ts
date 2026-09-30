import { describe, expect, it } from 'vitest';
import {
  FORMAL_METRICS,
  RISCV_FORMAL_VERDICTS,
  hasCounterexample,
  isFormalPropertyRow,
  metricInt,
  parseRiscvFormalVerdict,
  verdictDetail,
  verdictOf,
  verdictSummary,
  verdictTagId,
} from '../../src/formal/verdict';
import type { SimTestRow } from '../../src/run/model';

function row(overrides: Partial<SimTestRow> = {}): SimTestRow {
  return {
    id: 'insn/p',
    name: 'p',
    suite: 'insn',
    simulator: 'riscv_formal',
    status: 'fail',
    runtimeMs: 1000,
    metrics: {},
    ...overrides,
  };
}

function formalRow(verdict: string, metrics: Record<string, string> = {}): SimTestRow {
  return row({ metrics: { [FORMAL_METRICS.verdict]: verdict, ...metrics } });
}

describe('parseRiscvFormalVerdict', () => {
  it('accepts every token sby prints, plus SimCrux’s synthetic NO_OUTCOME', () => {
    expect(RISCV_FORMAL_VERDICTS).toEqual([
      'PASS',
      'FAIL',
      'UNKNOWN',
      'ERROR',
      'TIMEOUT',
      'NO_OUTCOME',
    ]);
    for (const verdict of RISCV_FORMAL_VERDICTS) {
      expect(parseRiscvFormalVerdict(verdict)).toBe(verdict);
    }
  });

  it('trims and uppercases, matching RiscvFormalVerdict.fromWireName', () => {
    expect(parseRiscvFormalVerdict('  fail ')).toBe('FAIL');
  });

  it('does NOT fall back to a value for an unrecognised token', () => {
    // Falling back to NO_OUTCOME would be a specific claim about the log
    // ("sby printed no DONE line") made on no evidence.
    expect(parseRiscvFormalVerdict('INCONCLUSIVE')).toBeUndefined();
    expect(parseRiscvFormalVerdict(undefined)).toBeUndefined();
    expect(parseRiscvFormalVerdict(7)).toBeUndefined();
  });
});

describe('isFormalPropertyRow — the mirror of RiscvResultKind', () => {
  it('is exactly "riscv.formal.verdict is present"', () => {
    expect(isFormalPropertyRow(formalRow('PASS'))).toBe(true);
    expect(isFormalPropertyRow(row())).toBe(false);
  });

  it('claims a NO_OUTCOME row — the run that learned nothing must not vanish', () => {
    expect(isFormalPropertyRow(formalRow('NO_OUTCOME'))).toBe(true);
  });

  it('does not claim an architectural-compatibility row', () => {
    // `riscv.signature.word_size` present, verdict absent. A `riscv.`
    // prefix test would fold these in and there is no trace to address.
    const arch = row({
      metrics: { 'riscv.signature.word_size': '4', 'riscv.isa': 'rv32i', 'riscv.mode': 'normal' },
    });
    expect(isFormalPropertyRow(arch)).toBe(false);
    expect(hasCounterexample(arch)).toBe(false);
  });
});

describe('verdictSummary — five failures, five different sentences', () => {
  /** Every non-PASS verdict, as the tree renders it. */
  const summaries = (): Record<string, string> => ({
    FAIL: verdictSummary(formalRow('FAIL', { [FORMAL_METRICS.depthReached]: '7' }), 'FAIL'),
    UNKNOWN: verdictSummary(formalRow('UNKNOWN'), 'UNKNOWN'),
    TIMEOUT: verdictSummary(formalRow('TIMEOUT'), 'TIMEOUT'),
    ERROR: verdictSummary(formalRow('ERROR'), 'ERROR'),
    NO_OUTCOME: verdictSummary(formalRow('NO_OUTCOME'), 'NO_OUTCOME'),
  });

  it('gives the five TestStatus.fail verdicts five distinct descriptions', () => {
    // THE constraint: five SymbiYosys verdicts share one TestStatus.fail
    // by design, and this is what stops the tree collapsing them.
    const values = Object.values(summaries());
    expect(new Set(values).size).toBe(5);
  });

  it('distinguishes "counterexample found" from "the engine did not decide"', () => {
    const { FAIL, UNKNOWN } = summaries();
    expect(FAIL).toContain('counterexample');
    expect(UNKNOWN).not.toContain('counterexample');
    expect(UNKNOWN).toContain('did not decide');
  });

  it('names the step a counterexample was found at, when sby reported one', () => {
    expect(verdictSummary(formalRow('FAIL', { [FORMAL_METRICS.depthReached]: '7' }), 'FAIL')).toBe(
      'counterexample at step 7',
    );
  });

  it('says "counterexample found" without a step rather than guessing step 0', () => {
    // Step 0 is the trace's initial state — a real, wrong answer, which is
    // why the CXP producer emits no coordinate in this case either.
    expect(verdictSummary(formalRow('FAIL'), 'FAIL')).toBe('counterexample found');
  });

  it('reports the bound a passing proof held over, when it is known', () => {
    expect(
      verdictSummary(formalRow('PASS', { [FORMAL_METRICS.depthConfigured]: '20' }), 'PASS'),
    ).toBe('proved to depth 20');
    expect(verdictSummary(formalRow('PASS'), 'PASS')).toBe('proved');
  });
});

describe('verdictTagId', () => {
  it('carries the verbatim token, so the filter means one thing in every locale', () => {
    expect(verdictTagId('NO_OUTCOME')).toBe('riscv.formal.verdict=NO_OUTCOME');
  });

  it('is distinct for every verdict', () => {
    expect(new Set(RISCV_FORMAL_VERDICTS.map(verdictTagId)).size).toBe(
      RISCV_FORMAL_VERDICTS.length,
    );
  });
});

describe('verdictDetail', () => {
  it('names the verdict on the first line', () => {
    expect(verdictDetail(formalRow('UNKNOWN'), 'UNKNOWN')[0]).toBe('SymbiYosys verdict: UNKNOWN');
  });

  it('reports depth as the reached/configured PAIR, not one number', () => {
    const detail = verdictDetail(
      formalRow('FAIL', {
        [FORMAL_METRICS.depthReached]: '7',
        [FORMAL_METRICS.depthConfigured]: '20',
      }),
      'FAIL',
    );
    expect(detail).toContain('Depth: reached 7 of 20 configured');
  });

  it('says which half is missing rather than reporting a bare depth', () => {
    expect(verdictDetail(formalRow('FAIL', { [FORMAL_METRICS.depthReached]: '7' }), 'FAIL')).toContain(
      'Depth reached: 7 (the configured bound was not recorded)',
    );
    expect(
      verdictDetail(formalRow('FAIL', { [FORMAL_METRICS.depthConfigured]: '20' }), 'FAIL'),
    ).toContain('Depth configured: 20 (the engine reported no depth)');
  });

  it('labels wall time with its provenance — engine vs. measured', () => {
    const engine = verdictDetail(
      formalRow('FAIL', {
        [FORMAL_METRICS.wallTimeMs]: '7000',
        [FORMAL_METRICS.wallTimeSource]: 'engine',
      }),
      'FAIL',
    );
    const measured = verdictDetail(
      formalRow('FAIL', {
        [FORMAL_METRICS.wallTimeMs]: '7000',
        [FORMAL_METRICS.wallTimeSource]: 'measured',
      }),
      'FAIL',
    );
    expect(engine).toContain('Wall time: 7.0s, as reported by the engine');
    expect(measured).toContain('Wall time: 7.0s, measured around the job');
    expect(engine).not.toEqual(measured);
  });

  it('says so when the source was not recorded, rather than picking one', () => {
    expect(
      verdictDetail(formalRow('FAIL', { [FORMAL_METRICS.wallTimeMs]: '500' }), 'FAIL'),
    ).toContain('Wall time: 0.5s (source not recorded)');
  });

  it('states outright that an undecided proof has no trace', () => {
    for (const verdict of ['UNKNOWN', 'TIMEOUT', 'NO_OUTCOME'] as const) {
      expect(verdictDetail(formalRow(verdict), verdict).join('\n')).toContain(
        'This is not a counterexample',
      );
    }
    expect(verdictDetail(formalRow('FAIL'), 'FAIL').join('\n')).not.toContain(
      'This is not a counterexample',
    );
  });

  it('surfaces an announced-but-unresolvable trace instead of silence', () => {
    const detail = verdictDetail(
      formalRow('FAIL', { [FORMAL_METRICS.traceUnresolved]: 'engine_0/trace.vcd' }),
      'FAIL',
    );
    expect(detail.join('\n')).toContain('engine_0/trace.vcd');
    expect(detail.join('\n')).toContain('could not find that file');
  });

  it('marks a demo-mode row so a replay is never mistaken for a solver run', () => {
    expect(
      verdictDetail(formalRow('FAIL', { [FORMAL_METRICS.mode]: 'demo' }), 'FAIL').join('\n'),
    ).toContain('replayed from committed demo fixtures');
    expect(
      verdictDetail(formalRow('FAIL', { [FORMAL_METRICS.mode]: 'normal' }), 'FAIL').join('\n'),
    ).not.toContain('replayed');
  });
});

describe('hasCounterexample — the exact mirror of riscvStreamCoordinateFor’s gate', () => {
  const trace = '/work/insn_sub_ch0/engine_0/trace.vcd';

  it('is true only for a FAIL row with a resolvable trace', () => {
    expect(hasCounterexample(formalRow('FAIL', {}))).toBe(false);
    expect(
      hasCounterexample(row({ metrics: { [FORMAL_METRICS.verdict]: 'FAIL' }, waveformPath: trace })),
    ).toBe(true);
  });

  it('is false for every verdict that learned nothing, even with a stray path', () => {
    // Offering the handoff here would assert a counterexample exists,
    // which is the one thing the formal surface must never say.
    for (const verdict of ['UNKNOWN', 'TIMEOUT', 'ERROR', 'NO_OUTCOME', 'PASS'] as const) {
      expect(
        hasCounterexample(
          row({ metrics: { [FORMAL_METRICS.verdict]: verdict }, waveformPath: trace }),
        ),
      ).toBe(false);
    }
  });

  it('is false for a non-formal row that happens to have a waveform', () => {
    expect(hasCounterexample(row({ waveformPath: '/work/dump.fst' }))).toBe(false);
  });

  it('is false when the path is empty rather than absent', () => {
    expect(
      hasCounterexample(row({ metrics: { [FORMAL_METRICS.verdict]: 'FAIL' }, waveformPath: '' })),
    ).toBe(false);
  });
});

describe('verdictOf / metricInt', () => {
  it('reads the verdict off the metrics map', () => {
    expect(verdictOf(formalRow('TIMEOUT'))).toBe('TIMEOUT');
    expect(verdictOf(row())).toBeUndefined();
  });

  it('parses a string-valued numeric metric, and refuses a non-numeric one', () => {
    expect(metricInt(formalRow('FAIL', { [FORMAL_METRICS.depthReached]: '7' }), FORMAL_METRICS.depthReached)).toBe(7);
    expect(metricInt(formalRow('FAIL', { [FORMAL_METRICS.depthReached]: 'deep' }), FORMAL_METRICS.depthReached)).toBeUndefined();
    expect(metricInt(formalRow('FAIL'), FORMAL_METRICS.depthReached)).toBeUndefined();
  });
});
