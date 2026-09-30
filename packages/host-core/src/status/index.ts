/**
 * Status surface: one shared status-bar item and the capabilities panel.
 *
 * See docs/implementation-map.md §2 (`status`) and §6d (why the status bar
 * belongs to the elected window host).
 *
 * [buildCapabilitiesPanelContent] (pure data) + [renderCapabilitiesPanelHtml]
 * (pure HTML) are unit-tested directly; [StatusBarController] composes
 * them behind [StatusBarHost] / `registerCommand` / `showPanel` seams so
 * its click-handling and content-refresh behaviour are tested the same
 * way, without a live `vscode`. [vscodeStatusBarHost], [vscodeRegisterCommand]
 * and [createVscodeShowPanel] are the thin, untested real adapters — the
 * elected window host (`window/window-host.ts`) wires:
 *
 * ```ts
 * new StatusBarController({
 *   host: vscodeStatusBarHost,
 *   registerCommand: (id, handler) => vscodeRegisterCommand(context, id, handler),
 *   showPanel: createVscodeShowPanel(context),
 *   buildContent: () => buildCapabilitiesPanelContent({
 *     tier: currentLicenseTier(),
 *     installedProducts: surfaceRegistry.surfaces.map((s) => s.id as CruxDesktopProduct),
 *     desktopPresence: desktopPeerDetector.snapshot,
 *   }),
 *   onOpened: () => telemetryClient.record({ name: TELEMETRY_EVENTS.statusPanelOpened }),
 * });
 * ```
 */
export {
  StatusBarController,
  STATUS_PANEL_COMMAND_ID,
  createVscodeShowPanel,
  vscodeRegisterCommand,
  vscodeStatusBarHost,
  type StatusBarHost,
  type StatusBarItemHandle,
  type StatusSurfaceOptions,
} from './status-bar';

export {
  registerProductStatusSurface,
  type ProductStatusSurface,
  type ProductStatusSurfaceOptions,
} from './product-surface';

export {
  buildCapabilitiesPanelContent,
  cruxProductInstallUrl,
  type CapabilitiesPanelContent,
  type CapabilitiesPanelOptions,
  type CapabilityAction,
  type CapabilityLink,
  type CapabilityProductRow,
  type ProductCapabilityCopy,
} from './panel-content';

export { renderCapabilitiesPanelHtml } from './panel-html';

export {
  CRUX_PRODUCT_DISPLAY_NAMES,
  capabilitiesPanelTitle,
  defaultDesktopPitch,
  defaultHandoffLabel,
  desktopAlreadyInstalledNote,
  desktopSectionHeading,
  documentationLinkLabel,
  linksSectionHeading,
  proLinkLabel,
  proPitch,
  proSectionHeading,
  statusBarTooltip,
  suiteLinkLabel,
  tierLabel,
  tierSectionHeading,
  STATUS_BAR_TEXT,
} from './strings';
