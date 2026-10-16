/**
 * The opt-in regions: the EEA, the United Kingdom, Switzerland and South
 * Korea, where usage statistics need consent before anything is stored or
 * sent.
 *
 * The apps show their own disclosure there with the switch off. An
 * extension has no disclosure of its own: it follows VS Code's telemetry
 * setting, which is on by default everywhere. So in these regions the
 * extensions send nothing at all, whatever that setting says, and keep no
 * installation id. Mirrors `crux_telemetry`'s `telemetry_region.dart`: the
 * same country set, the same time-zone set, and the same rule that any one
 * signal is enough and none can veto another.
 */

/** ISO 3166 codes of the opt-in regions. Same set as `kTelemetryOptInCountries`. */
export const TELEMETRY_OPT_IN_COUNTRIES: ReadonlySet<string> = new Set([
  // EU 27.
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EEA, non-EU.
  'IS', 'LI', 'NO',
  // Own equivalents of the same rule.
  'GB', 'CH', 'KR',
]);

/** Every `Europe/` zone counts. Over-inclusive on purpose, as in `crux_telemetry`. */
export const TELEMETRY_OPT_IN_TIME_ZONE_PREFIX = 'Europe/';

/** IANA zones outside `Europe/` that place a machine in an opt-in region. Same set as `kTelemetryOptInTimeZones`. */
export const TELEMETRY_OPT_IN_TIME_ZONES: ReadonlySet<string> = new Set([
  'Atlantic/Reykjavik',
  'Atlantic/Azores',
  'Atlantic/Madeira',
  'Atlantic/Canary',
  'Arctic/Longyearbyen',
  'Atlantic/Jan_Mayen',
  'Asia/Nicosia',
  'Asia/Famagusta',
  'Africa/Ceuta',
  'America/Cayenne',
  'America/Guadeloupe',
  'America/Marigot',
  'America/Martinique',
  'Indian/Reunion',
  'Indian/Mayotte',
  'Asia/Seoul',
]);

const REGION_OVERRIDE = /(?:^|[@;\-_])rg[=-]([a-z]{2})[a-z0-9]{1,4}/gi;

/**
 * The countries a locale identifier names, upper-cased. Accepts BCP 47
 * (`en-GB`, `zh-Hans-CN`), POSIX (`en_GB.UTF-8`) and a region override
 * (`en_US@rg=gbzzzz`, `en-US-u-rg-gbzzzz`), which counts as well as the base
 * country. Same rules as `telemetryCountriesInLocaleId`.
 */
export function telemetryCountriesInLocaleId(localeId: string): Set<string> {
  const countries = new Set<string>();
  for (const match of localeId.matchAll(REGION_OVERRIDE)) {
    const region = match[1];
    if (region !== undefined) countries.add(region.toUpperCase());
  }
  const base = localeId.split(/[.@]/)[0] ?? '';
  for (const subtag of base.split(/[-_]/).slice(1)) {
    if (subtag.length === 4) continue;
    if (/^[A-Za-z]{2}$/.test(subtag)) countries.add(subtag.toUpperCase());
    break;
  }
  return countries;
}

/** What the machine says about where it is. Read once, never stored, never sent. */
export interface TelemetryRegionSignals {
  /** Locale identifiers: the editor's display language, the runtime's default locale, the locale environment variables. */
  readonly localeIds: readonly string[];
  /** The IANA time zone, when the runtime names one. */
  readonly timeZone?: string;
}

/** Whether these signals place the machine in an opt-in region. */
export function telemetryRequiresOptIn(signals: TelemetryRegionSignals): boolean {
  const zone = signals.timeZone;
  if (
    zone !== undefined &&
    (zone.startsWith(TELEMETRY_OPT_IN_TIME_ZONE_PREFIX) || TELEMETRY_OPT_IN_TIME_ZONES.has(zone))
  ) {
    return true;
  }
  return signals.localeIds.some((id) =>
    [...telemetryCountriesInLocaleId(id)].some((country) => TELEMETRY_OPT_IN_COUNTRIES.has(country)),
  );
}

const LOCALE_VARIABLES = [
  'LC_ALL',
  'LC_MESSAGES',
  'LC_CTYPE',
  'LC_TIME',
  'LC_NUMERIC',
  'LC_MONETARY',
  'LC_PAPER',
  'LC_MEASUREMENT',
  'LANG',
  'LANGUAGE',
] as const;

/** The signals this extension host can read. Never throws; a signal it cannot read is left out. */
export function hostTelemetryRegionSignals(displayLanguage: string): TelemetryRegionSignals {
  const localeIds: string[] = [displayLanguage];
  let timeZone: string | undefined;
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    localeIds.push(resolved.locale);
    timeZone = resolved.timeZone;
  } catch {
    // No Intl data: the other signals decide.
  }
  for (const name of LOCALE_VARIABLES) {
    const value = process.env[name];
    if (value !== undefined && value !== '') localeIds.push(...value.split(':'));
  }
  return timeZone === undefined ? { localeIds } : { localeIds, timeZone };
}
