import { Emitter } from '../../src/cxp/emitter';
import type { PeerIdentity } from '../../src/cxp/identity';
import type { CxpMessage } from '../../src/cxp/messages';
import type { InboundCxpMessage } from '../../src/cxp/server';
import type {
  EditorDocument,
  EditorHost,
  EditorPosition,
  QuickPickChoice,
  ShowDocumentOptions,
  UserInterface,
} from '../../src/editor/editor-host';
import type { CxpEditorTransport } from '../../src/editor/dispatch';

/** A document with fixed lines, enough to exercise caret clamping. */
export class FakeDocument implements EditorDocument {
  constructor(
    readonly fsPath: string,
    private readonly lines: readonly string[],
  ) {}

  get lineCount(): number {
    return this.lines.length;
  }

  lineLength(line: number): number {
    return this.lines[line]?.length ?? 0;
  }
}

/** One `showTextDocument` call, recorded. */
export interface ShownDocument {
  readonly fsPath: string;
  readonly position: EditorPosition;
  readonly options: ShowDocumentOptions;
}

/**
 * An [EditorHost] backed by an in-memory file table.
 *
 * `openTextDocument` rejects for a path it does not know, which is how the
 * "the editor could not open the file" path is reached without needing a
 * real unreadable file on disk.
 */
export class FakeEditorHost implements EditorHost {
  readonly shown: ShownDocument[] = [];
  /** Every `openArtifact` call, in order. */
  readonly artifacts: { fsPath: string; options: ShowDocumentOptions }[] = [];
  /** Set to make every `openTextDocument` reject, whatever the path. */
  openRejects = false;
  /** Set to make every `openArtifact` reject, whatever the path. */
  artifactOpenRejects = false;

  constructor(
    private readonly folders: readonly string[],
    private readonly files: ReadonlyMap<string, readonly string[]>,
  ) {}

  workspaceFolders(): readonly string[] {
    return this.folders;
  }

  openTextDocument(fsPath: string): Promise<EditorDocument> {
    if (this.openRejects) return Promise.reject(new Error('editor refused'));
    const lines = this.files.get(fsPath);
    if (lines === undefined) return Promise.reject(new Error(`no such document: ${fsPath}`));
    return Promise.resolve(new FakeDocument(fsPath, lines));
  }

  showTextDocument(
    document: EditorDocument,
    position: EditorPosition,
    options: ShowDocumentOptions,
  ): Promise<void> {
    this.shown.push({ fsPath: document.fsPath, position, options });
    return Promise.resolve();
  }

  openArtifact(fsPath: string, options: ShowDocumentOptions): Promise<void> {
    if (this.artifactOpenRejects) return Promise.reject(new Error('editor refused'));
    this.artifacts.push({ fsPath, options });
    return Promise.resolve();
  }
}

/** A [UserInterface] that answers quick-picks from a scripted queue. */
export class FakeUserInterface implements UserInterface {
  readonly messages: string[] = [];
  readonly placeholders: string[] = [];
  /**
   * What each quick-pick actually offered, in order.
   *
   * Recorded because *what the user was shown* is the assertion that
   * matters for ambiguity: a resolver that quietly narrowed four
   * candidates to one still passes a test that only checks what was sent.
   */
  readonly offered: (readonly QuickPickChoice[])[] = [];
  /** Chosen by index into the offered list; `undefined` dismisses. */
  answers: (number | undefined)[] = [];

  showQuickPick<T extends QuickPickChoice>(
    choices: readonly T[],
    placeHolder: string,
  ): Promise<T | undefined> {
    this.placeholders.push(placeHolder);
    this.offered.push(choices);
    const index = this.answers.shift();
    return Promise.resolve(index === undefined ? undefined : choices[index]);
  }

  showInformationMessage(message: string): void {
    this.messages.push(message);
  }
}

/** A [CxpEditorTransport] that records what was sent where. */
export class FakeTransport implements CxpEditorTransport {
  readonly onInbound = new Emitter<InboundCxpMessage>();
  readonly sent: { peerId: string; message: CxpMessage }[] = [];
  /** Set false to simulate a peer that vanished before the reply. */
  reachable = true;

  sendTo(peerId: string, message: CxpMessage): boolean {
    this.sent.push({ peerId, message });
    return this.reachable;
  }
}

/** A peer identity for tests. */
export function peer(
  peerId: string,
  productName: string,
  capabilities: readonly string[] = [],
): PeerIdentity {
  return { peerId, productName, productVersion: '0.1.0', capabilities };
}

/** An [InboundCxpMessage] wrapping [message] from [from]. */
export function inbound(
  message: CxpMessage,
  from: PeerIdentity,
  messageId = 'msg-1',
): InboundCxpMessage {
  return {
    envelope: {
      cxpVersion: '1.1',
      messageId,
      from: from.peerId,
      kind: message.kind,
      payload: {},
    },
    message,
    from,
  };
}
