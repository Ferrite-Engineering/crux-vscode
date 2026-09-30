import { describe, expect, it } from 'vitest';
import { detectSimTerminalLinks } from '../src/terminal-links';

/** The single link in [line], or undefined when there is none. */
function only(line: string): ReturnType<typeof detectSimTerminalLinks>[number] | undefined {
  const links = detectSimTerminalLinks(line);
  expect(links.length).toBeLessThanOrEqual(1);
  return links[0];
}

/** The substring a link actually covers — what the user clicks. */
function covered(line: string, index = 0): string {
  const link = detectSimTerminalLinks(line)[index];
  return link === undefined ? '' : line.slice(link.startIndex, link.startIndex + link.length);
}

describe('detectSimTerminalLinks — SymbiYosys trace announcements', () => {
  it('claims the VCD in "Writing trace to VCD file:"', () => {
    const line = 'SBY 12:34:11 [insn_sub_ch0] engine_0: ##   0:00:07  Writing trace to VCD file: engine_0/trace.vcd';
    expect(only(line)?.target).toEqual({ kind: 'trace', path: 'engine_0/trace.vcd' });
    expect(covered(line)).toBe('engine_0/trace.vcd');
  });

  it('claims the VCD in the counterexample summary line', () => {
    const line = 'SBY 12:34:11 [insn_sub_ch0] summary: counterexample trace: insn_sub_ch0/engine_0/trace.vcd';
    expect(only(line)?.target).toEqual({
      kind: 'trace',
      path: 'insn_sub_ch0/engine_0/trace.vcd',
    });
  });

  it('claims a cover trace too — a cover run writes one per statement', () => {
    const line = 'summary: cover trace: cover_ch0/engine_0/trace0.vcd';
    expect(only(line)?.target).toEqual({ kind: 'trace', path: 'cover_ch0/engine_0/trace0.vcd' });
  });

  it('claims an FST announcement', () => {
    expect(only('Writing trace to FST file: engine_0/trace.fst')?.target).toEqual({
      kind: 'trace',
      path: 'engine_0/trace.fst',
    });
  });

  it('does NOT claim a bare .vcd mentioned in passing', () => {
    // Anchored on the announcement, not on the extension: an engine that
    // merely names a file it did not write would otherwise get a link to
    // something that does not exist.
    expect(detectSimTerminalLinks('note: consider deleting old_dump.vcd before rerunning')).toEqual(
      [],
    );
  });

  it('ignores an announcement whose target is not a waveform container', () => {
    expect(detectSimTerminalLinks('summary: counterexample trace: engine_0/trace.txt')).toEqual([]);
  });
});

describe('detectSimTerminalLinks — source references', () => {
  it('claims a Verilator error with line and column', () => {
    const line = '%Error: tb_alu.sv:128:7: Assertion failed in top.tb_alu';
    expect(only(line)?.target).toEqual({
      kind: 'source',
      path: 'tb_alu.sv',
      line: 128,
      column: 7,
    });
    expect(covered(line)).toBe('tb_alu.sv:128:7');
  });

  it('claims an Icarus reference with a line only', () => {
    expect(only('tb.v:41: $finish called at 1200 (1ps)')?.target).toEqual({
      kind: 'source',
      path: 'tb.v',
      line: 41,
    });
  });

  it('claims a VHDL reference', () => {
    expect(only('ghdl:error: assertion failed at counter_tb.vhd:88')?.target).toEqual({
      kind: 'source',
      path: 'counter_tb.vhd',
      line: 88,
    });
  });

  it('claims a path with directories', () => {
    expect(only('rtl/core/alu.sv:12: warning')?.target).toEqual({
      kind: 'source',
      path: 'rtl/core/alu.sv',
      line: 12,
    });
  });

  it('claims a Python traceback frame from a cocotb run', () => {
    expect(only('  File "tests/test_alu.py:64", line 64, in run')).toBeDefined();
  });

  it('does NOT mistake sby’s own progress timestamps for a source reference', () => {
    // The single most common false positive in a formal log, and the
    // reason the pattern is anchored on a known source extension.
    expect(
      detectSimTerminalLinks('SBY 12:34:11 [insn_add_ch0] engine_0: ##   0:00:04  Checking assertions in step 19..'),
    ).toEqual([]);
  });

  it('does not claim a line number of 0', () => {
    expect(detectSimTerminalLinks('tb.sv:0: nothing here')).toEqual([]);
  });

  it('does not claim a file with an extension it does not know', () => {
    expect(detectSimTerminalLinks('notes.txt:12: something')).toEqual([]);
  });
});

describe('detectSimTerminalLinks — overlap and ordering', () => {
  it('never emits overlapping links, which VSCode rejects outright', () => {
    const line = 'summary: counterexample trace: checks/insn_sub_ch0/engine_0/trace.vcd';
    const links = detectSimTerminalLinks(line);
    for (let i = 1; i < links.length; i += 1) {
      const previous = links[i - 1];
      const current = links[i];
      if (previous === undefined || current === undefined) continue;
      expect(previous.startIndex + previous.length).toBeLessThanOrEqual(current.startIndex);
    }
  });

  it('returns links in the order they appear in the line', () => {
    const line = 'tb.sv:10: see also rtl/alu.sv:20:3';
    const links = detectSimTerminalLinks(line);
    expect(links).toHaveLength(2);
    expect(links[0]?.startIndex).toBeLessThan(links[1]?.startIndex ?? 0);
    expect(covered(line, 0)).toBe('tb.sv:10');
    expect(covered(line, 1)).toBe('rtl/alu.sv:20:3');
  });

  it('claims nothing in ordinary chatter', () => {
    expect(detectSimTerminalLinks('SBY 12:34:11 [insn_add_ch0] Removing directory.')).toEqual([]);
    expect(detectSimTerminalLinks('')).toEqual([]);
  });
});
