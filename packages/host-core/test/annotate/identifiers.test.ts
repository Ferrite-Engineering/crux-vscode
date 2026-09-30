import { describe, expect, it } from 'vitest';
import {
  hdlDialectFor,
  identifiersOnLine,
  stripNonCode,
} from '../../src/annotate/identifiers';

describe('HDL language gating', () => {
  it('recognises the Verilog and VHDL language ids', () => {
    expect(hdlDialectFor('systemverilog')).toBe('verilog');
    expect(hdlDialectFor('verilog')).toBe('verilog');
    expect(hdlDialectFor('vhdl')).toBe('vhdl');
  });

  it('refuses anything else', () => {
    // Annotating an arbitrary document because a word in it happens to match
    // a stems entry is the intrusion the whole feature is gated to avoid.
    for (const languageId of ['plaintext', 'markdown', 'typescript', 'c', '']) {
      expect(hdlDialectFor(languageId)).toBeUndefined();
    }
  });
});

describe('stripNonCode', () => {
  it('drops a Verilog line comment', () => {
    expect(stripNonCode('assign a = b; // c is here', 'verilog')).toBe('assign a = b; ');
  });

  it('drops a VHDL line comment', () => {
    expect(stripNonCode('a <= b; -- c is here', 'vhdl')).toBe('a <= b; ');
  });

  it('does not treat SystemVerilog decrement as a comment', () => {
    // `--` is VHDL's comment marker and SystemVerilog's decrement operator.
    // Applying both markers to both dialects would blank the rest of a live
    // line every time someone wrote `i--`.
    expect(identifiersOnLine('counter--;', 'verilog', 8)).toEqual(['counter']);
  });

  it('blanks an in-line block comment without moving columns', () => {
    const line = 'assign a = /* note */ b;';
    const stripped = stripNonCode(line, 'verilog');
    expect(stripped).toHaveLength(line.length);
    expect(identifiersOnLine(line, 'verilog', 8)).toEqual(['a', 'b']);
  });

  it('blanks a string literal', () => {
    expect(identifiersOnLine('$display("alu_result is %d", x);', 'verilog', 8)).toEqual([
      'display',
      'x',
    ]);
  });
});

describe('identifiersOnLine', () => {
  it('returns distinct identifiers in source order', () => {
    expect(identifiersOnLine('alu_result = alu_a + alu_b + alu_a;', 'verilog', 8)).toEqual([
      'alu_result',
      'alu_a',
      'alu_b',
    ]);
  });

  it('drops common keywords before spending a lookup on them', () => {
    expect(identifiersOnLine('always_ff @(posedge clk) begin', 'verilog', 8)).toEqual(['clk']);
  });

  it('preserves the case the user wrote', () => {
    // The index folds case; the annotation echoes the word on the line.
    expect(identifiersOnLine('AluResult = 1;', 'verilog', 8)).toEqual(['AluResult']);
  });

  it('folds case when de-duplicating', () => {
    expect(identifiersOnLine('foo = FOO + Foo;', 'verilog', 8)).toEqual(['foo']);
  });

  it('caps after de-duplication, not before', () => {
    // A line mentioning one signal eight times spends one lookup and leaves
    // the rest of the budget for the rest of the line.
    expect(identifiersOnLine('a = a + a + a + b;', 'verilog', 2)).toEqual(['a', 'b']);
  });

  it('returns nothing for a zero budget', () => {
    expect(identifiersOnLine('a = b;', 'verilog', 0)).toEqual([]);
  });

  it('accepts the $ and _ Verilog allows in an identifier', () => {
    expect(identifiersOnLine('net$0_x = 1;', 'verilog', 8)).toEqual(['net$0_x']);
  });
});
