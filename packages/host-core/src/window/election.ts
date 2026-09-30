/**
 * Choosing which of the installed EDACrux extensions owns the window's
 * singletons — deterministically, from any activation order, with any
 * subset installed.
 *
 * Pure except for `await`ing an injected extension handle, so every branch
 * below is exercised by `test/window/election.test.ts` without a live
 * extension host.
 */
import type { CruxDesktopProduct } from '../desktop-detect';
import { cruxExtensionId } from '../editor/peer-extension';
import { isCruxWindowApi, type CruxWindowApi } from './api';

/**
 * Priority order for the static half of the election, by extension id
 * ascending.
 *
 * Two properties are wanted and this is the shortest thing that has both.
 *
 * **Deterministic and activation-order independent.** Every extension
 * computes the winner from the same list and the same "is it installed"
 * answer, so no message passing and no lock is needed to agree — which is
 * what removes the race the naive design has, where whoever activates
 * first wins and the answer changes between launches.
 *
 * **It puts WaveCrux last**, which alphabetical order gives for free and
 * which is worth keeping deliberately: WaveCrux's VSIX is the one carrying
 * a Flutter web payload, and electing it would mean a window with LintCrux
 * and WaveCrux installed activates WaveCrux's entry point purely to own a
 * socket. (Activation does not load the webview payload, so the cost is
 * small — but it is a cost with no benefit, and a rule that avoids it for
 * free is better than one that does not.)
 *
 * Never reorder this to express a preference. Any total order works; a
 * *changing* order does not, because two extensions from different
 * releases would disagree about the winner and both host.
 */
export const CRUX_WINDOW_HOST_ORDER: readonly CruxDesktopProduct[] = [
  'lintcrux',
  'netcrux',
  'simcrux',
  'wavecrux',
];

/**
 * The part of `vscode.Extension` the election reads, behind an interface
 * so the whole algorithm is testable under plain Node.
 */
export interface ExtensionHandle {
  readonly id: string;
  /**
   * VSCode's own flag. **Not a success signal** — measured: an extension
   * whose `activate()` threw still reports `isActive === true`, and its
   * `exports` is `undefined`. So nothing here branches on it; the api
   * shape is the only evidence that an extension is participating.
   */
  readonly isActive: boolean;
  /**
   * Whatever the extension's `activate()` returned. Untrusted, and — this
   * is the part that is not obvious — **it may throw**.
   *
   * Measured: reading `vscode.Extension.exports` for an installed,
   * enabled, not-yet-activated extension raises
   * `Error: Extension 'ferrite-engineering.lintcrux' is not known or not
   * activated`. An extension that read it during its own `activate()` to
   * see whether a sibling was hosting would therefore fail to activate
   * whenever that sibling had simply not been woken yet — the same shape
   * of failure this module exists to eliminate. [readWindowApi] is the
   * only place it is read, and it guards.
   */
  readonly exports: unknown;
  /**
   * `vscode.Extension.activate` — resolves once, on demand.
   *
   * **It does not always resolve.** Measured on VSCode 1.130.0 against the
   * suite's own extension pack (`ferrite-engineering.edacrux`, an
   * `extensionPack` manifest with no `main`): `getExtension` returns a
   * handle, `isActive` stays `false`, and `activate()` had still not
   * settled after 30 s — neither resolving nor rejecting.
   *
   * The `await` below is therefore only safe because every id it can reach
   * is one of the four *product* extensions, each of which has a `main`.
   * `test/window/untrusted-workspaces.test.ts` pins that: the election
   * looks up [CRUX_WINDOW_HOST_ORDER] and nothing else, so the pack is
   * never a candidate. Adding a timeout here instead would be worse — a
   * sibling that is merely slow would be excluded and elect a second host,
   * which is the failure this module exists to prevent.
   */
  activate(): Promise<unknown>;
}

/** The `vscode.extensions` lookup, injectable for tests. */
export interface ExtensionRegistryView {
  /**
   * `undefined` when the extension is not installed **or is disabled**.
   *
   * "Disabled" includes **disabled by workspace trust**, and that case is
   * the one worth stating because it is the one that changes who hosts.
   * Measured on VSCode 1.130.0, real VSIXes in a clean profile with an
   * untrusted folder open: an extension VSCode has disabled for trust is
   * absent from `vscode.extensions.all` and `getExtension` returns
   * `undefined` for it — **not** a handle with `isActive === false`. So a
   * `capabilities.untrustedWorkspaces.supported: false` extension
   * (SimCrux — see `trust.ts`) is not a candidate here at all, no
   * `activate()` is attempted on it, and the election converges on the
   * first surviving product in the order with no special case anywhere.
   */
  getExtension(id: string): ExtensionHandle | undefined;
}

/** The role one extension plays in this window. */
export type CruxWindowRole =
  | { readonly kind: 'host'; readonly reason: string }
  | { readonly kind: 'guest'; readonly api: CruxWindowApi; readonly reason: string };

/** Inputs to [electCruxWindowRole]. */
export interface CruxWindowElectionOptions {
  /** The product asking. Always treated as installed — it is running. */
  readonly self: CruxDesktopProduct;
  /** Where to look siblings up. Production: `vscode.extensions`. */
  readonly extensions: ExtensionRegistryView;
  /** Priority order. Defaults to [CRUX_WINDOW_HOST_ORDER]. */
  readonly order?: readonly CruxDesktopProduct[];
  /** Diagnostics. */
  readonly log?: (line: string) => void;
}

/**
 * The api of a sibling that is *already hosting*, if there is one.
 *
 * Synchronous and side-effect free: it never activates anything, because
 * "is someone already hosting" must be answerable during our own
 * `activate()` without waiting on anybody.
 */
export function activeWindowHostApi(
  options: Pick<CruxWindowElectionOptions, 'self' | 'extensions' | 'order'>,
): CruxWindowApi | undefined {
  for (const product of options.order ?? CRUX_WINDOW_HOST_ORDER) {
    if (product === options.self) continue;
    const api = readWindowApi(options.extensions.getExtension(cruxExtensionId(product)));
    if (api?.isWindowHost() === true) return api;
  }
  return undefined;
}

/**
 * [handle]'s exports as a [CruxWindowApi], or `undefined`.
 *
 * Two guards, both established by measurement rather than by reading the
 * API docs:
 *
 * - **`isActive` first**, because reading `exports` on an extension that
 *   has not activated *throws* (see [ExtensionHandle.exports]);
 * - **try/catch anyway**, because `isActive` is set by VSCode around the
 *   activation call and the window between "flagged active" and "exports
 *   assigned" is not ours to reason about.
 */
export function readWindowApi(handle: ExtensionHandle | undefined): CruxWindowApi | undefined {
  if (handle === undefined || !handle.isActive) return undefined;
  let exported: unknown;
  try {
    exported = handle.exports;
  } catch {
    return undefined;
  }
  return isCruxWindowApi(exported) ? exported : undefined;
}

/**
 * Decide whether this extension hosts the window or joins a sibling.
 *
 * Three rules, applied in order, and the ordering is the whole design:
 *
 * 1. **An incumbent wins, whatever the priority order says.** If any
 *    sibling already reports `isWindowHost()`, join it. This is what makes
 *    a mid-session install correct: a user who installs LintCrux into a
 *    window already hosted by SimCrux gets LintCrux joining SimCrux, not a
 *    second host appearing because the static order prefers LintCrux.
 *    Hosting is never handed over while a window is running — a handover
 *    would have to move a listening socket and a published `peer_id` from
 *    one bundle to another, and the window it would tidy up is one the
 *    user is about to reload anyway.
 *
 * 2. **Otherwise the first installed product in [CRUX_WINDOW_HOST_ORDER]
 *    hosts.** At a cold start every extension is inside its own
 *    `activate()`, so rule 1 finds nothing for any of them and they all
 *    reach the same answer from the same static list — no race, no
 *    handshake, no lock.
 *
 * 3. **A winner that cannot host is skipped.** If the elected sibling
 *    fails to activate, or activates but exports nothing we recognise (an
 *    older build predating this module), it is excluded and the election
 *    re-runs. Every guest excludes the same candidate for the same reason,
 *    so they converge on the same replacement.
 *
 * Never rejects and never throws: an extension that cannot determine a
 * host at all becomes the host, since the failure mode of "two hosts" is
 * strictly better than "no peer at all, silently".
 */
export async function electCruxWindowRole(
  options: CruxWindowElectionOptions,
): Promise<CruxWindowRole> {
  const order = options.order ?? CRUX_WINDOW_HOST_ORDER;
  const { self, extensions } = options;

  const incumbent = activeWindowHostApi({ self, extensions, order });
  if (incumbent !== undefined) {
    return { kind: 'guest', api: incumbent, reason: 'joined the running host' };
  }

  const excluded = new Set<CruxDesktopProduct>();
  for (;;) {
    const winner = order.find(
      (product) =>
        !excluded.has(product) &&
        (product === self || extensions.getExtension(cruxExtensionId(product)) !== undefined),
    );
    if (winner === undefined || winner === self) {
      // Re-check for an incumbent one last time: we may have awaited a
      // sibling's activation above, and a *third* extension may have
      // become the host while we did.
      const late = activeWindowHostApi({ self, extensions, order });
      if (late !== undefined) {
        return { kind: 'guest', api: late, reason: 'joined a host that appeared while electing' };
      }
      return { kind: 'host', reason: 'first installed extension in the host order' };
    }

    const handle = extensions.getExtension(cruxExtensionId(winner));
    /* c8 ignore next 4 -- `find` only returns an installed product. */
    if (handle === undefined) {
      excluded.add(winner);
      continue;
    }
    let activated: unknown;
    try {
      // On-demand activation: the elected host may have no activation
      // event that has fired yet, and VSCode returns the in-flight promise
      // when activation is already under way rather than starting a
      // second one.
      activated = await handle.activate();
    } catch (error) {
      options.log?.(`   window: ${handle.id} failed to activate (${String(error)})`);
      excluded.add(winner);
      continue;
    }
    // `activate()` resolves to the extension's exports. Preferred over
    // re-reading `handle.exports`, which is a getter with its own
    // preconditions — see [ExtensionHandle.exports].
    const api = isCruxWindowApi(activated) ? activated : readWindowApi(handle);
    if (api !== undefined) return { kind: 'guest', api, reason: `joined ${handle.id}` };
    options.log?.(`   window: ${handle.id} exports no window api; excluded from the election`);
    excluded.add(winner);
  }
}
