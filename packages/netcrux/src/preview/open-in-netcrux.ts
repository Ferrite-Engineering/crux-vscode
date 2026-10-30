/**
 * "Open in NetCrux": hand the netlist being previewed to the desktop app.
 *
 * The desktop app has what the preview does not: Pro features, no size limit
 * (it reads a netlist from disk in chunks), and a window of its own. This is the
 * way out of the preview for all three.
 *
 * ### What happens, in order
 *
 * 1. **A NetCrux is running.** The netlist goes to it over CXP as a `source`
 *    artifact (the shared `openArtifactInDesktop`), and the app opens it in its
 *    active tab. That is the same handoff the capabilities panel makes, with one
 *    difference below.
 * 2. **None is running, but one is installed.** It is launched with the file as
 *    its argument; NetCrux opens a positional `.json` as a netlist tab.
 * 3. **None is installed.** The user is told, with a button to the download page.
 *
 * The one difference from the shared handoff is what it falls back to. Its
 * fallback is the operating system's opener, which for a `.json` is whatever
 * owns JSON on that machine, an editor, never NetCrux. So the fallback here is
 * step 2 or 3, and a running app that does not answer ends in the same place a
 * missing one does.
 */
import type { desktopDetect } from '@crux-vscode/host-core';

/** What [openInNetCrux] did, for tests and telemetry. */
export type OpenInNetCruxOutcome =
  /** The running app took it over CXP. */
  | { readonly kind: 'opened-in-running-app' }
  /** The running app is there and said no, or would not talk to this window. */
  | { readonly kind: 'refused-by-running-app' }
  /** An installed app was launched with the file. */
  | { readonly kind: 'launched' }
  /** No NetCrux was found: the user was pointed to the download page. */
  | { readonly kind: 'not-installed' }
  /** An installed app was found and could not be started. */
  | { readonly kind: 'launch-failed'; readonly error: unknown };

/** Injected environment for [openInNetCrux]. */
export interface OpenInNetCruxDeps {
  /**
   * Hand [fsPath] to a running NetCrux over CXP, falling back to [launch] when
   * none is reachable. Production: `desktopDetect.openArtifactInDesktop` with
   * the `openPath` below.
   */
  readonly handOff: (
    fsPath: string,
    fallback: (fsPath: string) => Promise<void>,
    showMessage: (message: string) => void,
  ) => Promise<desktopDetect.ArtifactHandoffOutcome>;
  /** Whether a NetCrux CXP peer is running. */
  readonly peerRunning: () => Promise<boolean>;
  /** The installed desktop app's launch target, if one is found. */
  readonly locateInstalled: () => string | undefined;
  /** Start the installed app with the file as its argument. */
  readonly launch: (installed: string, fsPath: string) => Promise<void>;
  /** Offer the download page. Resolves once the user has answered. */
  readonly offerInstall: () => Promise<void>;
  /** A non-modal confirmation. */
  readonly showMessage: (message: string) => void;
  /** Diagnostics. */
  readonly log: (line: string) => void;
  /** The confirmation text for a launch. */
  readonly launchedMessage: () => string;
}

/** Hand [fsPath] to NetCrux Desktop, by the ladder in the module docs. */
export async function openInNetCrux(
  fsPath: string,
  deps: OpenInNetCruxDeps,
): Promise<OpenInNetCruxOutcome> {
  const installed = deps.locateInstalled();

  // The fallback of the CXP handoff: reached when the peer did not answer. It
  // is the launch rung of the ladder, or the install offer when there is no
  // app to launch.
  let fellBackTo: 'launched' | 'not-installed' | undefined;
  const fallback = async (path: string): Promise<void> => {
    if (installed === undefined) {
      fellBackTo = 'not-installed';
      await deps.offerInstall();
      return;
    }
    await deps.launch(installed, path);
    fellBackTo = 'launched';
  };

  if (await deps.peerRunning()) {
    // The shared handoff words its messages for the OS fallback it normally
    // makes ("handed to your system's default application"). When the fallback
    // here ran, that sentence would be wrong, so only the messages of the
    // CXP outcomes are passed on and the launch is confirmed in our own words.
    const outcome = await deps.handOff(fsPath, fallback, (message) => {
      if (fellBackTo === undefined) deps.showMessage(message);
    });
    switch (outcome.kind) {
      case 'opened-in-peer':
        return { kind: 'opened-in-running-app' };
      case 'refused-by-peer':
      case 'refused-handshake':
        return { kind: 'refused-by-running-app' };
      case 'launched-externally':
        if (fellBackTo === 'not-installed') return { kind: 'not-installed' };
        deps.showMessage(deps.launchedMessage());
        return { kind: 'launched' };
      case 'failed':
        return { kind: 'launch-failed', error: outcome.error };
    }
  }

  if (installed === undefined) {
    deps.log('   open in NetCrux: no running peer and no installed app found');
    await deps.offerInstall();
    return { kind: 'not-installed' };
  }
  try {
    await deps.launch(installed, fsPath);
  } catch (error) {
    deps.log(`   open in NetCrux: launching ${installed} failed (${String(error)})`);
    return { kind: 'launch-failed', error };
  }
  deps.showMessage(deps.launchedMessage());
  return { kind: 'launched' };
}
