/**
 * What each EDACrux extension does in a **restricted** (untrusted) VSCode
 * workspace, and what that costs the window-host election.
 *
 * ### The default is the trap
 *
 * An extension whose manifest says nothing about
 * `capabilities.untrustedWorkspaces` is **disabled** by VSCode in a
 * restricted workspace. Not degraded — disabled. Measured, on VSCode
 * 1.130.0, with all four installed as real VSIXes into a clean profile and
 * an untrusted folder open:
 *
 * ```
 * vscode.extensions.all.filter(id.startsWith('ferrite-'))  →  []
 * vscode.extensions.getExtension('ferrite-engineering.lintcrux')  →  undefined
 * ```
 *
 * — and zero CXP manifests published, no status bar, no diagnostics, and
 * nothing anywhere saying why. That is the worst first impression the
 * Marketplace path can produce, so every extension in this pack declares
 * its answer deliberately.
 *
 * ### The declarations, and the reasoning behind each
 *
 * | Product | `supported` | Why |
 * |---|---|---|
 * | `wavecrux` | `'limited'` | reads waveform bytes the user explicitly opens and `*.stems` from the workspace; renders in a strict-CSP webview. Nothing is executed. |
 * | `netcrux` | `'limited'` | reads stems, dials loopback to a peer it discovered through the shared manifest directory. Nothing is executed. |
 * | `lintcrux` | `'limited'` | reads a results file and writes a waiver file. Nothing is executed. |
 * | `simcrux` | `'limited'` | reads saved results into the Test Explorer, but its task provider builds a `ShellExecution` whose executable **and** whose config path are workspace-controlled (`edacrux.sim.executable`, `tasks.json`). That is code execution chosen by workspace content, which is the thing restricted mode exists to prevent, so every path that would start a process is refused while untrusted (`simcrux/src/trust.ts`), with a message saying to trust the folder. |
 *
 * The extension **pack** (`ferrite-engineering.edacrux`) declares
 * `true`: it has no `main`, contributes nothing, and its whole effect is to
 * make VSCode install the four. Each of those four then answers for itself.
 * A pack that reported "disabled in restricted mode" would be a lie in the
 * direction that matters — it reads as though its members were disabled too.
 *
 * ### Why SimCrux is `'limited'` and not `false`
 *
 * `false` is the one answer a user cannot see: VSCode removes the extension
 * from the window, so no tree, no status entry and no message exist to say
 * that trusting the folder would bring them back.
 * `'limited'` keeps the extension present, lets it show what it can show
 * safely (the saved results), refuses the one thing it cannot do, and
 * says so where the user is looking.
 *
 * ### The election, and `false` as a future option
 *
 * No product declares `false` today, so a restricted workspace elects the
 * same host a trusted one does. The mechanism for a product that does
 * declare it is unchanged and stays covered by tests: a trust-disabled
 * extension is `undefined` from `vscode.extensions.getExtension`, exactly
 * like one that is not installed at all, not an object with
 * `isActive === false`. `election.ts`'s "installed?" test is that same
 * `!== undefined`, so such a product is simply not a candidate and the
 * first surviving one in the order hosts, with no special case anywhere.
 */
import { CRUX_DESKTOP_PRODUCTS, type CruxDesktopProduct } from '../desktop-detect';
import { CRUX_WINDOW_HOST_ORDER } from './election';

/**
 * The values this pack uses for `capabilities.untrustedWorkspaces.supported`.
 *
 * `true` is deliberately absent: no *product* extension qualifies, because
 * every one of them reads files the workspace chose. Only the pack, which
 * reads nothing, declares `true`, and it is not a [CruxDesktopProduct].
 */
export type CruxUntrustedWorkspaceSupport = 'limited' | false;

/**
 * Each product's declaration, as the single source both the manifests and
 * `test/window/untrusted-workspaces.test.ts` are checked against.
 *
 * Five manifests cannot be diffed against each other for this the way
 * `manifest-contributions.test.ts` diffs the shared `edacrux.*` blocks —
 * these declarations are deliberately *different* per product. So the
 * check has to be against a stated intention, and this is it.
 */
export const CRUX_UNTRUSTED_WORKSPACE_SUPPORT: Readonly<
  Record<CruxDesktopProduct, CruxUntrustedWorkspaceSupport>
> = {
  lintcrux: 'limited',
  netcrux: 'limited',
  simcrux: 'limited',
  wavecrux: 'limited',
};

/**
 * Setting ids whose **workspace-provided** value VSCode must ignore in a
 * restricted workspace, per product.
 *
 * The test each entry had to pass: *can workspace content use this to
 * redirect a file read, name something to execute, or put text into the
 * user's own source?* A setting that only turns a display behaviour off,
 * or that supplies a label, fails that test and is deliberately absent —
 * `restrictedConfigurations` is not a place to list everything that could
 * conceivably matter, because every id in it is a setting a legitimate
 * project can no longer configure for its contributors.
 *
 * - **`edacrux.lint.resultsPath`** (LintCrux) — accepts an *absolute*
 *   path, so an untrusted folder can point the reader at any file on the
 *   machine and have whatever parses out of it rendered as diagnostics,
 *   attributed to file paths and line numbers the same file chose.
 * - **`edacrux.rtlAnnotation.enabled`** (WaveCrux) — the one boolean here,
 *   and it earns its place from `annotate/settings.ts`'s own rule: the
 *   first render "has to be something they asked for", and
 *   `toggleRtlAnnotationEnabled` writes it **globally** for exactly that
 *   reason. A workspace-provided `true` is the folder asking, not the
 *   user. A user who does want it keeps it: only the workspace value is
 *   ignored, never the global one.
 *
 * Deliberately **omitted**:
 *
 * - `edacrux.lint.waiverAuthor` — a name recorded into a waiver the user
 *   filed by hand. It redirects no read and names nothing executable.
 * - `edacrux.crossProbe.revealSelection`,
 *   `edacrux.crossProbe.openSourceFocusesEditor` — display toggles over
 *   messages that arrive from an already-discovered peer. A workspace can
 *   only make the window *less* eager with them.
 * - `edacrux.crossProbe.followWaveformSelection` — the one cross-probe
 *   toggle a workspace could make *more* eager, since it defaults off, and
 *   still omitted. Turning it on reveals a file the stems index named, and
 *   `resolveWorkspacePath` sits between the two, so the most an untrusted
 *   folder can achieve is opening one of its own files in a text editor —
 *   which is what `revealSelection`, already on by default and already
 *   unrestricted, does for a `source` element. It puts nothing into the
 *   user's source (unlike `rtlAnnotation.enabled`), redirects no read
 *   (unlike `lint.resultsPath`) and executes nothing.
 *
 * SimCrux restricts all three of its settings. `edacrux.sim.executable`
 * names what to run. `edacrux.sim.projectFile` and `edacrux.sim.resultsPath`
 * accept absolute paths, so an untrusted folder could otherwise choose any
 * file on the machine to parse into the test tree, which is the
 * `edacrux.lint.resultsPath` reasoning again.
 */
export const CRUX_RESTRICTED_CONFIGURATIONS: Readonly<
  Record<CruxDesktopProduct, readonly string[]>
> = {
  lintcrux: ['edacrux.lint.resultsPath'],
  netcrux: [],
  simcrux: ['edacrux.sim.projectFile', 'edacrux.sim.resultsPath', 'edacrux.sim.executable'],
  wavecrux: ['edacrux.rtlAnnotation.enabled'],
};

/**
 * The products still running in a restricted workspace — i.e. the ones
 * `vscode.extensions.getExtension` can still return a handle for.
 */
export const CRUX_RESTRICTED_MODE_PRODUCTS: readonly CruxDesktopProduct[] =
  CRUX_DESKTOP_PRODUCTS.filter(
    (product) => CRUX_UNTRUSTED_WORKSPACE_SUPPORT[product] !== false,
  );

/**
 * [CRUX_WINDOW_HOST_ORDER] with the trust-disabled products removed: the
 * order the election effectively runs in inside a restricted workspace.
 *
 * Derived rather than written out, so a future product that declares
 * `false` cannot be added to one list and forgotten in the other.
 */
export const CRUX_RESTRICTED_MODE_HOST_ORDER: readonly CruxDesktopProduct[] =
  CRUX_WINDOW_HOST_ORDER.filter(
    (product) => CRUX_UNTRUSTED_WORKSPACE_SUPPORT[product] !== false,
  );
