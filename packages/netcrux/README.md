# NetCrux — Netlist Driver Tracing

**"What drives this?" is a question you ask with the cursor already on the
signal.**

Select an identifier in Verilog, SystemVerilog or VHDL, run one command, and
NetCrux resolves that name through the design's stems index and highlights it in
a running NetCrux schematic — so you can follow the cone of influence back from
exactly where you were reading.

- **Registries:** [Marketplace](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.netcrux)
  · [Open VSX](https://open-vsx.org/extension/ferrite-engineering/netcrux) (Cursor, Windsurf, VSCodium, Theia)
- **Licence:** Apache-2.0 · **Home:** [netcrux.app](https://netcrux.app/)

---

## What it does

One gesture: **What Drives This? (NetCrux)**, on the editor context menu for
Verilog, SystemVerilog and VHDL.

1. Takes your selection — or the word under the caret.
2. Resolves it to a hierarchical element path through the **stems index**, the
   same source-to-netlist mapping the rest of the suite uses. When a bare
   identifier matches more than one path, it **asks** rather than guessing.
3. Finds a running NetCrux desktop peer over CXP and sends it
   `request_highlight`.

Every branch is answered rather than left to fail silently: no selection, no
candidate in the stems index, a peer that never acknowledges, a peer whose
socket is unreachable, and a peer that declines all say what happened. If no
NetCrux is running but it is installed, the extension **offers to launch it**.
If it is not installed, you get one honest sentence and one link.

## Why this reaches outside your editor

This is the part an in-editor extension API structurally cannot do. **CXP** is a
cross-process peer protocol, so the target is a real NetCrux desktop
application, on your machine, over loopback — with its full schematic canvas,
its layout engine, and your netlist already loaded. The editor is where you ask
the question; the schematic is where the answer is worth looking at.

Discovery is on demand. There is no background poller added by this extension:
the manifest directory is scanned once, at the moment you invoke the command.

Your VSCode window is one CXP peer no matter how many of the four extensions you
install — one identity, one manifest, one heartbeat, capabilities composed from
whatever is installed.

Install the [**EDACrux Suite**](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.edacrux)
pack to get all four at once.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `edacrux.crossProbe.revealSelection` | `true` | Bring the matching tab forward when a connected Crux app announces a selection |
| `edacrux.crossProbe.openSourceFocusesEditor` | `true` | Move the cursor into the editor when a peer asks to open a source location |
| `edacrux.crossProbe.followWaveformSelection` | `false` | With WaveCrux installed: reveal a signal's RTL declaration when you select it in a waveform tab in this window |

## Commands

| Command | Id |
|---|---|
| What Drives This? (NetCrux) | `netcrux.whatDrivesThis` |
| Send Selection to Crux App | `edacrux.sendSelectionToPeer` |
| Highlight Selection in Crux App | `edacrux.highlightSelectionInPeer` |
| Open Capabilities Panel | `edacrux.openCapabilitiesPanel` |

## What this extension does not do — stated plainly

- **It does not draw schematics in VSCode.** There is no netlist canvas in this
  extension and no netlist loaded in this window. It is a **sender**: it turns a
  source selection into a question and routes it to a tool that can answer it.
  If you want the schematic, you want [NetCrux Desktop](https://netcrux.app/) —
  and this extension will offer to open it for you.
- **It advertises no inbound capabilities**, because a NetCrux-only VSCode
  window genuinely has nothing to highlight. It will not accept a request it
  cannot honour just to look well-connected.
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
| [SimCrux](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.simcrux) | RTL regressions in the Test Explorer; a failing proof's counterexample opens in a waveform tab beside it |
| [EDACrux Suite](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.edacrux) | All four, installed together |

Built by Ferrite Engineering. Apache-2.0. [edacrux.app](https://edacrux.app/)
