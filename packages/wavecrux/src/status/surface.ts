/**
 * WaveCrux's wiring of host-core's status surface and desktop detection.
 *
 * Everything structural is host-core's
 * ([status.registerProductStatusSurface] stands up the discovery, the
 * [desktopDetect.DesktopPeerDetector] and the telemetry instrumentation;
 * the one status-bar item and its capabilities panel belong to the elected
 * [window.CruxWindowHost], and WaveCrux's words reach it through
 * `joinCruxWindow`'s `copy` in `extension.ts`). This module contributes
 * one thing and nothing else: behaviour for the handoff command id
 * host-core names but deliberately leaves unimplemented
 * (`desktop-detect/advertising.ts`).
 *
 * It used to contain the discovery/detector/status-bar composition too;
 * that moved into host-core when LintCrux needed it verbatim,
 * which is the rule this repo exists to enforce — a second copy of shared
 * wiring is the failure, not the duplication of two lines of product copy.
 */
import * as vscode from 'vscode';
import { desktopDetect as desktopDetectApi, status } from '@crux-vscode/host-core';
import type { desktopDetect, telemetry } from '@crux-vscode/host-core';
import { WAVECRUX_PRODUCT } from './copy';

/**
 * The artifact kind WaveCrux hands over, in the shared workspace vocabulary
 * (`kCxpWaveformArtifactKind` on the Dart side). WaveCrux's own inbound
 * handler refuses anything else, which is the point of naming it here
 * rather than in host-core: the kind is the one part of a handoff that
 * belongs to the product.
 *
 * ### The contract with the receiver
 *
 * WaveCrux's handler (`dispatchCxpOpenArtifact` in the WaveCrux open core,
 * `lib/services/remote/cxp/cxp_inbound_handlers.dart`) resolves the
 * waveform through its own copy of the shared workspace, falling back to
 * the request's `path` hint, and opens it in a new tab. Asserted here by
 * `test/status-handoff.test.ts` and on the WaveCrux side by
 * `test/services/remote/cxp/cxp_open_artifact_test.dart`:
 *
 * 1. the artifact kind is `waveform`;
 * 2. the path is absolute, carries no NUL, and is spelled exactly as it is
 *    on disk — no surrounding white space. That is the floor WaveCrux holds
 *    this request to, and the only path rule: it is not rooted in the
 *    folders WaveCrux has opened, so a dump it has never seen opens;
 * 3. the path names an existing waveform file — the one in the active tab.
 */
export const WAVECRUX_ARTIFACT_KIND = 'waveform';

/** Disposable bundle returned by [registerWaveCruxStatusSurface]. */
export interface WaveCruxStatusSurface extends vscode.Disposable {
  /** Exposed for the live-verification harness and for tests. */
  readonly detector: desktopDetect.DesktopPeerDetector | undefined;
}

/** What [registerWaveCruxStatusSurface] needs from `activate()`. */
export interface WaveCruxStatusSurfaceOptions {
  readonly record: (event: telemetry.TelemetryEvent) => void;
  /** The waveform currently in the active editor, if any — the handoff's subject. */
  readonly activeWaveformUri: () => vscode.Uri | undefined;
  /** This extension's context, for the handoff's CXP identity. */
  readonly context: vscode.ExtensionContext;
  /** Diagnostics, so a discovery failure is visible rather than silent. */
  readonly log: (line: string) => void;
}

/**
 * Stand up the status surface, desktop detection, and the handoff command.
 *
 * Never throws — see [status.registerProductStatusSurface] for what a
 * machine with no resolvable application-data root gets instead.
 */
export function registerWaveCruxStatusSurface(
  options: WaveCruxStatusSurfaceOptions,
): WaveCruxStatusSurface {
  const handoff = desktopDetectApi.createVscodeArtifactHandoff({
    product: WAVECRUX_PRODUCT,
    artifactKind: WAVECRUX_ARTIFACT_KIND,
    context: options.context,
    log: options.log,
  });
  return status.registerProductStatusSurface({
    product: WAVECRUX_PRODUCT,
    record: options.record,
    log: options.log,
    handoff: async () => {
      const uri = options.activeWaveformUri();
      if (uri === undefined) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Open a waveform first — the handoff sends the file in the active tab.'),
        );
        return;
      }
      await handoff(uri.fsPath);
    },
  });
}

/**
 * Behaviour for `edacrux.openInDesktop.wavecrux`, above.
 *
 * The button only ever appears once a WaveCrux desktop **peer is running**,
 * so "hand this file to the desktop app" is a request whose precondition is
 * already established by the time it can be clicked — which is exactly why
 * it should go over CXP rather than through the OS.
 *
 * It used to call `vscode.env.openExternal` unconditionally, with a note
 * deferring `request_open_artifact` because its `design_id` derivation was
 * "owned by the Dart side". That derivation is now ported and
 * conformance-tested (`host-core/src/cxp/design-id.ts`), so this sends the
 * protocol message, publishes the waveform into the shared workspace
 * so the receiver can resolve it, and keeps `openExternal` as the fallback
 * for a peer that is gone, silent, or too old to know the message. The
 * residual it removes: a user whose OS default for `.vcd` is GTKWave used to
 * get GTKWave from a button labelled "Open in WaveCrux Desktop".
 *
 * WaveCrux contributes two things and nothing else — the artifact kind, and
 * which file is the subject. Everything else is
 * [desktopDetect.openArtifactInDesktop].
 */
