import { describe, expect, it } from 'vitest';
import {
  CappedLineSplitter,
  DEFAULT_CXP_MAX_LINE_LENGTH,
  DEFAULT_CXP_MAX_PENDING_WRITE_BYTES,
  encodeFrame,
} from '../../src/cxp/framing';
import { CxpFrameTooLongError } from '../../src/cxp/errors';

/**
 * Drive a splitter with a series of chunks and collect what came out.
 * Mirrors `_split` in crux_cxp's `line_framing_test.dart`.
 */
function split(
  chunks: readonly string[],
  maxLineLength = DEFAULT_CXP_MAX_LINE_LENGTH,
): { lines: string[]; errors: Error[]; ended: boolean } {
  const lines: string[] = [];
  const errors: Error[] = [];
  let ended = false;
  const splitter = new CappedLineSplitter(
    {
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error),
      onEnd: () => {
        ended = true;
      },
    },
    maxLineLength,
  );
  for (const chunk of chunks) splitter.write(chunk);
  splitter.end();
  return { lines, errors, ended };
}

describe('CXP framing constants', () => {
  it('matches crux_cxp: 1 MiB inbound, 8 MiB outbound', () => {
    expect(DEFAULT_CXP_MAX_LINE_LENGTH).toBe(1024 * 1024);
    expect(DEFAULT_CXP_MAX_PENDING_WRITE_BYTES).toBe(8 * 1024 * 1024);
  });

  it('encodeFrame terminates with exactly one line feed', () => {
    expect(encodeFrame('{"a":1}')).toBe('{"a":1}\n');
  });
});

describe('CappedLineSplitter', () => {
  it('splits lines that span chunk boundaries', () => {
    expect(split(['ab', 'c\nde', 'f\n', 'g\nh']).lines).toEqual(['abc', 'def', 'g', 'h']);
  });

  it('splits several frames coalesced into one read', () => {
    // The TCP shape that matters: Nagle or a fast sender delivers three
    // whole frames in a single segment.
    expect(split(['a\nb\nc\n']).lines).toEqual(['a', 'b', 'c']);
  });

  it('reassembles a frame delivered one byte at a time', () => {
    const frame = '{"cxp_version":"1.1"}';
    expect(split([...`${frame}\n`]).lines).toEqual([frame]);
  });

  it('strips a trailing carriage return so \\r\\n and \\n both parse', () => {
    expect(split(['a\r\nb\n']).lines).toEqual(['a', 'b']);
  });

  it('strips only ONE trailing carriage return', () => {
    expect(split(['a\r\r\n']).lines).toEqual(['a\r']);
  });

  it('emits trailing data without a final newline at end of stream', () => {
    const result = split(['a\nrest']);
    expect(result.lines).toEqual(['a', 'rest']);
    expect(result.ended).toBe(true);
  });

  it('emits nothing extra when the stream ends on a newline', () => {
    expect(split(['a\n']).lines).toEqual(['a']);
  });

  it('accepts a line exactly at the cap', () => {
    expect(split([`${'x'.repeat(16)}\n`], 16).lines).toEqual(['x'.repeat(16)]);
  });

  it('fails on a terminated line exceeding the cap', () => {
    const result = split([`${'x'.repeat(32)}\n`], 16);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toBeInstanceOf(CxpFrameTooLongError);
    expect(result.lines).toEqual([]);
  });

  it('fails while buffering an unterminated line, before any newline', () => {
    // The overrun must be detected while buffering — otherwise a peer that
    // never terminates its line grows the buffer unboundedly.
    const result = split(['x'.repeat(8), 'x'.repeat(16)], 16);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain('Unterminated line');
  });

  it('measures the cap AFTER the carriage-return strip', () => {
    // 16 x's plus a \r is 17 code units on the wire but a 16-unit frame.
    expect(split([`${'x'.repeat(16)}\r\n`], 16).lines).toEqual(['x'.repeat(16)]);
  });

  it('is terminal: no lines after a breach, even from the same chunk', () => {
    // The exact TCP shape: an over-long frame and the frames after it
    // arriving in one segment.
    const result = split([`${'x'.repeat(64)}\nshort1\nshort2\n`], 16);
    expect(result.errors).toHaveLength(1);
    expect(result.lines).toEqual([]);
    expect(result.ended).toBe(false);
  });

  it('ignores chunks that arrive after a breach', () => {
    // Cancellation is asynchronous on every real transport, so a chunk
    // already queued behind the offending one still arrives. It must not
    // reach a consumer that has been told the connection is dead.
    const lines: string[] = [];
    const errors: Error[] = [];
    const splitter = new CappedLineSplitter(
      { onLine: (l) => lines.push(l), onError: (e) => errors.push(e) },
      16,
    );
    splitter.write('ok\n');
    expect(lines).toEqual(['ok']);
    splitter.write(`${'x'.repeat(64)}\n`);
    expect(errors).toHaveLength(1);
    expect(() => {
      splitter.write('short1\n');
      splitter.write('short2\n');
      splitter.end();
    }).not.toThrow();
    expect(lines).toEqual(['ok']);
    expect(splitter.failed).toBe(true);
  });

  it('reports the breach exactly once', () => {
    const errors: Error[] = [];
    const splitter = new CappedLineSplitter(
      { onLine: () => undefined, onError: (e) => errors.push(e) },
      4,
    );
    splitter.write('xxxxxxxx\n');
    splitter.write('yyyyyyyy\n');
    expect(errors).toHaveLength(1);
  });

  it('stop() detaches without emitting anything further', () => {
    const lines: string[] = [];
    let ended = false;
    const splitter = new CappedLineSplitter({
      onLine: (l) => lines.push(l),
      onError: () => undefined,
      onEnd: () => {
        ended = true;
      },
    });
    splitter.write('a\n');
    splitter.stop();
    splitter.write('b\n');
    splitter.end();
    expect(lines).toEqual(['a']);
    expect(ended).toBe(false);
  });

  it('stops mid-segment when the consumer tears down inside onLine', () => {
    // A `goodbye` or an unsupported version disconnects from inside the
    // line handler. The rest of the segment must not be dispatched into a
    // connection that is already gone.
    const lines: string[] = [];
    const splitter: CappedLineSplitter = new CappedLineSplitter({
      onLine: (line) => {
        lines.push(line);
        if (line === 'bye') splitter.stop();
      },
      onError: () => undefined,
    });
    splitter.write('one\nbye\nthree\n');
    expect(lines).toEqual(['one', 'bye']);
  });

  it('reassembles a multi-byte character split across two reads', () => {
    const lines: string[] = [];
    const splitter = new CappedLineSplitter({
      onLine: (l) => lines.push(l),
      onError: () => undefined,
    });
    const bytes = Buffer.from('héllo\n', 'utf8');
    // Split inside the two-byte 'é'.
    splitter.writeBytes(bytes.subarray(0, 2));
    splitter.writeBytes(bytes.subarray(2));
    expect(lines).toEqual(['héllo']);
  });

  it('measures the cap in UTF-16 code units, as crux_cxp does', () => {
    // 'é' is two UTF-8 bytes but one UTF-16 code unit: a 16-character
    // frame of them is at the cap, not over it.
    expect(split([`${'é'.repeat(16)}\n`], 16).lines).toEqual(['é'.repeat(16)]);
    expect(split([`${'é'.repeat(17)}\n`], 16).errors).toHaveLength(1);
  });
});
