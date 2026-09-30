/**
 * [TelemetryClient] — one per product extension, owning that product's
 * queue, envelope, and sender.
 *
 * ### The gate, applied twice, on purpose
 *
 * [record] checks [TelemetryGateHost.isEnabled] live before an event ever
 * enters the queue: when consent is off, nothing is queued at all — the
 * strongest form of "gated at send time", since there is nothing left to
 * send. [flush] checks it again, live, before it builds a payload: that
 * second check is what makes the [TelemetryGateHost.onDidChange]
 * subscription in [start] correct rather than merely convenient — a
 * consent flip cannot land in the gap between "queued while enabled" and
 * "flushed on the next tick" and still ship, because the flush re-checks.
 * The `onDidChange(false)` handler drops the queue immediately besides,
 * so nothing already queued survives even until the next tick.
 *
 * Net effect: **no code path in this class can send an event recorded
 * while, or after, consent was withdrawn.** `test/telemetry/client.test.ts`
 * asserts this directly, including the "queue built up while enabled, then
 * consent withdrawn mid-session" sequence by name.
 *
 * ### The host is the only sender
 *
 * [record] is host-native. [recordFromWebview] is the other entry point —
 * the one a product's webview (WaveCrux's) posts an event descriptor
 * through. Both end at the same
 * [sanitizeTelemetryEvent] call, so a webview cannot reach a validation
 * path the host does not also apply to itself, and both share the one
 * envelope this class owns — a webview never constructs or sees an
 * envelope field, so there is no `os`/`form_factor`/`installation_id` a
 * webview could get wrong or spoof.
 *
 * ### What this class deliberately does not do
 *
 * No disk persistence and no retry backoff for the event queue itself
 * (unlike `crux_telemetry`'s `LiveTelemetryService`, which has both). A
 * VSCode extension host's session is short relative to a desktop app's,
 * the event volume here is an order of magnitude smaller, and a dropped
 * batch on a `flush()` failure is the same "lose the counter, not the
 * feature" trade-off the Dart client makes for every other failure mode —
 * `flush()` never throws into a caller. If usage ever justifies it, the
 * durable-queue shape to copy is already specified in
 * `crux_telemetry`'s README.
 */
import type { Disposable } from '../cxp/emitter';
import {
  buildTelemetryPayload,
  hostTelemetryOperatingSystem,
  normalizeTelemetryLocale,
  telemetrySessionStart,
  type TelemetryEnvelopeFields,
} from './envelope';
import {
  coalesceTelemetryEvents,
  sanitizeTelemetryEvent,
  type TelemetryEvent,
  type TelemetryPropertyValue,
} from './events';
import type { TelemetryGateHost } from './gate';
import type { TelemetrySender } from './sender';
import {
  TELEMETRY_MAX_EVENTS_PER_BATCH,
  type TelemetryLicenseTier,
  type TelemetryOperatingSystem,
  type TelemetryProduct,
} from './vocabulary';

/** Construction options for [TelemetryClient]. */
export interface TelemetryClientOptions {
  /** This client's product slug — one client per product extension. */
  readonly product: TelemetryProduct;
  /**
   * The running extension's version, read live. `undefined` defers the
   * flush (matches `crux_telemetry`: a wrong `app_version` fails loudly
   * server-side, so guessing one is worse than waiting).
   */
  readonly appVersion: () => string | undefined;
  /** This installation's persisted id — see `installation-id.ts`. */
  readonly installationId: () => string;
  /** The tier to report. Defaults to reporting `'openCore'` — no VSCode license system exists yet. */
  readonly licenseTier?: () => TelemetryLicenseTier;
  /** `vscode.env.language`, unnormalized — this class normalizes it. */
  readonly locale: () => string;
  /** Defaults to [hostTelemetryOperatingSystem]. Overridable only for tests. */
  readonly os?: () => TelemetryOperatingSystem;
  /** Where batches are POSTed — `telemetryEndpointFor(dev)`. */
  readonly endpoint: string;
  readonly gate: TelemetryGateHost;
  readonly sender: TelemetrySender;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Background flush cadence. Defaults to 5 minutes; irrelevant to tests, which call `flush()` directly. */
  readonly flushIntervalMs?: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 5 * 60_000;

/** Default `licenseTier`: `'openCore'` — see [TelemetryClientOptions.licenseTier]. */
function defaultLicenseTier(): TelemetryLicenseTier {
  return 'openCore';
}

/** Untrusted-shape guard for [TelemetryClient.recordFromWebview]. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class TelemetryClient {
  private readonly sessionStart: string;
  private queue: TelemetryEvent[] = [];
  private gateSubscription: Disposable | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: TelemetryClientOptions) {
    this.sessionStart = telemetrySessionStart(options.now ?? Date.now);
  }

  /**
   * Record a host-native event. Live-gated: when
   * `vscode.env.isTelemetryEnabled` is currently false, this is a
   * complete no-op — the event is never queued, so there is nothing for a
   * later consent change to leak.
   */
  record(event: TelemetryEvent): void {
    if (!this.options.gate.isEnabled()) return;
    const sanitized = sanitizeTelemetryEvent(event);
    if (sanitized === undefined) return;
    if (this.queue.length >= TELEMETRY_MAX_EVENTS_PER_BATCH) return;
    this.queue.push(sanitized);
  }

  /**
   * Record an event descriptor relayed from a webview. `raw` is untrusted
   * input — anything not shaped like `{ name, properties? }`
   * is dropped before it reaches [record], and what does reach [record]
   * goes through the exact same gate and sanitization a host-native event
   * does. There is no separate, weaker validation path for webview input.
   */
  recordFromWebview(raw: unknown): void {
    if (!isPlainRecord(raw)) return;
    const name = raw['name'];
    if (typeof name !== 'string') return;
    const rawProperties = raw['properties'];
    // The cast is safe, not a type-system escape hatch: `record()` below
    // calls `sanitizeTelemetryEvent`, which re-validates every key and
    // value regardless of what this claims about their type — that
    // re-validation is the actual security boundary, not this annotation.
    const properties = isPlainRecord(rawProperties)
      ? (rawProperties as Record<string, TelemetryPropertyValue>)
      : undefined;
    this.record({ name, ...(properties !== undefined ? { properties } : {}) });
  }

  /**
   * Send whatever is queued, gated live one more time, then clear the
   * queue. Never throws — a telemetry failure must not surface anywhere a
   * caller would notice.
   *
   * - **Consent currently off:** the queue is dropped, not sent. This is
   *   the second half of the consent gate — see the class docs.
   * - **`appVersion()` not yet known:** the queue is left intact and this
   *   returns; the next tick tries again. Matches `crux_telemetry`'s
   *   "envelope defers exactly as it does for an unresolved app_version".
   * - **The sender rejects:** the batch is dropped. See "What this class
   *   deliberately does not do" in the class docs for why there is no
   *   retry.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    if (!this.options.gate.isEnabled()) {
      this.queue = [];
      return;
    }
    const appVersion = this.options.appVersion();
    if (appVersion === undefined) return;

    const entries = coalesceTelemetryEvents(this.queue);
    this.queue = [];
    if (entries.length === 0) return;

    const envelope: TelemetryEnvelopeFields = {
      installationId: this.options.installationId(),
      appVersion,
      product: this.options.product,
      os: (this.options.os ?? hostTelemetryOperatingSystem)(),
      locale: normalizeTelemetryLocale(this.options.locale()),
      licenseTier: (this.options.licenseTier ?? defaultLicenseTier)(),
      sessionStart: this.sessionStart,
    };
    const payload = buildTelemetryPayload(envelope, entries);
    try {
      await this.options.sender.send(this.options.endpoint, payload);
    } catch {
      // Swallowed deliberately — see the class docs. A telemetry failure
      // is strictly worse to surface than to lose the counter.
    }
  }

  /**
   * Arm the background flush timer and the consent-withdrawal listener.
   * Idempotent; a second call is a no-op.
   */
  start(): void {
    if (this.timer !== undefined) return;
    this.gateSubscription = this.options.gate.onDidChange((enabled) => {
      if (!enabled) this.queue = [];
    });
    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    // Never hold the extension host's event loop open on telemetry's account.
    this.timer.unref?.();
  }

  /** Stop the timer and the consent listener. Does not flush or clear the queue. */
  dispose(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.gateSubscription?.dispose();
    this.gateSubscription = undefined;
  }

  /** Test/inspection seam: how many events are currently queued. */
  get queueLength(): number {
    return this.queue.length;
  }
}
