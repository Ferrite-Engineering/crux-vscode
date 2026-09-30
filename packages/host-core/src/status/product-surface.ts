/**
 * [registerProductStatusSurface] — a product extension's **per-product**
 * desktop-detection wiring, in host-core, once.
 *
 * Every product package needs exactly the same things at activation:
 *
 * 1. a read-only [cxp.CxpDiscovery] over the shared manifest directory, so
 *    "is <product> Desktop running" is answered by the directory every Crux
 *    product already publishes into;
 * 2. a [DesktopPeerDetector] fed from that discovery — never a second
 *    filesystem poller;
 * 3. [instrumentDesktopPeerDetection] bound to *this* product's telemetry
 *    client;
 * 4. a `vscode.commands.registerCommand` behind
 *    [desktopHandoffCommandId], whose behaviour is the only genuinely
 *    per-product part.
 *
 * All four products need it verbatim. Four copies of this function is precisely the copy-pasted-TypeScript failure the shared
 * host exists to prevent, so it lives here and each product supplies only
 * its *words* ([ProductCapabilityCopy]) and its *handoff behaviour*.
 *
 * ### What used to be here and is not any more: the status bar
 *
 * This function also built the ONE [StatusBarController] — once per
 * extension, which with all four installed meant four status-bar items
 * and, worse, four registrations of `edacrux.openCapabilitiesPanel`.
 * `vscode.commands.registerCommand` throws on a duplicate id, so three of
 * the four extensions failed to activate entirely. The status bar and the
 * capabilities panel are window-level singletons and now belong to the
 * elected [window.CruxWindowHost]; a product contributes its *words* to
 * that panel through [window.joinCruxWindow]'s `copy`, and the handoff
 * command below — whose id is per-product and therefore never collides —
 * stays here.
 *
 * ### The discovery is read-only, and has no manifest of its own
 *
 * No `selfPeerId` is passed and no manifest is written: publishing a
 * manifest for a process that is not listening would put a dead endpoint in
 * front of every other product in the suite. Discovery here is purely "who
 * else is up", which is all desktop detection needs. The scan timer is `unref`'d by
 * [cxp.CxpDiscovery] itself, so it never holds the extension host open.
 */
import * as vscode from 'vscode';
import { CxpDiscovery, sharedCxpManifestDirectory } from '../cxp';
import {
  DesktopPeerDetector,
  desktopHandoffCommandId,
  instrumentDesktopPeerDetection,
  type CruxDesktopProduct,
} from '../desktop-detect';
import type { TelemetryEvent } from '../telemetry/events';

/** Disposable bundle returned by [registerProductStatusSurface]. */
export interface ProductStatusSurface extends vscode.Disposable {
  /**
   * The live detector, or `undefined` on a machine where discovery could
   * not be stood up at all. Exposed for live-verification harnesses and
   * for a caller that wants to branch on desktop presence itself — a
   * product's handoff command usually does.
   */
  readonly detector: DesktopPeerDetector | undefined;
}

/** What [registerProductStatusSurface] needs from a product's `activate()`. */
export interface ProductStatusSurfaceOptions {
  /** The product whose row switches between pitch and handoff. */
  readonly product: CruxDesktopProduct;
  /** This product's telemetry client's `record`. */
  readonly record: (event: TelemetryEvent) => void;
  /** Diagnostics, so a discovery failure is visible rather than silent. */
  readonly log: (line: string) => void;
  /**
   * Behaviour for `edacrux.openInDesktop.<product>`.
   *
   * host-core names the id and deliberately does not implement it: what a
   * handoff *sends* is the one thing that differs per product (a waveform
   * file, a `.lintcrux` project, a regression). Omit it and the command is
   * not registered at all — better an absent command than a palette entry
   * that errors.
   */
  readonly handoff?: () => void | Promise<void>;
}

/**
 * Stand up discovery, desktop detection and the handoff command for one
 * product.
 *
 * Never throws. A machine with no resolvable application-data root (no
 * `$HOME`, a stripped container) raises [cxp.CxpDiscoveryUnavailableError]
 * from `sharedCxpManifestDirectory`; that must cost the user desktop
 * *detection*, not the status bar — so the detector is left undefined and
 * every row falls back to the install pitch, which is the correct answer
 * when we genuinely cannot tell.
 */
export function registerProductStatusSurface(
  options: ProductStatusSurfaceOptions,
): ProductStatusSurface {
  const { product, record, log } = options;
  const disposables: vscode.Disposable[] = [];

  let discovery: CxpDiscovery | undefined;
  let detector: DesktopPeerDetector | undefined;
  try {
    const manifestDirectory = sharedCxpManifestDirectory();
    discovery = new CxpDiscovery({ manifestDirectory });
    const liveDiscovery = discovery;
    detector = new DesktopPeerDetector({
      peers: () => liveDiscovery.peers.map((manifest) => manifest.identity),
    });
    const liveDetector = detector;
    // `start()` resolves after the first scan; nothing here awaits it,
    // because `activate()` must not block the extension host on a
    // filesystem walk. The status bar renders from whatever the detector
    // knows at click time, which is the whole reason `buildContent` is a
    // callback rather than a snapshot.
    void discovery.start().then(
      () => {
        liveDetector.refresh();
      },
      (error: unknown) => {
        log(`   desktop detection unavailable: ${String(error)}`);
      },
    );
    disposables.push({ dispose: () => liveDiscovery.stop() });
    disposables.push(
      liveDiscovery.onEvent.listen(() => {
        liveDetector.refresh();
      }),
    );
    disposables.push(instrumentDesktopPeerDetection(product, liveDetector, record));
  } catch (error) {
    log(`   desktop detection unavailable: ${String(error)}`);
  }

  const handoff = options.handoff;
  if (handoff !== undefined) {
    disposables.push(
      vscode.commands.registerCommand(desktopHandoffCommandId(product), () => handoff()),
    );
  }

  return {
    detector,
    dispose: () => {
      for (const disposable of disposables.reverse()) disposable.dispose();
    },
  };
}
