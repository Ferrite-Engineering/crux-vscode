/**
 * LintCrux's [surface.CruxSurface] — what this extension adds to the
 * window's CXP identity.
 *
 * A VSCode window is **one** CXP peer however many of the four extensions
 * are installed in it (one process, one socket, one `peer_id`, one
 * manifest). What differs is what that peer can do, and that is the
 * capability list host-core composes from the registered surfaces. This
 * module is LintCrux's contribution to it and nothing else.
 *
 * ### Why exactly one capability
 *
 * `lintcrux.diagnostics` — this window has RTL lint results and can show
 * them in place. That is the whole of what a LintCrux-only window can
 * genuinely do beyond [surface.BASE_VSCODE_CAPABILITIES]'s
 * `request_open_source`, which every window can do.
 *
 * Deliberately **not** `request_highlight`: no `highlight` handler is
 * registered below, and a capability is a promise to the sender that it
 * need not defend against `unsupported`. Advertising a message kind
 * nothing routes would be a lie that costs a peer a round trip. It is also
 * exactly what `host-core/test/surface.test.ts` asserts — a window with
 * only LintCrux advertises lint capabilities and nothing waveform-shaped —
 * and the fixture there and the surface here are now the same list, on
 * purpose.
 */
import { editor } from '@crux-vscode/host-core';
import type { surface } from '@crux-vscode/host-core';

/** The capability string a window with the LintCrux extension advertises. */
export const LINTCRUX_DIAGNOSTICS_CAPABILITY = 'lintcrux.diagnostics';

/**
 * LintCrux's surface registration.
 *
 * `extensionId` is composed by host-core's [editor.cruxExtensionId] rather
 * than spelled here: the publisher prefix is a suite-wide fact, and SimCrux
 * needs to *resolve* the same id to ask whether a sibling
 * extension is installed. Two spellings of one publisher is the drift that
 * function exists to prevent.
 */
export const LINTCRUX_SURFACE: surface.CruxSurface = {
  id: 'lintcrux',
  extensionId: editor.cruxExtensionId('lintcrux'),
  capabilities: [LINTCRUX_DIAGNOSTICS_CAPABILITY],
};

/**
 * Register [LINTCRUX_SURFACE] in [registry]; dispose to remove it.
 *
 * The registry is host-core's and the peer identity is built from
 * `registry.capabilities()`, so registering here is what makes a window
 * with this extension installed advertise lint capabilities — and a window
 * without it not advertise them.
 */
export function registerLintCruxSurface(registry: surface.SurfaceRegistry): surface.Disposable {
  return registry.register(LINTCRUX_SURFACE);
}
