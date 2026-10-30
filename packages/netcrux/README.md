# NetCrux — Netlist Driver Tracing

**See a Yosys netlist as a schematic without leaving the editor, and ask "what
drives this?" with the cursor already on the signal.**

Open a Yosys JSON netlist and NetCrux draws it as a schematic next to your RTL:
hierarchy, search, Cone View, and a click on any element to open its source line.
Too big for the preview, or you want the Pro features? One click hands it to the
NetCrux desktop app. Select an identifier in Verilog, SystemVerilog or VHDL, run
one command, and NetCrux resolves that name through the design's stems index and
highlights it in a running NetCrux schematic.

- **Registries:** [Marketplace](https://marketplace.visualstudio.com/items?itemName=ferrite-engineering.netcrux)
  · [Open VSX](https://open-vsx.org/extension/ferrite-engineering/netcrux) (Cursor, Windsurf, VSCodium, Theia)
- **Licence:** Apache-2.0 · **Home:** [netcrux.app](https://netcrux.app/)

---

## Schematic preview

Right-click a `.json` netlist (the file Yosys writes with `write_json`) in the
Explorer or on its tab and choose **Open Schematic Preview**. You can also
choose **Open With...** on the file and pick **NetCrux Schematic Preview**, or
use the preview button in the title bar of a netlist open as text.

It is never the default editor for `.json`: double-clicking a file still opens
text, and the command checks the start of the file and tells you when it is not
a Yosys netlist.

In the preview:

- **Navigate the hierarchy**: push into an instance, pop back out, and filter
  the tree.
- **Search** instances, cells and nets by substring, glob or regex, and trace
  fan-in and fan-out one step at a time.
- **Select** an element for its properties, then **Cone View** to see only
  what drives it.
- **Go to Source in Editor**, from the right-click menu on the schematic or the
  Inspector, opens the RTL behind an element at its line. Relative paths are
  looked for next to the netlist and in your open folders, and a path written on
  another machine is matched by its file name. Only files inside the folders you
  have opened are shown.
- It follows your VS Code theme, reloads when a synthesis run rewrites the
  netlist, and works offline: the viewer is bundled, nothing is fetched.

The viewer is the same NetCrux web viewer that runs in a browser. Elaborating
Verilog, SystemVerilog or VHDL into a netlist stays in the desktop app.

### Open in NetCrux

**Open in NetCrux**, in the preview's title bar and on the right-click menu,
hands the netlist to the desktop app. It opens in a running NetCrux; if none is
running but one is installed, it starts it with the netlist; if none is
installed, it says so and links to the [download page](https://netcrux.app/).
The desktop app has the Pro features and reads a netlist from disk, so it takes
a design of any size.

### Large netlists

The preview reads the whole netlist into the editor's memory, so it stops at
**32 MB** by default. Above that it does not load the file; it offers **Open in
NetCrux** instead. Raise the limit, up to 256 MB, with
`netcrux.preview.maxFileSizeMB`.

## What the cursor question does

**What Drives This? (NetCrux)**, on the editor context menu for Verilog,
SystemVerilog and VHDL.

1. Takes your selection — or the word under the caret.
2. Resolves it to a hierarchical element path through the **stems index**, the
   same source-to-netlist mapping the rest of the suite uses. When a bare
   identifier matches more than one path, it **asks** rather than guessing.
3. Finds a running NetCrux desktop peer over CXP and sends it
   `request_highlight`.

Every branch is answered rather than left to fail silently: no selection, no
netlist index in the workspace at all, a name the index does not contain, a peer
that never acknowledges, a peer whose socket is unreachable, and a peer that
declines all say what happened. If no
NetCrux is running but it is installed, the extension **offers to launch it**.
If it is not installed, you get one honest sentence and one link.

### The netlist index

The command needs a `*.stems` file in the workspace folder. Without one it says
so, and says how to make one: in WaveCrux Desktop, **Tools > Generate RTL
Stems**, then save the file inside the folder you have open. Run the command
again and it is picked up.

### Language ids

The menu entry appears on files whose language is Verilog, SystemVerilog or
VHDL. A fresh editor with no HDL language extension opens `.v` and `.sv` as
Plain Text, so this extension registers those three language ids for `.v` `.vh`
`.sv` `.svh` `.vhd` `.vhdl` (and nothing else: no grammar, no highlighting).
An HDL language extension you install keeps providing the highlighting, and
VSCode merges the registrations by id. If another extension also claims `.v`,
for example a Coq one, choose with `files.associations` in your settings.

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
| `netcrux.preview.maxFileSizeMB` | `32` | The largest netlist, in MB, the schematic preview loads; a larger one is offered to NetCrux Desktop instead (1 to 256) |
| `edacrux.crossProbe.followWaveformSelection` | `false` | Contributed by WaveCrux, so it appears once WaveCrux is installed: reveal a signal's RTL declaration when you select it in a waveform tab in this window |

## Commands

| Command | Id |
|---|---|
| Open Schematic Preview | `netcrux.openSchematicPreview` |
| Open in NetCrux | `netcrux.openInNetCrux` |
| What Drives This? (NetCrux) | `netcrux.whatDrivesThis` |
| Send Selection to Crux App | `edacrux.sendSelectionToPeer` |
| Highlight Selection in Crux App | `edacrux.highlightSelectionInPeer` |
| Open Capabilities Panel | `edacrux.openCapabilitiesPanel` |

## What this extension does not do — stated plainly

- **It does not elaborate your RTL.** The preview draws a netlist that already
  exists. Running Yosys over Verilog, SystemVerilog or VHDL, the Pro features
  and anything past the preview's size limit are the job of
  [NetCrux Desktop](https://netcrux.app/), and the extension offers to open it
  for you.
- **It advertises no inbound capabilities**, because a NetCrux-only VSCode
  window genuinely has nothing to highlight. It will not accept a request it
  cannot honour just to look well-connected.
- **Restricted workspaces.** It runs with limited support in a folder you
  have not trusted, and nothing is held back: it reads the source, stems and
  netlist files you open, draws a netlist with its own bundled viewer, and
  sends selections to a NetCrux app already running on this machine. It never
  runs a program named by workspace content.

## Telemetry

Off unless *you* have VSCode telemetry on. The extension checks
`vscode.env.isTelemetryEnabled` at send time, not once at startup. The viewer
inside the preview sends nothing of its own and checks for no updates.

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
