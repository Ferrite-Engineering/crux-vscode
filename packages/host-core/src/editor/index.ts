/**
 * Editor integration surface — what makes a VSCode window useful to the
 * CXP mesh rather than merely present on it.
 *
 * Inbound (see `dispatch.ts` for the wiring):
 *
 * - `request_open_source` (§9.6) → `showTextDocument` with a `Selection`,
 *   after the §11 workspace-containment check. Replaces the configured
 *   shell-out in wavecrux's `dispatchCxpOpenSource`: no editor command to
 *   configure, no process to spawn, and `file_path` never reaches a shell.
 * - `request_highlight` (§9.4) → routed to whichever registered
 *   [CruxSurface] claims the element, with an explicit decline that lets
 *   the next surface try.
 * - `request_open_artifact` (CXP 1.1) → resolved through the shared
 *   workspace manifest, or the request's `path` hint, and opened in
 *   whichever editor VSCode considers the file's default — behind the same
 *   §11 containment check.
 * - `notify_selection` (§9.3) → announced to listeners, and the tab
 *   revealed *without focus* when the peer named a source file.
 *
 * Outbound: [PeerSendCommands], the "Send to <peer>" affordance — a direct
 * action on the selection, auto-targeting a lone peer and quick-picking
 * between several.
 *
 * Window-local: [revealDesignPathInEditor], the inverse of the RTL
 * annotation — a design path selected in a panel *in this window* resolved
 * through the stems index and revealed in the editor. Opt-in
 * (`edacrux.crossProbe.followWaveformSelection`) and focus-preserving.
 *
 * Two rules run through all of it and are worth stating once:
 *
 * 1. **Peer input is untrusted** (§11). Paths are resolved against the
 *    folders the user already opened, symlinks resolved *before* the
 *    containment test, and no refusal reason echoes the peer's own strings
 *    back into another app's UI.
 * 2. **Attention is requested, never seized.** Nothing here raises or
 *    focuses the VSCode window. Revealing a tab *inside* the window is a
 *    different act from the cross-process focus-stealing that is never
 *    allowed, and it is what `edacrux.crossProbe.*` governs.
 *
 * See docs/implementation-map.md §2 (`editor/*`) and §4.10/§5.
 */
export {
  vscodeCurrentSelectionSnapshot,
  vscodeEditorHost,
  vscodeUserInterface,
  type EditorDocument,
  type EditorHost,
  type EditorPosition,
  type QuickPickChoice,
  type ShowDocumentOptions,
  type UserInterface,
} from './editor-host';

export {
  CROSS_PROBE_SETTING_KEYS,
  DEFAULT_CROSS_PROBE_SETTINGS,
  EDACRUX_CONFIGURATION_SECTION,
  readCrossProbeSettings,
  type CrossProbeSettings,
} from './settings';

export {
  resolveWorkspacePath,
  type ResolvedWorkspacePath,
  type WorkspacePathOptions,
  type WorkspacePathRefusal,
} from './workspace-paths';

export {
  caretForCxpLocation,
  handleRequestOpenSource,
  openContainedSourceLocation,
  type ContainedOpenOptions,
  type CxpAckOutcome,
  type OpenSourceOptions,
} from './open-source';

export {
  handleRequestOpenArtifact,
  type OpenArtifactOptions,
} from './open-artifact';

export {
  revealDesignPathInEditor,
  type DesignPathLocation,
  type DesignPathNavigation,
  type DesignPathNavigationOptions,
  type DesignPathSourceResolver,
} from './design-path-navigation';

export { routeRequestHighlight, type HighlightRoutingOptions } from './highlight';

export {
  SelectionPresenter,
  SOURCE_ELEMENT_KIND,
  type InboundSelection,
  type SelectionPresentation,
  type SelectionPresenterOptions,
} from './notify-selection';

export {
  CRUX_SEND_COMMAND_IDS,
  PeerSendCommands,
  composeElementPathResolvers,
  isElementPathResolver,
  passThroughElementPathResolver,
  type EditorSelectionSnapshot,
  type ElementPathCandidates,
  type ElementPathChoice,
  type ElementPathResolver,
  type PeerSendCommandsOptions,
  type SendOutcome,
  type SendRefusal,
} from './send';

export {
  CxpEditorDispatcher,
  type CxpEditorDispatcherOptions,
  type CxpEditorTransport,
  type HandledCxpMessage,
} from './dispatch';

export {
  CRUX_EXTENSION_PUBLISHER,
  WAVEFORM_CUSTOM_EDITOR_VIEW_TYPE,
  cruxExtensionId,
  cruxExtensionMarketplaceUri,
  openInPeerExtensionEditor,
  type PeerExtensionOpenDeps,
  type PeerExtensionOpenOutcome,
} from './peer-extension';
