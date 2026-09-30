/**
 * [joinCruxWindow] — the one call every product extension's `activate()`
 * makes, and [deactivateCruxWindow] — the one call its `deactivate()`
 * makes.
 *
 * Written once here rather than four times in four `extension.ts` files on
 * purpose: the election is the kind of logic where four hand-written copies
 * would agree today and disagree after the first edit, and two EDACrux
 * extensions that disagree about who hosts is precisely the failure this
 * module exists to prevent. The standing rule ("the host core is the only
 * place shared behaviour lives") has no sharper case than this one.
 */
import * as vscode from 'vscode';
import type { Disposable } from '../cxp/emitter';
import type { PeerIdentity } from '../cxp/identity';
import type { CruxDesktopProduct } from '../desktop-detect';
import { cruxExtensionId } from '../editor/peer-extension';
import type { ElementPathResolver } from '../editor/send';
import type { ProductCapabilityCopy } from '../status/panel-content';
import type { TelemetryEvent } from '../telemetry/events';
import type { TelemetryLicenseTier } from '../telemetry/vocabulary';
import type { CruxSurface } from '../surface/index';
import {
  CRUX_WINDOW_API_VERSION,
  type CruxWindowApi,
  type CruxWindowContribution,
  type CruxWindowCrossProbe,
} from './api';
import {
  electCruxWindowRole,
  type CruxWindowRole,
  type ExtensionRegistryView,
} from './election';
import { CruxWindowHost, type CruxWindowHostOptions } from './window-host';

/** What [joinCruxWindow] needs from a product extension's `activate()`. */
export interface CruxWindowJoinOptions {
  /** This extension's context. */
  readonly context: vscode.ExtensionContext;
  /** This extension's product. */
  readonly product: CruxDesktopProduct;
  /** This product's CXP surface — see the product package's `surface.ts`. */
  readonly surface: CruxSurface;
  /** This product's words for the capabilities panel. */
  readonly copy?: ProductCapabilityCopy;
  /**
   * This product's identifier → design-path resolver, if it keeps one.
   * Carried in the contribution, so the window-level send commands use it
   * whichever extension hosts — see [CruxWindowContribution.resolver].
   */
  readonly resolver?: ElementPathResolver;
  /** Diagnostics, into this extension's output channel. */
  readonly log: (line: string) => void;
  /** This product's telemetry `record`. Used only if this extension hosts. */
  readonly record: (event: TelemetryEvent) => void;
  /** Tier the panel reports when this extension hosts. */
  readonly tier?: TelemetryLicenseTier;
  /** Extension lookup. Defaults to `vscode.extensions`. Tests inject. */
  readonly extensions?: ExtensionRegistryView;
  /** Passed through to [CruxWindowHost] when this extension hosts. Tests. */
  readonly hostOptions?: Partial<
    Pick<CruxWindowHostOptions, 'manifestDirectory' | 'heartbeatIntervalMs' | 'peerStartDelayMs'>
  >;
}

/** This extension's membership of the window. */
export interface CruxWindowMembership {
  /**
   * **Return this from `activate()`.** It becomes this extension's
   * `exports`, which is how every other EDACrux extension in the window
   * finds it.
   */
  readonly api: CruxWindowApi;
  /** The [CruxWindowHost], when this extension is the one hosting. */
  readonly host: CruxWindowHost | undefined;
  /** Resolves once the role is settled. Tests and harnesses. */
  settled(): Promise<CruxWindowRole>;
  /** Idempotent; async because a host must delete its manifest. */
  dispose(): Promise<void>;
}

/** The membership this bundle created, for [deactivateCruxWindow]. */
let current: CruxWindowMembership | undefined;

/**
 * Real [ExtensionRegistryView] over `vscode.extensions`.
 *
 * `getExtension` returns `undefined` for an extension that is not
 * installed **or is disabled**, which is exactly the question the election
 * asks — a disabled extension will never activate and must not be elected.
 */
const vscodeExtensions: ExtensionRegistryView = {
  getExtension(id: string) {
    const extension = vscode.extensions.getExtension(id);
    if (extension === undefined) return undefined;
    return {
      id: extension.id,
      get isActive(): boolean {
        return extension.isActive;
      },
      get exports(): unknown {
        // Throws for an extension that has not activated — see
        // [ExtensionHandle.exports]. `readWindowApi` checks `isActive`
        // first; this second guard is what keeps a future caller that
        // forgets from taking an `activate()` down with it.
        try {
          return extension.exports as unknown;
        } catch {
          return undefined;
        }
      },
      activate: async (): Promise<unknown> => (await extension.activate()) as unknown,
    };
  },
};

/**
 * Elect a window host, join it, and hand back the api to export.
 *
 * **Returns synchronously and never blocks `activate()`.** The election's
 * one asynchronous step is `await`ing a sibling's activation, and doing
 * that inside `activate()` would make every guest's activation wait on the
 * host's — a chain that is harmless today and a deadlock the day something
 * makes the host wait on a guest. So the role resolves in a floating
 * promise, contributions made before it settles are queued, and
 * [CruxWindowApi.isWindowHost] answers honestly at read time.
 */
export function joinCruxWindow(options: CruxWindowJoinOptions): CruxWindowMembership {
  const extensions = options.extensions ?? vscodeExtensions;
  const selfExtensionId = cruxExtensionId(options.product);

  let host: CruxWindowHost | undefined;
  let guestApi: CruxWindowApi | undefined;
  let disposed = false;
  const pending: CruxWindowContribution[] = [];
  const registrations: Disposable[] = [];

  const registerNow = (contribution: CruxWindowContribution): Disposable | undefined => {
    if (host !== undefined) return host.join(contribution);
    if (guestApi !== undefined) return guestApi.join(contribution);
    return undefined;
  };

  const api: CruxWindowApi = {
    cruxWindowApiVersion: CRUX_WINDOW_API_VERSION,
    isWindowHost: () => host !== undefined,
    hostExtensionId: () =>
      host !== undefined ? selfExtensionId : guestApi?.hostExtensionId() ?? undefined,
    join: (contribution: CruxWindowContribution): Disposable => {
      if (disposed) return { dispose: () => undefined };
      const immediate = registerNow(contribution);
      if (immediate !== undefined) {
        registrations.push(immediate);
        return immediate;
      }
      // The role has not settled yet. Queue it; `settle` flushes. A join
      // that arrives before the election finishes is the *normal* case for
      // this extension's own surface, not an edge case.
      pending.push(contribution);
      let cancelled = false;
      return {
        dispose: () => {
          if (cancelled) return;
          cancelled = true;
          const index = pending.indexOf(contribution);
          if (index >= 0) pending.splice(index, 1);
        },
      };
    },
    peers: (): readonly PeerIdentity[] => {
      if (host !== undefined) return host.peers.map((manifest) => manifest.identity);
      return guestApi?.peers() ?? [];
    },
    capabilities: (): readonly string[] => {
      if (host !== undefined) return host.registry.capabilities();
      return guestApi?.capabilities() ?? [];
    },
    // Forwarded rather than re-implemented on the guest path: the window has
    // one peer, so it has one cross-probe state, and a guest that built its
    // own would be reporting on a `CxpPeerHost` that does not exist in its
    // bundle. `?.()` because the host may be an older build with no such
    // method — see [CruxWindowApi.crossProbe].
    crossProbe: (): CruxWindowCrossProbe | undefined => {
      if (host !== undefined) return host.crossProbe;
      return guestApi?.crossProbe?.();
    },
  };

  const adopt = (role: CruxWindowRole): void => {
    if (disposed) return;
    if (role.kind === 'host') {
      options.log(`   window: hosting this window (${role.reason})`);
      host = new CruxWindowHost({
        context: options.context,
        product: options.product,
        log: options.log,
        record: options.record,
        ...(options.tier !== undefined ? { tier: options.tier } : {}),
        ...options.hostOptions,
      });
    } else {
      options.log(
        `   window: ${role.api.hostExtensionId() ?? 'another extension'} hosts this window (${role.reason})`,
      );
      guestApi = role.api;
    }
    for (const contribution of pending.splice(0, pending.length)) {
      const registration = registerNow(contribution);
      if (registration !== undefined) registrations.push(registration);
    }
  };

  const settled = electCruxWindowRole({
    self: options.product,
    extensions,
    log: options.log,
  }).then(
    (role) => {
      adopt(role);
      return role;
    },
    (error: unknown) => {
      // `electCruxWindowRole` is documented never to reject; if it somehow
      // does, hosting is the safe answer — a duplicate manifest is
      // recoverable, a window with no peer at all is silent.
      options.log(`   window: election failed (${String(error)}); hosting`);
      const role: CruxWindowRole = { kind: 'host', reason: 'election failed' };
      adopt(role);
      return role;
    },
  );

  // This extension's own surface, queued now and registered the moment the
  // role settles.
  registrations.push(
    api.join({
      surface: options.surface,
      ...(options.copy !== undefined ? { copy: options.copy } : {}),
      ...(options.resolver !== undefined ? { resolver: options.resolver } : {}),
    }),
  );

  const membership: CruxWindowMembership = {
    api,
    get host(): CruxWindowHost | undefined {
      return host;
    },
    settled: async () => await settled,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const registration of registrations.reverse()) registration.dispose();
      registrations.length = 0;
      await host?.dispose();
      host = undefined;
      guestApi = undefined;
      if (current === membership) current = undefined;
    },
  };

  // Synchronous disposal too: VSCode disposes `subscriptions` on unload,
  // and the async `deactivate()` path below is what actually awaits the
  // manifest removal.
  options.context.subscriptions.push({
    dispose: () => {
      void membership.dispose();
    },
  });
  current = membership;
  return membership;
}

/**
 * **What every EDACrux extension's `deactivate()` returns.**
 *
 * `deactivate()` may return a promise and VSCode awaits it (briefly) before
 * tearing the extension host down; `context.subscriptions` disposal cannot
 * be awaited at all. Deleting the published manifest is a filesystem write,
 * and a manifest left behind is the failure CXP §10.3 warns about from the
 * other side: every peer in the suite dials a closed port until it reaps
 * us. So the removal has to happen on the one path that can be waited on.
 *
 * A no-op in an extension that is not hosting, and idempotent.
 */
export async function deactivateCruxWindow(): Promise<void> {
  await current?.dispose();
  current = undefined;
}
