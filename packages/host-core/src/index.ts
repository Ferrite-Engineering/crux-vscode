/**
 * @crux-vscode/host-core — shared behaviour for the EDACrux VSCode
 * extensions. Not itself an extension; every product package
 * (wavecrux, lintcrux, simcrux, netcrux) imports from here.
 *
 * Rule: a surface package may import host-core; host-core never imports
 * from a surface package.
 *
 * Module boundaries (docs/implementation-map.md §2):
 *   annotate/       RTL annotation: signal values as editor decorations
 *   cross-probe/    the window's peer list, activity log and directed send
 *   cxp/            CXP protocol: framing, envelope, handshake, discovery, connector
 *   editor/         open-source / highlight routing, "Send to <peer>"
 *   names/          GTKWave stems parser + bidirectional name index
 *   telemetry/      isTelemetryEnabled gate, envelope, Worker sender, webview relay
 *   status/         shared status-bar item + capabilities panel
 *   desktop-detect/ desktop-peer presence detection + handoff
 *   l10n/           shared localization bundle access
 *   surface/        the registration interface product packages implement
 *   window/         the one-window election: which extension owns the peer
 */
export * as annotate from './annotate';
export * as crossProbe from './cross-probe';
export * as cxp from './cxp';
export * as editor from './editor';
export * as names from './names';
export * as telemetry from './telemetry';
export * as status from './status';
export * as desktopDetect from './desktop-detect';
export * as l10n from './l10n';
export * as surface from './surface';
export * as window from './window';
