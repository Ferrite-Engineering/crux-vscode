/**
 * The closed vocabularies and shape limits the telemetry ingestion Worker
 * enforces, mirrored **exactly**.
 *
 * Source of truth: the ingestion Worker's own validator (`PRODUCTS`,
 * `OPERATING_SYSTEMS`, `FORM_FACTORS`, `LICENSE_TIERS`, `EVENT_NAME`,
 * `APP_VERSION`, `INSTALLATION_ID`, `LOCALE`, `PROPERTY_KEY`,
 * `PROPERTY_VALUE`, `MAX_*`). The Worker validates the **whole batch** as
 * one unit for the envelope fields — one bad field costs every event in the
 * batch a 400 the client never sees — so every value this module builds
 * must land inside these sets before it is ever queued, not merely before
 * it is sent.
 *
 * These are duplicated here rather than imported because the Worker is a
 * separate deployable (a different repo, a different runtime) and
 * `crux_telemetry`'s Dart copy is duplicated for the same reason. Drift is
 * the risk that duplication buys down only if every copy is reviewed
 * against the others when one changes — the Worker source file itself
 * says as much in its own comments.
 */

/** `PRODUCTS` — the four suite products a batch may claim. */
export const TELEMETRY_PRODUCTS = ['wavecrux', 'netcrux', 'lintcrux', 'simcrux'] as const;
export type TelemetryProduct = (typeof TELEMETRY_PRODUCTS)[number];

/** `OPERATING_SYSTEMS`. */
export const TELEMETRY_OPERATING_SYSTEMS = [
  'macos',
  'windows',
  'linux',
  'ios',
  'android',
  'web',
] as const;
export type TelemetryOperatingSystem = (typeof TELEMETRY_OPERATING_SYSTEMS)[number];

/**
 * `FORM_FACTORS`. The extension only ever reports `'vscode'` — see
 * `envelope.ts` for why the other four buckets never apply here.
 */
export const TELEMETRY_FORM_FACTOR = 'vscode' as const;
export type TelemetryFormFactor = typeof TELEMETRY_FORM_FACTOR;

/** `LICENSE_TIERS`. */
export const TELEMETRY_LICENSE_TIERS = ['openCore', 'edu', 'pro', 'enterprise'] as const;
export type TelemetryLicenseTier = (typeof TELEMETRY_LICENSE_TIERS)[number];

/** `EVENT_NAME` — `noun.verb` or `noun.subnoun.verb`, lowercase, dot-separated. */
export const TELEMETRY_EVENT_NAME_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+){1,2}$/;

/** `APP_VERSION` — bounded semver-ish, never a free-text channel. */
export const TELEMETRY_APP_VERSION_PATTERN =
  /^[0-9]{1,4}(\.[0-9]{1,4}){1,3}(?:[-+][0-9A-Za-z.]{1,16})?$/;

/** `INSTALLATION_ID` — a lowercase UUID and nothing else. */
export const TELEMETRY_INSTALLATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `LOCALE` — language, optional script, optional region. */
export const TELEMETRY_LOCALE_PATTERN = /^[a-z]{2,3}(?:_[A-Z][a-z]{3})?(?:_[A-Z]{2})?$/;

/** `PROPERTY_KEY` — the only shape a property name may take. */
export const TELEMETRY_PROPERTY_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * `PROPERTY_VALUE` — the only shape a string property value may take. No
 * spaces, no punctuation, no path separators, no capitals: a file name, a
 * signal name, or a rule message cannot survive this.
 */
export const TELEMETRY_PROPERTY_VALUE_PATTERN = /^[a-z0-9_]{1,64}$/;

/** `MAX_EVENTS` — events per batch. */
export const TELEMETRY_MAX_EVENTS_PER_BATCH = 500;
/** `MAX_PROPERTIES` — properties per event; extras are dropped, not rejected. */
export const TELEMETRY_MAX_PROPERTIES_PER_EVENT = 6;
/** `MAX_COUNT` — the ceiling for both an event's `count` and an integer property value. */
export const TELEMETRY_MAX_INTEGER = 100_000;
/** `MAX_BODY_BYTES` — the Worker rejects a batch above this outright. */
export const TELEMETRY_MAX_BODY_BYTES = 64 * 1024;

/** Whether [value] is a syntactically valid installation id. */
export function isValidTelemetryInstallationId(value: string): boolean {
  return TELEMETRY_INSTALLATION_ID_PATTERN.test(value);
}

/** Whether [value] is a syntactically valid catalog event name. */
export function isValidTelemetryEventName(value: string): boolean {
  return TELEMETRY_EVENT_NAME_PATTERN.test(value);
}

/** Whether [value] is a syntactically valid property key. */
export function isValidTelemetryPropertyKey(value: string): boolean {
  return TELEMETRY_PROPERTY_KEY_PATTERN.test(value);
}

/** Whether [value] is a syntactically valid string property value. */
export function isValidTelemetryPropertyStringValue(value: string): boolean {
  return TELEMETRY_PROPERTY_VALUE_PATTERN.test(value);
}
