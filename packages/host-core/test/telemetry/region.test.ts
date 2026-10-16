import { describe, expect, it } from 'vitest';
import {
  hostTelemetryRegionSignals,
  telemetryCountriesInLocaleId,
  telemetryRequiresOptIn,
} from '../../src/telemetry/region';

describe('telemetryCountriesInLocaleId', () => {
  it('reads the country from every platform spelling', () => {
    expect(telemetryCountriesInLocaleId('en-GB')).toEqual(new Set(['GB']));
    expect(telemetryCountriesInLocaleId('en_GB.UTF-8')).toEqual(new Set(['GB']));
    expect(telemetryCountriesInLocaleId('zh-Hans-CN')).toEqual(new Set(['CN']));
    expect(telemetryCountriesInLocaleId('de_DE@euro')).toEqual(new Set(['DE']));
  });

  it('a region override counts as well as the base country', () => {
    expect(telemetryCountriesInLocaleId('en_US@rg=gbzzzz')).toEqual(new Set(['US', 'GB']));
    expect(telemetryCountriesInLocaleId('en-US-u-rg-gbzzzz')).toEqual(new Set(['US', 'GB']));
  });

  it('nothing that is not a country is read as one', () => {
    for (const id of ['en', 'es-419', 'C', 'C.UTF-8', 'POSIX', '']) {
      expect(telemetryCountriesInLocaleId(id)).toEqual(new Set());
    }
    expect(telemetryCountriesInLocaleId('en-US-u-ca-gregory')).toEqual(new Set(['US']));
  });
});

describe('telemetryRequiresOptIn', () => {
  it('a European time zone is enough on its own', () => {
    expect(telemetryRequiresOptIn({ localeIds: ['en'], timeZone: 'Europe/London' })).toBe(true);
    expect(telemetryRequiresOptIn({ localeIds: ['en'], timeZone: 'Asia/Seoul' })).toBe(true);
  });

  it('an opt-in country in any locale is enough on its own', () => {
    expect(
      telemetryRequiresOptIn({ localeIds: ['en', 'en-US', 'de-DE'], timeZone: 'America/Denver' }),
    ).toBe(true);
    expect(telemetryRequiresOptIn({ localeIds: ['en_US@rg=gbzzzz'] })).toBe(true);
  });

  it('elsewhere it is not', () => {
    expect(telemetryRequiresOptIn({ localeIds: ['en', 'en-US'], timeZone: 'America/Denver' })).toBe(
      false,
    );
    expect(telemetryRequiresOptIn({ localeIds: ['de-US'], timeZone: 'Etc/UTC' })).toBe(false);
  });
});

describe('hostTelemetryRegionSignals', () => {
  it('always carries the display language, and never throws', () => {
    const signals = hostTelemetryRegionSignals('en');
    expect(signals.localeIds[0]).toBe('en');
  });
});
