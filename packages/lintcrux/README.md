# LintCrux — RTL Lint and Waivers

**A lint report you have to leave the editor to read is a lint report nobody
reads.**

LintCrux turns your RTL lint results into ordinary VSCode diagnostics —
squiggles in your own Verilog and VHDL, entries in the Problems panel, filterable
by the engine-namespaced rule id — and lets you waive a violation from a quick
fix, writing into the same waiver file the LintCrux Pro application reads.

- **Registries:** [Marketplace](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.lintcrux)
  · [Open VSX](https://open-vsx.org/extension/ferrite-engineering/lintcrux) (Cursor, Windsurf, VSCodium, Theia)
- **Licence:** Apache-2.0 · **Home:** [lintcrux.app](https://lintcrux.app/)

---

## How it works

Run LintCrux however you already run it — locally, in a pre-commit hook, in CI —
and point the extension at the results file:

```bash
lintcrux rtl/*.sv --sarif lintcrux.sarif
```

Every unwaived violation becomes a `vscode.Diagnostic`. The flat JSON export
(`--export json --out <path>`) works too, and the format is detected from the
file's **contents**, not its extension, so a `.json` full of SARIF is read
correctly.

**The extension never shells out.** It reads a results file and nothing else.
No hidden process spawns while you type, no surprise CPU during a build, and it
works identically whether the file was produced on this machine or fetched from
a CI artifact.

## Waive from the editor, into the real waiver store

A quick fix on any violation files a waiver scoped either to that line or to
that rule in that file. It writes `.lintcrux-waivers.json` — v1 schema, same
fields, same atomic write — and the output is **byte-identical to what the
LintCrux Pro application produces**. That was verified against the real Dart waiver
store, not assumed from the schema. The squiggle disappears immediately, and
LintCrux Pro — desktop and CLI — applies the waiver as one of its own. (Managed
waivers are a LintCrux Pro feature; the free LintCrux app does not read this file.)

Set `edacrux.lint.waiverAuthor` to control the recorded author; left empty it
uses the OS user name, exactly as the application does.

## Part of a suite that talks to itself

LintCrux, WaveCrux, SimCrux and NetCrux speak **CXP**, a cross-process peer
protocol — which means this window can be a peer of a running LintCrux, NetCrux
or WaveCrux *desktop* session, not just of other extensions. Your VSCode window
is one CXP peer no matter how many of the four you install: one identity, one
manifest, one heartbeat, capabilities composed from whatever is installed.

Install the [**EDACrux Suite**](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.edacrux)
pack to get all four at once.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `edacrux.lint.resultsPath` | `lintcrux.sarif` | Where to read results from, per workspace folder (or an absolute path) |
| `edacrux.lint.waiverAuthor` | *(empty)* | Author recorded on waivers; empty uses the OS user, as the app does |
| `edacrux.crossProbe.revealSelection` | `true` | Bring the matching tab forward when a connected Crux app announces a selection |
| `edacrux.crossProbe.openSourceFocusesEditor` | `true` | Move the cursor into the editor when a peer asks to open a source location |
| `edacrux.crossProbe.followWaveformSelection` | `false` | With WaveCrux installed: reveal a signal's RTL declaration when you select it in a waveform tab in this window |

## Commands

| Command | Id |
|---|---|
| Refresh Lint Diagnostics | `lintcrux.refreshDiagnostics` |
| Triage This Design in LintCrux Desktop | `lintcrux.openTriageInDesktop` |
| Send Selection to Crux App | `edacrux.sendSelectionToPeer` |
| Highlight Selection in Crux App | `edacrux.highlightSelectionInPeer` |
| Open Capabilities Panel | `edacrux.openCapabilitiesPanel` |

## What this extension does not do — stated plainly

- **It does not run the linter.** It reads results. Running the tool is your
  build's job, and keeping it there is what makes the extension predictable.
- **It is not a triage dashboard.** What is *new* since the last run, which
  waivers are in force across the design, and how counts are trending need a run
  history — that is [LintCrux Desktop](https://lintcrux.app/)'s job, and the
  **Triage This Design in LintCrux Desktop** command is the honest handoff
  rather than a shrunken dashboard in a sidebar.
- **Restricted workspaces.** This extension declares no untrusted-workspace
  support, so it stays inert until you trust the folder.

## Telemetry

Off unless *you* have VSCode telemetry on. The extension checks
`vscode.env.isTelemetryEnabled` at send time, not once at startup.

## Localization

English, 简体中文, 日本語 and 한국어 — hand-translated, commands and settings
included.

---

## The rest of the suite

| Extension | What it is for |
|---|---|
| [WaveCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.wavecrux) | Nine protocol decoders, X-trace, waveform diff, FSM views — on VCD/FST/GHW in an editor tab |
| [SimCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.simcrux) | RTL regressions in the Test Explorer; a failing proof's counterexample opens in a waveform tab beside it |
| [NetCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.netcrux) | "What drives this signal?" on a selection, resolved through the stems index |
| [EDACrux Suite](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.edacrux) | All four, installed together |

Built by Ferrite Engineering. Apache-2.0. [edacrux.app](https://edacrux.app/)
