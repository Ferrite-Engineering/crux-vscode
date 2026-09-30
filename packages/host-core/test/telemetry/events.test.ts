import { describe, expect, it } from 'vitest';
import {
  TELEMETRY_EVENTS,
  coalesceTelemetryEvents,
  sanitizeTelemetryEvent,
  sanitizeTelemetryProperties,
  telemetrySizeBucket,
} from '../../src/telemetry/events';
import { isValidTelemetryEventName } from '../../src/telemetry/vocabulary';

describe('TELEMETRY_EVENTS catalog', () => {
  it('every catalog name is a syntactically valid event name', () => {
    for (const name of Object.values(TELEMETRY_EVENTS)) {
      expect(isValidTelemetryEventName(name)).toBe(true);
    }
  });

  it('has no duplicate names', () => {
    const names = Object.values(TELEMETRY_EVENTS);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('telemetrySizeBucket', () => {
  it('buckets coarsely and never returns the byte count', () => {
    expect(telemetrySizeBucket(1_000)).toBe('tiny');
    expect(telemetrySizeBucket(5_000_000)).toBe('small');
    expect(telemetrySizeBucket(50_000_000)).toBe('medium');
    expect(telemetrySizeBucket(500_000_000)).toBe('large');
    expect(telemetrySizeBucket(5_000_000_000)).toBe('huge');
  });

  it('degrades a negative or non-finite input to the smallest bucket rather than throwing', () => {
    expect(telemetrySizeBucket(-1)).toBe('tiny');
    expect(telemetrySizeBucket(Number.NaN)).toBe('tiny');
    expect(telemetrySizeBucket(Number.POSITIVE_INFINITY)).toBe('tiny');
  });
});

describe('sanitizeTelemetryProperties', () => {
  it('drops a hostile string value — a path, a signal name — rather than sending it', () => {
    // Constraint C: a file name, a path, or a signal name must not survive.
    const sanitized = sanitizeTelemetryProperties({
      format: 'vcd',
      path: '/Users/dev/secret-design.vcd',
      signal: 'top.cpu.alu.result',
    });
    expect(sanitized).toEqual({ format: 'vcd' });
  });

  it('drops a malformed key but keeps the well-formed ones alongside it', () => {
    const sanitized = sanitizeTelemetryProperties({
      'Has Space': 'x',
      good_key: 'ok',
    });
    expect(sanitized).toEqual({ good_key: 'ok' });
  });

  it('passes through booleans and small integers unchanged', () => {
    expect(sanitizeTelemetryProperties({ honored: true, tabs: 3 })).toEqual({
      honored: true,
      tabs: 3,
    });
  });

  it('drops an out-of-range or non-integer number', () => {
    expect(sanitizeTelemetryProperties({ huge: 1_000_000, frac: 1.5 })).toEqual({});
  });

  it('caps at 6 properties, keeping the first 6 in sorted key order', () => {
    const many: Record<string, string> = {};
    for (const letter of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) many[letter] = 'ok';
    expect(Object.keys(sanitizeTelemetryProperties(many))).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('returns an empty object for undefined, null, or a non-object', () => {
    expect(sanitizeTelemetryProperties(undefined)).toEqual({});
  });
});

describe('sanitizeTelemetryEvent', () => {
  it('drops the whole event when the name is malformed', () => {
    expect(sanitizeTelemetryEvent({ name: 'not-a-catalog-name' })).toBeUndefined();
    expect(sanitizeTelemetryEvent({ name: 'File.Opened' })).toBeUndefined();
  });

  it('keeps a valid event and sanitizes its properties, omitting an empty properties bag', () => {
    expect(sanitizeTelemetryEvent({ name: TELEMETRY_EVENTS.fileOpened })).toEqual({
      name: TELEMETRY_EVENTS.fileOpened,
    });
    expect(
      sanitizeTelemetryEvent({
        name: TELEMETRY_EVENTS.fileOpened,
        properties: { format: 'vcd', path: '/etc/passwd' },
      }),
    ).toEqual({ name: TELEMETRY_EVENTS.fileOpened, properties: { format: 'vcd' } });
  });
});

describe('coalesceTelemetryEvents', () => {
  it('folds identical (name, properties) pairs into one row with a count', () => {
    const entries = coalesceTelemetryEvents([
      { name: TELEMETRY_EVENTS.featureUsed, properties: { feature: 'spi' } },
      { name: TELEMETRY_EVENTS.featureUsed, properties: { feature: 'spi' } },
      { name: TELEMETRY_EVENTS.featureUsed, properties: { feature: 'i2c' } },
    ]);
    expect(entries).toEqual([
      { name: TELEMETRY_EVENTS.featureUsed, properties: { feature: 'spi' }, count: 2 },
      { name: TELEMETRY_EVENTS.featureUsed, properties: { feature: 'i2c' }, count: 1 },
    ]);
  });

  it('property order does not create spurious distinct rows', () => {
    const entries = coalesceTelemetryEvents([
      { name: TELEMETRY_EVENTS.badgeImpression, properties: { tier: 'pro', product: 'wavecrux' } },
      { name: TELEMETRY_EVENTS.badgeImpression, properties: { product: 'wavecrux', tier: 'pro' } },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.count).toBe(2);
  });

  it('drops malformed events rather than letting them poison coalescing', () => {
    const entries = coalesceTelemetryEvents([
      { name: 'not valid' },
      { name: TELEMETRY_EVENTS.activated },
    ]);
    expect(entries).toEqual([{ name: TELEMETRY_EVENTS.activated, count: 1 }]);
  });
});
