import { describe, expect, it } from 'vitest';
import {
  CRUX_LINK_MAX_LENGTH,
  decodeLinkValue,
  encodeLinkValue,
  hasForbiddenLinkCharacter,
  parseCruxLinkQuery,
  type CruxLinkGrammar,
} from '../../src/links/grammar';

const GRAMMAR: CruxLinkGrammar = { scheme: 'wavecrux', keys: { file: 4096, signal: 1024, t: 48 } };

const parse = (raw: string): ReturnType<typeof parseCruxLinkQuery> => parseCruxLinkQuery(raw, GRAMMAR);

function refusalOf(raw: string): string | undefined {
  const result = parse(raw);
  return result.ok ? undefined : result.refusal;
}

/**
 * Link vectors from outside this code: crux_mcp's `location_test.dart`, whose
 * first four are the reference link builder's own hand-derived examples and
 * whose last is derived by hand from the encoding rule. (file, signal, t, link)
 */
const VECTORS: ReadonlyArray<readonly [string, string, string, string]> = [
  [
    '/work/run 1/witness.vcd',
    'top.u_alu.result',
    '1500ns',
    'wavecrux://open?file=%2Fwork%2Frun%201%2Fwitness.vcd&signal=top.u_alu.result&t=1500ns',
  ],
  [
    '/work/c++/run 1/witness.vcd',
    'top.u_alu.result',
    '1500ns',
    'wavecrux://open?file=%2Fwork%2Fc%2B%2B%2Frun%201%2Fwitness.vcd&signal=top.u_alu.result&t=1500ns',
  ],
  ['/tmp/µ-x~y.fst', 'top.data[3]', '42', 'wavecrux://open?file=%2Ftmp%2F%C2%B5-x~y.fst&signal=top.data%5B3%5D&t=42'],
  ['/a&b=c?d#e.vcd', 'tb.dut', '0us', 'wavecrux://open?file=%2Fa%26b%3Dc%3Fd%23e.vcd&signal=tb.dut&t=0us'],
  ["/x/(a)!*'.vcd", 'top.a', '7', 'wavecrux://open?file=%2Fx%2F%28a%29%21%2A%27.vcd&signal=top.a&t=7'],
];

describe('the link encoding', () => {
  it('writes every vector byte for byte', () => {
    for (const [file, signal, t, link] of VECTORS) {
      expect(`wavecrux://open?file=${encodeLinkValue(file)}&signal=${encodeLinkValue(signal)}&t=${encodeLinkValue(t)}`).toBe(
        link,
      );
    }
  });

  it('reads every vector back to its values', () => {
    for (const [file, signal, t, link] of VECTORS) {
      const result = parse(link);
      expect(result.ok, link).toBe(true);
      if (!result.ok) continue;
      expect(Object.fromEntries(result.values)).toEqual({ file, signal, t });
    }
  });

  it('mutation: encodeURIComponent is not the link encoding', () => {
    const differs = VECTORS.some(([file]) => encodeURIComponent(file) !== encodeLinkValue(file));
    expect(differs).toBe(true);
  });

  it('decodes as Dart decodeComponent does: + stays +, raw non-ASCII and broken escapes refused', () => {
    expect(decodeLinkValue('a+b')).toBe('a+b');
    expect(decodeLinkValue('%2Fa%20b')).toBe('/a b');
    expect(decodeLinkValue('é')).toBeUndefined();
    expect(decodeLinkValue('%2')).toBeUndefined();
    expect(decodeLinkValue('%G1')).toBeUndefined();
    expect(decodeLinkValue('%FF')).toBeUndefined();
    expect(decodeLinkValue('%C3')).toBeUndefined();
    // A byte-order mark is kept, so the forbidden-character check sees it.
    expect(decodeLinkValue('%EF%BB%BFx')).toBe('﻿x');
  });
});

describe('parseCruxLinkQuery refuses', () => {
  const ok = 'wavecrux://open?file=%2Fw%2Fd.vcd';

  it('accepts the plain form, any case of open, a trailing slash, keys in any order', () => {
    expect(parse(ok).ok).toBe(true);
    expect(parse('WaveCrux://OPEN/?t=5&file=%2Fw%2Fd.vcd').ok).toBe(true);
  });

  it.each([
    ['too-long', `wavecrux://open?file=%2F${'a'.repeat(CRUX_LINK_MAX_LENGTH)}`],
    ['too-long', `wavecrux://open?file=%2F${'a'.repeat(4096)}`],
    ['too-long', `wavecrux://open?file=%2Fa&signal=${'s'.repeat(1025)}`],
    ['wrong-scheme', 'netcrux://open?file=%2Fa'],
    ['wrong-scheme', 'wavecrux'],
    ['forbidden-character', 'wavecrux://open?file=/a b.vcd'],
    ['forbidden-character', 'wavecrux://open?file=%2Fa%0Ab.vcd'],
    ['forbidden-character', 'wavecrux://open?file=%2Fa%E2%80%AEb.vcd'],
    ['forbidden-character', 'wavecrux://open?file=%2Fa.vcd&signal=top%20a'],
    ['forbidden-character', 'wavecrux://open?file=%EF%BB%BF%2Fa.vcd'],
    ['malformed', 'wavecrux://open?file=%2Fa#x'],
    ['malformed', 'wavecrux:open?file=%2Fa'],
    ['malformed', 'wavecrux://close?file=%2Fa'],
    ['malformed', 'wavecrux://user@open?file=%2Fa'],
    ['malformed', 'wavecrux://open:80?file=%2Fa'],
    ['malformed', 'wavecrux://open/x?file=%2Fa'],
    ['malformed', 'wavecrux://open?file'],
    ['malformed', 'wavecrux://open?=x'],
    ['missing-value', 'wavecrux://open'],
    ['missing-value', 'wavecrux://open?'],
    ['missing-value', 'wavecrux://open?file='],
    ['missing-value', 'wavecrux://open?signal=a'],
    ['unknown-key', 'wavecrux://open?file=%2Fa&cmd=x'],
    ['unknown-key', 'wavecrux://open?File=%2Fa'],
    ['duplicate-key', 'wavecrux://open?file=%2Fa&file=%2Fb'],
    ['bad-encoding', 'wavecrux://open?file=%2Fa%ZZ'],
    ['bad-encoding', 'wavecrux://open?file=%2Fa%FF'],
    ['bad-encoding', 'wavecrux://open?file=%2Faé'],
    ['bad-encoding', 'wavecrux://open?file=%2Fa%EF%BF%BD'],
  ])('%s: %s', (refusal, raw) => {
    expect(refusalOf(raw)).toBe(refusal);
  });

  it('allows a plain space only inside a decoded path', () => {
    expect(hasForbiddenLinkCharacter('/a b', { allowSpace: true })).toBe(false);
    expect(hasForbiddenLinkCharacter('/a b')).toBe(true);
    expect(hasForbiddenLinkCharacter('/a b', { allowSpace: true })).toBe(true);
  });
});
