/**
 * Asking the webview to bring a signal into view — the inbound half of
 * `request_highlight` (CXP §9.4) once it has crossed the host bridge.
 *
 * ### Why this file exists at all
 *
 * Everything on either side of it was already built. host-core routes an
 * inbound `request_highlight` to whichever [surface.CruxSurface] claims the
 * element and turns the answer into the §9.5 ack; the Dart side's
 * `EditorHostBridge._dispatch` already recognises a `request_highlight`
 * frame and hands it to `dispatchCxpHighlight` — the CXP server's *own*
 * handler, which reaches `signalGroupsProvider.addSignals`,
 * `selectedSignalProvider.select` and `cursorStateProvider.placePrimary`.
 * The gap was the twenty lines in the middle: nothing posted the frame and
 * nothing waited for the acknowledgement it sends back. This is those.
 *
 * No `vscode` import, so every bound below is testable without an extension
 * host — the same rule `open-waveform.ts` and `value-query.ts` follow.
 *
 * ### Correlation, and why it is `in_reply_to` here and `query_id` next door
 *
 * A highlight is a **request**: one frame out, exactly one answer back. So
 * it correlates the ordinary CXP way, on the `message_id` of the frame we
 * posted, and the pending promise is keyed on it. `value-query.ts` next door
 * correlates on a `query_id` instead, because *its* query stands and is
 * answered again on every cursor move — `in_reply_to` names one message and
 * a standing query has many answers. Two different correlation schemes on
 * one bridge look like an inconsistency until you notice they are answering
 * two different questions.
 *
 * ### The three ways this ends, all of them answers
 *
 * `honored` · `refused` (the app looked and the signal is not in the loaded
 * waveform — a normal §9.5 outcome, not an error) · silence. Silence is the
 * one that has to be designed rather than inherited: a webview that never
 * answers must not leave the peer's socket waiting, and must not leave a
 * promise pending inside the extension host forever. [HIGHLIGHT_ACK_TIMEOUT_MS]
 * bounds it, and the timeout is reported as its own outcome rather than
 * being dressed up as a refusal, because the caller maps the two onto
 * different reasons.
 */
import { cxp } from '@crux-vscode/host-core';
import { hostBridgeFrame, type HostBridgeFrame } from './open-waveform';

/** Mirrors the CXP kind the Dart bridge dispatches. */
export const REQUEST_HIGHLIGHT_KIND = 'request_highlight';

/** Mirrors the CXP kind the Dart bridge answers with. */
export const REQUEST_HIGHLIGHT_ACK_KIND = 'request_highlight_ack';

/** The kind the Dart bridge answers with when it could not decode the frame. */
export const ERROR_RESPONSE_KIND = 'error_response';

/**
 * How long to wait for the app's answer before giving up on one highlight.
 *
 * A shade above `value-query.ts`'s 4 s, and bounded for a different reason
 * from it. Above, because a highlight is not always cheap: the app may have
 * to *load* a signal the user never added to the viewer, and
 * `_highlightSignalLikeOrOpen` can fall back to resolving the design's
 * waveform out of the shared workspace before it answers. Bounded,
 * because unlike a value query — answered into decorations nobody waits on
 * — this one is holding a **peer's** `request_highlight` open on a socket,
 * so a wedged webview has to be *reported* rather than felt as a hang in
 * the other application.
 */
export const HIGHLIGHT_ACK_TIMEOUT_MS = 5_000;

/** What to highlight, as it came off the CXP wire. Untouched (§6.1). */
export interface WebviewHighlightRequest {
  readonly element: { readonly kind: string; readonly path: string };
  readonly coordinate?: cxp.CxpStreamCoordinate;
  readonly metadata: cxp.JsonObject;
}

/** The app's answer to one [WebviewHighlightRequest]. */
export type WebviewHighlightAnswer =
  /** `request_highlight_ack honored=true`. */
  | { readonly outcome: 'honored'; readonly detail?: string }
  /** `request_highlight_ack honored=false` — it looked, and could not. */
  | { readonly outcome: 'refused'; readonly detail?: string }
  /** `error_response` — the app could not decode or act on the frame. */
  | { readonly outcome: 'error'; readonly detail?: string }
  /** No answer inside [HIGHLIGHT_ACK_TIMEOUT_MS]. */
  | { readonly outcome: 'timeout' }
  /** No webview to ask: no waveform tab, or one that was disposed. */
  | { readonly outcome: 'unavailable' };

/** What [WebviewHighlightTarget] needs from the panel it speaks for. */
export interface WebviewHighlightTargetOptions {
  /** Post a frame into the webview. `Webview.postMessage`. */
  readonly post: (frame: HostBridgeFrame) => PromiseLike<boolean> | boolean;
  /** Timeout seam. Defaults to [HIGHLIGHT_ACK_TIMEOUT_MS]. */
  readonly timeoutMs?: number;
  /** Timer seam, for tests. Defaults to `setTimeout`/`clearTimeout`. */
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
}

/**
 * One open waveform panel, as an inbound-highlight destination.
 *
 * One per waveform tab, with the same `open()`/`close()` lifetime as the
 * tab's [WebviewValueSource] and for the same reason: a disposed webview's
 * `postMessage` resolves `false` forever, so a target that outlived its
 * panel would turn every inbound highlight into a five-second wait followed
 * by a timeout. `isReady()` is false until the waveform's bytes are on their
 * way and false again the moment the panel is disposed.
 */
export class WebviewHighlightTarget {
  constructor(private readonly options: WebviewHighlightTargetOptions) {}

  private readonly pending = new Map<
    string,
    { settle: (answer: WebviewHighlightAnswer) => void; cancelTimeout: () => void }
  >();

  private ready = false;

  /** Mark the panel as able to answer — called once the bytes are posted. */
  open(): void {
    this.ready = true;
  }

  /** Mark the panel as gone. Every in-flight request settles `unavailable`. */
  close(): void {
    this.ready = false;
    for (const messageId of [...this.pending.keys()]) {
      this.settle(messageId, { outcome: 'unavailable' });
    }
  }

  /** Whether a waveform has been delivered to this panel. */
  isReady(): boolean {
    return this.ready;
  }

  /** In-flight requests. Test observability. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Post [request] to the webview and wait for its acknowledgement.
   *
   * Never rejects. Every failure — including a `postMessage` that throws
   * because the panel went away between the `isReady` check and the post —
   * comes back as an outcome, because the caller owes a peer an ack either
   * way.
   */
  async request(request: WebviewHighlightRequest): Promise<WebviewHighlightAnswer> {
    if (!this.ready) return { outcome: 'unavailable' };

    const messageId = cxp.newCxpMessageId();
    const frame = hostBridgeFrame({
      kind: REQUEST_HIGHLIGHT_KIND,
      messageId,
      // The element is relayed **exactly as it arrived** — §6.1 requires an
      // unrecognised kind to survive intact, and the Dart side has its own
      // (larger) vocabulary. Normalising here would make this build's
      // vocabulary the ceiling on the app's.
      payload: {
        element: { kind: request.element.kind, path: request.element.path },
        ...(request.coordinate !== undefined
          ? { coordinate: cxp.encodeStreamCoordinate(request.coordinate) }
          : {}),
        ...(Object.keys(request.metadata).length > 0 ? { metadata: request.metadata } : {}),
      },
    });

    const answered = new Promise<WebviewHighlightAnswer>((resolve) => {
      const cancelTimeout = (this.options.schedule ?? defaultSchedule)(() => {
        this.settle(messageId, { outcome: 'timeout' });
      }, this.options.timeoutMs ?? HIGHLIGHT_ACK_TIMEOUT_MS);
      this.pending.set(messageId, { settle: resolve, cancelTimeout });
    });

    try {
      await this.options.post(frame);
    } catch {
      this.settle(messageId, { outcome: 'unavailable' });
    }
    return await answered;
  }

  /**
   * Route one inbound CXP envelope. Returns whether it was ours.
   *
   * An ack for a request that already timed out is claimed and dropped: the
   * peer has been answered, and settling twice would resolve a promise
   * nobody holds. Claiming it still matters — it keeps a late ack out of the
   * output channel's frame log, where it would read as an unexplained
   * highlight nobody asked for.
   */
  accept(envelope: unknown): boolean {
    if (typeof envelope !== 'object' || envelope === null) return false;
    const { kind, payload } = envelope as { kind?: unknown; payload?: unknown };
    if (kind !== REQUEST_HIGHLIGHT_ACK_KIND && kind !== ERROR_RESPONSE_KIND) return false;
    if (typeof payload !== 'object' || payload === null) return false;
    const {
      in_reply_to: inReplyTo,
      honored,
      reason,
      message,
    } = payload as {
      in_reply_to?: unknown;
      honored?: unknown;
      reason?: unknown;
      message?: unknown;
    };
    if (typeof inReplyTo !== 'string' || !this.pending.has(inReplyTo)) return false;

    if (kind === ERROR_RESPONSE_KIND) {
      this.settle(inReplyTo, {
        outcome: 'error',
        ...(typeof message === 'string' && message.length > 0 ? { detail: message } : {}),
      });
      return true;
    }
    // `honored` is required on an ack (§9.5). A frame without it is not an
    // answer we can act on, so it is treated as the app failing rather than
    // silently as a refusal — a missing `honored` read as `false` would
    // report "the signal is not in the waveform" about a malformed frame.
    if (typeof honored !== 'boolean') {
      this.settle(inReplyTo, { outcome: 'error' });
      return true;
    }
    const detail = typeof reason === 'string' && reason.length > 0 ? { detail: reason } : {};
    this.settle(inReplyTo, honored ? { outcome: 'honored', ...detail } : { outcome: 'refused', ...detail });
    return true;
  }

  private settle(messageId: string, answer: WebviewHighlightAnswer): void {
    const entry = this.pending.get(messageId);
    if (entry === undefined) return;
    this.pending.delete(messageId);
    entry.cancelTimeout();
    entry.settle(answer);
  }
}

const defaultSchedule = (run: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => {
    clearTimeout(timer);
  };
};
