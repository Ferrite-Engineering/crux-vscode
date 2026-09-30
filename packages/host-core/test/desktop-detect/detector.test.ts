import { describe, expect, it } from 'vitest';
import { CRUX_DESKTOP_PRODUCTS, DesktopPeerDetector } from '../../src/desktop-detect/detector';
import type { PeerIdentity } from '../../src/cxp/identity';

function identity(productName: string): PeerIdentity {
  return { peerId: `${productName}-1-1`, productName, productVersion: '0.1.0', capabilities: [] };
}

describe('DesktopPeerDetector', () => {
  it('reports presence per product, not one flag for "any desktop app"', () => {
    // Constraint E: WaveCrux desktop present, LintCrux desktop absent — a
    // user with one must still see the pitch for the other.
    const detector = new DesktopPeerDetector({ peers: () => [identity('wavecrux')] });
    expect(detector.isPresent('wavecrux')).toBe(true);
    expect(detector.isPresent('lintcrux')).toBe(false);
    expect(detector.isPresent('simcrux')).toBe(false);
    expect(detector.isPresent('netcrux')).toBe(false);
  });

  it('the snapshot covers every known desktop product, present or not', () => {
    const detector = new DesktopPeerDetector({ peers: () => [] });
    expect(detector.snapshot.map((row) => row.product).sort()).toEqual(
      [...CRUX_DESKTOP_PRODUCTS].sort(),
    );
    expect(detector.snapshot.every((row) => row.present === false)).toBe(true);
  });

  it('ignores peers that are not one of the four desktop products (e.g. another VSCode window)', () => {
    const detector = new DesktopPeerDetector({ peers: () => [identity('VSCode')] });
    expect(detector.snapshot.every((row) => row.present === false)).toBe(true);
  });

  it('refresh() recomputes from the live source and emits only on an actual change', () => {
    let peers: PeerIdentity[] = [];
    const detector = new DesktopPeerDetector({ peers: () => peers });
    const seen: (readonly { product: string; present: boolean }[])[] = [];
    detector.onDidChange.listen((snapshot) => seen.push(snapshot));

    detector.refresh(); // no change yet
    expect(seen).toHaveLength(0);

    peers = [identity('wavecrux')];
    detector.refresh();
    expect(seen).toHaveLength(1);
    expect(detector.isPresent('wavecrux')).toBe(true);

    detector.refresh(); // same peers again — no new event
    expect(seen).toHaveLength(1);

    peers = [];
    detector.refresh();
    expect(seen).toHaveLength(2);
    expect(detector.isPresent('wavecrux')).toBe(false);
  });
});
