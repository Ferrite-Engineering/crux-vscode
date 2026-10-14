/**
 * The one-time offer to make WaveCrux the default editor for `.vcd` files.
 *
 * ### The problem
 *
 * The manifest claims `.vcd` with `priority: "default"`, which VSCode
 * honours: a `.vcd` opens in WaveCrux with no further setup. Some VSCode
 * forks that install from Open VSX open the same file in the plain text
 * editor instead and show WaveCrux only under *Reopen Editor With...*. The
 * manifest is right; the fork's resolver is not following it. A user cannot
 * be expected to know that, and the file looks like text to them.
 *
 * ### What this does, and what it deliberately does not
 *
 * When a `.vcd` file is opened in the **text** editor, this asks once
 * whether WaveCrux should be the default for `*.vcd`. On a yes it writes
 * `workbench.editorAssociations` in the user's settings, which every
 * VSCode-based editor honours, and reopens the tab in WaveCrux.
 *
 * - It reacts to a `.vcd` text tab and nothing else. Where `priority`
 *   works, a `.vcd` opens as a custom editor, no text tab ever appears, and
 *   the user never sees this.
 * - It asks **once per installation**, whatever the answer, and the message
 *   is dismissible. Declining, or closing the message, is final.
 * - It writes **only on consent**, and only to the user's own settings (the
 *   global value), never to the workspace's.
 * - It stays quiet when the user has already decided: any existing
 *   association for a `.vcd` pattern, to any editor, is respected.
 *
 * Every dependency is injected, so each branch is exercised without an
 * extension host.
 */
import * as vscode from 'vscode';

/** The glob written to `workbench.editorAssociations`. */
export const VCD_ASSOCIATION_PATTERN = '*.vcd';

/** `globalState` key recording that the offer has been made. */
export const DEFAULT_EDITOR_OFFER_STATE_KEY = 'wavecrux.offer.defaultVcdEditor';

/** What `workbench.editorAssociations` can hold: the object form, or the legacy list. */
export type EditorAssociations =
  | Readonly<Record<string, string>>
  | readonly { readonly viewType: string; readonly filenamePattern?: string }[];

/** Narrow an untrusted settings value to [EditorAssociations], or `undefined`. */
export function asEditorAssociations(value: unknown): EditorAssociations | undefined {
  if (Array.isArray(value)) {
    const entries: { viewType: string; filenamePattern?: string }[] = [];
    for (const item of value as unknown[]) {
      if (typeof item !== 'object' || item === null) continue;
      const { viewType, filenamePattern } = item as { viewType?: unknown; filenamePattern?: unknown };
      if (typeof viewType !== 'string') continue;
      entries.push(
        typeof filenamePattern === 'string' ? { viewType, filenamePattern } : { viewType },
      );
    }
    return entries;
  }
  if (typeof value === 'object' && value !== null) {
    const entries: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string') entries[key] = item;
    }
    return entries;
  }
  return undefined;
}

/** The glob patterns [associations] already assigns an editor to. */
function patternsOf(associations: EditorAssociations | undefined): readonly string[] {
  if (associations === undefined) return [];
  if (Array.isArray(associations)) {
    return (associations as readonly { filenamePattern?: string }[]).flatMap((entry) =>
      entry.filenamePattern === undefined ? [] : [entry.filenamePattern],
    );
  }
  return Object.keys(associations);
}

/**
 * Whether the user has already chosen an editor for `.vcd` files.
 *
 * Any pattern that ends in `.vcd` counts, whether it covers every folder or
 * one, and whichever editor it names: a deliberate choice of the text
 * editor is a choice, and not ours to overrule with a prompt.
 */
export function hasVcdAssociation(associations: EditorAssociations | undefined): boolean {
  return patternsOf(associations).some((pattern) => pattern.toLowerCase().endsWith('.vcd'));
}

/**
 * [associations] with `*.vcd` mapped to [viewType]; the rest untouched.
 * The shape of the input is kept, so a user on the legacy list form does
 * not find their setting rewritten as an object.
 */
export function withVcdAssociation(
  associations: EditorAssociations | undefined,
  viewType: string,
): EditorAssociations {
  if (Array.isArray(associations)) {
    return [
      ...(associations as readonly { viewType: string; filenamePattern?: string }[]),
      { viewType, filenamePattern: VCD_ASSOCIATION_PATTERN },
    ];
  }
  return { ...(associations as Record<string, string> | undefined), [VCD_ASSOCIATION_PATTERN]: viewType };
}

/** Whether [path] names a `.vcd` file. Case-insensitive: Windows hands us `TOP.VCD`. */
export function isVcdPath(path: string): boolean {
  return path.toLowerCase().endsWith('.vcd');
}

/** The question. */
export function offerMessage(): string {
  return vscode.l10n.t(
    'This editor opened a .vcd file as plain text. Make WaveCrux the default editor for .vcd files?',
  );
}

/** Accept button. */
export function acceptLabel(): string {
  return vscode.l10n.t('Make WaveCrux the default');
}

/** Decline button. */
export function declineLabel(): string {
  return vscode.l10n.t('No thanks');
}

/** Shown after the setting was written. */
export function confirmedMessage(): string {
  return vscode.l10n.t(
    'WaveCrux now opens .vcd files by default. To change this, edit "workbench.editorAssociations" in your settings.',
  );
}

/** Shown when the setting could not be written. */
export function failedMessage(): string {
  return vscode.l10n.t(
    'WaveCrux could not change your settings. Use Reopen Editor With... on a .vcd tab, then choose to configure the default editor for *.vcd.',
  );
}

/** What the offer needs from its environment. */
export interface DefaultEditorOfferHost {
  /** Whether the offer has been made before on this installation. */
  readonly wasOffered: () => boolean;
  /** Record that the offer has been made. */
  readonly markOffered: () => Promise<void>;
  /** The effective `workbench.editorAssociations`, as the user's windows see it. */
  readonly effectiveAssociations: () => unknown;
  /** The user-level (global) value only, which is all that is ever written back. */
  readonly globalAssociations: () => unknown;
  /** Write the user-level value. Rejects if the settings cannot be changed. */
  readonly writeGlobalAssociations: (value: EditorAssociations) => Promise<void>;
  /** Non-modal message with buttons; resolves to the chosen label, `undefined` if dismissed. */
  readonly showMessage: (
    message: string,
    ...actions: readonly string[]
  ) => Promise<string | undefined>;
  /** Diagnostics. */
  readonly log: (line: string) => void;
}

/** What one call did. Test and diagnostic observability. */
export type DefaultEditorOfferOutcome =
  | { readonly kind: 'not-applicable' }
  | { readonly kind: 'already-offered' }
  | { readonly kind: 'already-configured' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'accepted' }
  | { readonly kind: 'write-failed' };

/**
 * Make the offer for a `.vcd` file that has just opened as text.
 *
 * [onAccepted] runs after the setting is written, to reopen the tab the
 * user was looking at in WaveCrux. Never throws.
 */
export async function offerDefaultEditor(
  host: DefaultEditorOfferHost,
  options: {
    readonly path: string;
    readonly viewType: string;
    readonly onAccepted?: () => Promise<void>;
  },
): Promise<DefaultEditorOfferOutcome> {
  if (!isVcdPath(options.path)) return { kind: 'not-applicable' };
  if (host.wasOffered()) return { kind: 'already-offered' };
  if (hasVcdAssociation(asEditorAssociations(host.effectiveAssociations()))) {
    return { kind: 'already-configured' };
  }

  // Marked before the question is asked, not after the answer: a message
  // that is dismissed, ignored or lost to a window reload still counts as
  // having asked, because this is a one-time offer and not a nag.
  await host.markOffered();

  const choice = await host.showMessage(offerMessage(), acceptLabel(), declineLabel());
  if (choice !== acceptLabel()) {
    host.log('   default editor offer: declined');
    return { kind: 'declined' };
  }

  try {
    await host.writeGlobalAssociations(
      withVcdAssociation(asEditorAssociations(host.globalAssociations()), options.viewType),
    );
  } catch (error) {
    host.log(`   default editor offer: settings not written (${String(error)})`);
    void host.showMessage(failedMessage());
    return { kind: 'write-failed' };
  }
  host.log('   default editor offer: accepted, workbench.editorAssociations updated');
  try {
    await options.onAccepted?.();
  } catch (error) {
    // The setting is written; failing to reopen the current tab only means
    // the user reopens it themselves.
    host.log(`   default editor offer: tab not reopened (${String(error)})`);
  }
  void host.showMessage(confirmedMessage());
  return { kind: 'accepted' };
}

/** The real [DefaultEditorOfferHost]. */
export function vscodeDefaultEditorOfferHost(
  context: vscode.ExtensionContext,
  log: (line: string) => void,
): DefaultEditorOfferHost {
  const configuration = (): vscode.WorkspaceConfiguration =>
    vscode.workspace.getConfiguration('workbench');
  return {
    wasOffered: () => context.globalState.get<boolean>(DEFAULT_EDITOR_OFFER_STATE_KEY) === true,
    markOffered: async () => {
      await context.globalState.update(DEFAULT_EDITOR_OFFER_STATE_KEY, true);
    },
    effectiveAssociations: () => configuration().get<unknown>('editorAssociations'),
    globalAssociations: () => configuration().inspect<unknown>('editorAssociations')?.globalValue,
    writeGlobalAssociations: async (value) => {
      await configuration().update('editorAssociations', value, vscode.ConfigurationTarget.Global);
    },
    showMessage: async (message, ...actions) =>
      await vscode.window.showInformationMessage(message, ...actions),
    log,
  };
}
