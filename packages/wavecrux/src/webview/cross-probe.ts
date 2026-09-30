/**
 * The Cross-Probe panel's state, on its way *into* the webview — and the
 * panel's Send button on its way back out.
 *
 * ### The bug this closes
 *
 * The WaveCrux app's Cross-Probe dock tab renders from four reactive
 * sources, all of them fed by the app's own CXP server. Inside a webview
 * there is no such server and there cannot be one: `app.dart` only
 * instantiates the CXP lifecycle bridge on linux/macOS/windows, because a
 * webview has no `dart:io` and cannot bind a TCP socket. So the panel showed
 * a red banner — "CXP server is offline — enable it in Settings → CXP
 * Cross-Probe" — about a setting that was already on and that could never
 * have helped, an empty "Connected Peers" list, and a Send button that
 * returned at its first line without a sound.
 *
 * Meanwhile *this* process was a first-class CXP peer with a published
 * manifest, a live peer set and real traffic crossing it. Nothing was
 * broken except that nobody told the panel.
 *
 * ### What crosses, and in which direction
 *
 * ```
 * host-core CrossProbeHost.onDidChange
 *      → crossProbeStateFrame → postMessage → EditorHostBridge._dispatch
 *      → editorHostCrossProbeProvider → the panel's four ValueListenables
 *
 * panel Send → EditorHostBridge.postCrossProbeSend → parseCrossProbeSend
 *      → CruxWindowCrossProbe.send → LocalCxpServer.sendTo → the peer
 * ```
 *
 * Both directions ride the **one** `crux.cxp` frame channel this panel
 * already has, routed by the same `onCxpEnvelope` claimant chain as the
 * value query and the highlight bridge. There is no second `postMessage`
 * listener and no second channel; a webview delivers a message to every
 * registered listener, so a second one would double-count the telemetry
 * relay and split CXP routing across two places that could disagree.
 *
 * ### Correlation, which is neither of the other two schemes next door
 *
 * `value-query.ts` correlates on a `query_id` (a standing query, many
 * answers); `highlight-bridge.ts` correlates on `in_reply_to` (one request,
 * one answer). A cross-probe send is a third shape: it is answered by the
 * *state* — a delivered send appears in the next snapshot's `events`, so the
 * push is the ack. Only a **refusal** needs correlating, because the panel
 * shows it as a toast and the host re-pushes its whole snapshot on every
 * peer change; without an id the same toast would re-fire on each push. So a
 * refusal carries `in_reply_to` and the Dart side shows each one once.
 *
 * No `vscode` import, so every bound below is testable without an extension
 * host — the same rule `open-waveform.ts`, `value-query.ts`,
 * `highlight-bridge.ts` and `selection-navigation.ts` follow.
 */
import { crossProbe, cxp, type window as hostWindow } from '@crux-vscode/host-core';
import { hostBridgeFrame, type HostBridgeFrame } from './open-waveform';

/** Mirrors `kHostBridgeCrossProbeStateKind`. */
export const CROSS_PROBE_STATE_KIND = 'crux.cross_probe_state';

/** Mirrors `kHostBridgeCrossProbeSendKind`. */
export const CROSS_PROBE_SEND_KIND = 'crux.cross_probe_send';

/** The panel send this window has been asked to make. */
export interface CrossProbeSendRequest {
  /** `message_id` of the requesting frame — what a refusal is correlated on. */
  readonly messageId: string;
  /** Which discovered peer to send to. */
  readonly peerId: string;
  /** The §9.3 announcement, decoded by host-core's own decoder. */
  readonly selection: crossProbe.CrossProbeSelection;
}

/** A refusal, held until the next state frame carries it down. */
export interface CrossProbeSendRefusal {
  readonly inReplyTo: string;
  readonly peerLabel: string;
  readonly reason?: string;
}

/**
 * The frame carrying one snapshot into the webview.
 *
 * The peer list goes down as **`PeerIdentity` JSON verbatim** (§8.1) rather
 * than as a peer DTO invented here: the receiving side decodes it with
 * `PeerIdentity.fromJson`, the same function it uses for a peer that arrived
 * over a socket, so there is one identity shape in the system and not two.
 */
export function crossProbeStateFrame(
  snapshot: crossProbe.CrossProbeSnapshot,
  refusal?: CrossProbeSendRefusal,
): HostBridgeFrame {
  return hostBridgeFrame({
    kind: CROSS_PROBE_STATE_KIND,
    payload: {
      online: snapshot.online,
      peers: snapshot.peers.map((peer) => ({
        peer_id: peer.peerId,
        product_name: peer.productName,
        product_version: peer.productVersion,
        capabilities: [...peer.capabilities],
      })),
      unreachable: snapshot.unreachable.map((failure) => ({
        peer_id: failure.peerId,
        host: failure.host,
        port: failure.port,
        // The error's `message`, never the `Error` itself: this is rendered
        // in the panel, and a stack trace in a peer row is noise.
        error: failure.error.message,
        consecutive_failures: failure.consecutiveFailures,
        next_retry_after_ticks: failure.nextRetryAfterTicks,
      })),
      events: snapshot.events.map((event) => ({
        message_kind: event.messageKind,
        direction: event.direction,
        peer_label: event.peerLabel,
        timestamp_ms: event.timestampMs,
        ...(event.summary !== undefined ? { summary: event.summary } : {}),
      })),
      ...(refusal !== undefined
        ? {
            send_failure: {
              in_reply_to: refusal.inReplyTo,
              peer_label: refusal.peerLabel,
              ...(refusal.reason !== undefined ? { reason: refusal.reason } : {}),
            },
          }
        : {}),
    },
  });
}

/**
 * Decode an inbound envelope as a panel send, or `undefined`.
 *
 * The `selection` half goes through host-core's own `decodeCxpMessage`
 * rather than being read field by field — a webview's messages are
 * untrusted input in exactly the way a socket peer's are, and this build
 * already has one hardened `notify_selection` decoder. A second one would be
 * a second thing to get wrong, and the difference would show up as a frame
 * this window forwarded onto the wire that a peer then rejected.
 */
export function parseCrossProbeSend(envelope: unknown): CrossProbeSendRequest | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined;
  const {
    kind,
    payload,
    message_id: messageId,
  } = envelope as { kind?: unknown; payload?: unknown; message_id?: unknown };
  if (kind !== CROSS_PROBE_SEND_KIND) return undefined;
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined;
  if (!cxp.isJsonObject(payload)) return undefined;
  const { peer_id: peerId, selection } = payload;
  if (typeof peerId !== 'string' || peerId.length === 0) return undefined;
  if (!cxp.isJsonObject(selection)) return undefined;
  let message;
  try {
    message = cxp.decodeCxpMessage(cxp.CxpMessageKind.notifySelection, selection);
  } catch {
    return undefined;
  }
  if (message === undefined || message.kind !== cxp.CxpMessageKind.notifySelection) {
    return undefined;
  }
  return {
    messageId,
    peerId,
    selection: {
      elements: message.elements,
      ...(message.displayName !== undefined ? { displayName: message.displayName } : {}),
      ...(message.coordinate !== undefined ? { coordinate: message.coordinate } : {}),
      metadata: message.metadata,
    },
  };
}

/** What [WebviewCrossProbeBridge] needs from the panel it speaks for. */
export interface WebviewCrossProbeBridgeOptions {
  /** Post a frame into the webview. `Webview.postMessage`. */
  readonly post: (frame: HostBridgeFrame) => PromiseLike<boolean> | boolean;
  /**
   * The window's cross-probe state, from `joinCruxWindow`'s api.
   *
   * `undefined` when this window has no EDACrux host that exposes one — an
   * older sibling extension hosting the window. The panel then behaves
   * exactly as it did before this existed: no peers, no events, and — still
   * — no offline banner, because the Dart side suppresses that under an
   * editor host regardless of what arrives here.
   */
  readonly crossProbe: hostWindow.CruxWindowCrossProbe | undefined;
}

/**
 * One open waveform panel, as a cross-probe surface.
 *
 * One per waveform tab, with the same `open()`/`close()` lifetime as the
 * tab's [WebviewValueSource] and [WebviewHighlightTarget], and for the same
 * reason: a disposed webview's `postMessage` resolves `false` forever, so a
 * bridge that outlived its panel would keep pushing snapshots at nothing on
 * every peer change for the rest of the session.
 *
 * Subscribing happens in the **constructor**, not in `open()`: the window's
 * CXP peer starts on a settle delay well after a tab can be opened, and the
 * subscription is what delivers the first real snapshot when it does. What
 * `open()` gates is *posting*, which is the part that needs a live webview.
 */
export class WebviewCrossProbeBridge {
  private readonly subscription: { dispose(): void } | undefined;
  private refusal: CrossProbeSendRefusal | undefined;
  private ready = false;
  private disposed = false;

  constructor(private readonly options: WebviewCrossProbeBridgeOptions) {
    this.subscription = options.crossProbe?.onDidChange(() => {
      void this.push();
    });
  }

  /** Mark the panel as able to receive, and push the current state at it. */
  open(): void {
    if (this.disposed) return;
    this.ready = true;
    void this.push();
  }

  /** Mark the panel as gone. Stops pushing; the subscription is released. */
  close(): void {
    this.ready = false;
    if (this.disposed) return;
    this.disposed = true;
    this.subscription?.dispose();
  }

  /**
   * Route one inbound envelope. Returns whether it was a panel send.
   *
   * Claimed either way once it decodes — including a send this window could
   * not deliver — because the answer is the state push below and the caller
   * must not also log the frame.
   */
  accept(envelope: unknown): boolean {
    const request = parseCrossProbeSend(envelope);
    if (request === undefined) return false;
    const access = this.options.crossProbe;
    const outcome = access?.send(request.peerId, request.selection);
    // A window with no cross-probe access at all is still owed an answer:
    // silence is the failure mode this whole change exists to remove.
    this.refusal =
      outcome === undefined || !outcome.delivered
        ? {
            inReplyTo: request.messageId,
            peerLabel: outcome?.peerLabel ?? request.peerId,
            ...(outcome?.reason !== undefined ? { reason: outcome.reason } : {}),
          }
        : undefined;
    // A delivered send has already been recorded as an event by the host, so
    // this same push carries both halves of the answer.
    void this.push();
    return true;
  }

  /**
   * Post the current snapshot.
   *
   * The refusal is **sticky** rather than one-shot: the host re-pushes on
   * every peer change and clearing it here would race those pushes, while
   * leaving it costs nothing because the Dart side shows each `in_reply_to`
   * exactly once.
   */
  private async push(): Promise<void> {
    if (!this.ready || this.disposed) return;
    const snapshot = this.options.crossProbe?.snapshot() ?? crossProbe.CROSS_PROBE_OFFLINE;
    try {
      await this.options.post(crossProbeStateFrame(snapshot, this.refusal));
    } catch {
      // The panel went away between the readiness check and the post. There
      // is nothing to report to and nothing to retry.
    }
  }
}
