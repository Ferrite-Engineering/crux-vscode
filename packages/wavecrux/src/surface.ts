/**
 * WaveCrux's [surface.CruxSurface] — what this extension adds to the
 * window's CXP identity, and the one inbound message it can act on.
 *
 * A VSCode window is **one** CXP peer however many of the four extensions
 * are installed in it (one process, one socket, one `peer_id`, one
 * manifest). What differs is what that peer can do, and that is the
 * capability list host-core composes from the registered surfaces. This
 * module is WaveCrux's contribution to it.
 *
 * ### `request_highlight`, and the follow-up this closes
 *
 * The previous version of this file registered **no** capabilities and no
 * `highlight` handler, and said why: "bringing a signal into view in the
 * waveform needs a webview command the host bridge does not expose yet. The
 * follow-up that adds one adds `request_highlight` and a `highlight` handler
 * here, together, in the same change." This is that change, and they do land
 * together — the capability string is a promise, and a promise with no
 * handler behind it costs a peer a round trip to learn we lied.
 *
 * The route is now complete end to end: peer → host-core's
 * `CxpEditorDispatcher` → `routeRequestHighlight` → this handler →
 * `WebviewHighlightTarget` → `window.postMessage` → the Dart
 * `EditorHostBridge` → `dispatchCxpHighlight`, which is the *same* function
 * WaveCrux's own CXP server calls. There is no parallel highlight
 * implementation anywhere on that path, which is why it is short.
 *
 * ### What is still not advertised
 *
 * - `wavecrux.signal_value` / `wavecrux.cursor_time_fs` — these describe
 *   what a peer answers over **WCP**, and nothing routes a WCP call to the
 *   webview. The webview genuinely can answer both (`webview/value-query.ts`
 *   does exactly that for the RTL annotation), which is what makes claiming
 *   them tempting and still wrong on this wire.
 * - `request_open_artifact` — host-core's `CxpEditorDispatcher` models three
 *   inbound kinds and that is not one of them.
 *
 * `request_open_source` is in [surface.BASE_VSCODE_CAPABILITIES] and belongs
 * to every window, not to this extension.
 */
import { editor } from '@crux-vscode/host-core';
import type { surface } from '@crux-vscode/host-core';
import type { WebviewHighlightTarget } from './webview/highlight-bridge';
import {
  reasonHighlightFailed,
  reasonNoWaveformOpen,
  reasonNotInWaveform,
  reasonWaveformDidNotAnswer,
} from './strings';

/** The capability string this surface adds to the window's advertised set. */
export const WAVECRUX_HIGHLIGHT_CAPABILITY = 'request_highlight';

/**
 * Element kinds this surface **claims**. Anything else is declined, and
 * routing continues to the next installed surface.
 *
 * Mirrors the signal-like/scope/marker arms of `_dispatchCxpHighlight` in
 * `wavecrux/lib/services/remote/cxp/cxp_inbound_handlers.dart`: exactly the
 * kinds the app resolves against a loaded waveform. Deliberately checked
 * **here** rather than by posting everything and letting the app answer,
 * for the reason [surface.SurfaceHighlightResult] spells out: a `refused`
 * stops routing, so a surface that answers for a `rule` element it does not
 * own is a surface that can starve LintCrux of its own highlights the day
 * LintCrux registers a handler. A kind gate is what makes `refused` safe to
 * use for everything else.
 *
 * `source` is in the Dart list and deliberately **not** here. Inside VSCode
 * a source element names a file the *editor* owns; sending it to the
 * waveform panel would claim it for the one surface in the window that
 * cannot open a file at a line.
 *
 * An unrecognised kind — one a peer built against a later revision minted —
 * is also declined, matching the Dart `null` arm.
 */
export const WAVECRUX_HIGHLIGHT_ELEMENT_KINDS: readonly string[] = [
  'signal',
  'instance',
  'net',
  'port',
  'scope',
  'marker',
];

/** What [createWaveCruxSurface] needs from the extension. */
export interface WaveCruxSurfaceOptions {
  /**
   * The waveform panel an inbound highlight should go to, or `undefined`
   * when no waveform is open in this window.
   *
   * A callback rather than a value because a surface is registered once, at
   * activation, and lives as long as the extension does, while panels come
   * and go — see `annotate/surface.ts`'s adoption stack, which this reads
   * through and which exists for the same reason.
   */
  readonly target: () => WebviewHighlightTarget | undefined;
  /** Diagnostics, into the WaveCrux output channel. */
  readonly log?: (line: string) => void;
}

/**
 * Map the app's answer onto the three outcomes host-core's router expects.
 *
 * Exported for its own tests: this mapping is the whole of the contract
 * between a webview that may or may not be there and a peer that is owed an
 * ack, and every arm of it is a decision.
 *
 * | App said | Outcome | Why |
 * |---|---|---|
 * | `honored: true` | `honored` | routing stops; the ack is `honored: true` |
 * | `honored: false` | `refused` | it looked and the signal is not in the loaded waveform — a §9.5 outcome, not an error |
 * | `error_response` | `refused` | the app owns the element and failed on it; another surface answering for it would be worse |
 * | nothing, in 5 s | `refused` | **not** `declined`: a surface that took the request and went silent must not fall through and leave the peer reading "no installed Crux surface handles this element" |
 * | no panel open | `refused` | see below |
 *
 * **No panel open is `refused`, not `declined`, and that is the one arm
 * worth arguing about.** `declined` would fall through, and with no other
 * surface handling waveform elements the peer would be told "no installed
 * Crux surface handles this element" — which is false and unactionable when
 * the truth is "WaveCrux is right here, open a waveform". `refused` costs
 * the fall-through, and the kind gate above is what makes that affordable:
 * this surface only ever claims elements no other surface in the pack deals
 * in. (NetCrux is a *send* surface by design — a schematic browser needs a
 * canvas this editor cannot give it — so it registers no
 * highlight handler to be starved of one.)
 *
 * **No reason is ever echoed from the app.** The Dart reasons are good
 * English sentences that sometimes interpolate the element path or kind the
 * *peer* sent, and this ack is rendered in the peer's own UI — the §11 hop
 * `editor/strings.ts` refuses to make. So the reason is one of this
 * extension's own localized strings, and the app's own words go to the
 * output channel instead, where they are a diagnostic rather than a relay.
 */
export function highlightResultFor(
  answer: { readonly outcome: string; readonly detail?: string },
): surface.SurfaceHighlightResult {
  switch (answer.outcome) {
    case 'honored':
      return { outcome: 'honored' };
    case 'refused':
      return { outcome: 'refused', reason: reasonNotInWaveform() };
    case 'timeout':
      return { outcome: 'refused', reason: reasonWaveformDidNotAnswer() };
    case 'unavailable':
      return { outcome: 'refused', reason: reasonNoWaveformOpen() };
    default:
      return { outcome: 'refused', reason: reasonHighlightFailed() };
  }
}

/**
 * WaveCrux's surface registration.
 *
 * The capability is advertised whenever this extension is installed, not
 * only while a waveform happens to be open: a capability describes what the
 * *surface* can act on, and "is a tab open right now" is state a manifest
 * refreshed every 30 s could never track honestly anyway. A window without
 * WaveCrux installed registers no such surface and therefore advertises no
 * `request_highlight` — which is the composition property
 * `host-core/test/surface.test.ts` and `test/surface.test.ts` both pin.
 */
export function createWaveCruxSurface(options: WaveCruxSurfaceOptions): surface.CruxSurface {
  return {
    id: 'wavecrux',
    extensionId: editor.cruxExtensionId('wavecrux'),
    capabilities: [WAVECRUX_HIGHLIGHT_CAPABILITY],
    highlight: async (request) => {
      if (!WAVECRUX_HIGHLIGHT_ELEMENT_KINDS.includes(request.element.kind)) {
        return { outcome: 'declined' };
      }
      const target = options.target();
      if (target === undefined || !target.isReady()) {
        options.log?.('   highlight: no waveform panel to route to');
        return highlightResultFor({ outcome: 'unavailable' });
      }
      const answer = await target.request({
        element: request.element,
        ...(request.coordinate !== undefined ? { coordinate: request.coordinate } : {}),
        metadata: request.metadata,
      });
      options.log?.(
        `   highlight: ${answer.outcome}` +
          ('detail' in answer && answer.detail !== undefined ? ` — ${answer.detail}` : ''),
      );
      return highlightResultFor(answer);
    },
  };
}

/**
 * Register a WaveCrux surface in [registry]; dispose to remove it.
 *
 * Production goes through [window.joinCruxWindow], which registers into
 * whichever extension hosts the window. This entry point exists for tests
 * and for a caller holding a registry directly, matching the other three
 * products' `surface.ts`.
 */
export function registerWaveCruxSurface(
  registry: surface.SurfaceRegistry,
  options: WaveCruxSurfaceOptions = { target: () => undefined },
): surface.Disposable {
  return registry.register(createWaveCruxSurface(options));
}
