/**
 * The production wiring of [openArtifactInDesktop] — the four real
 * dependencies, filled in once.
 *
 * `artifact-handoff.ts` is pure so its five outcomes can be tested without a
 * socket or an extension host. This is the adapter that gives it a real
 * peer scan, a real workspace store, a real identity and a real
 * `openExternal`, so a product package supplies only the two things that are
 * genuinely its own: its **artifact kind** and the **path** to hand over.
 * Four copies of this wiring is the copy-pasted-TypeScript failure host-core
 * exists to prevent.
 */
import * as vscode from 'vscode';
import { createVscodePeerIdentity } from '../cxp/peer-id';
import { sharedCxpManifestDirectory } from '../cxp/manifest-directory';
import { CxpWorkspaceStore, sharedCxpWorkspaceDirectory } from '../cxp/workspace-store';
import { openArtifactInDesktop, type ArtifactHandoffOutcome } from './artifact-handoff';
import { discoverDesktopPeer } from './discover-peer';
import type { CruxDesktopProduct } from './detector';

/** What [createVscodeArtifactHandoff] needs from a product's `activate()`. */
export interface VscodeArtifactHandoffOptions {
  /** The desktop product to hand off to. */
  readonly product: CruxDesktopProduct;
  /** The artifact kind this product hands over — `waveform`, `source`, … */
  readonly artifactKind: string;
  /** The hosting extension's context, for the peer identity's version. */
  readonly context: vscode.ExtensionContext;
  /** Diagnostics, into the product's output channel. */
  readonly log: (line: string) => void;
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const manifest: unknown = context.extension.packageJSON;
  if (typeof manifest === 'object' && manifest !== null) {
    const version = (manifest as { version?: unknown }).version;
    if (typeof version === 'string') return version;
  }
  return '0.0.0';
}

/**
 * A handoff function for one product: give it an absolute artifact path and
 * it does the CXP send, the shared-workspace publish and the `openExternal`
 * fallback.
 *
 * Never throws. A machine with no resolvable application-data root loses
 * peer discovery and the workspace publish — and still gets the OS handoff,
 * which is precisely the behaviour that shipped before this existed.
 */
export function createVscodeArtifactHandoff(
  options: VscodeArtifactHandoffOptions,
): (artifactPath: string) => Promise<ArtifactHandoffOutcome> {
  return async (artifactPath: string) => {
    let workspace: CxpWorkspaceStore | undefined;
    let discoverPeer: () => Promise<undefined> | ReturnType<typeof discoverDesktopPeer> = () =>
      Promise.resolve(undefined);
    try {
      const manifestDirectory = sharedCxpManifestDirectory();
      discoverPeer = () => discoverDesktopPeer({ product: options.product, manifestDirectory });
      workspace = new CxpWorkspaceStore({
        workspaceDirectory: sharedCxpWorkspaceDirectory(),
      });
    } catch (error) {
      options.log(`   handoff: CXP discovery unavailable (${String(error)})`);
    }

    return await openArtifactInDesktop({
      product: options.product,
      artifactKind: options.artifactKind,
      artifactPath,
      selfIdentity: createVscodePeerIdentity({
        workspaceFolder: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        productVersion: extensionVersion(options.context),
      }),
      discoverPeer,
      ...(workspace !== undefined ? { workspace } : {}),
      openPath: async (fsPath) => {
        await vscode.env.openExternal(vscode.Uri.file(fsPath));
      },
      showMessage: (message) => {
        void vscode.window.showInformationMessage(message);
      },
      log: options.log,
    });
  };
}
