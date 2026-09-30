import { describe, expect, it } from 'vitest';
import {
  decodeEnvelope,
  encodeEnvelope,
  encodeEnvelopeLine,
  envelopeFor,
  newCxpMessageId,
  parseEnvelopeLine,
} from '../../src/cxp/envelope';
import { CxpFormatError } from '../../src/cxp/errors';
import { CXP_PROTOCOL_VERSION } from '../../src/cxp/version';

const wellFormed = {
  cxp_version: '1.1',
  message_id: 'msg-1',
  from: 'wavecrux-123',
  kind: 'hello',
  payload: { identity: 'placeholder' },
} as const;

describe('CxpEnvelope', () => {
  it('round-trips through encodeEnvelopeLine and parseEnvelopeLine', () => {
    const envelope = envelopeFor({
      from: 'wavecrux-1-2',
      kind: 'notify_selection',
      payload: { elements: [] },
      messageId: 'm-1',
    });
    const line = encodeEnvelopeLine(envelope);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(parseEnvelopeLine(line.slice(0, -1))).toEqual(envelope);
  });

  it('defaults cxp_version to the version we speak', () => {
    expect(envelopeFor({ from: 'a', kind: 'hello', payload: {} }).cxpVersion).toBe(
      CXP_PROTOCOL_VERSION,
    );
  });

  it('encodes exactly the five wire fields', () => {
    expect(Object.keys(encodeEnvelope(decodeEnvelope(wellFormed))).sort()).toEqual([
      'cxp_version',
      'from',
      'kind',
      'message_id',
      'payload',
    ]);
  });

  it.each(['cxp_version', 'message_id', 'from', 'kind', 'payload'])(
    'rejects a missing "%s"',
    (field) => {
      const json: Record<string, unknown> = { ...wellFormed };
      delete json[field];
      expect(() => decodeEnvelope(json as never)).toThrow(CxpFormatError);
      expect(() => decodeEnvelope(json as never)).toThrow(`missing "${field}"`);
    },
  );

  it.each([
    ['cxp_version', 1],
    ['message_id', 42],
    ['from', null],
    ['kind', ['hello']],
    ['payload', 'not-an-object'],
    ['payload', ['not', 'an', 'object']],
  ])('rejects a mistyped "%s"', (field, value) => {
    expect(() => decodeEnvelope({ ...wellFormed, [field]: value })).toThrow(CxpFormatError);
  });

  it('ignores unrecognised envelope-level fields — additive minors', () => {
    const decoded = decodeEnvelope({
      ...wellFormed,
      some_future_field: { nested: true },
    });
    expect(decoded.kind).toBe('hello');
    expect(Object.keys(encodeEnvelope(decoded))).not.toContain('some_future_field');
  });

  it('accepts an empty payload', () => {
    expect(decodeEnvelope({ ...wellFormed, payload: {} }).payload).toEqual({});
  });

  it('reports a non-object top-level JSON value as malformed', () => {
    expect(() => parseEnvelopeLine('[1,2,3]')).toThrow('Top-level JSON value is not an object.');
    expect(() => parseEnvelopeLine('"a string"')).toThrow(
      'Top-level JSON value is not an object.',
    );
  });

  it('reports unparseable JSON as malformed', () => {
    expect(() => parseEnvelopeLine('{not json')).toThrow(CxpFormatError);
  });

  it('mints message ids with negligible collision probability', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newCxpMessageId()));
    expect(ids.size).toBe(500);
  });
});
