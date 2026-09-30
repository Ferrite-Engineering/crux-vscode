/**
 * The cross-extension contract that makes four separately-installed
 * extensions behave as **one** EDACrux window.
 *
 * ### The problem this exists to solve
 *
 * All four product extensions run in one VSCode extension-host process, but
 * esbuild bundles a private copy of host-core into each VSIX. There is no
 * shared module instance: `import { SurfaceRegistry }` in LintCrux and the
 * same import in SimCrux are different classes backed by different memory.
 * So anything a *window* may have exactly one of — one CXP `peer_id`, one
 * listening socket, one published manifest, one status-bar item, one
 * `edacrux.*` command registration — cannot be created by each extension
 * independently. Doing so produces, in order of how badly it fails:
 *
 * - **four peer manifests for one window**, so every Dart product in the
 *   suite sees four VSCode peers and dials all of them;
 * - **four status-bar items** where the window should have one status surface;
 * - **an activation failure**, because `vscode.commands.registerCommand`
 *   throws on a duplicate id and the throw escapes `activate()`. Measured,
 *   before this module existed: with all four installed, LintCrux activated
 *   and the other three died with `command 'edacrux.openCapabilitiesPanel'
 *   already exists`.
 *
 * ### The mechanism
 *
 * VSCode's own idiom for extension-to-extension communication: whatever
 * `activate()` returns becomes `vscode.extensions.getExtension(id).exports`,
 * a live object reference readable by any other extension in the process.
 * Every EDACrux extension returns a [CruxWindowApi]. Exactly one of them
 * reports `isWindowHost() === true` and owns the window-level singletons;
 * the rest [CruxWindowApi.join] it, contributing their surface, their words
 * and, where they keep one, their name resolver. See `election.ts` for how
 * the one is chosen.
 *
 * ### Why not `extensionDependencies`
 *
 * It would guarantee activation order, and it is the wrong tool: VSCode
 * treats `extensionDependencies` as a hard *install* dependency and will
 * install the named extension alongside. All four of these ship separately
 * and a user who installs LintCrux must not silently also get WaveCrux —
 * a 7 MB VSIX carrying a Flutter web payload they never asked for. The
 * ordering guarantee is obtained instead from
 * `vscode.extensions.getExtension(id).activate()`, which activates a
 * sibling on demand whatever its own activation events say, and which
 * returns the in-flight promise when activation is already under way.
 */
import type {
  CrossProbeSelection,
  CrossProbeSendOutcome,
  CrossProbeSnapshot,
} from '../cross-probe';
import type { Disposable } from '../cxp/emitter';
import type { PeerIdentity } from '../cxp/identity';
import type { ElementPathResolver } from '../editor/send';
import type { ProductCapabilityCopy } from '../status/panel-content';
import type { CruxSurface } from '../surface/index';

/**
 * Version of the [CruxWindowApi] shape. Incremented only for a change that
 * an older guest could not survive.
 *
 * ### Negotiation rule: a guest accepts **any** host version ≥ 1
 *
 * The obvious rule — "join only a host whose version I recognise" — is
 * wrong here, and wrong in the direction that breaks the invariant this
 * whole module exists for. A guest that refuses a *newer* host elects
 * itself instead, and the window ends up with two hosts and two manifests:
 * exactly the failure the negotiation was supposed to prevent. Refusing to
 * join can only ever be worse than joining, so the compatibility burden
 * sits on the host: [CruxWindowApi.join] takes a plain structural object
 * and must stay additive forever, in the same spirit as CXP §6.1's
 * forward-compatibility rule (`cxp/version.ts`).
 */
export const CRUX_WINDOW_API_VERSION = 1;

/**
 * What one product extension contributes to the window it joins.
 *
 * Deliberately data, not behaviour-with-a-lifetime: everything here is
 * either a value or a callback the host may invoke, and the *only* handle
 * back is the [Disposable] [CruxWindowApi.join] returns. A guest that
 * deactivates disposes it and the window recomposes — which is what makes
 * "capabilities track what is installed **and enabled**" true at runtime
 * rather than only at startup.
 */
export interface CruxWindowContribution {
  /**
   * This product's CXP surface: the capability strings it adds to the
   * window's advertised set, and its optional `request_highlight` handler.
   */
  readonly surface: CruxSurface;
  /**
   * This product's words for the capabilities panel row.
   *
   * Optional because the panel can render a product row from its display
   * name and the shared defaults alone; supplying it is how a product
   * keeps its own pitch and handoff label.
   */
  readonly copy?: ProductCapabilityCopy;
  /**
   * This product's identifier → design-path resolver, when it keeps one —
   * a `names.NameResolver` over its stems index.
   *
   * The window-level `edacrux.sendSelectionToPeer` /
   * `edacrux.highlightSelectionInPeer` commands are registered by whichever
   * extension the election picks, which is often not the one holding the
   * index (LintCrux hosts a four-extension window; NetCrux and WaveCrux keep
   * the stems indexes). Contributing the resolver is how the host's commands
   * resolve names the same way the product's own commands do. The host asks
   * each contributed resolver in turn and sends the identifier verbatim when
   * none answers (`editor.composeElementPathResolvers`).
   *
   * Optional and structural: an older host ignores the field, an older guest
   * omits it, and only `resolve` is ever called on it — the object comes
   * from another bundle, so nothing may depend on its prototype.
   */
  readonly resolver?: ElementPathResolver;
}

/**
 * The object every EDACrux extension returns from `activate()`.
 *
 * Every field is a **function**, not a value, and that is load-bearing:
 * `exports` is captured once by VSCode and read later by whoever asks, so
 * a guest that is still resolving its role, or an extension that becomes
 * the host asynchronously after a higher-priority sibling failed to
 * activate, must be able to answer honestly at read time rather than at
 * return time.
 */
export interface CruxWindowApi {
  /** See [CRUX_WINDOW_API_VERSION]. */
  readonly cruxWindowApiVersion: number;
  /**
   * Whether *this* extension owns the window's singletons right now.
   *
   * The election reads this and nothing else to recognise an incumbent: an
   * extension installed mid-session must join the host that is already
   * running rather than the one a static priority order would have picked.
   */
  isWindowHost(): boolean;
  /** Extension id of the host, once known — for diagnostics. */
  hostExtensionId(): string | undefined;
  /**
   * Add [contribution] to the window. Dispose the result to remove it.
   *
   * Throws nothing: called on a non-host api it registers nothing and
   * returns an inert disposable, because the caller has no way to know it
   * raced a role change and a throw would fail an `activate()`.
   */
  join(contribution: CruxWindowContribution): Disposable;
  /**
   * The CXP peers this window has discovered, excluding itself.
   *
   * Exposed so each product's desktop detection reads the **one** scanner
   * the host already runs instead of starting a fifth filesystem poller.
   */
  peers(): readonly PeerIdentity[];
  /** The window's composed CXP capability list. Diagnostics and tests. */
  capabilities(): readonly string[];
  /**
   * The window's cross-probe state, for a surface that renders a panel over
   * it. `undefined` from a build older than this method.
   *
   * **Optional, and it has to be**: `exports` may be an older sibling's
   * bundle, and [CRUX_WINDOW_API_VERSION] deliberately does not gate a guest
   * from joining a host it does not fully recognise (see the version note
   * above — refusing to join is always worse than joining). So this is
   * additive and every caller must handle its absence, which degrades to
   * exactly the behaviour that shipped before it existed.
   *
   * The returned object is **stable for the window's lifetime**, including
   * before the CXP peer has started — a surface activates immediately and
   * the peer starts on a settle delay, so an accessor that returned
   * `undefined` until the peer was up would force every caller to poll for
   * it. Subscribe now; the first snapshot arrives when there is one.
   */
  crossProbe?(): CruxWindowCrossProbe | undefined;
}

/**
 * The window's cross-probe state and its one directed-send entry point, as
 * a guest extension sees it.
 *
 * Deliberately four plain functions rather than the [crossProbe.CrossProbeHost]
 * itself: this object crosses a bundle boundary, so nothing about it may
 * depend on `instanceof`, on a shared prototype, or on the host and the guest
 * having compiled the same version of a class.
 */
export interface CruxWindowCrossProbe {
  /** The state right now. Safe before the peer has started. */
  snapshot(): CrossProbeSnapshot;
  /** Fires on every change. Dispose to stop listening. */
  onDidChange(listener: (snapshot: CrossProbeSnapshot) => void): Disposable;
  /** Send one selection to one peer. Never throws; failure is an outcome. */
  send(peerId: string, selection: CrossProbeSelection): CrossProbeSendOutcome;
}

/**
 * Whether [value] — which came from another extension's `exports` and is
 * therefore entirely untrusted — is a usable [CruxWindowApi].
 *
 * Structural, never `instanceof`: the object was built by a *different
 * bundle's* copy of this module, so it shares no prototype with anything
 * here even when it is the same version of the same source file.
 */
export function isCruxWindowApi(value: unknown): value is CruxWindowApi {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof CruxWindowApi, unknown>>;
  return (
    typeof candidate.cruxWindowApiVersion === 'number' &&
    candidate.cruxWindowApiVersion >= 1 &&
    typeof candidate.isWindowHost === 'function' &&
    typeof candidate.join === 'function' &&
    typeof candidate.peers === 'function'
  );
}
