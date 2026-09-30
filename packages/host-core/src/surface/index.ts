/**
 * The registration interface each product package (wavecrux, lintcrux,
 * simcrux, netcrux) implements to plug into host-core.
 *
 * A VSCode window is **one** CXP peer no matter how many of the four
 * extensions are installed in it: one process, one listening socket, one
 * `peer_id`, one manifest. What differs between windows is what that peer
 * can actually *do* — and that is carried by `capabilities` (CXP §8.1),
 * which is why capabilities are **composed here from what is installed**
 * rather than hardcoded anywhere. A window with only the LintCrux
 * extension must not advertise waveform capabilities.
 *
 * See docs/implementation-map.md §2 (`surface`). Each product package
 * implements this interface in its own `surface.ts` and registers it with
 * `window.joinCruxWindow`.
 */
import type { ElementId } from '../cxp/element-id';
import { Emitter, type Disposable } from '../cxp/emitter';
import type { PeerIdentity } from '../cxp/identity';
import type { JsonObject } from '../cxp/json';
import type { CxpStreamCoordinate } from '../cxp/stream-coordinate';

/**
 * Capabilities every EDACrux VSCode window has, with no product surface
 * installed at all.
 *
 * Two, and both are things an editor can do with no product surface at all:
 *
 * - `request_open_source` — open a file at a line and column, which is the
 *   whole of that message;
 * - `request_open_artifact` — resolve `(design_id, kind)` through the shared
 *   workspace manifest (or the request's `path` hint) and open the
 *   result. Listed here rather than on a surface because the resolution and
 *   the §11 containment are host-core's, and the *opening* goes through
 *   VSCode's own editor resolution: a window with no Crux surface at all
 *   still genuinely honours it.
 *
 * Everything else — highlighting a signal, acting on a selection — needs a
 * surface to route to, so a bare window advertising it would be lying.
 *
 * (`capabilities` is advisory per §8.1 and no Dart product currently
 * consults it before sending, so an honest list costs us nothing today and
 * is the only list that stays correct when one does.)
 */
export const BASE_VSCODE_CAPABILITIES: readonly string[] = [
  // Listed in the order `capabilities()` sorts into, so a test may compare
  // against this constant directly.
  'request_open_artifact',
  'request_open_source',
];

/**
 * The capability strings the Dart peers publish today, for surfaces that
 * want to advertise a matching one.
 *
 * Deliberately short: `wavecrux_cxp_server.dart` is the only Dart server
 * that advertises anything beyond the message kinds, and it advertises
 * exactly these two. A surface is free to declare its own string; this is
 * a shared spelling for the ones already on the wire, not a closed set.
 */
export const KNOWN_PEER_CAPABILITIES = {
  /** WaveCrux: can report the value of a signal at a time. */
  wavecruxSignalValue: 'wavecrux.signal_value',
  /** WaveCrux: can report/accept the cursor time in femtoseconds. */
  wavecruxCursorTimeFs: 'wavecrux.cursor_time_fs',
} as const;

/**
 * An inbound `request_highlight` (CXP §9.4) offered to a surface.
 *
 * The [element] is passed through **exactly as it arrived**. §6.1 requires
 * an unrecognised element kind to survive intact, so nothing between the
 * socket and the surface normalises, lowercases, or drops a kind this build
 * has never heard of — a surface built against a later vocabulary can
 * honour a request host-core cannot classify.
 */
export interface SurfaceHighlightRequest {
  /** What to bring into view. Unmodified peer input. */
  readonly element: ElementId;
  /** Where *within* the element to land (§9.9), when the sender said. */
  readonly coordinate?: CxpStreamCoordinate;
  /** Free-form sender context; unknown keys must be ignored (§9.3). */
  readonly metadata: JsonObject;
  /** Who asked. Identity only — never a channel to reply on. */
  readonly from: PeerIdentity;
}

/**
 * A surface's answer to a [SurfaceHighlightRequest].
 *
 * Three outcomes, and the third is the one that makes routing work:
 *
 * - `honored` — the surface acted. Routing stops.
 * - `refused` — the surface *owns* this kind of element and still cannot
 *   act (the netlist is loaded, the net simply is not in it). Routing
 *   stops, and [reason] becomes the ack's reason.
 * - `declined` — not this surface's kind of element at all. Routing
 *   continues to the next surface.
 *
 * Collapsing the last two would mean the first-registered extension could
 * answer for the whole window: LintCrux, asked to highlight a waveform
 * signal, would refuse it and WaveCrux would never be offered the request.
 * Returning `undefined` is the same as `declined`, so a surface that only
 * handles one kind can `return` early without ceremony.
 */
export type SurfaceHighlightResult =
  | { readonly outcome: 'honored'; readonly reason?: string }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'declined' };

/**
 * One product's presence in this window.
 *
 * Registered by the product extension on activation and disposed on its
 * deactivation, so the composed capability list tracks what is actually
 * installed *and enabled* rather than what was installed at first launch.
 */
export interface CruxSurface {
  /**
   * Product short name — `wavecrux`, `lintcrux`, `simcrux`, `netcrux`.
   * Registering the same id twice replaces the earlier registration
   * (an extension that reactivates must not double its capabilities).
   */
  readonly id: string;
  /** Full VSCode extension id, e.g. `ferrite-engineering.lintcrux`. */
  readonly extensionId: string;
  /**
   * Capability strings this surface adds to the window's advertised set.
   *
   * Declare only what the surface can genuinely act on **right now**. A
   * capability is a promise to the sender that it need not defend against
   * `unsupported`; a receiver must still answer correctly regardless.
   */
  readonly capabilities: readonly string[];
  /**
   * Offer this surface an inbound `request_highlight`.
   *
   * Optional: a surface with nothing to highlight (a task provider, say)
   * omits it and is skipped. Deliberately part of *this* interface rather
   * than a second registry — one registration means one lifetime, and a
   * surface can never be present for capability composition while absent
   * for routing.
   *
   * May be async. May throw: `routeRequestHighlight` treats a throw as a
   * decline so one broken extension cannot swallow the window's highlight
   * routing.
   */
  readonly highlight?: (
    request: SurfaceHighlightRequest,
  ) => SurfaceHighlightResult | undefined | Promise<SurfaceHighlightResult | undefined>;
}

/**
 * The set of product surfaces active in this window, and the CXP
 * capability list composed from them.
 *
 * host-core owns one of these; the CXP identity is built from
 * [capabilities] so that identity reflects the installed surfaces. The
 * registry never imports from a surface package — surfaces push into it.
 */
export class SurfaceRegistry {
  /**
   * Fires whenever the registered set changes, with the new composed
   * capability list.
   *
   * Capabilities are announced in the handshake and in the published
   * manifest, so a change after either has gone out only reaches peers on
   * the next manifest heartbeat (≤30 s) and the next handshake. That is
   * acceptable precisely because capabilities are advisory — but a
   * consumer that wants the manifest refreshed promptly listens here.
   */
  readonly onDidChange = new Emitter<readonly string[]>();

  private readonly registered = new Map<string, CruxSurface>();

  /** Surfaces currently registered, in registration order. */
  get surfaces(): readonly CruxSurface[] {
    return [...this.registered.values()];
  }

  /** Whether a surface with [id] is registered. */
  has(id: string): boolean {
    return this.registered.has(id);
  }

  /**
   * Register [surface]; dispose the result to remove it.
   *
   * The disposable is idempotent and only ever removes *this*
   * registration — a re-registration under the same id that happened in
   * between is left alone, so a slow deactivate cannot unregister the
   * activation that replaced it.
   */
  register(surface: CruxSurface): Disposable {
    this.registered.set(surface.id, surface);
    this.onDidChange.emit(this.capabilities());
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.registered.get(surface.id) !== surface) return;
        this.registered.delete(surface.id);
        this.onDidChange.emit(this.capabilities());
      },
    };
  }

  /**
   * The window's advertised CXP capabilities: [BASE_VSCODE_CAPABILITIES]
   * plus every registered surface's, deduplicated and sorted.
   *
   * Sorted so the value is stable for a given set of surfaces regardless
   * of activation order — two windows with the same extensions publish
   * byte-identical manifests, which makes a diff of the manifest directory
   * readable.
   */
  capabilities(): readonly string[] {
    const all = new Set<string>(BASE_VSCODE_CAPABILITIES);
    for (const surface of this.registered.values()) {
      for (const capability of surface.capabilities) all.add(capability);
    }
    return [...all].sort();
  }
}

export type { Disposable };
