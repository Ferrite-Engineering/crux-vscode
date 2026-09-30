# WaveCrux — Waveform Analysis for RTL

**The waveform is not the hard part. Working out what the waveform means is.**

WaveCrux puts a full debug-analysis layer in a VSCode tab: nine protocol
decoders with a transaction table, X-trace to find where an unknown came from,
waveform diff across two runs, FSM state views, and switching-activity
analysis. Then it connects that tab to the rest of your toolchain — including
the tools that are not running inside your editor.

Open a `.vcd`, `.fst`, `.ghw`, `.lxt` or `.lxt2` and it opens here, in an
editor tab, beside the RTL that produced it.

- **Registries:** [Marketplace](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.wavecrux)
  · [Open VSX](https://open-vsx.org/extension/ferrite-engineering/wavecrux) (Cursor, Windsurf, VSCodium, Theia)
- **Licence:** Apache-2.0 · **Home:** [wavecrux.app](https://wavecrux.app/)

---

## The analysis layer

Everything below ships in the extension. No account, no key, no separate
download — it is the WaveCrux open-core build, embedded.

| | |
|---|---|
| **Protocol decoders** | Nine, decoding into a transaction table rather than a squashed bus row: SPI, I²C, UART, AXI4-Lite, APB, AHB-Lite, Wishbone, SPI-Flash (stacked on SPI), and a RISC-V instruction-trace decoder. |
| **X-trace** | Walk an `x` backwards to the driver that produced it, instead of scrolling until you spot the transition. |
| **Waveform diff** | Two runs side by side, with the divergence found for you. "It passed yesterday" becomes a timestamp. |
| **FSM state visualization** | State encodings rendered as states, and the transition you did not expect made visible. |
| **Switching activity** | Which nets are actually toggling, and how much — the input to a power conversation, or to finding a runaway clock. |
| **Multi-signal pattern search** | Search for a *condition across several signals*, not one value on one signal. |
| **cocotb log correlation** | Line up a cocotb run's log against the trace it produced. |
| **GTKWave `.gtkw` import** | Bring your existing saved sessions across. Signal order, groups, and radices survive the move. |

Rendering, navigation, formatting and netlist search are table stakes and are
built on [wellen](https://github.com/ekiwi/wellen) compiled to WebAssembly —
the same parsing engine several other open-source viewers use. We are not
claiming to draw a nicer square wave. The claim is everything above.

## Built for the editor, not merely hosted in it

- **Real editor integration.** A `CustomReadonlyEditorProvider`, so waveforms
  are tabs: they split, they go to a second editor group, they restore with
  the window, and `workbench.editorAssociations` works on them.
- **Live theme bridge.** The viewer follows your VSCode theme — light, dark and
  high-contrast — with a WCAG contrast floor enforced on signal colours, so a
  high-contrast theme does not produce an unreadable trace.
- **Large files stream.** Bytes reach the viewer in 4 MiB chunks rather than as
  one allocation, with a 256 MiB ceiling. Cold start measured at 246–406 ms.
- **RTL value annotation** — *the feature that is better here than on the
  desktop.* Turn it on and signal values from the waveform render as inline
  decorations in your own Verilog/VHDL, following the waveform cursor. The
  desktop app needs a second pane for this; in an editor, your source is
  already open at the line you are reading. Only stems-exact name matches are
  annotated and an ambiguous name is shown as *ambiguous* rather than guessed.
  Off until you opt in (`edacrux.rtlAnnotation.enabled`).

## Connected to tools that are not in your editor

WaveCrux, LintCrux, SimCrux and NetCrux speak **CXP**, a cross-process peer
protocol. That is the part an in-editor extension API cannot do: CXP reaches
the desktop applications, on the same machine, over loopback — so a running
NetCrux or LintCrux desktop session is a peer of this window.

Your VSCode window is **one** CXP peer no matter how many of the four
extensions you install: one identity, one manifest, one heartbeat, capabilities
composed from whatever is installed. A peer that asks this window to open a
source location gets the file opened at the right line.

Install the [**EDACrux Suite**](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.edacrux)
pack to get all four at once.

## Getting started

1. Open any `.vcd`, `.fst`, `.ghw`, `.lxt` or `.lxt2` file in the explorer.
2. It opens in a WaveCrux tab. Add signals from the hierarchy and navigate.
3. Optional: run **EDACrux: Toggle RTL Value Annotation** with a Verilog or
   VHDL file open to see cursor values inline in your source.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `edacrux.rtlAnnotation.enabled` | `false` | Inline signal values in Verilog/VHDL source, following the waveform cursor |
| `edacrux.crossProbe.revealSelection` | `true` | Bring the matching tab forward when a connected Crux app announces a selection |
| `edacrux.crossProbe.openSourceFocusesEditor` | `true` | Move the cursor into the editor when a peer asks to open a source location |
| `edacrux.crossProbe.followWaveformSelection` | `false` | Reveal a signal's RTL declaration in the editor when you select it in a waveform tab in this window |

## Commands

| Command | Id |
|---|---|
| Open Waveform Panel | `wavecrux.openPanel` |
| Toggle RTL Value Annotation | `edacrux.toggleRtlAnnotation` |
| Send Selection to Crux App | `edacrux.sendSelectionToPeer` |
| Highlight Selection in Crux App | `edacrux.highlightSelectionInPeer` |
| Open Capabilities Panel | `edacrux.openCapabilitiesPanel` |

Send and Highlight take the identifier under your cursor to a running Crux app: one connected app is sent to directly, several are offered in a quick pick.

## What this extension does not do — stated plainly

- **FSDB is refused, with an explanation.** `.fsdb` requires Synopsys libraries
  that cannot be redistributed. The extension tells you that instead of failing
  obscurely.
- **NetCrux → waveform highlight is not wired yet.** WaveCrux's surface
  advertises *no* highlight capability rather than accepting the request and
  dropping it. When the webview command lands, the capability is advertised in
  the same change.
- **Restricted workspaces.** This extension declares no untrusted-workspace
  support, so it stays inert until you trust the folder.
- **Pro and Enterprise features are not bundled.** No AI debug advisor, no SV
  assertion visualization, no collaborative viewing, no Stage Pro custom widget
  SDK. Those live in [WaveCrux Desktop](https://wavecrux.app/) and are linked,
  never quietly disabled here.
- **The desktop app is still the deeper tool** for multi-tab workspaces, the
  Stage instrument panel, interactive VCD over a pipe, and the WCP remote
  control API.

## Telemetry

Off unless *you* have VSCode telemetry on. The extension checks
`vscode.env.isTelemetryEnabled` at send time, not once at startup, so turning
telemetry off in VSCode turns it off here immediately.

## Localization

English, 简体中文, 日本語 and 한국어 — hand-translated, commands and settings
included.

---

## The rest of the suite

| Extension | What it is for |
|---|---|
| [LintCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.lintcrux) | RTL lint results as Problems-panel diagnostics, with waivers filed from a quick fix |
| [SimCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.simcrux) | RTL regressions in the Test Explorer; a failing proof's counterexample opens in a waveform tab beside it |
| [NetCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.netcrux) | "What drives this signal?" on a selection, resolved through the stems index |
| [EDACrux Suite](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.edacrux) | All four, installed together |

Built by Ferrite Engineering. Apache-2.0. [edacrux.app](https://edacrux.app/)
