import { describe, expect, it } from 'vitest';
import {
  parseWaveCruxLink,
  parseWaveCruxLinkTime,
  wholePicoseconds,
  WAVECRUX_LINK_EXTENSIONS,
} from '../../src/links/wavecrux-link';

function refusalOf(raw: string): string | undefined {
  const result = parseWaveCruxLink(raw);
  return result.ok ? undefined : result.refusal;
}

describe('parseWaveCruxLink', () => {
  it('reads the reference builder example link', () => {
    // The example link crux_mcp's location_test.dart copies from the
    // reference server's JSON contract, byte for byte.
    expect(
      parseWaveCruxLink('wavecrux://open?file=%2Fwork%2Frun%201%2Fwitness.vcd&signal=top.u_alu.result&t=1500ns'),
    ).toEqual({
      ok: true,
      link: { file: '/work/run 1/witness.vcd', signal: 'top.u_alu.result', time: '1500ns', timePs: 1_500_000 },
    });
  });

  it('reads a file alone, and a tick time with no picosecond form', () => {
    expect(parseWaveCruxLink('wavecrux://open?file=%2Fw%2Fd.fst')).toEqual({ ok: true, link: { file: '/w/d.fst' } });
    expect(parseWaveCruxLink('wavecrux://open?file=%2Fw%2Fd.fst&t=42')).toEqual({
      ok: true,
      link: { file: '/w/d.fst', time: '42' },
    });
  });

  it.each([
    ['bad-time', 'wavecrux://open?file=%2Fa.vcd&t=-5ns'],
    ['bad-time', 'wavecrux://open?file=%2Fa.vcd&t=1.5'],
    ['bad-time', 'wavecrux://open?file=%2Fa.vcd&t=5min'],
    ['bad-time', 'wavecrux://open?file=%2Fa.vcd&t=5NS'],
    ['bad-time', 'wavecrux://open?file=%2Fa.vcd&t=1e3ns'],
    ['bad-time', `wavecrux://open?file=%2Fa.vcd&t=${'1'.repeat(25)}`],
    ['too-long', `wavecrux://open?file=%2Fa.vcd&t=${'1'.repeat(49)}`],
    ['unknown-key', 'wavecrux://open?file=%2Fa.vcd&cell=top.u'],
    ['unknown-key', 'wavecrux://open?file=%2Fa.vcd&exec=calc'],
    ['duplicate-key', 'wavecrux://open?file=%2Fa.vcd&signal=a&signal=b'],
    ['missing-value', 'wavecrux://open?signal=a&t=5'],
    ['wrong-scheme', 'netcrux://open?file=%2Fa.vcd'],
    ['malformed', 'wavecrux://open?file=%2Fa.vcd#t=5'],
    ['forbidden-character', 'wavecrux://open?file=%2Fa.vcd&signal=top%E2%80%8Fa'],
    ['bad-encoding', 'wavecrux://open?file=%2Fa%C3.vcd'],
  ])('refuses %s: %s', (refusal, raw) => {
    expect(refusalOf(raw)).toBe(refusal);
  });

  it('leaves a relative path for the file check, as the desktop parser does', () => {
    expect(parseWaveCruxLink('wavecrux://open?file=dump.vcd')).toEqual({ ok: true, link: { file: 'dump.vcd' } });
  });
});

describe('the t grammar', () => {
  it('reads times and ticks exactly', () => {
    expect(parseWaveCruxLinkTime('1500ns')).toEqual({ mantissa: 1500n, exponent: -9 });
    expect(parseWaveCruxLinkTime('1.5us')).toEqual({ mantissa: 15n, exponent: -7 });
    expect(parseWaveCruxLinkTime('2µs')).toEqual({ mantissa: 2n, exponent: -6 });
    expect(parseWaveCruxLinkTime('2μs')).toEqual({ mantissa: 2n, exponent: -6 });
    expect(parseWaveCruxLinkTime('2s')).toEqual({ mantissa: 2n, exponent: 0 });
    expect(parseWaveCruxLinkTime('42')).toEqual({ ticks: 42n });
    expect(parseWaveCruxLinkTime('')).toBeUndefined();
  });

  it('gives whole picoseconds only when the time is one, and fits a JSON number', () => {
    // Hand-derived: 1500 ns = 1 500 000 ps; 1.5 us = 1 500 000 ps; 2 s = 2e12 ps.
    expect(wholePicoseconds({ mantissa: 1500n, exponent: -9 })).toBe(1_500_000);
    expect(wholePicoseconds({ mantissa: 15n, exponent: -7 })).toBe(1_500_000);
    expect(wholePicoseconds({ mantissa: 2n, exponent: 0 })).toBe(2_000_000_000_000);
    expect(wholePicoseconds({ mantissa: 3000n, exponent: -15 })).toBe(3);
    expect(wholePicoseconds({ mantissa: 1500n, exponent: -15 })).toBeUndefined();
    expect(wholePicoseconds({ ticks: 42n })).toBeUndefined();
    expect(wholePicoseconds({ mantissa: 10n ** 20n, exponent: 0 })).toBeUndefined();
  });
});

describe('the files a link may open', () => {
  it('are the formats read in-process, and never FSDB, a session, a pack or a manifest', () => {
    expect([...WAVECRUX_LINK_EXTENSIONS].sort()).toEqual(['.fst', '.ghw', '.lxt', '.lxt2', '.vcd']);
  });
});
