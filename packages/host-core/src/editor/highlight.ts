import type { PeerIdentity } from '../cxp/identity';
import type { RequestHighlight } from '../cxp/messages';
import type { SurfaceHighlightRequest, SurfaceRegistry } from '../surface/index';
import type { CxpAckOutcome } from './open-source';
import { reasonNoSurfaceHandlesElement, reasonNoSurfaceInstalled } from './strings';

/** Dependencies of [routeRequestHighlight]. */
export interface HighlightRoutingOptions {
  /** The surfaces installed in this window. */
  readonly registry: SurfaceRegistry;
  /**
   * Sink for a surface that threw. Defaults to `console.error`. A throw is
   * a bug in a product extension, and losing it silently would make the
   * window look like it simply has no surface for that element.
   */
  readonly onSurfaceError?: (surfaceId: string, error: unknown) => void;
}

/**
 * Route an inbound `request_highlight` (CXP §9.4) to whichever installed
 * surface can honour it, and produce the `request_highlight_ack` outcome
 * (§9.5).
 *
 * ### The fall-through
 *
 * Surfaces are offered the request in registration order. Each answers
 * `honored`, `refused`, or `declined` (see [SurfaceHighlightResult]):
 *
 * - the first `honored` wins and routing stops;
 * - the first `refused` also stops routing — the surface has claimed the
 *   element and is telling us it cannot show it, which is a better ack than
 *   letting a second surface answer for something it does not own;
 * - `declined` (or `undefined`, or a throw) passes the request on.
 *
 * If every surface declines, the ack is `honored: false`. The reason
 * distinguishes the two cases that look identical from the peer's side but
 * are not: *nothing is installed here* versus *things are installed and
 * none of them deal in this kind of element*. The first is fixed by
 * installing an extension; the second by opening the right artifact.
 *
 * Neither reason quotes `element.path` or `element.kind` — CXP §11 makes
 * both untrusted peer input, and the ack we return is rendered in the
 * peer's own UI.
 */
export async function routeRequestHighlight(
  request: RequestHighlight,
  from: PeerIdentity,
  options: HighlightRoutingOptions,
): Promise<CxpAckOutcome> {
  const onSurfaceError =
    options.onSurfaceError ??
    ((surfaceId: string, error: unknown): void => {
      console.error(`[crux] surface "${surfaceId}" failed handling request_highlight:`, error);
    });

  // Built once and shared: every surface sees the same object, and the
  // element inside it is the one that came off the wire (§6.1 — an
  // unrecognised kind round-trips intact rather than being normalised).
  const offered: SurfaceHighlightRequest = {
    element: request.element,
    ...(request.coordinate !== undefined ? { coordinate: request.coordinate } : {}),
    metadata: request.metadata,
    from,
  };

  let sawHandler = false;
  for (const surface of options.registry.surfaces) {
    const handler = surface.highlight;
    if (handler === undefined) continue;
    sawHandler = true;
    let result;
    try {
      result = await handler(offered);
    } catch (error) {
      onSurfaceError(surface.id, error);
      continue;
    }
    if (result === undefined || result.outcome === 'declined') continue;
    if (result.outcome === 'honored') {
      return result.reason !== undefined
        ? { honored: true, reason: result.reason }
        : { honored: true };
    }
    return { honored: false, reason: result.reason };
  }

  return {
    honored: false,
    reason: sawHandler ? reasonNoSurfaceHandlesElement() : reasonNoSurfaceInstalled(),
  };
}
