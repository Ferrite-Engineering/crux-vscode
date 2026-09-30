# SimCrux — RTL Regressions in the Test Explorer

**A failing formal property should not end at a log line and a file path.**

SimCrux puts your RTL regression in VSCode's Test Explorer, runs it as a task,
and — when a bounded proof fails — opens the counterexample trace in a waveform
tab **beside** the failing property. That last step is the reason this extension
exists.

- **Registries:** [Marketplace](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.simcrux)
  · [Open VSX](https://open-vsx.org/extension/ferrite-engineering/simcrux) (Cursor, Windsurf, VSCodium, Theia)
- **Licence:** Apache-2.0 · **Home:** [simcrux.app](https://simcrux.app/)

---

## What it does

**The regression is a test tree before anything has run.** `simcrux.yaml`'s
suites and tests become `TestItem`s immediately; a `results.ndjson` then
decorates them with per-test state, duration and inline failure messages. You
see the shape of the regression without waiting for it.

**Failing proof → waveform beside it.** A failing bounded proof records its
counterexample on the result row. One command opens that VCD in the WaveCrux
tab next to the test tree, so the property and the trace that refutes it are on
screen together. If WaveCrux is not installed you get a sentence saying so and a
link — not a broken command. If the trace was recorded on a CI farm and is not
on this machine, it says that instead of opening an empty editor.

**The formal verdict survives.** Five SymbiYosys outcomes collapse into VSCode's
single `TestStatus.fail`. A tree driven by status alone would render
*counterexample found* and *the engine could not decide* identically — which is
the difference between "you have a bug" and "you have no answer". The verdict is
carried into the item description, into a filterable `TestTag`, and into the
failure message. Only a genuine refutation ever offers a counterexample.

**Run it from here.** A `simcrux` task type runs `simcrux <config> --ci`, which
is what writes the results file the tree reads. Simulator output is linked:
source references like `tb.sv:128:7` and SymbiYosys trace announcements become
clickable in the terminal.

## Getting started

1. Open a workspace containing a `simcrux.yaml`.
2. Open the Test Explorer — the suites and tests are already there.
3. Run the `simcrux` task, or run your regression however you normally do.
4. Right-click a failing formal property → **Open Counterexample in WaveCrux**.

## Part of a suite that talks to itself

SimCrux, WaveCrux, LintCrux and NetCrux speak **CXP**, a cross-process peer
protocol — so this window can be a peer of a running *desktop* Crux session, not
only of other extensions. Your VSCode window is one CXP peer no matter how many
of the four you install: one identity, one manifest, one heartbeat.

Install the [**EDACrux Suite**](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.edacrux)
pack to get all four at once.

## Settings

| Setting | Default | What it names |
|---|---|---|
| `edacrux.sim.projectFile` | `simcrux.yaml` | The project config this window works against |
| `edacrux.sim.resultsPath` | *(derived)* | Empty means the config's `output.results_path`, else `results.ndjson` beside the config |
| `edacrux.sim.executable` | `simcrux` | The binary the regression task runs |
| `edacrux.crossProbe.revealSelection` | `true` | Bring the matching tab forward when a connected Crux app announces a selection |
| `edacrux.crossProbe.openSourceFocusesEditor` | `true` | Move the cursor into the editor when a peer asks to open a source location |
| `edacrux.crossProbe.followWaveformSelection` | `false` | With WaveCrux installed: reveal a signal's RTL declaration when you select it in a waveform tab in this window |

## Commands

| Command | Id |
|---|---|
| Refresh Regression Results | `simcrux.refreshResults` |
| Run Regression | `simcrux.runRegression` |
| Open Counterexample in WaveCrux | `simcrux.openCounterexample` |
| Open This Project in SimCrux Desktop | `simcrux.openHistoryInDesktop` |
| Send Selection to Crux App | `edacrux.sendSelectionToPeer` |
| Highlight Selection in Crux App | `edacrux.highlightSelectionInPeer` |
| Open Capabilities Panel | `edacrux.openCapabilitiesPanel` |

## What this extension does not do — stated plainly

- **No run history.** Flakiness detection, trends, run-to-run comparison, and
  any view of a CI fleet or simulation farm need a database rather than a file
  in a workspace. That is [SimCrux Desktop](https://simcrux.app/)'s job, and
  **Open This Project in SimCrux Desktop** is the handoff.
- **One config per window.** The CLI takes one config per run, so the test tree,
  the task and the counterexample handoff all agree on which — rather than
  quietly disagreeing.
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
| [LintCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.lintcrux) | RTL lint results as Problems-panel diagnostics, with waivers filed from a quick fix |
| [NetCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.netcrux) | "What drives this signal?" on a selection, resolved through the stems index |
| [EDACrux Suite](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.edacrux) | All four, installed together |

Built by Ferrite Engineering. Apache-2.0. [edacrux.app](https://edacrux.app/)
