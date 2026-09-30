import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NameIndex } from '../../src/names/name-index';
import type { StemsEntry } from '../../src/names/stems-parser';
import { resolveViewport, type ViewportLine } from '../../src/annotate/model';

/**
 * The performance claim, measured.
 *
 * RTL annotation's deliverable is not "annotation works" — it is "annotation does not
 * make the editor feel slow", and that is a number, not an assertion. This
 * file produces the number on **real HDL** against an index the size of a
 * real design, and fails if it drifts past the point where it would start to
 * be felt.
 *
 * What is timed is the synchronous half only: viewport scan, identifier
 * extraction, and the index lookups. That is the part that runs on the
 * extension host's thread while the user is scrolling. The value query is
 * asynchronous, off-process, and cannot block a keystroke however slow it is.
 *
 * The budget it has to fit inside is the 60 ms debounce
 * (`DEFAULT_DEBOUNCE_MS`). The bound asserted below is far looser than the
 * measured value on purpose: a regression test that tracks the current
 * number would fail on a busy CI machine, and one that tracks the *budget*
 * fails only when the property being claimed has actually stopped holding.
 */

const RTL = fileURLToPath(new URL('../fixtures/rtl/rv32_cpu.v', import.meta.url));
const SOURCE_FILE = '/ws/rtl/rv32_cpu.v';

/** A viewport-sized window of real RTL, 1-based. */
function viewport(lines: number): readonly ViewportLine[] {
  const text = readFileSync(RTL, 'utf8').split('\n');
  // From the decode block: continuous assignments, bit slices and an
  // instantiation port map — the identifier-dense part of the file, which is
  // the honest place to measure.
  const start = 20;
  return Array.from({ length: lines }, (_, offset) => ({
    line: start + offset,
    text: text[(start + offset - 1) % text.length] ?? '',
  }));
}

/**
 * An index the size of a real design: a quarter of a million entries across
 * 300 stems files, plus one shard that actually covers the fixture.
 *
 * The bulk exists to prove the claim that matters — that resolution cost is
 * a function of the **viewport**, not of the design. If it were not, this is
 * where it would show.
 */
function largeIndex(): NameIndex {
  const index = new NameIndex('linux');
  const identifiers = [
    'clk', 'rst', 'pc', 'instr', 'opcode', 'rd', 'funct3', 'rs1', 'rs2',
    'funct7', 'imm_i', 'imm_s', 'imm_b', 'imm_j', 'rs1_val', 'rs2_val',
    'rf_we', 'rf_wdata', 'alu_result', 'branch_taken',
  ];

  for (let file = 0; file < 300; file++) {
    const entries: StemsEntry[] = [];
    for (let entry = 0; entry < 800; entry++) {
      entries.push({
        path: `top.block${file}.sub${entry % 40}.net_${entry}`,
        sourceFile: `/ws/rtl/generated/block${file}.sv`,
        lineNumber: (entry % 900) + 1,
        kind: 'variable',
      });
    }
    index.replace(`/ws/stems/block${file}.stems`, entries);
  }

  // The shard that covers the file under test: every identifier declared on
  // several lines, as a real stems file for a real module would be.
  const covered: StemsEntry[] = [];
  for (let line = 1; line <= 123; line++) {
    for (const identifier of identifiers) {
      covered.push({
        path: `top.cpu.${identifier}`,
        sourceFile: SOURCE_FILE,
        lineNumber: line,
        kind: 'variable',
      });
    }
  }
  index.replace('/ws/stems/rv32_cpu.stems', covered);
  return index;
}

/** Median and p95 of [samples] milliseconds. */
function summarize(samples: number[]): { median: number; p95: number; mean: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  return {
    median: at(0.5),
    p95: at(0.95),
    mean: samples.reduce((total, sample) => total + sample, 0) / samples.length,
  };
}

function measure(lines: readonly ViewportLine[], index: NameIndex, runs: number): number[] {
  // Warm up: the first pass pays for JIT and for the index's first touch of
  // every bucket it reads, neither of which a scrolling user pays again.
  for (let run = 0; run < 20; run++) {
    resolveViewport({ index, fsPath: SOURCE_FILE, languageId: 'verilog', lines });
  }
  const samples: number[] = [];
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    resolveViewport({ index, fsPath: SOURCE_FILE, languageId: 'verilog', lines });
    samples.push(performance.now() - started);
  }
  return samples;
}

describe('annotation resolution — measured', () => {
  it('resolves a full viewport of real RTL well inside the debounce window', () => {
    const index = largeIndex();
    expect(index.size).toBeGreaterThan(240_000);

    const lines = viewport(40);
    const resolution = resolveViewport({
      index,
      fsPath: SOURCE_FILE,
      languageId: 'verilog',
      lines,
    });
    const timing = summarize(measure(lines, index, 300));

    // The number IS the deliverable: printed, not just asserted.
    console.log(
      `[rtl annotation profile] 40-line viewport, ${index.size} indexed entries: ` +
        `${resolution.lookups} lookups, ${resolution.paths.length} paths, ` +
        `${resolution.lines.length} annotated lines — ` +
        `median ${timing.median.toFixed(3)} ms, mean ${timing.mean.toFixed(3)} ms, ` +
        `p95 ${timing.p95.toFixed(3)} ms`,
    );

    // A quarter of the 60 ms debounce. Measured on a 2026 laptop this comes
    // out around two hundredths of a millisecond; the bound is where the
    // claim would stop being true, not where it currently sits.
    expect(timing.median).toBeLessThan(15);
  });

  it('costs the same on a large design as on a small one', () => {
    // The claim the bidirectional index exists to support. If resolution
    // were a scan, a 300× bigger index would show here and nowhere else.
    const small = new NameIndex('linux');
    small.replace('/ws/stems/rv32_cpu.stems', [
      {
        path: 'top.cpu.clk',
        sourceFile: SOURCE_FILE,
        lineNumber: 16,
        kind: 'variable',
      },
    ]);
    const lines = viewport(40);

    const big = summarize(measure(lines, largeIndex(), 200));
    const tiny = summarize(measure(lines, small, 200));

    // The comparison IS the deliverable: printed, not just asserted.
    console.log(
      `[rtl annotation profile] same viewport, 240k-entry index ${big.median.toFixed(3)} ms vs ` +
        `1-entry index ${tiny.median.toFixed(3)} ms`,
    );

    // Generous: both numbers are tens of microseconds, where scheduler noise
    // is a large fraction of the measurement. What is being refuted is an
    // order-of-magnitude difference, which is what a scan would produce.
    expect(big.median).toBeLessThan(Math.max(tiny.median * 8, 1));
  });

  it('spends little enough per lookup that candidatesFor needs no change', () => {
    // `NameIndex.candidatesFor` allocates a `Map` per call, and whether a
    // bucket-level filter was worth building instead is a question for a
    // profile, not a guess. This is that measurement: the
    // lookups alone, isolated from tokenization, at viewport scale.
    const index = largeIndex();
    const identifiers = ['clk', 'instr', 'opcode', 'rs1_val', 'rf_wdata', 'nope_not_here'];
    const runs = 2_000;

    for (let run = 0; run < 200; run++) {
      for (const identifier of identifiers) {
        index.candidatesFor({ fsPath: SOURCE_FILE, line: 24, identifier });
      }
    }
    const started = performance.now();
    for (let run = 0; run < runs; run++) {
      for (const identifier of identifiers) {
        index.candidatesFor({ fsPath: SOURCE_FILE, line: 24, identifier });
      }
    }
    const perLookupUs = ((performance.now() - started) / (runs * identifiers.length)) * 1000;

    // The number IS the deliverable: printed, not just asserted.
    console.log(
      `[rtl annotation profile] candidatesFor: ${perLookupUs.toFixed(3)} µs per lookup ` +
        `(a 40-line viewport makes ~60 of them, so ~` +
        `${((perLookupUs * 60) / 1000).toFixed(3)} ms of a 60 ms debounce)`,
    );

    // The decision this bound records: a viewport's worth of lookups has to
    // stay under a millisecond — under 2% of the debounce — for the
    // per-call allocation to be beneath notice. It measures around a tenth
    // of that, so `candidatesFor` keeps its simple shape.
    expect((perLookupUs * 60) / 1000).toBeLessThan(1);
  });

  it('stays inside the budget for a pathologically dense viewport', () => {
    // The bound `AnnotationLimits` actually allows: 400 lines, 8 identifiers
    // each. Nobody's screen shows this; a folded-open region plus a small
    // font can approach it, and the debounce has to survive it.
    const index = largeIndex();
    const lines = viewport(400);
    const timing = summarize(measure(lines, index, 60));

    // The number IS the deliverable: printed, not just asserted.
    console.log(
      `[rtl annotation profile] 400-line worst case: median ${timing.median.toFixed(3)} ms, ` +
        `p95 ${timing.p95.toFixed(3)} ms`,
    );

    expect(timing.median).toBeLessThan(60);
  });
});
