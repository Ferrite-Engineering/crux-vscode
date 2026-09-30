/**
 * Finding a running desktop peer's **address** — read-only, on demand.
 *
 * [DesktopPeerDetector] answers *presence* (a boolean per product) from the
 * discovery a surface already runs. It deliberately does not expose a
 * manifest's `host`/`port`, because for a long time nothing in a VSCode
 * window dialled anybody. Two things now do — NetCrux's "what drives this"
 * and the desktop artifact handoff — and both need the address.
 *
 * This adds **no second poller**, the failure mode `desktop-detect`'s own
 * docs call out (a second watcher over the same directory is what once
 * turned laptop sleep into a suite-wide disconnect). It runs
 * [CxpDiscovery.scanNow] exactly once, reading whatever the manifest
 * directory holds at the moment the user invoked the command, and discards
 * the object. No `start()`, no interval, no state. A directory that does not
 * exist reads as "no peers", the correct answer on a machine where no Crux
 * app has ever run.
 */
import { CxpDiscovery } from './../cxp/discovery';
import type { CxpPeerManifest } from './../cxp/manifest';
import type { CruxDesktopProduct } from './detector';

/** Injected environment for [discoverDesktopPeer]. */
export interface DiscoverDesktopPeerOptions {
  /** The product whose peer to find. */
  readonly product: CruxDesktopProduct;
  /** Directory holding `<peer_id>.json`. Production: `sharedCxpManifestDirectory()`. */
  readonly manifestDirectory: string;
}

/**
 * The live desktop manifest for [product], or `undefined` when none is
 * running (or the manifest directory could not be read).
 *
 * With more than one instance of a product running — two design sessions at
 * once — the most recently started wins. A deliberate simplification rather
 * than a second disambiguation quick-pick: either instance is a reasonable
 * place to land, and picking the freshest is the same defensible-rather-than-
 * obviously-right call the CXP dial tie-break makes.
 */
export async function discoverDesktopPeer(
  options: DiscoverDesktopPeerOptions,
): Promise<CxpPeerManifest | undefined> {
  const discovery = new CxpDiscovery({ manifestDirectory: options.manifestDirectory });
  await discovery.scanNow();
  const candidates = discovery.peers.filter(
    (manifest) => manifest.identity.productName === options.product,
  );
  return candidates.reduce<CxpPeerManifest | undefined>((freshest, candidate) => {
    if (freshest === undefined || candidate.startedAt > freshest.startedAt) return candidate;
    return freshest;
  }, undefined);
}
