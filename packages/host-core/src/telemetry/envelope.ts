/**
 * The per-batch envelope: its fields, how each is derived, and the JSON
 * payload shape the Worker's `POST /v1/events` expects.
 *
 * `crux_telemetry`'s payload contract
 * (`packages/crux_telemetry/README.md` § "Payload contract") is the
 * template this mirrors — same field names, same `events[]` shape — so a
 * dataset row produced by the extension reads exactly like one produced by
 * a desktop or mobile build, differing only in `form_factor`.
 */
import type { TelemetryBatchEntry, TelemetryPropertyValue } from './events';
import {
  TELEMETRY_FORM_FACTOR,
  TELEMETRY_LOCALE_PATTERN,
  type TelemetryLicenseTier,
  type TelemetryOperatingSystem,
  type TelemetryProduct,
} from './vocabulary';

/** Production ingestion endpoint (`POST /v1/events`). */
export const TELEMETRY_PRODUCTION_ENDPOINT = 'https://telemetry.edacrux.app/v1/events';
/** Staging/dev ingestion endpoint (`POST /dev/v1/events`) — a distinct dataset, not a header flag. */
export const TELEMETRY_STAGING_ENDPOINT = 'https://telemetry.edacrux.app/dev/v1/events';

/**
 * Resolve the ingestion endpoint. **The path selects the dataset**: a dev
 * build must post to the dev path, never the production one with a flag
 * in the body — see the Worker's own header comment for why that
 * invariant matters (a misconfigured client cannot silently write staging
 * events into production).
 */
export function telemetryEndpointFor(dev: boolean): string {
  return dev ? TELEMETRY_STAGING_ENDPOINT : TELEMETRY_PRODUCTION_ENDPOINT;
}

/**
 * `os` for events this extension originates. Unlike the Dart webview
 * client — whose `os` stays `'web'` forever because `kIsWeb` cannot see
 * past the browser sandbox it runs in (see `telemetry_platform.dart`) —
 * this code runs as the VSCode **extension host**, a real Node process on
 * a real desktop OS, so reporting the actual platform is both accurate
 * and cheap. `form_factor: 'vscode'` is what already marks the traffic as
 * editor-hosted; `os` answers "which desktop OS", the same question it
 * answers for every other platform.
 *
 * This applies uniformly to host-native events AND to events relayed from
 * a product's webview (the envelope is entirely host-owned — see
 * `client.ts` — so there is no second `os` derivation to
 * keep in sync with the Dart side's `kIsWeb` branch).
 */
export function hostTelemetryOperatingSystem(
  platform: NodeJS.Platform = process.platform,
): TelemetryOperatingSystem {
  switch (platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      // linux, and every other Node platform (freebsd, openbsd, sunos, aix)
      // the extension host might report — falls back to the closest known
      // bucket rather than an unlisted value that would reject the whole
      // batch, matching the Dart derivation's own fuchsia -> linux fallback.
      return 'linux';
  }
}

/**
 * Normalize `vscode.env.language` (e.g. `en`, `zh-cn`, `pt-br`) into the
 * Worker's Unicode-locale shape (`en`, `zh_CN`, `pt_BR`).
 *
 * VSCode's own locale identifiers are lowercase and hyphen-separated;
 * [TELEMETRY_LOCALE_PATTERN] expects an underscore-separated Unicode
 * locale with an uppercase region and a title-cased script, matching what
 * every Dart build already sends. Getting this right is what lets
 * "does zh_CN earn its maintenance cost" answer the same question
 * for the extension as it does for the desktop app; getting it wrong does
 * not fail loudly — the Worker soft-degrades an unrecognised locale to
 * `''` rather than rejecting the batch — so a silent mismatch here would
 * simply undercount a locale forever rather than error.
 */
export function normalizeTelemetryLocale(vscodeLocale: string): string {
  const segments = vscodeLocale.trim().split('-').filter((segment) => segment.length > 0);
  const [language, ...rest] = segments;
  if (language === undefined || !/^[a-zA-Z]{2,3}$/.test(language)) return '';
  let normalized = language.toLowerCase();
  for (const segment of rest) {
    if (/^[a-zA-Z]{4}$/.test(segment)) {
      // Script subtag: title-case (`hans` -> `Hans`).
      normalized += `_${segment[0]?.toUpperCase() ?? ''}${segment.slice(1).toLowerCase()}`;
    } else if (/^[a-zA-Z]{2}$/.test(segment)) {
      // Region subtag: uppercase (`cn` -> `CN`).
      normalized += `_${segment.toUpperCase()}`;
    }
    // Anything else (numeric region codes, variants) is not part of the
    // Worker's locale shape and is dropped rather than guessed at.
  }
  return TELEMETRY_LOCALE_PATTERN.test(normalized) ? normalized : '';
}

/** Fields carried once per batch, shared by every event in it. */
export interface TelemetryEnvelopeFields {
  readonly installationId: string;
  readonly appVersion: string;
  readonly product: TelemetryProduct;
  readonly os: TelemetryOperatingSystem;
  readonly locale: string;
  readonly licenseTier: TelemetryLicenseTier;
  /** ISO-8601 instant, e.g. `2026-08-10T09:15:00Z`. Never an end or a duration. */
  readonly sessionStart: string;
}

/** The JSON body `POST /v1/events` expects. */
export interface TelemetryPayload {
  readonly installation_id: string;
  readonly app_version: string;
  readonly product: TelemetryProduct;
  readonly os: TelemetryOperatingSystem;
  readonly form_factor: typeof TELEMETRY_FORM_FACTOR;
  readonly locale: string;
  readonly license_tier: TelemetryLicenseTier;
  readonly session_start: string;
  readonly events: readonly {
    readonly name: string;
    readonly properties?: Readonly<Record<string, TelemetryPropertyValue>>;
    readonly count: number;
  }[];
}

/** Assemble the wire payload for one batch. */
export function buildTelemetryPayload(
  envelope: TelemetryEnvelopeFields,
  entries: readonly TelemetryBatchEntry[],
): TelemetryPayload {
  return {
    installation_id: envelope.installationId,
    app_version: envelope.appVersion,
    product: envelope.product,
    os: envelope.os,
    form_factor: TELEMETRY_FORM_FACTOR,
    locale: envelope.locale,
    license_tier: envelope.licenseTier,
    session_start: envelope.sessionStart,
    events: entries.map((entry) => ({
      name: entry.name,
      ...(entry.properties !== undefined && Object.keys(entry.properties).length > 0
        ? { properties: entry.properties }
        : {}),
      count: entry.count,
    })),
  };
}

/** `session_start` for a session beginning now, normalized to whole seconds UTC. */
export function telemetrySessionStart(now: () => number = Date.now): string {
  return new Date(now()).toISOString().slice(0, 19) + 'Z';
}
