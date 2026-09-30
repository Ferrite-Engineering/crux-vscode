/**
 * The event catalog and the per-event validation/sanitization/coalescing
 * that sits between a call site and the network.
 *
 * host-core owns this catalog — unlike a Dart product's own feature
 * catalog (`crux_telemetry`'s README: "no event catalog... the one part of
 * telemetry that is genuinely per-product") — because every name here
 * describes host-core's **own** behaviour: activation, the file-open
 * funnel, the status surface, the desktop-detection segmentation. A
 * product's feature-usage names are still its own; `featureUsedEvent`
 * below is the shared shape each product's own call sites
 * build on, not a closed list of features.
 */
import {
  TELEMETRY_MAX_INTEGER,
  TELEMETRY_MAX_PROPERTIES_PER_EVENT,
  TELEMETRY_PROPERTY_KEY_PATTERN,
  TELEMETRY_PROPERTY_VALUE_PATTERN,
  isValidTelemetryEventName,
} from './vocabulary';

/** A property value in the shape the Worker's `encodeProperties` accepts. */
export type TelemetryPropertyValue = string | number | boolean;

/** One occurrence of a catalog event, before coalescing. */
export interface TelemetryEvent {
  readonly name: string;
  readonly properties?: Readonly<Record<string, TelemetryPropertyValue>>;
}

/**
 * The host-core event catalog.
 *
 * Every value here already matches [isValidTelemetryEventName] — asserted
 * by `test/telemetry/events.test.ts` so a typo can never ship silently as
 * "no event sent" (an unrecognised name is dropped by [sanitizeTelemetryEvent],
 * not rejected loudly).
 */
export const TELEMETRY_EVENTS = {
  /**
   * The extension host activated in this window. Fired once per
   * activation, by whichever product extension's `activate()` calls it —
   * every extension shares this name so "installs vs. activations" is one
   * query across the whole pack, not four.
   */
  activated: 'extension.activated',
  /**
   * A file the surface understands was opened. Properties: `format` (a
   * closed per-surface token, e.g. `vcd`, `sv`) and `size_bucket` (see
   * [telemetrySizeBucket] — never a byte count: file sizes are never sent).
   */
  fileOpened: 'file.opened',
  /**
   * The first file this **installation** has ever opened — the
   * acquisition-to-activation conversion moment. Fired at
   * most once per installation; the caller is responsible for persisting
   * that it already fired (`context.globalState`, mirroring how
   * [installation-id.ts] persists the id itself).
   */
  firstFileOpened: 'file.first_opened',
  /**
   * A registered analysis feature was invoked. Property: `feature`, a
   * token from the calling product's own vocabulary — host-core validates
   * its *shape* (via [sanitizeTelemetryEvent]) but does not own the list,
   * exactly as `crux_telemetry` does not own a product's feature names.
   */
  featureUsed: 'feature.used',
  /**
   * A tier badge (a Pro-gated action rendered visible-but-badged) was
   * shown to the user. Property: `tier` — the tier the
   * badge names, not the viewer's own tier.
   */
  badgeImpression: 'badge.impression',
  /** The same badge was clicked/selected. Properties as [badgeImpression]. */
  badgeClick: 'badge.click',
  /**
   * The status-bar item's capabilities panel was opened — the click,
   * because clicks on a passive affordance are far better intent data than
   * dismissals of an interruption. There is deliberately no
   * "dismissed" counterpart: a status bar item is never modal, so there is
   * nothing to dismiss.
   */
  statusPanelOpened: 'status.panel_opened',
  /**
   * A desktop peer for one product became present or absent in this
   * window. Properties: `product` (one of the four desktop
   * products) and `present` (bool).
   *
   * This is the funnel's key metric, computed as a **join across events
   * sharing `installation_id`**, not as a single number this event
   * carries: an installation with `extension.activated` / `file.opened`
   * rows and no `desktop.peer_detected{present=true}` row for the
   * matching product is "arrived via the extension, no desktop install
   * yet"; the same installation later gaining such a row is the
   * conversion. Firing this once at activation (whatever the state is)
   * and again on every transition is what makes that join possible —
   * silence is not distinguishable from "never checked".
   */
  desktopPeerDetected: 'desktop.peer_detected',
} as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[keyof typeof TELEMETRY_EVENTS];

/**
 * Coarse size buckets. **Never a byte count** — file sizes are never sent,
 * and this bucket is the coarse stand-in. The thresholds are host-core's own and are not
 * meant to match any product's internal size classification; they exist
 * only to answer "roughly how big are the files people open", which is
 * useful for prioritising performance work without ever recording one.
 */
export const TELEMETRY_SIZE_BUCKETS = ['tiny', 'small', 'medium', 'large', 'huge'] as const;
export type TelemetrySizeBucket = (typeof TELEMETRY_SIZE_BUCKETS)[number];

/**
 * Bucket [bytes] into a [TelemetrySizeBucket]. The byte count itself is
 * consumed and discarded here — nothing upstream of this function's
 * return value may ever see it again.
 */
export function telemetrySizeBucket(bytes: number): TelemetrySizeBucket {
  if (!Number.isFinite(bytes) || bytes < 0) return 'tiny';
  if (bytes < 1_000_000) return 'tiny'; // < 1 MB
  if (bytes < 10_000_000) return 'small'; // < 10 MB
  if (bytes < 100_000_000) return 'medium'; // < 100 MB
  if (bytes < 1_000_000_000) return 'large'; // < 1 GB
  return 'huge';
}

/**
 * Sanitize a raw properties bag into the shape the Worker will actually
 * keep, mirroring `encodeProperties` client-side: an invalid key or value
 * is **dropped**, not rejected — one bad property must not cost the whole
 * event, matching the Worker's own "drop, don't reject" policy for
 * properties (as opposed to envelope fields, which fail the whole batch).
 *
 * This is also the enforcement point for the value rules and for the
 * host being the only sender: it
 * is applied identically to a host-native `record()` call and a
 * webview-relayed one, so a webview cannot smuggle a value past whatever
 * the host would have applied to itself. A hostile value (a path, a signal
 * name, anything with punctuation, spaces, or capitals) fails
 * [TELEMETRY_PROPERTY_VALUE_PATTERN] and is dropped here, before it is
 * ever queued — not merely before it is sent.
 */
export function sanitizeTelemetryProperties(
  properties: Readonly<Record<string, unknown>> | undefined,
): Record<string, TelemetryPropertyValue> {
  const sanitized: Record<string, TelemetryPropertyValue> = {};
  if (properties === undefined || properties === null || typeof properties !== 'object') {
    return sanitized;
  }
  let kept = 0;
  for (const key of Object.keys(properties).sort()) {
    if (kept >= TELEMETRY_MAX_PROPERTIES_PER_EVENT) break;
    if (!TELEMETRY_PROPERTY_KEY_PATTERN.test(key)) continue;
    const value: unknown = properties[key];
    if (typeof value === 'string') {
      if (!TELEMETRY_PROPERTY_VALUE_PATTERN.test(value)) continue;
      sanitized[key] = value;
    } else if (typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      Math.abs(value) <= TELEMETRY_MAX_INTEGER
    ) {
      sanitized[key] = value;
    } else {
      continue;
    }
    kept += 1;
  }
  return sanitized;
}

/**
 * Validate and sanitize one [TelemetryEvent]. Returns `undefined` when the
 * event name itself is malformed — the one case that drops the whole
 * event rather than merely a property, because an event with no valid
 * name has nothing to attach a count to.
 */
export function sanitizeTelemetryEvent(event: TelemetryEvent): TelemetryEvent | undefined {
  if (!isValidTelemetryEventName(event.name)) return undefined;
  const properties = sanitizeTelemetryProperties(event.properties);
  return Object.keys(properties).length > 0 ? { name: event.name, properties } : { name: event.name };
}

/** One coalesced row: a distinct `(name, properties)` pair and its count. */
export interface TelemetryBatchEntry {
  readonly name: string;
  readonly properties?: Readonly<Record<string, TelemetryPropertyValue>>;
  readonly count: number;
}

/** Deterministic key for grouping — sorted keys so property order never matters. */
function coalesceKey(event: TelemetryEvent): string {
  const properties = event.properties ?? {};
  const sortedEntries = Object.keys(properties)
    .sort()
    .map((key) => [key, properties[key]] as const);
  return JSON.stringify([event.name, sortedEntries]);
}

/**
 * Fold identical `(name, properties)` pairs into one row with a count,
 * matching `crux_telemetry`'s `coalesceTelemetryEvents` — both so the
 * payload is smaller and so the ingest side's Analytics Engine sampling
 * index stays sound (the index must distinguish every
 * row a single batch can produce, and coalescing is what makes "every row"
 * tractable in the first place).
 */
export function coalesceTelemetryEvents(
  events: readonly TelemetryEvent[],
): readonly TelemetryBatchEntry[] {
  const order: string[] = [];
  const byKey = new Map<string, TelemetryBatchEntry>();
  for (const raw of events) {
    const sanitized = sanitizeTelemetryEvent(raw);
    if (sanitized === undefined) continue;
    const key = coalesceKey(sanitized);
    const existing = byKey.get(key);
    if (existing === undefined) {
      order.push(key);
      byKey.set(key, { ...sanitized, count: 1 });
    } else {
      byKey.set(key, { ...existing, count: existing.count + 1 });
    }
  }
  return order.map((key) => {
    const entry = byKey.get(key);
    if (entry === undefined) throw new Error('coalesceTelemetryEvents: internal key mismatch');
    return entry;
  });
}
