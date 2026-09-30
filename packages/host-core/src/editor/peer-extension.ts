/**
 * Cross-*extension* contracts: the ids the four EDACrux extensions publish
 * under, the `viewType` WaveCrux's custom editor registers, and the one
 * guarded way to open a file in a sibling extension's editor.
 *
 * ### Why this is in host-core and not in the product that uses it
 *
 * The pack is four separately-installable extensions in one window, and a
 * surface package **may not import another surface package** — the rule at
 * the top of `index.ts`. But SimCrux's counterexample handoff
 * has to open a VCD in *WaveCrux's* tab, which means naming
 * `wavecrux.waveform`. Its only two options were importing WaveCrux
 * (forbidden) or re-spelling the literal (drift: the day WaveCrux renames
 * its `viewType`, SimCrux's handoff breaks silently and nothing fails a
 * build).
 *
 * So the literal lives here, where host-core already owns every other
 * cross-extension name: `desktopHandoffCommandId`, the `edacrux.*`
 * settings namespace, `CRUX_SEND_COMMAND_IDS`, the capability strings.
 * `packages/wavecrux/src/formats.ts` re-exports it rather than declaring
 * it, so there is exactly one definition and WaveCrux is still the package
 * that *contributes* the editor.
 *
 * The same argument covers [cruxExtensionId]: `ferrite-engineering.<product>`
 * was hand-spelled in two `surface.ts` files before this existed and
 * SimCrux's would have been the third.
 *
 * ### Why an "is it installed" check rather than just calling the command
 *
 * `vscode.openWith` against an unregistered `viewType` does not fall back
 * to a sensible editor; it rejects, and a rejected `executeCommand` inside
 * a `TestRun` surfaces to the user as an unexplained command failure.
 * Every product in the pack ships standalone, so "the other extension is
 * not installed" is an ordinary state and deserves a *boundary message* —
 * the same treatment `handoff.ts` gives a missing desktop app — rather
 * than a broken command. This module returns that state as a value; the
 * calling product owns the words, because only it knows what the user was
 * trying to do.
 */
import type { CruxDesktopProduct } from '../desktop-detect';

/** The Marketplace/Open VSX publisher every EDACrux extension ships under. */
export const CRUX_EXTENSION_PUBLISHER = 'ferrite-engineering';

/**
 * The full VSCode extension id for a product's editor extension, e.g.
 * `ferrite-engineering.wavecrux`.
 *
 * This is the id `vscode.extensions.getExtension` takes and the id a
 * [surface.CruxSurface] reports — one spelling for both.
 */
export function cruxExtensionId(product: CruxDesktopProduct): string {
  return `${CRUX_EXTENSION_PUBLISHER}.${product}`;
}

/**
 * The URI that opens a product extension's page in the Extensions view.
 *
 * `vscode:extension/<publisher>.<name>` is VSCode's own scheme for this
 * and `env.openExternal` resolves it **inside the window** rather than in
 * a browser. Deliberately not [status.cruxProductInstallUrl], which points
 * at `https://<product>.app`: when the missing thing is an *extension*,
 * sending the user to download a desktop app answers a question they did
 * not ask.
 */
export function cruxExtensionMarketplaceUri(product: CruxDesktopProduct): string {
  return `vscode:extension/${cruxExtensionId(product)}`;
}

/**
 * The `viewType` WaveCrux's custom editor registers (its `package.json`
 * `contributes.customEditors`).
 *
 * Public by construction: a `viewType` in a manifest is an id other
 * extensions are *expected* to pass to `vscode.openWith`. Naming it is not
 * reaching into WaveCrux's internals — its internals are the webview
 * behind it, which nothing here touches.
 */
export const WAVEFORM_CUSTOM_EDITOR_VIEW_TYPE = 'wavecrux.waveform';

/** What [openInPeerExtensionEditor] did. */
export type PeerExtensionOpenOutcome =
  /** The editor was opened. */
  | { readonly kind: 'opened'; readonly viewType: string }
  /**
   * That product's extension is not installed in this window, so there is
   * no editor to open the file in. The caller states the boundary.
   */
  | { readonly kind: 'not-installed'; readonly product: CruxDesktopProduct }
  /**
   * The open was attempted and the editor host rejected it. [reason] is
   * the stringified error, for the caller's log — never for a peer.
   */
  | { readonly kind: 'failed'; readonly reason: string };

/** Injected environment for [openInPeerExtensionEditor]. */
export interface PeerExtensionOpenDeps {
  /** Production: `vscode.extensions.getExtension(id) !== undefined`. */
  readonly isExtensionInstalled: (extensionId: string) => boolean;
  /**
   * Production: `vscode.commands.executeCommand('vscode.openWith', uri,
   * viewType, column)`. Typed as `unknown` for the uri/column so this
   * module stays free of a `vscode` import and testable in plain Node.
   */
  readonly openWith: (viewType: string) => Promise<void>;
}

/**
 * Open something in [product]'s editor extension, if that extension is
 * installed in this window.
 *
 * Never throws: a rejected open becomes a `failed` outcome, because every
 * caller here is running inside a command handler or a test run where an
 * unhandled rejection is invisible to the user and fatal to the flow.
 */
export async function openInPeerExtensionEditor(
  product: CruxDesktopProduct,
  viewType: string,
  deps: PeerExtensionOpenDeps,
): Promise<PeerExtensionOpenOutcome> {
  if (!deps.isExtensionInstalled(cruxExtensionId(product))) {
    return { kind: 'not-installed', product };
  }
  try {
    await deps.openWith(viewType);
    return { kind: 'opened', viewType };
  } catch (error) {
    return { kind: 'failed', reason: String(error) };
  }
}
