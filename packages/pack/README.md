# EDACrux Suite — RTL Verification Workbench

**Four verification tools that were built to hand work to each other, installed
into one editor window.**

Waveform analysis, RTL lint, regression testing and netlist tracing — WaveCrux,
LintCrux, SimCrux and NetCrux. Each works standalone. Installed together they
become one CXP peer: a single identity your desktop Crux applications can talk
to, with capabilities composed from whatever you actually installed.

- **Registries:** [Marketplace](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.edacrux)
  · [Open VSX](https://open-vsx.org/extension/ferrite-engineering/edacrux) (Cursor, Windsurf, VSCodium, Theia)
- **Licence:** Apache-2.0 · **Home:** [edacrux.app](https://edacrux.app/)

---

## What you get

| Extension | Leads with |
|---|---|
| **[WaveCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.wavecrux)** | Nine protocol decoders with a transaction table, X-trace, waveform diff, FSM state views, switching-activity analysis, multi-signal pattern search, cocotb log correlation and GTKWave `.gtkw` import — on `.vcd`, `.fst`, `.ghw`, `.lxt` and `.lxt2`, in an editor tab. Plus signal values rendered inline in your own Verilog/VHDL. |
| **[LintCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.lintcrux)** | Lint results as Problems-panel diagnostics in your own RTL, and a quick fix that files a waiver byte-identically to LintCrux Pro's own waiver store. |
| **[SimCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.simcrux)** | `simcrux.yaml` as a Test Explorer tree, regressions as a task, the five SymbiYosys verdicts kept distinct — and a failing proof's counterexample opening in a waveform tab beside it. |
| **[NetCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.netcrux)** | "What drives this?" on a source selection, resolved through the stems index and highlighted in a running NetCrux schematic. |

## The handoff that only this suite does

A bounded proof fails in the Test Explorer. You open its counterexample and the
trace appears in a WaveCrux tab **beside** the failing property — same window,
no file dialog, no path copied out of a log. The property and the waveform that
refutes it are on screen together.

That works because the two extensions were designed against the same contract,
not because one scraped the other's output.

## The part that reaches outside the editor

The four extensions speak **CXP**, a cross-process peer protocol shared with
every Crux desktop application. That is a different thing from an in-editor
extension API — not simply a better one. An extension API connects extensions
inside one editor window. CXP connects **tools that are not in your editor**: a
running NetCrux, LintCrux or WaveCrux desktop session on the same machine is a
peer of this window, over loopback.

Concretely, and only what is actually wired today:

- Your window publishes **exactly one** CXP manifest, whichever subset of the
  four you install, with capabilities composed as the union of what those
  extensions can genuinely honour — never a capability nothing routes.
- A peer that sends `request_open_source` gets the file opened at the right
  line, and the tab brought forward without stealing your keyboard focus or
  raising the window.
- A peer that announces a selection can bring the matching tab forward.
- NetCrux turns a source selection into a `request_highlight` sent to a NetCrux
  desktop schematic.

Everything the suite does not yet route is named in each extension's own
listing, under "What this extension does not do". We would rather you find the
boundary in the README than in the tool.

## Installing

This pack installs all four. Install them individually if you only want one —
nothing here is load-bearing for the others, and no extension degrades when its
siblings are absent. It says so instead: SimCrux without WaveCrux tells you what
it would have opened and offers the link.

## Settings

Each setting is contributed by the extension that uses it, under one shared
`edacrux.*` namespace — because a VSCode window is one CXP peer however many
product extensions it hosts.

| Setting | Default | Contributed by |
|---|---|---|
| `edacrux.rtlAnnotation.enabled` | `false` | WaveCrux — inline signal values in Verilog/VHDL source |
| `edacrux.crossProbe.revealSelection` | `true` | all — bring the matching tab forward on a peer's selection |
| `edacrux.crossProbe.openSourceFocusesEditor` | `true` | all — move the cursor into the editor on `request_open_source` |
| `edacrux.crossProbe.followWaveformSelection` | `false` | all, used by WaveCrux — reveal a signal's RTL declaration when you select it in a waveform tab |
| `edacrux.lint.resultsPath` | `lintcrux.sarif` | LintCrux — where results are read from |
| `edacrux.lint.waiverAuthor` | *(empty)* | LintCrux — author recorded on waivers |
| `edacrux.sim.projectFile` | `simcrux.yaml` | SimCrux — the project config this window works against |
| `edacrux.sim.resultsPath` | *(derived)* | SimCrux — where run results are read from |
| `edacrux.sim.executable` | `simcrux` | SimCrux — the binary the regression task runs |

## Telemetry

Off unless *you* have VSCode telemetry on. Every extension checks
`vscode.env.isTelemetryEnabled` at send time, not once at startup, so turning
VSCode telemetry off turns it off here immediately.

## Localization

English, 简体中文, 日本語 and 한국어 — hand-translated across all four
extensions, commands and settings included.

## Licence

**Apache-2.0**, all four extensions and the shared host. Permissive, familiar to
corporate legal review, and no network-copyleft obligation to reason about if
your team builds internal tooling around it.

---

Built by Ferrite Engineering. [edacrux.app](https://edacrux.app/)
