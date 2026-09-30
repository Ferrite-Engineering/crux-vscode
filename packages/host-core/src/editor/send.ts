import type { ElementId, ElementKind } from '../cxp/element-id';
import type { PeerIdentity } from '../cxp/identity';
import type { JsonObject } from '../cxp/json';
import {
  CXP_DESIGN_ID_METADATA_KEY,
  CxpMessageKind,
  type CxpMessage,
  type NotifySelection,
  type RequestHighlight,
} from '../cxp/messages';
import type { QuickPickChoice, UserInterface } from './editor-host';
import {
  noConnectedPeersMessage,
  noEditorSelectionMessage,
  peerMayNotAcceptDescription,
  pickElementPlaceholder,
  pickPeerPlaceholder,
} from './strings';

/**
 * Command ids for the outbound send affordance.
 *
 * `edacrux.*`, not `wavecrux.*`: the commands are host-core's, work in a
 * window with any one of the four extensions installed, and must not read
 * as belonging to whichever product happened to activate first. The
 * matching `contributes.commands` entries (and their localized titles) are
 * declared by the extension packages, which is where a VSCode manifest can
 * live at all.
 */
export const CRUX_SEND_COMMAND_IDS = {
  /** "Send Selection to Crux App" — emits `notify_selection`. */
  notifySelection: 'edacrux.sendSelectionToPeer',
  /** "Highlight Selection in Crux App" — emits `request_highlight`. */
  requestHighlight: 'edacrux.highlightSelectionInPeer',
} as const;

/**
 * What the user has selected in the editor right now.
 *
 * Positions are **1-based**, matching the wire (CXP §9.6) rather than
 * VSCode: this crosses into CXP payloads, and keeping one convention on
 * this side of the boundary is what stops a second off-by-one appearing
 * opposite the inbound one.
 */
export interface EditorSelectionSnapshot {
  /** The selected text, or the word under the caret when nothing is selected. */
  readonly identifier: string;
  /** Real path of the file it came from. */
  readonly fsPath: string;
  /** 1-based line of the selection start. */
  readonly line: number;
  /** 1-based column of the selection start. */
  readonly column: number;
}

/**
 * One candidate design path, with the provenance the quick-pick shows.
 *
 * The [description] is what makes an ambiguous send honest: "from stems"
 * and "name match" look identical as bare paths, and the difference is
 * precisely what the user needs in order to know whether to trust the list.
 * It is already localized by whoever produced it — `names/` owns those
 * strings, since it owns the distinction.
 */
export interface ElementPathChoice {
  /** Full hierarchical path to send. */
  readonly path: string;
  /** Short, already-localized provenance note. */
  readonly description?: string;
}

/**
 * What a resolver returns: bare paths, or paths with provenance.
 *
 * The union keeps the trivial resolver trivial — returning `[identifier]`
 * is still a complete answer — while letting a real one explain itself.
 */
export type ElementPathCandidates = readonly (string | ElementPathChoice)[];

/**
 * Maps what the user selected in a source file to the hierarchical design
 * path(s) a peer would recognise — `alu_result` in `alu.sv` to
 * `top.cpu.alu.result`.
 *
 * The real implementation is `names/NameResolver` (the stems index, with a
 * design-hierarchy fallback); [passThroughElementPathResolver] remains the
 * default for a host that has not constructed one, and sends the identifier
 * verbatim. That is genuinely useful when the peer's design uses flat names
 * or the user selected a full dotted path, and it is honest about being
 * nothing more.
 *
 * Returning several candidates is expected and supported: an identifier
 * that appears under multiple instantiations is ambiguous, and the caller
 * asks the user rather than picking one.
 */
export interface ElementPathResolver {
  resolve(snapshot: EditorSelectionSnapshot): ElementPathCandidates | Promise<ElementPathCandidates>;
}

/** Sends the selected text as the element path, unchanged. */
export const passThroughElementPathResolver: ElementPathResolver = {
  resolve(snapshot: EditorSelectionSnapshot): readonly string[] {
    const identifier = snapshot.identifier.trim();
    return identifier.length > 0 ? [identifier] : [];
  },
};

/**
 * Whether [value] can be called as an [ElementPathResolver].
 *
 * Structural, never `instanceof`: a resolver handed across the window
 * boundary was built by a *different bundle's* copy of host-core (see
 * `window/api.ts`), so it shares no prototype with anything here.
 */
export function isElementPathResolver(value: unknown): value is ElementPathResolver {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { resolve?: unknown }).resolve === 'function'
  );
}

/**
 * One resolver over several: the first that returns a candidate answers,
 * and the pass-through answers when none does.
 *
 * This is what the window-level send commands run on. Each product that
 * keeps a stems index contributes its `names.NameResolver`; a window where
 * none is contributed, or where none knows the selected identifier, sends
 * the identifier verbatim — exactly what [passThroughElementPathResolver]
 * alone would have sent, so adding a resolver can only ever add answers.
 *
 * [resolvers] is read per call because contributions come and go as
 * extensions activate and deactivate. A resolver that throws, or returns
 * something that is not an array, is treated as having no answer and
 * reported to [onError]; one broken contribution must not take the
 * command down for every other product in the window.
 */
export function composeElementPathResolvers(
  resolvers: () => readonly ElementPathResolver[],
  onError?: (error: unknown) => void,
): ElementPathResolver {
  return {
    async resolve(snapshot: EditorSelectionSnapshot): Promise<ElementPathCandidates> {
      for (const resolver of resolvers()) {
        try {
          const candidates: unknown = await resolver.resolve(snapshot);
          if (!Array.isArray(candidates)) {
            onError?.(new TypeError('resolver returned a non-array'));
            continue;
          }
          if (candidates.length > 0) return candidates as ElementPathCandidates;
        } catch (error) {
          onError?.(error);
        }
      }
      return passThroughElementPathResolver.resolve(snapshot);
    },
  };
}

/** Why a send did not happen. Never an error — all are ordinary outcomes. */
export type SendRefusal =
  /** Nothing selected and no word under the caret. */
  | 'no-selection'
  /** No CXP peer is connected to this window. */
  | 'no-peers'
  /** The resolver produced no candidate path for the selection. */
  | 'no-element'
  /** The user dismissed a quick-pick. */
  | 'cancelled'
  /** The chosen peer went away between the pick and the send. */
  | 'unreachable';

/** Result of one send command invocation. */
export type SendOutcome =
  | { readonly sent: true; readonly to: PeerIdentity; readonly message: CxpMessage }
  | { readonly sent: false; readonly reason: SendRefusal };

/** Construction options for [PeerSendCommands]. */
export interface PeerSendCommandsOptions {
  /** Quick-picks and messages. */
  readonly ui: UserInterface;
  /** The current editor selection, or `undefined` when there is none. */
  readonly currentSelection: () => EditorSelectionSnapshot | undefined;
  /**
   * Peers reachable right now — `LocalCxpServer.connectedPeers`.
   *
   * Connected, not merely discovered: a peer whose manifest is on disk but
   * whose link has not come up cannot receive anything, and offering it
   * would produce a send that silently goes nowhere.
   */
  readonly connectedPeers: () => readonly PeerIdentity[];
  /** Deliver to one peer — `LocalCxpServer.sendTo`. Returns reachability. */
  readonly send: (peerId: string, message: CxpMessage) => boolean;
  /** Identifier resolution. Defaults to [passThroughElementPathResolver]. */
  readonly resolver?: ElementPathResolver;
  /** Element kind to send. Defaults to `signal`. */
  readonly elementKind?: ElementKind;
  /** Shared-design id for `crux.design_id` metadata (wire 1.1), if known. */
  readonly designId?: () => string | undefined;
}

interface PeerChoice extends QuickPickChoice {
  readonly identity: PeerIdentity;
}

interface PathChoice extends QuickPickChoice {
  readonly path: string;
}

/** The path out of either shape a resolver may return. */
function pathOf(candidate: string | ElementPathChoice): string {
  return typeof candidate === 'string' ? candidate : candidate.path;
}

/**
 * The "Send to <peer>" affordance — the outbound half of cross-probing.
 *
 * A *direct action*: a command on the editor selection that sends straight to the discovered
 * peer, rather than a panel the user must open first. The panel still
 * exists for the multi-peer and advanced cases; this is the one-keystroke
 * path.
 *
 * ### Targeting
 *
 * - **Exactly one connected peer: send to it, no prompt.** That is what
 *   "auto-targeting the discovered peer" means, and a confirmation
 *   quick-pick with a single entry is exactly the friction a direct action
 *   exists to avoid.
 * - **Several: quick-pick**, ordered so peers that advertise the relevant
 *   capability come first.
 *
 * ### Capabilities rank, they never veto
 *
 * `capabilities` is advisory (CXP §8.1): a receiver must answer correctly
 * whether or not it advertised, and older peers advertise nothing at all.
 * So a peer that has not advertised the kind is still listed, still
 * selectable, and still sent to when it is the only one — it is merely
 * sorted lower and labelled [peerMayNotAcceptDescription]. Treating a
 * missing capability as a refusal would make the UI reject sends the
 * protocol would have delivered.
 */
export class PeerSendCommands {
  constructor(private readonly options: PeerSendCommandsOptions) {}

  /** `notify_selection` (§9.3): announce the selection. Not acknowledged. */
  async sendSelection(): Promise<SendOutcome> {
    return await this.dispatch(CxpMessageKind.notifySelection);
  }

  /** `request_highlight` (§9.4): ask the peer to bring the element into view. */
  async requestHighlight(): Promise<SendOutcome> {
    return await this.dispatch(CxpMessageKind.requestHighlight);
  }

  private async dispatch(
    kind: typeof CxpMessageKind.notifySelection | typeof CxpMessageKind.requestHighlight,
  ): Promise<SendOutcome> {
    const snapshot = this.options.currentSelection();
    if (snapshot === undefined || snapshot.identifier.trim().length === 0) {
      this.options.ui.showInformationMessage(noEditorSelectionMessage());
      return { sent: false, reason: 'no-selection' };
    }

    const peers = this.options.connectedPeers();
    if (peers.length === 0) {
      this.options.ui.showInformationMessage(noConnectedPeersMessage());
      return { sent: false, reason: 'no-peers' };
    }

    const resolver = this.options.resolver ?? passThroughElementPathResolver;
    const candidates = await resolver.resolve(snapshot);
    if (candidates.length === 0) {
      this.options.ui.showInformationMessage(noEditorSelectionMessage());
      return { sent: false, reason: 'no-element' };
    }

    // Ambiguity is asked about, never guessed: one identifier under several
    // instantiations has no "obviously right" answer, and picking the first
    // silently sends the user to the wrong instance.
    const path = await this.pickPath(candidates);
    if (path === undefined) return { sent: false, reason: 'cancelled' };

    const target = await this.pickPeer(peers, kind);
    if (target === undefined) return { sent: false, reason: 'cancelled' };

    const element: ElementId = {
      kind: this.options.elementKind ?? 'signal',
      path,
    };
    const message =
      kind === CxpMessageKind.notifySelection
        ? this.notifySelection(element, snapshot)
        : this.requestHighlightMessage(element);

    if (!this.options.send(target.peerId, message)) {
      return { sent: false, reason: 'unreachable' };
    }
    return { sent: true, to: target, message };
  }

  private metadata(): JsonObject {
    const designId = this.options.designId?.();
    return designId !== undefined ? { [CXP_DESIGN_ID_METADATA_KEY]: designId } : {};
  }

  private notifySelection(
    element: ElementId,
    snapshot: EditorSelectionSnapshot,
  ): NotifySelection {
    return {
      kind: CxpMessageKind.notifySelection,
      elements: [element],
      displayName: snapshot.identifier.trim(),
      metadata: this.metadata(),
    };
  }

  private requestHighlightMessage(element: ElementId): RequestHighlight {
    return {
      kind: CxpMessageKind.requestHighlight,
      element,
      metadata: this.metadata(),
    };
  }

  private async pickPath(candidates: ElementPathCandidates): Promise<string | undefined> {
    const [only] = candidates;
    if (candidates.length === 1 && only !== undefined) return pathOf(only);
    const choices: PathChoice[] = candidates.map((candidate) => {
      const path = pathOf(candidate);
      const description = typeof candidate === 'string' ? undefined : candidate.description;
      return {
        label: path,
        ...(description !== undefined ? { description } : {}),
        path,
      };
    });
    const picked = await this.options.ui.showQuickPick(choices, pickElementPlaceholder());
    return picked?.path;
  }

  private async pickPeer(
    peers: readonly PeerIdentity[],
    kind: string,
  ): Promise<PeerIdentity | undefined> {
    // One peer means no prompt. The capability is not consulted
    // here — the user asked to send, and the receiver gets to answer.
    const [only] = peers;
    if (peers.length === 1 && only !== undefined) return only;

    const ranked = [...peers].sort((a, b) => {
      const capable = Number(b.capabilities.includes(kind)) - Number(a.capabilities.includes(kind));
      if (capable !== 0) return capable;
      const byName = a.productName.localeCompare(b.productName);
      return byName !== 0 ? byName : a.peerId.localeCompare(b.peerId);
    });
    const choices: PeerChoice[] = ranked.map((identity) => ({
      label: identity.productName,
      ...(identity.capabilities.includes(kind)
        ? {}
        : { description: peerMayNotAcceptDescription() }),
      detail: identity.productVersion,
      identity,
    }));
    const picked = await this.options.ui.showQuickPick(choices, pickPeerPlaceholder());
    return picked?.identity;
  }
}
