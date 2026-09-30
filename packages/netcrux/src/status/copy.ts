/**
 * NetCrux's content for host-core's shared status surface.
 *
 * Same seam LintCrux (`packages/lintcrux/src/status/copy.ts`) and SimCrux
 * fill: host-core owns the status-bar item, the capabilities panel, its
 * layout and its telemetry; `ProductCapabilityCopy` is where a product
 * supplies its own words.
 *
 * NetCrux's boundary reads differently from the other three, and the copy
 * says so plainly rather than pretending otherwise: LintCrux and SimCrux
 * each show *something* in the editor and point to the app for *more*.
 * NetCrux shows nothing at all — embedding a
 * schematic canvas would fight the code for space, so this extension never
 * tries. The desktop app is not an upgrade from an in-editor view; it is
 * the only view there is.
 */
import * as vscode from 'vscode';
import { status as hostStatus } from '@crux-vscode/host-core';
import type { desktopDetect, status } from '@crux-vscode/host-core';

/** NetCrux's own product id in host-core's four-product vocabulary. */
export const NETCRUX_PRODUCT = 'netcrux' as const;

/**
 * The install pitch, replacing host-core's generic default.
 *
 * Says what NetCrux Desktop *is* rather than apologising for the editor's
 * lack of a canvas: sending the user to the schematic is the
 * outcome this extension exists to produce, not a consolation prize for a
 * feature the editor could not fit.
 */
export function netCruxDesktopPitch(): string {
  return vscode.l10n.t(
    'NetCrux Desktop draws the synthesized schematic and traces the cone of influence — right-click a register in your RTL and its net opens straight on the canvas.',
  );
}

/** Handoff label shown once a NetCrux desktop peer is detected. */
export function netCruxHandoffLabel(): string {
  return vscode.l10n.t('Open in NetCrux Desktop');
}

/**
 * The capability boundary, short form. Just one note, because NetCrux's boundary
 * is not a list of things the editor does partially — it is the single fact
 * that the editor renders no schematic at all.
 */
export function netCruxCapabilityNotes(): readonly string[] {
  return [
    vscode.l10n.t(
      'There is no schematic view here by design — a canvas worth reading needs the space NetCrux Desktop gives it. This extension only sends the register or net you right-click across; the app is where it is drawn.',
    ),
  ];
}

/**
 * NetCrux's [status.ProductCapabilityCopy].
 *
 * Guarded on the product, exactly as LintCrux's and SimCrux's are: a window
 * that also has another Crux extension installed gets host-core's defaults
 * for those rows rather than NetCrux's sentences under someone else's name.
 */
export const netCruxCapabilityCopy: status.ProductCapabilityCopy = {
  desktopPitch: (product: desktopDetect.CruxDesktopProduct): string =>
    product === NETCRUX_PRODUCT ? netCruxDesktopPitch() : hostStatus.defaultDesktopPitch(product),
  handoffLabel: (product: desktopDetect.CruxDesktopProduct): string =>
    product === NETCRUX_PRODUCT ? netCruxHandoffLabel() : hostStatus.defaultHandoffLabel(product),
  capabilityNotes: (product: desktopDetect.CruxDesktopProduct): readonly string[] =>
    product === NETCRUX_PRODUCT ? netCruxCapabilityNotes() : [],
};
