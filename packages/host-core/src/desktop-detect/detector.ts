/**
 * [DesktopPeerDetector] — per-product presence, derived from peers this
 * window already knows about.
 *
 * **Reads the existing discovery; never scans the manifest directory a
 * second time**. The production wiring (`window/window-host.ts`) passes
 * `() => peer.peers.map((manifest) => manifest.identity)` from the
 * discovery the window's CXP peer host already runs — this class has no
 * filesystem access of its own and no timer of its own, on purpose: a
 * second poller watching the same directory is exactly what it must not
 * add.
 */
import { Emitter, type Disposable } from '../cxp/emitter';
import type { PeerIdentity } from '../cxp/identity';
import { TELEMETRY_PRODUCTS, type TelemetryProduct } from '../telemetry/vocabulary';

/**
 * The four desktop products a VSCode window can detect a peer for.
 * Identical to [TELEMETRY_PRODUCTS] — one canonical list, so the set this
 * module detects against can never drift from the set telemetry reports
 * against.
 */
export const CRUX_DESKTOP_PRODUCTS = TELEMETRY_PRODUCTS;
export type CruxDesktopProduct = TelemetryProduct;

/** Whether a desktop peer for [product] is present in this window right now. */
export interface DesktopPeerPresence {
  readonly product: CruxDesktopProduct;
  readonly present: boolean;
}

/** Construction options for [DesktopPeerDetector]. */
export interface DesktopPeerDetectorOptions {
  /**
   * The peers currently known to this window, read live. Production
   * wiring: `CxpDiscovery.peers.map((manifest) => manifest.identity)`, or
   * `LocalCxpServer.connectedPeers` if presence should mean "reachable"
   * rather than merely "manifest on disk" — either is a legitimate choice
   * for a caller, and this class does not care which.
   */
  readonly peers: () => readonly PeerIdentity[];
}

function computeSnapshot(peers: readonly PeerIdentity[]): readonly DesktopPeerPresence[] {
  const present = new Set(peers.map((peer) => peer.productName));
  return CRUX_DESKTOP_PRODUCTS.map((product) => ({ product, present: present.has(product) }));
}

function sameSnapshot(
  a: readonly DesktopPeerPresence[],
  b: readonly DesktopPeerPresence[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, index) => {
    const other = b[index];
    return other !== undefined && other.product === row.product && other.present === row.present;
  });
}

/**
 * Per-product desktop-peer presence, computed on demand from a live peer
 * source.
 *
 * **Modelled per product, not as one flag**: a user with
 * the WaveCrux desktop app running and no LintCrux install has
 * `isPresent('wavecrux') === true` and `isPresent('lintcrux') === false`,
 * so the LintCrux surface still shows its own pitch while WaveCrux's
 * switches to a handoff. Collapsing this to "some desktop app is running"
 * would suppress every product's advertising the moment any one peer
 * appeared, which is exactly the bug this per-product shape prevents.
 */
export class DesktopPeerDetector {
  /** Fires with the new snapshot whenever [refresh] finds a change. */
  readonly onDidChange = new Emitter<readonly DesktopPeerPresence[]>();

  private readonly peersSource: () => readonly PeerIdentity[];
  private current: readonly DesktopPeerPresence[];

  constructor(options: DesktopPeerDetectorOptions) {
    this.peersSource = options.peers;
    this.current = computeSnapshot(this.peersSource());
  }

  /** Presence for every known desktop product, as of the last [refresh] (or construction). */
  get snapshot(): readonly DesktopPeerPresence[] {
    return this.current;
  }

  /** Whether a desktop peer for [product] is present, as of the last [refresh]. */
  isPresent(product: CruxDesktopProduct): boolean {
    return this.current.find((row) => row.product === product)?.present ?? false;
  }

  /**
   * Recompute from the live peer source. Call this whenever the
   * underlying discovery may have changed — wire it to `CxpDiscovery`'s
   * own `onEvent`. [onDidChange] fires only when presence actually
   * differs from the previous snapshot, so a scan that finds no change
   * produces no event.
   */
  refresh(): readonly DesktopPeerPresence[] {
    const next = computeSnapshot(this.peersSource());
    if (!sameSnapshot(this.current, next)) {
      this.current = next;
      this.onDidChange.emit(next);
    }
    return this.current;
  }
}

export type { Disposable };
