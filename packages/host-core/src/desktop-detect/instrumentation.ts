/**
 * Wires [DesktopPeerDetector] transitions to the telemetry catalog's
 * `desktop.peer_detected` event — the adoption funnel's key segmentation
 * dimension: of installations that arrive with no desktop peer, how many
 * later gain one.
 *
 * Kept as a tiny, independent composition function rather than folded
 * into either [DesktopPeerDetector] or `TelemetryClient` — the detector
 * covers all four products at once, while a telemetry client is scoped to
 * one product's envelope, so *something* has to bridge "detector says
 * WaveCrux's presence changed" to "record it through WaveCrux's client".
 * `status/registerProductStatusSurface` calls this once per installed
 * product, each with that product's own `TelemetryClient.record` bound in.
 */
import type { Disposable } from '../cxp/emitter';
import { TELEMETRY_EVENTS, type TelemetryEvent } from '../telemetry/events';
import type { CruxDesktopProduct, DesktopPeerDetector } from './detector';

/**
 * Record [product]'s current desktop-peer presence through [record] now,
 * and again every time [detector] reports a change for [product].
 *
 * Firing once immediately (not only on change) is deliberate: silence is
 * not distinguishable from "never checked" in the analytics data, and the
 * funnel query needs a `desktop.peer_detected{present=false}` row to
 * exist for an installation that never had the desktop app, not merely
 * the absence of a `present=true` one — see [TELEMETRY_EVENTS.desktopPeerDetected]'s
 * doc comment for the query shape this makes possible.
 */
export function instrumentDesktopPeerDetection(
  product: CruxDesktopProduct,
  detector: DesktopPeerDetector,
  record: (event: TelemetryEvent) => void,
): Disposable {
  let lastReported = detector.isPresent(product);
  const report = (present: boolean): void => {
    record({
      name: TELEMETRY_EVENTS.desktopPeerDetected,
      properties: { product, present },
    });
  };

  report(lastReported);

  // `detector.onDidChange` fires on any product's transition, not just
  // this one — a LintCrux peer appearing must not re-report WaveCrux's
  // unchanged presence. Tracking `lastReported` locally is what keeps
  // this instrumentation's output to "the initial value, then one row per
  // actual transition of *this* product", matching the doc comment above.
  return detector.onDidChange.listen((snapshot) => {
    const row = snapshot.find((entry) => entry.product === product);
    const present = row?.present ?? false;
    if (present === lastReported) return;
    lastReported = present;
    report(present);
  });
}
