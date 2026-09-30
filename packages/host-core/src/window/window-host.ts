/**
 * [CruxWindowHost] — everything a VSCode window may have exactly one of,
 * owned by exactly one extension.
 *
 * Built only by whichever extension the election in `election.ts` picks.
 * What it owns, and why each item is here rather than in a product
 * package:
 *
 * | Singleton | Why one per window |
 * |---|---|
 * | [surface.SurfaceRegistry] | the composed capability list *is* the window's identity (CXP §8.1) |
 * | [cxp.CxpPeerHost] | one process, one loopback socket, one `peer_id`, one manifest (§10.2) |
 * | [editor.CxpEditorDispatcher] | inbound `request_open_source` / `request_highlight` / `notify_selection` |
 * | [status.StatusBarController] | the window's ONE status surface |
 * | the `edacrux.*` commands | `registerCommand` throws on a duplicate id |
 *
 * ### Why the peer starts on a delay
 *
 * The manifest carries the window's capabilities, and at a cold start all
 * four extensions activate within a few milliseconds of each other. Binding
 * and publishing on the first extension's activation would publish a
 * manifest advertising one surface, then rewrite it three times as the
 * others join — every rewrite a new `started_at` and a new set of
 * capabilities for peers to re-read. [CXP_WINDOW_PEER_START_DELAY_MS] lets
 * the startup burst settle so the *first* manifest is already the union.
 * Anything that joins later still republishes, so the delay is an
 * optimisation of the common case and never a correctness requirement.
 */
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import {
  CxpPeerHost,
  CxpWorkspaceStore,
  createVscodePeerIdentity,
  sharedCxpManifestDirectory,
  sharedCxpWorkspaceDirectory,
  type CxpPeerManifest,
  type PeerIdentity,
} from '../cxp';
import {
  CROSS_PROBE_OFFLINE,
  CrossProbeHost,
  reasonCrossProbeUnavailable,
  type CrossProbeSelection,
  type CrossProbeSendOutcome,
  type CrossProbeSnapshot,
} from '../cross-probe';
import { Emitter, type Disposable } from '../cxp/emitter';
import { DesktopPeerDetector, type CruxDesktopProduct } from '../desktop-detect';
import {
  CRUX_SEND_COMMAND_IDS,
  CxpEditorDispatcher,
  PeerSendCommands,
  composeElementPathResolvers,
  isElementPathResolver,
  readCrossProbeSettings,
  vscodeCurrentSelectionSnapshot,
  vscodeEditorHost,
  vscodeUserInterface,
  type ElementPathResolver,
} from '../editor';
import {
  StatusBarController,
  buildCapabilitiesPanelContent,
  createVscodeShowPanel,
  vscodeRegisterCommand,
  vscodeStatusBarHost,
  type ProductCapabilityCopy,
} from '../status';
import { TELEMETRY_EVENTS, type TelemetryEvent } from '../telemetry/events';
import type { TelemetryLicenseTier } from '../telemetry/vocabulary';
import { SurfaceRegistry, type CruxSurface } from '../surface/index';
import type { CruxWindowContribution, CruxWindowCrossProbe } from './api';

/**
 * How long to let a startup burst settle before binding the CXP socket and
 * publishing the first manifest. See the class docs.
 */
export const CXP_WINDOW_PEER_START_DELAY_MS = 750;

/**
 * The shared workspace directory, or `undefined` on a machine with no
 * resolvable application-data root — the same condition that costs the
 * window its CXP peer, and for the same reason it must not throw here.
 */
function tryWorkspaceDirectory(log: (line: string) => void): string | undefined {
  try {
    return sharedCxpWorkspaceDirectory();
  } catch (error) {
    log(`   window: CXP workspace store unavailable (${String(error)})`);
    return undefined;
  }
}

/** Construction options for [CruxWindowHost]. */
export interface CruxWindowHostOptions {
  /** The **hosting** extension's context. Owns the panel and its webview. */
  readonly context: vscode.ExtensionContext;
  /** The hosting extension's product — diagnostics and telemetry attribution. */
  readonly product: CruxDesktopProduct;
  /** Diagnostics, into the hosting extension's output channel. */
  readonly log: (line: string) => void;
  /** The hosting extension's telemetry `record`. */
  readonly record: (event: TelemetryEvent) => void;
  /** Tier the capabilities panel reports. Defaults to `openCore`. */
  readonly tier?: TelemetryLicenseTier;
  /** Manifest directory. Tests only — see [cxp.CxpPeerHostOptions]. */
  readonly manifestDirectory?: string;
  /** Manifest heartbeat period. Tests only. */
  readonly heartbeatIntervalMs?: number | null;
  /** Peer-start delay. Tests only; `0` starts on the next tick. */
  readonly peerStartDelayMs?: number;
  /**
   * The workspace folder the `peer_id` hashes. Defaults to the window's
   * first folder. Tests inject; nothing in production should.
   */
  readonly workspaceFolder?: () => string | undefined;
  /** Scan/retry periods, passed to [cxp.CxpPeerHost]. Tests only. */
  readonly scanIntervalMs?: number;
  readonly retryIntervalMs?: number;
}

/** One product's live contribution to the window. */
interface JoinedProduct {
  readonly surface: CruxSurface;
  readonly copy: ProductCapabilityCopy | undefined;
  readonly resolver: ElementPathResolver | undefined;
}

/**
 * Deliberately does **not** implement [Disposable]: its [dispose] is
 * `async`, like [cxp.CxpPeerHost.dispose], because the last thing it does
 * is delete a file. A synchronous `dispose(): void` here would be a
 * promise nobody awaits, and the manifest would survive the window.
 */
export class CruxWindowHost {
  /** The window's composed surfaces. */
  readonly registry = new SurfaceRegistry();

  /**
   * The window's cross-probe state, as a guest surface sees it.
   *
   * A **stable relay**, created here in the constructor, rather than the
   * [CrossProbeHost] itself: that one cannot exist until the CXP peer has
   * started, which is [CXP_WINDOW_PEER_START_DELAY_MS] after every surface
   * has already activated and asked for it. Handing out an object that
   * answers "offline, no peers" until then is what lets a webview subscribe
   * once, at the moment its panel is built, and simply receive the first
   * real snapshot when there is one.
   */
  readonly crossProbe: CruxWindowCrossProbe = {
    snapshot: (): CrossProbeSnapshot => this.crossProbeHost?.snapshot ?? CROSS_PROBE_OFFLINE,
    onDidChange: (listener): Disposable => this.crossProbeChanged.listen(listener),
    send: (peerId, selection: CrossProbeSelection): CrossProbeSendOutcome =>
      this.crossProbeHost?.sendSelectionToPeer(peerId, selection) ?? {
        delivered: false,
        peerLabel: peerId,
        reason: reasonCrossProbeUnavailable(),
      },
  };

  /**
   * What `edacrux.sendSelectionToPeer` / `edacrux.highlightSelectionInPeer`
   * resolve a selection with: every joined product's contributed resolver,
   * in product-id order, then the selected identifier verbatim.
   *
   * Read per call, so a product that joins or leaves mid-session changes
   * the answer without re-registering the commands. Product-id order rather
   * than join order so the answer does not depend on which extension
   * happened to activate first; the products that contribute one today
   * (NetCrux, WaveCrux) index the same workspace stems files, so the order
   * decides ties, not results.
   */
  readonly elementPathResolver: ElementPathResolver = composeElementPathResolvers(
    () =>
      [...this.joined.values()]
        .sort((a, b) => a.surface.id.localeCompare(b.surface.id))
        .flatMap((entry) => (entry.resolver === undefined ? [] : [entry.resolver])),
    (error) => {
      this.options.log(`   window: a contributed name resolver failed (${String(error)})`);
    },
  );

  private readonly crossProbeChanged = new Emitter<CrossProbeSnapshot>();
  private readonly joined = new Map<string, JoinedProduct>();
  private readonly disposables: Disposable[] = [];
  private crossProbeHost: CrossProbeHost | undefined;
  private peer: CxpPeerHost | undefined;
  private detector: DesktopPeerDetector | undefined;
  private dispatcher: CxpEditorDispatcher | undefined;
  private identity: PeerIdentity | undefined;
  private startTimer: NodeJS.Timeout | undefined;
  private starting: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly options: CruxWindowHostOptions) {
    this.disposables.push(
      new StatusBarController({
        host: vscodeStatusBarHost,
        registerCommand: (id, handler) => vscodeRegisterCommand(options.context, id, handler),
        showPanel: createVscodeShowPanel(options.context),
        buildContent: () => this.panelContent(),
        onOpened: () => options.record({ name: TELEMETRY_EVENTS.statusPanelOpened }),
      }),
    );

    this.registry.onDidChange.listen((capabilities) => {
      options.log(`   window: capabilities = ${capabilities.join(', ')}`);
      void this.republish();
    });

    const delay = options.peerStartDelayMs ?? CXP_WINDOW_PEER_START_DELAY_MS;
    this.startTimer = setTimeout(() => {
      this.startTimer = undefined;
      void this.startPeer();
    }, delay);
    // Never hold the extension host open on our own timer.
    this.startTimer.unref?.();
  }

  /** Peers discovered by the one scanner this window runs. */
  get peers(): readonly CxpPeerManifest[] {
    return this.peer?.peers ?? [];
  }

  /** The identity this window publishes, once the peer has started. */
  get publishedIdentity(): PeerIdentity | undefined {
    return this.identity;
  }

  /**
   * Add a product's [contribution]. Dispose the result to remove it.
   *
   * Registering the same product id twice replaces the earlier
   * registration — an extension that reactivates must not double its
   * capabilities — which is [surface.SurfaceRegistry.register]'s rule, and
   * the panel row follows it because both are keyed by the surface id.
   */
  join(contribution: CruxWindowContribution): Disposable {
    const surface = contribution.surface;
    // The contribution may come from another bundle — possibly an older or
    // newer build — so the resolver is checked by shape, and a value that is
    // not one is ignored rather than trusted to be called later.
    const resolver = isElementPathResolver(contribution.resolver)
      ? contribution.resolver
      : undefined;
    this.joined.set(surface.id, { surface, copy: contribution.copy, resolver });
    const registration = this.registry.register(surface);
    this.options.log(`   window: ${surface.extensionId} joined`);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.joined.get(surface.id)?.surface === surface) this.joined.delete(surface.id);
        registration.dispose();
      },
    };
  }

  /**
   * Resolves once the CXP peer has been started (or has failed to start).
   * Tests and live-verification harnesses only.
   */
  async started(): Promise<void> {
    if (this.startTimer !== undefined) {
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
      await this.startPeer();
      return;
    }
    await this.starting;
  }

  /**
   * Stop being a peer and give up every singleton.
   *
   * Async, and an extension's `deactivate()` must **return** it: removing
   * the manifest is a filesystem write, and a manifest left behind points
   * every peer in the suite at a closed port until they reap it.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.startTimer !== undefined) clearTimeout(this.startTimer);
    this.startTimer = undefined;
    await this.starting?.catch(() => undefined);
    this.dispatcher?.dispose();
    this.dispatcher = undefined;
    await this.peer?.dispose().catch(() => undefined);
    this.peer = undefined;
    for (const disposable of this.disposables.reverse()) disposable.dispose();
    this.disposables.length = 0;
    this.crossProbeHost = undefined;
    this.crossProbeChanged.clear();
    this.joined.clear();
  }

  /**
   * The identity this window announces: a **stable** `peer_id` with a live
   * capability list.
   *
   * Built once and then only ever copied with fresh capabilities.
   * Re-minting it would change the `peer_id`, and since the manifest is
   * named `<peer_id>.json` that would leave the previous file behind — one
   * window, two manifests, one of them pointing at a port that still
   * happens to be open. Exactly the bug this module exists to prevent,
   * arrived at from the other direction.
   */
  private currentIdentity(): PeerIdentity {
    const capabilities = this.registry.capabilities();
    const existing = this.identity;
    if (existing !== undefined) {
      this.identity = { ...existing, capabilities };
      return this.identity;
    }
    const workspaceFolder =
      this.options.workspaceFolder?.() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.identity = createVscodePeerIdentity({
      workspaceFolder,
      productVersion: this.extensionVersion(),
      capabilities,
    });
    return this.identity;
  }

  private extensionVersion(): string {
    const manifest: unknown = this.options.context.extension.packageJSON;
    if (typeof manifest === 'object' && manifest !== null) {
      const version = (manifest as { version?: unknown }).version;
      if (typeof version === 'string') return version;
    }
    return '0.0.0';
  }

  private async startPeer(): Promise<void> {
    if (this.disposed || this.peer !== undefined || this.starting !== undefined) return;
    this.starting = this.startPeerOnce();
    await this.starting;
  }

  private async startPeerOnce(): Promise<void> {
    let manifestDirectory: string;
    try {
      manifestDirectory = this.options.manifestDirectory ?? sharedCxpManifestDirectory();
    } catch (error) {
      // No resolvable application-data root (no $HOME, a stripped
      // container). That must cost the window its CXP peer, not its
      // status bar — so it is logged and nothing else is torn down.
      this.options.log(`   window: CXP unavailable (${String(error)})`);
      return;
    }

    const peer = new CxpPeerHost({
      selfIdentity: () => this.currentIdentity(),
      manifestDirectory,
      ...(this.options.heartbeatIntervalMs !== undefined
        ? { heartbeatIntervalMs: this.options.heartbeatIntervalMs }
        : {}),
      ...(this.options.scanIntervalMs !== undefined
        ? { scanIntervalMs: this.options.scanIntervalMs }
        : {}),
      ...(this.options.retryIntervalMs !== undefined
        ? { retryIntervalMs: this.options.retryIntervalMs }
        : {}),
    });
    this.peer = peer;
    // The panel's desktop-presence rows, from the scanner the peer already
    // runs — never a second filesystem poller (`desktop-detect`'s rule).
    const detector = new DesktopPeerDetector({
      peers: () => peer.peers.map((manifest) => manifest.identity),
    });
    this.detector = detector;
    this.disposables.push(
      peer.discovery.onEvent.listen(() => {
        detector.refresh();
      }),
    );
    // The panel's view of the same peer set the detector reads, plus the
    // activity log and the directed send. Created *before* `peer.start()`,
    // so the `peer_connected` for a peer that dials us during the bind is
    // already being listened for when it arrives.
    const crossProbe = new CrossProbeHost({ peer });
    this.crossProbeHost = crossProbe;
    this.disposables.push(
      crossProbe.onDidChange.listen((snapshot) => {
        this.crossProbeChanged.emit(snapshot);
      }),
      { dispose: () => crossProbe.dispose() },
    );
    // The shared-workspace store the inbound `request_open_artifact`
    // resolves through (implementation map §6g).
    // Rooted at the *workspace* sibling of the manifest directory we just
    // resolved, so the two can never end up under different bases; when the
    // caller injected a manifest directory (tests), the sibling is derived
    // from it rather than from the machine's real application-data root.
    const workspaceDirectory =
      this.options.manifestDirectory === undefined
        ? tryWorkspaceDirectory(this.options.log)
        : join(dirname(this.options.manifestDirectory), 'workspace');
    this.dispatcher = new CxpEditorDispatcher({
      transport: peer.server,
      registry: this.registry,
      editor: vscodeEditorHost,
      settings: () => readCrossProbeSettings(),
      ...(workspaceDirectory !== undefined
        ? { workspace: new CxpWorkspaceStore({ workspaceDirectory }) }
        : {}),
    });

    const send = new PeerSendCommands({
      ui: vscodeUserInterface,
      currentSelection: () => {
        const editor = vscode.window.activeTextEditor;
        return editor === undefined ? undefined : vscodeCurrentSelectionSnapshot(editor);
      },
      connectedPeers: () => peer.server.connectedPeers,
      send: (peerId, message) => peer.server.sendTo(peerId, message),
      resolver: this.elementPathResolver,
    });
    this.disposables.push(
      vscodeRegisterCommand(this.options.context, CRUX_SEND_COMMAND_IDS.notifySelection, () => {
        void send.sendSelection();
      }),
      vscodeRegisterCommand(this.options.context, CRUX_SEND_COMMAND_IDS.requestHighlight, () => {
        void send.requestHighlight();
      }),
    );

    try {
      await peer.start();
      this.options.log(
        `   window: CXP peer ${peer.selfIdentity.peerId} listening on ` +
          `${peer.server.host}:${String(peer.server.boundPort ?? peer.server.port)}`,
      );
    } catch (error) {
      this.options.log(`   window: CXP peer failed to start (${String(error)})`);
    }
    // `online` has just flipped, and nothing in [CrossProbeHost] observes
    // the bind itself — it listens to peers, links and traffic. A surface
    // that subscribed at activation is holding the pre-start
    // `CROSS_PROBE_OFFLINE` and would keep holding it until the first peer
    // appeared, which on a machine with no other Crux app running is never.
    this.crossProbeChanged.emit(crossProbe.snapshot);
  }

  private async republish(): Promise<void> {
    const peer = this.peer;
    if (peer === undefined || !peer.isRunning) return;
    try {
      await peer.republish();
    } catch (error) {
      // The heartbeat will carry the new capabilities within 30 s.
      this.options.log(`   window: republish failed (${String(error)})`);
    }
  }

  private panelContent(): ReturnType<typeof buildCapabilitiesPanelContent> {
    const products = this.registry.surfaces.map((surface) => surface.id as CruxDesktopProduct);
    const copies: Partial<Record<CruxDesktopProduct, ProductCapabilityCopy>> = {};
    for (const [id, entry] of this.joined) {
      if (entry.copy !== undefined) copies[id as CruxDesktopProduct] = entry.copy;
    }
    return buildCapabilitiesPanelContent({
      tier: this.options.tier ?? 'openCore',
      installedProducts: products,
      desktopPresence: this.detector?.snapshot ?? [],
      copies,
    });
  }
}
