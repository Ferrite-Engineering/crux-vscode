/**
 * The waveform's selection, on its way *out* of the webview.
 *
 * `CxpSelectionEmitter` in the WaveCrux app already broadcasts every
 * selection change as a CXP `notify_selection` — on desktop to the peers
 * subscribed to the CXP server, and under a VSCode host to
 * `EditorHostBridge.postCxp`, which posts it up here.
 *
 * This module is the consumer, and it is deliberately only a *decoder*: it
 * turns one inbound envelope into the design path the selection names, and
 * host-core's `editor.revealDesignPathInEditor` does everything after that
 * (stems lookup, §11 containment, the reveal). The split is the standing
 * rule — resolving a design path to a source line is shared behaviour, and
 * "which element of a WaveCrux selection is the one the user clicked" is
 * not.
 *
 * No `vscode` import, so every bound below is testable without an extension
 * host.
 */
import { cxp } from '@crux-vscode/host-core';

/**
 * Element kinds whose `path` is a **design path** the stems index can
 * resolve to a declaration.
 *
 * `marker` is excluded although the emitter sends it: a marker's path is a
 * letter (`A`, `B`, …), which is a position on the timeline and names
 * nothing in the RTL. Looking one up would either miss or — worse — hit a
 * one-letter signal somewhere in the design and navigate to it.
 *
 * `source` is excluded for the opposite reason: its path is already a file,
 * so it is not a question for the name index at all. Nothing emits one
 * today; if something does, it wants `revealSelection`'s route, not this
 * one.
 */
export const DESIGN_PATH_ELEMENT_KINDS: readonly string[] = [
  'signal',
  'instance',
  'net',
  'port',
  'scope',
];

/** A decoded selection announcement from the webview. */
export interface WebviewSelection {
  /** The selected elements, in the app's own order. */
  readonly elements: readonly cxp.ElementId[];
  /** The app's label for the selection. Untrusted; never rendered raw. */
  readonly displayName?: string;
  /** Free-form app context — carries `crux.design_id` and the cursor time. */
  readonly metadata: cxp.JsonObject;
}

/**
 * Decode an inbound CXP envelope as a `notify_selection`, or `undefined`.
 *
 * Goes through host-core's own `decodeCxpMessage` rather than reading the
 * payload by hand: the webview's messages are untrusted input in exactly
 * the way a socket peer's are, and a second selection decoder is a second
 * thing to get wrong. It is also what makes an **empty** `elements` list —
 * a cleared selection, CXP §9.3 — decode here rather than throw, now that
 * both implementations accept one.
 */
export function parseWebviewSelection(envelope: unknown): WebviewSelection | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined;
  const { kind, payload } = envelope as { kind?: unknown; payload?: unknown };
  if (kind !== cxp.CxpMessageKind.notifySelection) return undefined;
  if (!cxp.isJsonObject(payload)) return undefined;
  let message;
  try {
    message = cxp.decodeCxpMessage(cxp.CxpMessageKind.notifySelection, payload);
  } catch {
    // A malformed selection is dropped, not fatal: the app is mid-drag and
    // another one is a hundred milliseconds away.
    return undefined;
  }
  if (message === undefined || message.kind !== cxp.CxpMessageKind.notifySelection) {
    return undefined;
  }
  return {
    elements: message.elements,
    ...(message.displayName !== undefined ? { displayName: message.displayName } : {}),
    metadata: message.metadata,
  };
}

/**
 * The design path this selection is *about*, or `undefined`.
 *
 * The **first** element of a resolvable kind, which is the app's own
 * primary — `CxpSelectionEmitter` emits one element per announcement and
 * CXP §9.1 already treats `elements[0]` as primary for `path_prefix`
 * filtering, so "first" is the convention both sides already use rather
 * than a new one invented here.
 *
 * A cleared selection (`elements: []`) yields `undefined`, which is exactly
 * right for this feature: the user deselecting a signal is not a request to
 * navigate anywhere, and navigating on it would move the editor away from
 * the line they were just sent to.
 */
export function designPathOf(selection: WebviewSelection): string | undefined {
  for (const element of selection.elements) {
    if (!DESIGN_PATH_ELEMENT_KINDS.includes(element.kind)) continue;
    const path = element.path.trim();
    if (path.length > 0) return path;
  }
  return undefined;
}
