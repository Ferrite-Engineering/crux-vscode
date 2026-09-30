/**
 * Desktop-peer detection: suppress CXP advertising when a desktop peer is
 * already present, and expose the handoff to it.
 *
 * See docs/implementation-map.md §2 (`desktop-detect`) and §6g (the
 * handoff over `request_open_artifact`).
 *
 * [DesktopPeerDetector] reads peers a caller already discovered — it never
 * scans the manifest directory itself — and reports
 * presence **per product**, so a window with WaveCrux desktop but no
 * LintCrux desktop still pitches LintCrux. [desktopAdvertisingDecision]
 * turns that presence into "advertise" vs. "hand off to
 * `desktopHandoffCommandId(product)`", and [instrumentDesktopPeerDetection]
 * reports every transition through a product's `TelemetryClient` as the
 * funnel's segmentation dimension.
 */
export {
  CRUX_DESKTOP_PRODUCTS,
  DesktopPeerDetector,
  type CruxDesktopProduct,
  type DesktopPeerDetectorOptions,
  type DesktopPeerPresence,
} from './detector';

export {
  desktopAdvertisingDecision,
  desktopHandoffCommandId,
  type DesktopAdvertisingDecision,
} from './advertising';

export { instrumentDesktopPeerDetection } from './instrumentation';

export {
  discoverDesktopPeer,
  type DiscoverDesktopPeerOptions,
} from './discover-peer';

export {
  openArtifactInDesktop,
  type ArtifactHandoffDeps,
  type ArtifactHandoffOutcome,
} from './artifact-handoff';

export {
  createVscodeArtifactHandoff,
  type VscodeArtifactHandoffOptions,
} from './vscode-handoff';

export {
  handoffFailedMessage,
  handoffLaunchedExternallyMessage,
  handoffOpenedInDesktopMessage,
  handoffRefusedByDesktopMessage,
} from './strings';
