# crux-vscode

The EDACrux VSCode extension pack: WaveCrux, LintCrux, SimCrux, and NetCrux
as native VSCode extensions, cross-linked over the [CXP peer
protocol](https://edacrux.app/cxp) the same way the four desktop apps already
are. A pnpm workspace, TypeScript strict, Apache-2.0.

Extension IDs (permanent — see [Extension identity](#extension-identity)
below):

| Package | Extension ID | Displayed as |
|---|---|---|
| `packages/wavecrux` | `ferrite-engineering.wavecrux` | WaveCrux Waveform Viewer |
| `packages/lintcrux` | `ferrite-engineering.lintcrux` | LintCrux RTL Lint |
| `packages/simcrux` | `ferrite-engineering.simcrux` | SimCrux Regression Manager |
| `packages/netcrux` | `ferrite-engineering.netcrux` | NetCrux Schematic Browser |
| `packages/pack` | `ferrite-engineering.edacrux` | EDACrux Suite |

## The host-core / surface split

`packages/host-core` (`@crux-vscode/host-core`) is a shared library, **not
itself an extension**. It owns every piece of behaviour more than one
product needs, so it never gets copy-pasted across the four extensions:

| Module | Owns |
|---|---|
| `cxp/` | CXP framing, envelope, handshake, discovery, and per-peer connections |
| `window/` | the one-window election: which extension hosts the CXP peer, the status bar and the `edacrux.*` commands |
| `editor/` | routing `request_open_source` / `request_open_artifact` / `request_highlight`, the "Send to \<peer\>" command |
| `names/` | the GTKWave stems parser, the bidirectional name index, and the name resolver |
| `annotate/` | RTL annotation: signal values as editor decorations |
| `cross-probe/` | the window's peer list, activity log and directed send, for a product's Cross-Probe panel |
| `telemetry/` | the telemetry gate, envelope, Worker sender, and webview relay |
| `status/` | the shared status-bar item and capabilities panel |
| `desktop-detect/` | detecting an already-running desktop peer, suppressing advertising, and the desktop handoff |
| `l10n/` | an intentionally empty module — strings live in each module's `strings.ts` and `packages/host-core/l10n/` |
| `surface/` | the registration interface each product package implements |

**Rule:** a product package (`wavecrux`, `lintcrux`, `simcrux`, `netcrux`)
may import `@crux-vscode/host-core`; `host-core` never imports from a
product package. Each product package is a thin surface: it registers
itself with host-core (a `CustomEditorProvider` for WaveCrux, a
`DiagnosticCollection` for LintCrux, a `TestController` for SimCrux, a
send/receive command surface for NetCrux) and otherwise defers.

`packages/pack` is a manifest-only `extensionPack` — no code — that
installs all four together as **EDACrux Suite**.

See [`docs/implementation-map.md`](docs/implementation-map.md) for the full
wire-level contract (CXP framing, discovery, error codes, the stems format)
these modules implement against and the design decisions behind them, and
[`docs/webview-hosting.md`](docs/webview-hosting.md) for how the WaveCrux
Flutter web build is hosted inside a webview.

## Running the Extension Development Host (F5)

1. `pnpm install` at the repo root.
2. Open this repo in VSCode.
3. Press **F5** (or Run ▸ Start Debugging) and pick one of the launch
   configurations in [`.vscode/launch.json`](.vscode/launch.json):
   - **WaveCrux: Run Extension** / **LintCrux: Run Extension** /
     **SimCrux: Run Extension** / **NetCrux: Run Extension** — launches a
     new "Extension Development Host" window with that one extension
     loaded.
   - **EDACrux Suite: Run All Four Extensions** — launches all four at
     once, for testing cross-probe behaviour between them.

Each configuration's `preLaunchTask` runs that package's `build` script
(esbuild, [`tool/build-extension.mjs`](tool/build-extension.mjs)) first, so
F5 always debugs a fresh bundle. Set breakpoints in the package's `src/`
— the bundle carries source maps back to the original TypeScript.

No Marketplace account or publisher token is needed for local development;
`--extensionDevelopmentPath` loads the extension directly from disk.

## Workspace layout

```
packages/host-core/   shared library — see above; not an extension
packages/wavecrux/    extension — webview surface (CustomEditorProvider)
packages/lintcrux/    extension — Diagnostic/CodeAction surface
packages/simcrux/     extension — TestController/Task surface
packages/netcrux/     extension — cross-probe-send surface
packages/pack/        the EDACrux Suite extension pack manifest
tool/                 build + release scripts, shared test config
docs/                 implementation map and other repo-governing docs
```

## Common commands

Run from the repo root:

```bash
pnpm install        # install the whole workspace
pnpm -r lint         # ESLint, zero-warnings, every package
pnpm -r typecheck     # tsc --noEmit, every package
pnpm -r test           # vitest run, every package
pnpm -r build            # esbuild bundle, every extension
pnpm -r package            # bundle + vsce package -> packages/*/dist/*.vsix
node tool/verify-l10n.mjs    # confirm every locale stub is present
node tool/verify-listing.mjs  # confirm the five Marketplace listings are shippable
```

The `wavecrux` extension embeds the WaveCrux Flutter web build, which is not
committed. `pnpm --filter wavecrux run build:web` stages it from a checkout of
[WaveCrux](https://github.com/Ferrite-Engineering/wavecrux) — a sibling
`../wavecrux` by default, or the path in `CRUX_WAVECRUX_REPO` — and needs a
Flutter toolchain. See [`docs/webview-hosting.md`](docs/webview-hosting.md) §6.

## Localization

The suite ships **EN + zh-Hans + ja + ko**. Every package carries both
localization layers from its first commit:

- **`package.nls.json`** (+ `package.nls.zh-hans.json` / `.ja.json` /
  `.ko.json`) — manifest-field strings (`displayName`, `description`,
  command titles, …), referenced from `package.json` with `%key%` syntax.
- **`l10n/bundle.l10n.json`** (+ locale-suffixed siblings) — runtime
  strings, called with `vscode.l10n.t('English source string')`. VSCode
  keys these bundles by the literal source string, not an arbitrary id.

`node tool/verify-l10n.mjs` (also run in CI's `lint` job) fails if any
localized package is missing a required locale stub — a locale gap
otherwise falls back to English silently instead of failing loud.

No hardcoded user-facing strings land outside these two mechanisms — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Testing

Unit tests run under [vitest](https://vitest.dev). Because `vscode` is a
virtual module only the real extension host provides, every package's
`vitest.config.ts` aliases it to
[`tool/test/vscode-mock.mjs`](tool/test/vscode-mock.mjs) — a minimal stub
(real `l10n.t()` behaviour, auto-mocked everything else) shared by every
package's test suite. Full integration coverage against a real VSCode
instance (`@vscode/test-electron`) is not wired up yet; it lands with the
first surface that needs it.

## The listings

Each extension's own `README.md` **is** its Marketplace / Open VSX listing
body — it is not developer documentation, and it is read by strangers on a
web page rather than by contributors in a checkout. `package.json` carries
the icon, gallery banner, categories and keywords; `package.nls*.json`
carries the display name and description in all four locales.

`node tool/verify-listing.mjs` (also run in CI's `lint` job, and in the
release workflow) fails on a missing or wrongly-sized icon, an invalid
category or keyword set, a drifted per-package `LICENSE`, a **relative** link
in a listing README — the Marketplace rewrites those against this repository,
which is not where a listing reader should land — and on a
locale whose `displayName` or `description` is still byte-identical to
English. `vsce package` independently refuses to build with a missing icon.

## Extension identity

`publisher` is `ferrite-engineering` and `name` is the product name in
every `package.json` in this repo — both are **final from the first
commit**. The extension ID (`publisher.name`) is how VSCode, the
Marketplace, and Open VSX identify an installed extension across upgrades;
changing either half after publication orphans every existing install.

## License

Apache License, Version 2.0. See [`LICENSE`](LICENSE) and
[`NOTICES`](NOTICES). Contributions: see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Status

Published to the Visual Studio Marketplace and Open VSX. The five packages
share one version (`VERSION`, checked by `node tool/version.mjs --check`) and
are released together from a `vscode-v<semver>` tag by
[`.github/workflows/release.yml`](.github/workflows/release.yml). No
registry token is needed for local development, and none is stored in this
repository.
