import { describe, expect, it } from 'vitest';
import {
  TELEMETRY_PRODUCTION_ENDPOINT,
  TELEMETRY_STAGING_ENDPOINT,
  buildTelemetryPayload,
  hostTelemetryOperatingSystem,
  normalizeTelemetryLocale,
  telemetryEndpointFor,
  telemetrySessionStart,
} from '../../src/telemetry/envelope';
import { TELEMETRY_LOCALE_PATTERN } from '../../src/telemetry/vocabulary';

describe('telemetryEndpointFor', () => {
  it('the path selects the dataset, not a flag in the body', () => {
    expect(telemetryEndpointFor(false)).toBe(TELEMETRY_PRODUCTION_ENDPOINT);
    expect(telemetryEndpointFor(true)).toBe(TELEMETRY_STAGING_ENDPOINT);
    expect(TELEMETRY_PRODUCTION_ENDPOINT).toBe('https://telemetry.edacrux.app/v1/events');
    expect(TELEMETRY_STAGING_ENDPOINT).toBe('https://telemetry.edacrux.app/dev/v1/events');
  });
});

describe('hostTelemetryOperatingSystem', () => {
  it('maps every Node platform to a bucket the Worker accepts', () => {
    expect(hostTelemetryOperatingSystem('darwin')).toBe('macos');
    expect(hostTelemetryOperatingSystem('win32')).toBe('windows');
    expect(hostTelemetryOperatingSystem('linux')).toBe('linux');
  });

  it('falls back to linux for an unlisted platform rather than an invalid value', () => {
    expect(hostTelemetryOperatingSystem('freebsd')).toBe('linux');
    expect(hostTelemetryOperatingSystem('sunos')).toBe('linux');
  });
});

describe('normalizeTelemetryLocale', () => {
  it('converts VSCode locale identifiers into the Worker\'s Unicode-locale shape', () => {
    expect(normalizeTelemetryLocale('en')).toBe('en');
    expect(normalizeTelemetryLocale('zh-cn')).toBe('zh_CN');
    expect(normalizeTelemetryLocale('pt-br')).toBe('pt_BR');
    expect(normalizeTelemetryLocale('zh-hans')).toBe('zh_Hans');
    expect(normalizeTelemetryLocale('zh-hans-cn')).toBe('zh_Hans_CN');
  });

  it('every normalized output matches the Worker\'s LOCALE pattern', () => {
    for (const input of ['en', 'zh-cn', 'pt-br', 'zh-hans', 'zh-hans-cn', 'ja', 'ko']) {
      const normalized = normalizeTelemetryLocale(input);
      expect(TELEMETRY_LOCALE_PATTERN.test(normalized)).toBe(true);
    }
  });

  it('degrades an unrecognisable input to the empty string rather than guessing', () => {
    expect(normalizeTelemetryLocale('')).toBe('');
    expect(normalizeTelemetryLocale('!!!')).toBe('');
  });
});

describe('telemetrySessionStart', () => {
  it('normalizes to whole-second UTC, matching the Worker\'s blob11 shape', () => {
    const fixed = () => Date.parse('2026-08-10T09:15:00.512Z');
    expect(telemetrySessionStart(fixed)).toBe('2026-08-10T09:15:00Z');
  });
});

describe('buildTelemetryPayload', () => {
  it('matches the crux_telemetry payload-contract shape', () => {
    const payload = buildTelemetryPayload(
      {
        installationId: '6f1b0d3e-1234-4abc-8def-0123456789ab',
        appVersion: '0.6.0',
        product: 'wavecrux',
        os: 'macos',
        locale: 'zh_CN',
        licenseTier: 'openCore',
        sessionStart: '2026-08-10T09:15:00Z',
      },
      [{ name: 'decoder.opened', properties: { decoder: 'spi' }, count: 4 }],
    );
    expect(payload).toEqual({
      installation_id: '6f1b0d3e-1234-4abc-8def-0123456789ab',
      app_version: '0.6.0',
      product: 'wavecrux',
      os: 'macos',
      form_factor: 'vscode',
      locale: 'zh_CN',
      license_tier: 'openCore',
      session_start: '2026-08-10T09:15:00Z',
      events: [{ name: 'decoder.opened', properties: { decoder: 'spi' }, count: 4 }],
    });
  });

  it('omits properties entirely for an event that has none, rather than sending {}', () => {
    const payload = buildTelemetryPayload(
      {
        installationId: '6f1b0d3e-1234-4abc-8def-0123456789ab',
        appVersion: '0.6.0',
        product: 'lintcrux',
        os: 'linux',
        locale: 'en',
        licenseTier: 'openCore',
        sessionStart: '2026-08-10T09:15:00Z',
      },
      [{ name: 'extension.activated', count: 1 }],
    );
    expect(payload.events[0]).toEqual({ name: 'extension.activated', count: 1 });
    expect(payload.events[0]).not.toHaveProperty('properties');
  });
});
