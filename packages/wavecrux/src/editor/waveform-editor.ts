/**
 * The custom editor: double-click a waveform in the Explorer and WaveCrux
 * opens inline.
 *
 * This is the discoverability payload of the whole extension pack. Every
 * other surface in the pack has to be *found* — a command, a status-bar item,
 * a context menu. This one is found by doing the thing the user was going to
 * do anyway.
 *
 * ### Read-only, and that is the design
 *
 * `CustomReadonlyEditorProvider`, not `CustomEditorProvider`. A waveform is a
 * simulator's output; nothing in WaveCrux writes one back, and claiming the
 * editable interface would put a dirty indicator and a Save command on a
 * document that has no edits to save.
 *
 * ### The four paths out of `resolveCustomEditor`
 *
 * 1. **Supported and deliverable** — stream the bytes across the bridge.
 * 2. **FSDB** — recognised, claimed on purpose, and refused with the reason.
 *    See `formats.ts`.
 * 3. **Too large / empty** — refused before a byte is read, because the
 *    receiver's cap (`kHostBridgeMaxOpenBytes`) would refuse it anyway and a
 *    silent refusal looks exactly like a hang.
 * 4. **Payload not staged** — a developer-only case the shared renderer
 *    already explains.
 *
 * All four record `file.opened`. A refusal is still a person bringing a
 * waveform to the editor, and a funnel that can only see the successes cannot
 * tell "nobody has FSDB" from "everybody with FSDB gave up".
 */
import * as vscode from 'vscode';
import { telemetry, type window as hostWindow } from '@crux-vscode/host-core';
import { WAVEFORM_VIEW_TYPE, baseName, waveformFormatFor, type WaveformFormat } from '../formats';
import { openWaveformByteSource, waveformSizeBytes } from './byte-source';
import { releaseContextWhenHidden } from './retention';
import { renderNoticeHtml } from '../webview/notice-html';
import {
  MAX_OPEN_BYTES,
  planWaveformTransfer,
  streamWaveform,
  type WaveformByteSource,
  type WaveformTransferPlan,
} from '../webview/open-waveform';
import { handleWebviewMessage, renderWaveCruxWebview, type DiagnosticSink } from '../webview/panel';
import { hostSessionFrame } from '../webview/host-session';
import { WebviewValueSource } from '../webview/value-query';
import { WebviewHighlightTarget } from '../webview/highlight-bridge';
import { designPathOf, parseWebviewSelection } from '../webview/selection-navigation';
import { WebviewCrossProbeBridge } from '../webview/cross-probe';

/** How long to wait for the app's first frame before posting anyway. */
export const FIRST_FRAME_WAIT_MS = 30_000;

/** What the provider needs from the extension. */
export interface WaveformEditorDependencies {
  readonly extensionUri: vscode.Uri;
  readonly sink: DiagnosticSink;
  /** host-core's `TelemetryClient.recordFromWebview` — the host is the only sender. */
  readonly recordTelemetryFromWebview?: (raw: unknown) => void;
  /** host-core's `TelemetryClient.record`. */
  readonly recordTelemetry?: (event: telemetry.TelemetryEvent) => void;
  /**
   * Whether this installation has ever opened a file, and a way to say it has.
   *
   * `file.first_opened` is the acquisition-to-activation conversion moment,
   * so it must fire once per *installation* and never again — which means the
   * flag is persisted (`context.globalState`), not remembered in a field.
   */
  readonly hasOpenedBefore?: () => boolean;
  readonly markOpened?: () => void;
  /**
   * Adopt this tab's waveform as the one RTL annotation asks about,
   * and hand back a teardown for when the tab closes.
   *
   * The provider owns the panel's lifetime, so it is the only place that can
   * honestly say "this waveform is now the live one" — and the only place
   * that knows when it stops being. Optional so the provider stays testable
   * without an annotation controller.
   */
  readonly adoptValueSource?: (source: WebviewValueSource) => () => void;
  /**
   * Adopt this tab's panel as the destination for an inbound
   * `request_highlight`, and hand back a teardown for when the tab closes.
   *
   * Exactly the shape (and the adoption-stack semantics) of
   * [adoptValueSource], and for the same reason: the surface that routes
   * highlights is registered once at activation and outlives every panel,
   * so it has to read through a registry rather than hold a reference to
   * one. Optional so the provider stays testable without a surface.
   */
  readonly adoptHighlightTarget?: (target: WebviewHighlightTarget) => () => void;
  /**
   * A signal the user selected **in the waveform**, as its design path.
   *
   * The inverse of the RTL annotation: the extension resolves it through
   * the stems index and reveals the declaration. Called on every selection
   * announcement the app makes; the opt-in check
   * (`edacrux.crossProbe.followWaveformSelection`) lives on the other side
   * of this seam, in host-core, so the provider does not have to know what
   * governs it.
   *
   * [panelColumn] is the editor group *this waveform tab* is in, which the
   * provider is the only place that knows. It is passed so the reveal can
   * land somewhere else: a waveform panel is an editor tab, so revealing
   * into the active group covers the panel the user just clicked in.
   */
  readonly onWaveformSelection?: (designPath: string, panelColumn: number | undefined) => void;
  /**
   * Re-render the RTL annotations in the visible editors.
   *
   * Called when the app answers a standing value query it was not asked —
   * i.e. the waveform cursor moved — and once when a waveform finishes
   * crossing the bridge. Both are "the values on screen may be stale", and
   * neither is a VSCode event, so nothing else can notice them.
   */
  readonly refreshAnnotations?: () => void;
  /**
   * The window's cross-probe state, for the app's Cross-Probe dock tab.
   *
   * Read as a **function**, not captured as a value: `activate()` builds this
   * provider before the window election has settled, so the accessor here is
   * called per panel rather than once at registration. `undefined` when the
   * window is hosted by a build with no cross-probe access to expose, in
   * which case the panel behaves exactly as it did before this existed.
   */
  readonly crossProbe?: () => hostWindow.CruxWindowCrossProbe | undefined;
}

/**
 * One open waveform tab.
 *
 * Holds the byte source rather than the bytes: `dispose` closes a descriptor,
 * not a 200 MB buffer. That is also what makes the re-send after a context
 * release cheap — see `retention.ts`.
 */
export class WaveformDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    readonly format: WaveformFormat | undefined,
    readonly sizeBytes: number,
    readonly plan: WaveformTransferPlan,
    private readonly source: WaveformByteSource | undefined,
  ) {}

  /** The tab label and the name the app shows. */
  get displayName(): string {
    return baseName(this.uri.path);
  }

  /** The open byte source, or `undefined` when the document was refused. */
  get byteSource(): WaveformByteSource | undefined {
    return this.source;
  }

  dispose(): void {
    void this.source?.dispose();
  }
}

export class WaveformEditorProvider implements vscode.CustomReadonlyEditorProvider<WaveformDocument> {
  constructor(private readonly deps: WaveformEditorDependencies) {}

  /**
   * Register the provider.
   *
   * `retainContextWhenHidden` is **static per view type** — it is fixed at
   * registration and a panel cannot change it later — so it is on for every
   * waveform, and the size-dependent half of the policy is implemented as an
   * explicit teardown in `resolveCustomEditor`. See `retention.ts` for the
   * measurements behind that split.
   *
   * `supportsMultipleEditorsPerDocument` is left at its default (`false`): two
   * webviews over one document would mean two Flutter engines and two copies
   * of the parsed waveform for one file.
   */
  static register(deps: WaveformEditorDependencies): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      WAVEFORM_VIEW_TYPE,
      new WaveformEditorProvider(deps),
      { webviewOptions: { retainContextWhenHidden: true } },
    );
  }

  /**
   * Decide what will happen to this file, before opening anything.
   *
   * The `stat` here is the whole reason a multi-gigabyte FST is cheap to
   * refuse: the plan is made from the size, and only a plan that will actually
   * be delivered opens a descriptor.
   */
  async openCustomDocument(uri: vscode.Uri): Promise<WaveformDocument> {
    const format = waveformFormatFor(uri.path);
    let sizeBytes = 0;
    try {
      sizeBytes = await waveformSizeBytes(uri);
    } catch {
      // A file that vanished between the click and the stat. `planWaveformTransfer`
      // turns a zero size into a refusal, which is the right answer.
    }
    const plan =
      format?.supported === true
        ? planWaveformTransfer(sizeBytes)
        : ({ mode: 'refused', totalBytes: sizeBytes, reason: 'too_large' } as const);
    const source =
      format?.supported === true && plan.mode !== 'refused'
        ? await openWaveformByteSource(uri, sizeBytes)
        : undefined;
    return new WaveformDocument(uri, format, sizeBytes, plan, source);
  }

  /**
   * Synchronous on purpose — see the `void send()` comment below. The
   * interface allows `void`, and returning a promise that waits on the webview
   * is the one thing this method must never do.
   */
  resolveCustomEditor(document: WaveformDocument, panel: vscode.WebviewPanel): void {
    // Sampled BEFORE `recordOpen`, which is what marks the installation as
    // having opened a file. Read afterwards it would be `true` on the very
    // first open, and the Dart side's nudge policy would put a capability
    // nudge exactly where it must never appear. See `webview/host-session.ts`.
    const openedFileBefore = this.deps.hasOpenedBefore?.() === true;
    this.recordOpen(document);
    this.deps.sink.append(
      `   ${document.displayName}: resolving (${document.format?.token ?? 'unknown'}, ` +
        `${document.plan.mode})`,
    );

    const notice = noticeFor(document);
    if (notice !== undefined) {
      panel.webview.options = { enableScripts: false };
      panel.webview.html = renderNoticeHtml(notice);
      this.deps.sink.append(`   ${document.displayName}: ${notice.logLine}`);
      return;
    }

    // RTL annotation's half of the bridge. Created before the message listener because
    // the listener routes into it, and adopted as the window's live waveform
    // only once — see `adoptValueSource`.
    const values = new WebviewValueSource({
      post: (frame) => panel.webview.postMessage(frame),
      onCursorMoved: () => {
        this.deps.refreshAnnotations?.();
      },
    });
    const releaseValueSource = this.deps.adoptValueSource?.(values);

    // The inbound-highlight destination for this tab. Same lifetime and the
    // same adoption stack as the value source above — one panel, two roles,
    // both released together in `onDidDispose`.
    const highlights = new WebviewHighlightTarget({
      post: (frame) => panel.webview.postMessage(frame),
    });
    const releaseHighlightTarget = this.deps.adoptHighlightTarget?.(highlights);

    // The Cross-Probe dock tab's state. Constructed here, before the message
    // listener that routes into it, and subscribed from construction rather
    // than from `open()`: the window's CXP peer starts on a settle delay and
    // this subscription is what carries the first real snapshot down when it
    // does. Same `open()`/`close()` lifetime as the two above.
    const crossProbeBridge = new WebviewCrossProbeBridge({
      post: (frame) => panel.webview.postMessage(frame),
      crossProbe: this.deps.crossProbe?.(),
    });

    let firstFrame = deferred();
    // The ONE `onDidReceiveMessage` listener for this panel. A webview
    // delivers to every registered listener, so a second one would relay
    // each telemetry event twice and split CXP routing across two places.
    panel.webview.onDidReceiveMessage((message: unknown) => {
      handleWebviewMessage(message, {
        extensionUri: this.deps.extensionUri,
        sink: this.deps.sink,
        ...(this.deps.recordTelemetryFromWebview !== undefined
          ? { recordTelemetryFromWebview: this.deps.recordTelemetryFromWebview }
          : {}),
        // The ONE router for this panel's CXP frames. Each claimant is
        // asked in turn and the first to claim wins; nothing here logs a
        // claimed frame, because the standing value query answers on every
        // cursor move and a line per answer would bury the output channel.
        onCxpEnvelope: (envelope) =>
          values.accept(envelope) ||
          highlights.accept(envelope) ||
          crossProbeBridge.accept(envelope) ||
          // Read at message time, not at resolve time: a tab the user drags
          // into another group keeps working, because `panel.viewColumn`
          // tracks the move.
          this.acceptSelection(envelope, panel.viewColumn),
        onDiagnostic: (diagnostic) => {
          if (diagnostic.kind === 'first-frame') firstFrame.resolve();
        },
      });
    });

    let disposed = false;
    panel.onDidDispose(() => {
      disposed = true;
      values.close();
      releaseValueSource?.();
      // Settles every in-flight highlight `unavailable` rather than leaving
      // a peer's `request_highlight` waiting out the full timeout on a
      // panel that is already gone.
      highlights.close();
      releaseHighlightTarget?.();
      // Releases the window-level cross-probe subscription, so a closed tab
      // stops costing a snapshot push on every peer change for the rest of
      // the session.
      crossProbeBridge.close();
      this.deps.sink.append(`   ${document.displayName}: panel disposed`);
      // Unblocks a transfer that is waiting on a first frame that will now
      // never arrive, so `send` returns instead of holding the descriptor for
      // the watchdog's full 30 s.
      firstFrame.resolve();
    });

    const send = async (): Promise<void> => {
      const staged = await renderWaveCruxWebview(
        panel.webview,
        this.deps.extensionUri,
        this.deps.sink,
      );
      if (!staged) return;
      // The app installs its `window` message listener during bootstrap,
      // before `runApp`, so first frame is a *sufficient* signal that a posted
      // frame will be received — and the earliest one the shim already
      // reports. The timeout is a fallback, not a design: posting into a
      // webview that never booted is harmless, and never posting because a
      // single diagnostic went missing would not be.
      await Promise.race([firstFrame.promise, delay(FIRST_FRAME_WAIT_MS)]);
      if (disposed) {
        this.deps.sink.append(`   ${document.displayName}: transfer abandoned (panel gone)`);
        return;
      }
      // Before the bytes, not after: the app decides whether a slow parse
      // may raise a capability nudge the moment that parse finishes, and a
      // session frame arriving after the waveform would lose the race on
      // exactly the large files the nudge exists for. Re-posted after a
      // context release for the same reason — the rebuilt app has forgotten
      // everything it was told.
      await panel.webview.postMessage(hostSessionFrame({ openedFileBefore }));
      const source = document.byteSource;
      if (source === undefined) return;
      const frames = await streamWaveform(source, {
        displayName: document.displayName,
        plan: document.plan,
        transferId: `${document.uri.toString()}#${Date.now()}`.slice(-64),
        post: (frame) => panel.webview.postMessage(frame),
        isCancelled: () => disposed,
      });
      this.deps.sink.append(
        `   ${document.displayName}: ${document.sizeBytes} bytes in ${frames} frame(s) ` +
          `(${document.plan.mode})`,
      );
      // The waveform is on its way, so this panel can now be asked what
      // signals are worth. The app answers the standing query again once its
      // parse finishes — see `HostAnnotationValueService`, which listens to
      // the waveform source as well as the cursor precisely so an annotation
      // does not wait for the user to nudge the cursor.
      values.open();
      // …and asked to bring a signal into view. Opened at the same moment
      // and not earlier: a `request_highlight` posted before the waveform
      // is on its way would be answered against an empty viewer, and
      // `honored: false` for "the bytes have not landed yet" is a worse
      // answer to a peer than "no waveform is open".
      highlights.open();
      // …and told who this window can cross-probe with. Posted after the
      // first frame like everything else here, and again on every change:
      // the panel is a dock tab the user may open at any point, so the state
      // has to be there waiting rather than fetched when the tab is shown.
      crossProbeBridge.open();
      this.deps.refreshAnnotations?.();
    };

    // Deliberately NOT awaited. `resolveCustomEditor`'s promise is VSCode's
    // signal that the editor is ready; the webview's content is not created
    // until it resolves. `send` waits for the app's first frame before posting
    // bytes, so awaiting it here deadlocks: VSCode waits for the provider, the
    // provider waits for a frame from a webview VSCode has not built yet, and
    // the tab sits blank until the first-frame watchdog gives up. Measured —
    // this is what a blank waveform tab with a "resolving" line and no `boot`
    // diagnostic means.
    void send();

    // The size-dependent half of the retention policy. Above the threshold the
    // webview is torn down when the tab is hidden and rebuilt when it comes
    // back — a Flutter cold start plus a re-parse, paid only by the documents
    // whose retained context is worth more than that. See `retention.ts`.
    if (releaseContextWhenHidden(document.sizeBytes)) {
      let released = false;
      panel.onDidChangeViewState(() => {
        if (disposed) return;
        if (!panel.visible && !released) {
          released = true;
          panel.webview.html = '';
          // The webview is gone until it comes back. Saying so now turns an
          // inbound highlight during the release into an immediate "no
          // waveform is open" instead of a five-second wait on a document
          // that no longer has a message listener.
          highlights.close();
          this.deps.sink.append(`   ${document.displayName}: context released (hidden)`);
          return;
        }
        if (panel.visible && released) {
          released = false;
          // A fresh gate: the rebuilt webview boots from scratch, so the old
          // resolved promise would let the re-send race the new listener.
          firstFrame = deferred();
          this.deps.sink.append(`   ${document.displayName}: reloading from the open descriptor`);
          void send();
        }
      });
    }
  }

  /**
   * Claim an inbound envelope that is the app announcing its selection, and
   * hand its design path on for the editor to follow.
   *
   * Returns `true` for **every** `notify_selection`, including one this
   * extension does nothing with (a marker, a cleared selection). Claiming it
   * either way is the point: the emitter announces on every cursor move, so
   * an unclaimed one would be logged by `handleWebviewMessage`'s fall-through
   * and turn the output channel into a scroll of frames the moment somebody
   * drags the cursor.
   *
   * The opt-in check is deliberately *not* here — it is in host-core's
   * `revealDesignPathInEditor`, one call downstream — so that the setting is
   * read live, in one place, by everything that could navigate.
   */
  private acceptSelection(envelope: unknown, panelColumn: number | undefined): boolean {
    const selection = parseWebviewSelection(envelope);
    if (selection === undefined) return false;
    const designPath = designPathOf(selection);
    if (designPath !== undefined) this.deps.onWaveformSelection?.(designPath, panelColumn);
    return true;
  }

  /** Fire the funnel events for one open, and persist the first-open flag. */
  private recordOpen(document: WaveformDocument): void {
    const record = this.deps.recordTelemetry;
    if (record === undefined) return;
    const delivered = document.byteSource !== undefined;
    const first = delivered && this.deps.hasOpenedBefore?.() !== true;
    for (const event of openTelemetryEvents(document, { first })) record(event);
    if (first) this.deps.markOpened?.();
  }
}

/**
 * `file.opened` — and, on the first delivered open of an installation,
 * `file.first_opened`.
 *
 * `size_bucket` is host-core's coarse bucket and **never** a byte count (file
 * sizes are never sent); the byte count is consumed by
 * `telemetrySizeBucket` here and never leaves this function.
 *
 * `delivered` and `reason` are on the event because a refusal is still a
 * person bringing a waveform to the editor. Without them a query cannot tell
 * "nobody has FSDB" from "everybody with FSDB gave up", and those two answers
 * point at opposite roadmaps. `file.first_opened` deliberately does **not**
 * fire for a refusal: nothing was opened.
 */
export function openTelemetryEvents(
  document: WaveformDocument,
  options: { readonly first: boolean },
): readonly telemetry.TelemetryEvent[] {
  const delivered = document.byteSource !== undefined;
  const opened: telemetry.TelemetryEvent = {
    name: telemetry.TELEMETRY_EVENTS.fileOpened,
    properties: {
      format: document.format?.token ?? 'unknown',
      size_bucket: telemetry.telemetrySizeBucket(document.sizeBytes),
      delivered,
      ...(delivered ? {} : { reason: refusalReason(document) }),
    },
  };
  if (!delivered || !options.first) return [opened];
  return [opened, { name: telemetry.TELEMETRY_EVENTS.firstFileOpened }];
}

/** Why a document was not delivered, as a closed telemetry token. */
export function refusalReason(document: WaveformDocument): string {
  if (document.format === undefined) return 'unrecognized';
  if (!document.format.supported) return 'format_unsupported';
  if (document.plan.mode === 'refused') return document.plan.reason;
  return 'unknown';
}

/** The notice to render instead of the app, or `undefined` to render the app. */
export function noticeFor(
  document: WaveformDocument,
): { title: string; message: string; logLine: string } | undefined {
  if (document.format !== undefined && !document.format.supported) {
    return {
      // Matches `fsdbWebUnsupportedTitle` / `fsdbWebUnsupportedMessage` in the
      // WaveCrux app's ARB: same limitation, same voice, one clause changed
      // because the thing that cannot run fsdb2vcd here is an editor panel and
      // not a browser tab.
      title: vscode.l10n.t('FSDB needs the desktop app'),
      message: vscode.l10n.t(
        'FSDB is a proprietary Synopsys format. WaveCrux converts it with your local Synopsys tools (fsdb2vcd), which a VSCode editor panel cannot run. Open this file in the WaveCrux desktop app, or convert it to VCD or FST first and open that here.',
      ),
      logLine: 'fsdb — refused, desktop app required',
    };
  }
  if (document.plan.mode !== 'refused') return undefined;
  if (document.plan.reason === 'empty') {
    return {
      title: vscode.l10n.t('This waveform is empty'),
      message: vscode.l10n.t(
        'The file has no contents. A simulation that failed before its first write leaves a file this size; check the simulator’s log, then reopen this file once it has data.',
      ),
      logLine: 'empty — refused',
    };
  }
  return {
    title: vscode.l10n.t('This waveform is too large for the editor panel'),
    message: vscode.l10n.t(
      'The editor panel loads a waveform entirely into memory, which caps it at {0} MB. Open this file in the WaveCrux desktop app, which streams from disk and has no such limit.',
      Math.floor(MAX_OPEN_BYTES / (1024 * 1024)),
    ),
    logLine: 'too large — refused',
  };
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve: () => resolve() };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
