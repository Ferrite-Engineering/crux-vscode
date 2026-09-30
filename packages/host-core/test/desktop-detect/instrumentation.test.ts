import { describe, expect, it } from 'vitest';
import { DesktopPeerDetector } from '../../src/desktop-detect/detector';
import { instrumentDesktopPeerDetection } from '../../src/desktop-detect/instrumentation';
import { TELEMETRY_EVENTS, type TelemetryEvent } from '../../src/telemetry/events';
import type { PeerIdentity } from '../../src/cxp/identity';

function identity(productName: string): PeerIdentity {
  return { peerId: `${productName}-1-1`, productName, productVersion: '0.1.0', capabilities: [] };
}

describe('instrumentDesktopPeerDetection', () => {
  it('reports the current state immediately, not only on a later transition', () => {
    const detector = new DesktopPeerDetector({ peers: () => [] });
    const recorded: TelemetryEvent[] = [];
    instrumentDesktopPeerDetection('wavecrux', detector, (event) => recorded.push(event));

    expect(recorded).toEqual([
      { name: TELEMETRY_EVENTS.desktopPeerDetected, properties: { product: 'wavecrux', present: false } },
    ]);
  });

  it('reports again on every transition for the product it was instrumented for', () => {
    let peers: PeerIdentity[] = [];
    const detector = new DesktopPeerDetector({ peers: () => peers });
    const recorded: TelemetryEvent[] = [];
    instrumentDesktopPeerDetection('wavecrux', detector, (event) => recorded.push(event));

    peers = [identity('wavecrux')];
    detector.refresh();
    peers = [];
    detector.refresh();

    expect(recorded.map((event) => event.properties)).toEqual([
      { product: 'wavecrux', present: false },
      { product: 'wavecrux', present: true },
      { product: 'wavecrux', present: false },
    ]);
  });

  it('a transition for a different product does not report through this instrumentation', () => {
    let peers: PeerIdentity[] = [];
    const detector = new DesktopPeerDetector({ peers: () => peers });
    const recorded: TelemetryEvent[] = [];
    instrumentDesktopPeerDetection('wavecrux', detector, (event) => recorded.push(event));
    recorded.length = 0; // discard the initial report

    peers = [identity('lintcrux')];
    detector.refresh();

    expect(recorded).toEqual([]);
  });

  it('disposing the subscription stops further reports', () => {
    let peers: PeerIdentity[] = [];
    const detector = new DesktopPeerDetector({ peers: () => peers });
    const recorded: TelemetryEvent[] = [];
    const subscription = instrumentDesktopPeerDetection('wavecrux', detector, (event) =>
      recorded.push(event),
    );
    subscription.dispose();

    peers = [identity('wavecrux')];
    detector.refresh();

    expect(recorded).toHaveLength(1); // only the initial report
  });
});
