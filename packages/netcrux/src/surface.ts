/**
 * NetCrux's [surface.CruxSurface] — what this extension adds to the
 * window's CXP identity.
 *
 * A VSCode window is **one** CXP peer however many of the four extensions
 * are installed in it. What differs is what that peer can do, and that is
 * the capability list host-core composes from the registered surfaces. This
 * module is NetCrux's contribution to it — which, deliberately, is nothing.
 *
 * ### Why zero capabilities, not one
 *
 * LintCrux and SimCrux each register a `highlight` handler and one
 * capability string for it: their windows can genuinely act on an inbound
 * `request_highlight` by showing something in place. NetCrux never can —
 * by design it is a **sender only**, a CXP client that reaches out to a
 * running NetCrux *desktop*, never a surface an inbound request routes to.
 * There is no `highlight` handler below because there is nothing here to
 * offer one: a NetCrux-only VSCode window has no netlist loaded and no
 * canvas to highlight anything on.
 *
 * Registering with an empty capability list still matters, and is why the
 * extension registers at all rather than skipping it:
 * it is what keeps `registry.has('netcrux')` true (so the capabilities
 * panel shows NetCrux's row) while composing nothing into
 * `registry.capabilities()` — a window with only this extension installed
 * must not claim it can honour anything it cannot, matching
 * `host-core/test/surface.test.ts`'s fixture for a window with no highlight
 * handlers at all.
 */
import { editor } from '@crux-vscode/host-core';
import type { surface } from '@crux-vscode/host-core';

/** NetCrux's surface registration. Contributes no capabilities — see above. */
export const NETCRUX_SURFACE: surface.CruxSurface = {
  id: 'netcrux',
  extensionId: editor.cruxExtensionId('netcrux'),
  capabilities: [],
};

/**
 * Register [NETCRUX_SURFACE] in [registry]; dispose to remove it.
 *
 * The registry is host-core's and the peer identity is built from
 * `registry.capabilities()` plus `registry.has(...)`-driven listings, so
 * registering here is what makes a window with this extension installed
 * report NetCrux as present — without ever advertising a capability this
 * window cannot honour.
 */
export function registerNetCruxSurface(registry: surface.SurfaceRegistry): surface.Disposable {
  return registry.register(NETCRUX_SURFACE);
}
