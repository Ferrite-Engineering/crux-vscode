/**
 * Finding a running NetCrux desktop peer — NetCrux's binding of host-core's
 * [desktopDetect.discoverDesktopPeer].
 *
 * The general version lives in host-core because a second caller appeared
 * (the desktop artifact handoff, which needs the same address for the same
 * reason). Everything that was documented here is documented there: why it
 * is a one-shot `scanNow()` rather than a second continuous poller, and why
 * the freshest of several instances wins. This file supplies the one thing
 * that is NetCrux's — which product to look for.
 */
import { desktopDetect } from '@crux-vscode/host-core';
import type { cxp } from '@crux-vscode/host-core';
import { NETCRUX_PRODUCT } from '../status/copy';

/** Injected environment for [discoverNetCruxPeer]. */
export interface DiscoverNetCruxPeerDeps {
  /** Directory holding `<peer_id>.json` manifests. Production: `sharedCxpManifestDirectory()`. */
  readonly manifestDirectory: string;
}

/** The NetCrux desktop peer manifest, if one is live right now. */
export async function discoverNetCruxPeer(
  deps: DiscoverNetCruxPeerDeps,
): Promise<cxp.CxpPeerManifest | undefined> {
  return await desktopDetect.discoverDesktopPeer({
    product: NETCRUX_PRODUCT,
    manifestDirectory: deps.manifestDirectory,
  });
}
