import { describe, expect, it } from 'vitest';
import {
  TELEMETRY_APP_VERSION_PATTERN,
  TELEMETRY_FORM_FACTOR,
  TELEMETRY_LICENSE_TIERS,
  TELEMETRY_LOCALE_PATTERN,
  TELEMETRY_OPERATING_SYSTEMS,
  TELEMETRY_PRODUCTS,
  TELEMETRY_PROPERTY_KEY_PATTERN,
  TELEMETRY_PROPERTY_VALUE_PATTERN,
  isValidTelemetryEventName,
  isValidTelemetryInstallationId,
} from '../../src/telemetry/vocabulary';

describe('telemetry vocabulary', () => {
  it('matches the Worker\'s closed sets exactly', () => {
    // The ingestion Worker's PRODUCTS, OPERATING_SYSTEMS and LICENSE_TIERS. A mismatch here means a batch this extension sends
    // would be rejected 400 the moment it left an app the Worker doesn't
    // yet recognise, or would silently under-report a product/tier the
    // Worker does recognise but this list has drifted from.
    expect([...TELEMETRY_PRODUCTS].sort()).toEqual(
      ['lintcrux', 'netcrux', 'simcrux', 'wavecrux'].sort(),
    );
    expect([...TELEMETRY_OPERATING_SYSTEMS].sort()).toEqual(
      ['android', 'ios', 'linux', 'macos', 'web', 'windows'].sort(),
    );
    expect([...TELEMETRY_LICENSE_TIERS].sort()).toEqual(
      ['edu', 'enterprise', 'openCore', 'pro'].sort(),
    );
  });

  it('only ever reports the vscode form_factor bucket', () => {
    expect(TELEMETRY_FORM_FACTOR).toBe('vscode');
  });

  it('accepts a lowercase UUID as an installation id and rejects everything else', () => {
    expect(isValidTelemetryInstallationId('6f1b0d3e-1234-4abc-8def-0123456789ab')).toBe(true);
    // Uppercase, a machine id, a plain string — none are a UUID.
    expect(isValidTelemetryInstallationId('6F1B0D3E-1234-4ABC-8DEF-0123456789AB')).toBe(false);
    expect(isValidTelemetryInstallationId('not-a-uuid')).toBe(false);
    expect(isValidTelemetryInstallationId('')).toBe(false);
  });

  it('accepts noun.verb and noun.subnoun.verb event names, nothing shorter or longer', () => {
    expect(isValidTelemetryEventName('file.opened')).toBe(true);
    expect(isValidTelemetryEventName('file.first_opened')).toBe(true);
    // One segment (no dot) and four segments both fall outside the shape
    // the Worker's EVENT_NAME regex accepts.
    expect(isValidTelemetryEventName('activated')).toBe(false);
    expect(isValidTelemetryEventName('a.b.c.d')).toBe(false);
    expect(isValidTelemetryEventName('File.Opened')).toBe(false);
  });

  it('property keys reject anything with a capital, a space, or a leading digit', () => {
    expect(TELEMETRY_PROPERTY_KEY_PATTERN.test('format')).toBe(true);
    expect(TELEMETRY_PROPERTY_KEY_PATTERN.test('size_bucket')).toBe(true);
    expect(TELEMETRY_PROPERTY_KEY_PATTERN.test('Format')).toBe(false);
    expect(TELEMETRY_PROPERTY_KEY_PATTERN.test('1format')).toBe(false);
    expect(TELEMETRY_PROPERTY_KEY_PATTERN.test('has space')).toBe(false);
  });

  it('property string values reject a path, a signal name with dots, or free text', () => {
    expect(TELEMETRY_PROPERTY_VALUE_PATTERN.test('spi')).toBe(true);
    expect(TELEMETRY_PROPERTY_VALUE_PATTERN.test('/etc/passwd')).toBe(false);
    expect(TELEMETRY_PROPERTY_VALUE_PATTERN.test('top.cpu.alu.result')).toBe(false);
    expect(TELEMETRY_PROPERTY_VALUE_PATTERN.test('Hello, world!')).toBe(false);
  });

  it('app_version and locale patterns match the Worker exactly', () => {
    expect(TELEMETRY_APP_VERSION_PATTERN.test('0.6.0')).toBe(true);
    expect(TELEMETRY_APP_VERSION_PATTERN.test('1.0.0-beta.1')).toBe(true);
    expect(TELEMETRY_APP_VERSION_PATTERN.test('not-a-version')).toBe(false);
    expect(TELEMETRY_LOCALE_PATTERN.test('en')).toBe(true);
    expect(TELEMETRY_LOCALE_PATTERN.test('zh_CN')).toBe(true);
    expect(TELEMETRY_LOCALE_PATTERN.test('zh_Hans_CN')).toBe(true);
    expect(TELEMETRY_LOCALE_PATTERN.test('zh-CN')).toBe(false);
  });
});
