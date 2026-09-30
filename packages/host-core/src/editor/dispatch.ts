import type { Disposable, Emitter } from '../cxp/emitter';
import { CxpMessageKind, type CxpMessage } from '../cxp/messages';
import type { InboundCxpMessage } from '../cxp/server';
import type { CxpWorkspaceStore } from '../cxp/workspace-store';
import type { SurfaceRegistry } from '../surface/index';
import type { EditorHost } from './editor-host';
import { routeRequestHighlight } from './highlight';
import { SelectionPresenter, type SelectionPresentation } from './notify-selection';
import { handleRequestOpenArtifact } from './open-artifact';
import { handleRequestOpenSource, type CxpAckOutcome } from './open-source';
import { DEFAULT_CROSS_PROBE_SETTINGS, type CrossProbeSettings } from './settings';

/**
 * The transport surface the dispatcher needs — structurally satisfied by
 * [LocalCxpServer], and by a fake in tests.
 */
export interface CxpEditorTransport {
  /** Every inbound message, from accepted sockets and outbound links alike. */
  readonly onInbound: Emitter<InboundCxpMessage>;
  /** Directed send, bypassing subscription filters. Returns reachability. */
  sendTo(peerId: string, message: CxpMessage): boolean;
}

/** Construction options for [CxpEditorDispatcher]. */
export interface CxpEditorDispatcherOptions {
  /** Where messages arrive and acks go back out. */
  readonly transport: CxpEditorTransport;
  /** Installed product surfaces, for `request_highlight` routing. */
  readonly registry: SurfaceRegistry;
  /** The editor to open and reveal in. */
  readonly editor: EditorHost;
  /**
   * The shared-workspace store, for resolving `request_open_artifact`.
   * Omitted on a machine with no resolvable application-data root, where
   * the request's `path` hint is the only candidate.
   */
  readonly workspace?: Pick<CxpWorkspaceStore, 'resolveArtifact'>;
  /** Focus/reveal policy, read live. Defaults to the documented defaults. */
  readonly settings?: () => CrossProbeSettings;
  /** Symlink resolver, injectable for tests. */
  readonly realpath?: (path: string) => Promise<string>;
  /** Platform tag for path-case comparison, injectable for tests. */
  readonly platform?: NodeJS.Platform;
}

/** What the dispatcher did with one inbound message. Test observability. */
export interface HandledCxpMessage {
  /** The kind that was handled. */
  readonly kind: string;
  /** The sending peer. */
  readonly peerId: string;
  /** The ack sent back, for the two acknowledged kinds. */
  readonly ack?: CxpAckOutcome;
  /** What the selection presenter did, for `notify_selection`. */
  readonly presentation?: SelectionPresentation;
}

/**
 * Wires the four inbound editor-relevant CXP kinds to their handlers and
 * sends the acknowledgements the protocol requires.
 *
 * `request_open_source`, `request_highlight` and — since wire minor 1.1 —
 * `request_open_artifact` **must** be acknowledged by a receiver that
 * accepts them (CXP §12 conformance item 6), whether or not they were
 * honoured. `notify_selection` is a statement and gets no reply (§9.3).
 * Every other kind is left alone — the transport already answers
 * `unknown_kind` for what it does not model, and this class must not
 * swallow kinds another module owns.
 *
 * ### Serialised on purpose
 *
 * Handling is chained through one promise rather than run concurrently. Two
 * `request_open_source` messages arriving together would otherwise race
 * `showTextDocument`, and the tab that ends up in front would be whichever
 * document loaded faster rather than whichever request arrived last. It
 * also keeps acks in receipt order, which is what makes two implementations'
 * logs line up.
 */
export class CxpEditorDispatcher implements Disposable {
  /** The `notify_selection` half, exposed for its event. */
  readonly selection: SelectionPresenter;

  private readonly subscription: Disposable;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: CxpEditorDispatcherOptions) {
    this.selection = new SelectionPresenter({
      editor: options.editor,
      ...(options.settings !== undefined ? { settings: options.settings } : {}),
      ...(options.realpath !== undefined ? { realpath: options.realpath } : {}),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
    this.subscription = options.transport.onInbound.listen((inbound) => {
      this.enqueue(inbound);
    });
  }

  /**
   * Resolves once everything received so far has been handled. Tests await
   * it instead of sleeping; nothing in production needs it.
   */
  async settled(): Promise<void> {
    await this.queue;
  }

  /** Stop handling inbound messages. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscription.dispose();
    this.selection.dispose();
  }

  private enqueue(inbound: InboundCxpMessage): void {
    // A handler that rejects must not break the chain for every later
    // message, so the catch is on the chain rather than on each link.
    this.queue = this.queue.then(async () => {
      try {
        await this.handle(inbound);
      } catch (error) {
        console.error('[crux] editor dispatch failed:', error);
      }
    });
  }

  private async handle(inbound: InboundCxpMessage): Promise<HandledCxpMessage | undefined> {
    if (this.disposed) return undefined;
    const settings = this.options.settings?.() ?? DEFAULT_CROSS_PROBE_SETTINGS;
    const { message, envelope, from } = inbound;

    switch (message.kind) {
      case CxpMessageKind.requestOpenSource: {
        const ack = await handleRequestOpenSource(message, {
          editor: this.options.editor,
          settings,
          ...(this.options.realpath !== undefined ? { realpath: this.options.realpath } : {}),
          ...(this.options.platform !== undefined ? { platform: this.options.platform } : {}),
        });
        this.options.transport.sendTo(from.peerId, {
          kind: CxpMessageKind.requestOpenSourceAck,
          inReplyTo: envelope.messageId,
          honored: ack.honored,
          ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
        });
        return { kind: message.kind, peerId: from.peerId, ack };
      }
      case CxpMessageKind.requestOpenArtifact: {
        const ack = await handleRequestOpenArtifact(message, {
          editor: this.options.editor,
          settings,
          ...(this.options.workspace !== undefined ? { workspace: this.options.workspace } : {}),
          ...(this.options.realpath !== undefined ? { realpath: this.options.realpath } : {}),
          ...(this.options.platform !== undefined ? { platform: this.options.platform } : {}),
        });
        this.options.transport.sendTo(from.peerId, {
          kind: CxpMessageKind.requestOpenArtifactAck,
          inReplyTo: envelope.messageId,
          honored: ack.honored,
          ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
        });
        return { kind: message.kind, peerId: from.peerId, ack };
      }
      case CxpMessageKind.requestHighlight: {
        const ack = await routeRequestHighlight(message, from, {
          registry: this.options.registry,
        });
        this.options.transport.sendTo(from.peerId, {
          kind: CxpMessageKind.requestHighlightAck,
          inReplyTo: envelope.messageId,
          honored: ack.honored,
          ...(ack.reason !== undefined ? { reason: ack.reason } : {}),
        });
        return { kind: message.kind, peerId: from.peerId, ack };
      }
      case CxpMessageKind.notifySelection: {
        const presentation = await this.selection.present(message, from);
        return { kind: message.kind, peerId: from.peerId, presentation };
      }
      default:
        return undefined;
    }
  }
}
