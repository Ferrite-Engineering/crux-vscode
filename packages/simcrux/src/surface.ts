/**
 * SimCrux's [surface.CruxSurface] — what this extension adds to the
 * window's CXP identity.
 *
 * A VSCode window is **one** CXP peer however many of the four extensions
 * are installed in it. What differs is what that peer can do, and that is
 * the capability list host-core composes from the registered surfaces.
 *
 * ### Why exactly one capability
 *
 * `simcrux.regression_results` — this window has a SimCrux run's results
 * loaded and can show a named test in place. That is the whole of what a
 * SimCrux-only window can genuinely do beyond
 * [surface.BASE_VSCODE_CAPABILITIES]'s `request_open_source`.
 *
 * Deliberately **not** advertised:
 *
 * - **`request_highlight`.** No `highlight` handler is registered below. A
 *   capability is a promise that the sender need not defend against
 *   `unsupported`, and advertising a kind nothing routes costs a peer a
 *   round trip to learn we lied.
 * - **Anything waveform-shaped.** SimCrux's counterexample handoff *opens*
 *   a waveform, but it does so by asking WaveCrux's editor to — this
 *   window can display a trace only when the WaveCrux extension is also
 *   installed, and that window advertises it through WaveCrux's own
 *   surface. Claiming it here would make a SimCrux-only window advertise a
 *   capability that disappears when a second extension is uninstalled.
 * - **Anything about *running* a regression.** CXP has no message kind for
 *   it, and the task provider is a VSCode affordance, not a peer service.
 */
import { editor } from '@crux-vscode/host-core';
import type { surface } from '@crux-vscode/host-core';

/** The capability string a window with the SimCrux extension advertises. */
export const SIMCRUX_RESULTS_CAPABILITY = 'simcrux.regression_results';

/** SimCrux's surface registration. */
export const SIMCRUX_SURFACE: surface.CruxSurface = {
  id: 'simcrux',
  extensionId: editor.cruxExtensionId('simcrux'),
  capabilities: [SIMCRUX_RESULTS_CAPABILITY],
};

/**
 * Register [SIMCRUX_SURFACE] in [registry]; dispose to remove it.
 *
 * The registry is host-core's and the peer identity is built from
 * `registry.capabilities()`, so registering here is what makes a window
 * with this extension installed advertise regression capabilities — and a
 * window without it not advertise them.
 */
export function registerSimCruxSurface(registry: surface.SurfaceRegistry): surface.Disposable {
  return registry.register(SIMCRUX_SURFACE);
}
