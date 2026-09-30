# crux-vscode — implementation map

The contract host-core and the five packages implement, and the decisions
they inherit, each with the reason it was settled that way. Everything here
describes the code as built. The wire protocol is the CXP specification,
published at <https://edacrux.app/cxp> (PDF:
<https://edacrux.app/cxp-specification.pdf>); §3 lists the Dart reference
implementations the TypeScript peer is held to.

**Section signs.** `§1`–`§7` and `§6a`–`§6i` are sections of this document;
code comments cite it by those numbers. A section of the specification is
always written `CXP §n`.

---

## 1. Package layout

```
crux-vscode/                     pnpm workspace, TypeScript strict, Apache 2.0
  packages/host-core/            library; NOT an extension. All shared behaviour.
  packages/wavecrux/             extension — webview surface (CustomReadonlyEditorProvider)
  packages/lintcrux/             extension — Diagnostic/CodeAction surface
  packages/simcrux/              extension — TestController/Task surface
  packages/netcrux/              extension — cross-probe send surface
  packages/pack/                 ferrite-engineering.edacrux extension pack
  tool/                          build + release scripts
```

Extension IDs are permanent: `ferrite-engineering.wavecrux`, `.lintcrux`,
`.simcrux`, `.netcrux`, `.edacrux`.

## 2. host-core module boundaries

| Module | Owns |
|---|---|
| `cxp/framing` | newline framing, 1 MiB inbound cap, 8 MiB pending-write cap, `\r` strip |
| `cxp/envelope` | envelope encode/decode, required-field validation, unknown-field tolerance |
| `cxp/messages` | typed payloads for all 13 kinds + error codes |
| `cxp/auth-token` | the wire-1.2 token: CSPRNG mint, per-process default, constant-time compare (§4.4) |
| `cxp/loopback` | the host rule every dial is held to — loopback only, checked before a socket exists (§4.9) |
| `cxp/server` | TCP listener on 127.0.0.1:0, per-connection handshake gate (token required by default), dispatch |
| `cxp/client` | outbound dial, hello (with the peer's manifest token)/hello_ack, goodbye |
| `cxp/manifest-directory` | the shared manifest directory (§4.8), never an app-private container |
| `cxp/manifest-writer` | atomic publish (token included) + 30 s heartbeat of this peer's manifest, delete on stop |
| `cxp/discovery` | scan, prune, reap, tmp sweep, dedupe |
| `cxp/connector` | one link per discovered peer, loopback-only dialling, auto-subscribe on handshake, backoff, tie-break, never-redial-after-goodbye |
| `cxp/peer-host` | composes server + writer + discovery + connector; the single `deactivate` teardown |
| `cxp/peer-id` | this window's `peer_id` (§4.6) and `PeerIdentity` |
| `cxp/design-id` | port of `cxpDesignIdForPath`, held to the Dart original by a conformance test (§6g) |
| `cxp/workspace-store` | the shared `crux/cxp/workspace/<design_id>.json` documents; a `design_id` that would escape the directory names no file (§6g) |
| `cxp/one-shot` | dial, handshake, send one request, await its ack, hang up (§6g) |
| `cross-probe` | the window's peer set, activity log and directed send, as a product's Cross-Probe panel wants them (§6i) |
| `editor/dispatch` | `CxpEditorDispatcher`: inbound `request_open_source` / `request_open_artifact` / `request_highlight` / `notify_selection` → their handlers, acks back out |
| `editor/open-source` | `request_open_source` → `showTextDocument` + `Selection`; **the one** containment-checked open path (`openContainedSourceLocation`) |
| `editor/open-artifact` | `request_open_artifact` → workspace store, then `path` hint → `vscode.open` (§6g) |
| `editor/workspace-paths` | `resolveWorkspacePath`, the CXP §11 containment gate every path to the editor goes through |
| `editor/highlight` | route `request_highlight` to a registered surface |
| `editor/design-path-navigation` | design path → stems → the declaration line, revealed; the inverse of RTL annotation (§6f) |
| `editor/send` | outbound "Send to <peer>" command surface, quick-pick |
| `names/stems-parser` | GTKWave stems parser (port of `stems_parser.dart`) |
| `names/name-index` | the **bidirectional** index |
| `names/stems-index-service` | keeps the index current: initial load, then a debounced re-read of each watched `*.stems` file, bounded (§6b) |
| `names/resolver`, `names/hierarchy` | `NameResolver`: stems first, hierarchy fallback only when stems has nothing (§6b) |
| `annotate/identifiers` | HDL language-id gate + per-line identifier scanner (comments, strings, keywords stripped) |
| `annotate/model` | viewport → design paths; ambiguity shown, never guessed; `AnnotationLimits` |
| `annotate/annotations` | resolved lines + a value snapshot → the text a decoration carries |
| `annotate/value-source` | the `valuesAt(paths, cancellation)` seam the waveform fills |
| `annotate/controller` | the loop: 60 ms debounce, visible-range-only, generation discipline, profile |
| `annotate/settings` | `edacrux.rtlAnnotation.enabled`, off by default, toggled globally (§6e) |
| `annotate/vscode-annotation` | decoration types, hover + ambiguity picker, the two commands, event wiring |
| `telemetry` | `isTelemetryEnabled` gate, envelope, Worker sender, webview relay (§7) |
| `status` | one status-bar item + capabilities panel |
| `desktop-detect` | peer-present → suppress advertising; the desktop handoff over `request_open_artifact` (`artifact-handoff`, §6g) |
| `l10n` | an empty placeholder: host-core's strings go through `vscode.l10n.t()` in each module's `strings.ts`, and live in `packages/host-core/l10n/` for `tool/sync-l10n.mjs` to copy outward (§6a) |
| `surface` | the registration interface each product package implements |
| `window` | the one-window election: which extension owns the peer, the registry, the status bar and the `edacrux.*` commands (§6d) |
| `window/trust` | what each extension declares for `capabilities.untrustedWorkspaces`, and what a restricted workspace does to the election (§6e) |

Rule: a surface package may import host-core; host-core never imports a surface.

## 3. Reference implementations

The TypeScript peer is a second implementation of code that already ships in
the Dart products, and it is held to that code rather than re-derived:

| TypeScript | Dart reference |
|---|---|
| `cxp/*` | `crux_cxp` in `crux-shared` |
| `editor/*` inbound handlers | WaveCrux's `lib/services/remote/cxp/cxp_inbound_handlers.dart` |
| `names/stems-parser` | WaveCrux's `lib/services/rtl_source/stems_parser.dart` |
| `cxp/design-id` | `crux_cxp`'s `cxp_design_id.dart` (§6g) |
| `telemetry/*` | `crux_telemetry`'s `lib/src/telemetry_platform.dart` (§7) |

## 4. Wire-level surface the TypeScript peer must implement

Authority: the spec; **behaviour** matched to `crux_cxp`. Where they differ, the
Dart implementation's choice wins (two conforming implementations that disagree
in practice is the outcome to avoid). The dialling tie-break in §4.9 is the one
deliberate exception.

### 4.1 Version — send `1.2`

`CXP_PROTOCOL_VERSION = '1.2'` in `cxp/version.ts`, matching `crux_cxp`'s
`cxpProtocolVersion` in `messages/cxp_message.dart` (0.7.0 and later). 1.1
added `request_open_artifact` / `request_open_artifact_ack` and reserved the
`crux.design_id` metadata key; 1.2 added peer authentication (§4.4). Version
compatibility is major-only: `version.split('.').first === '1'`. A string with
no `.` compares whole.

**The one bend in minor compatibility.** A 1.2 server requires the token by
default, so a pre-1.2 dialler — which sends none — is refused `unauthorized`.
A 1.2 dialler still reaches a pre-1.2 server, which ignores the field. Over the
symmetric topology a mixed pair keeps one working route instead of two.
`crux_cxp` made that trade and this implementation mirrors it;
`LocalCxpServer({ requireAuthToken: false })` is the opt-out. The consequence
worth knowing: **an extension older than 1.2 cannot dial a 1.2 desktop
product** — only the product's own dial back to the extension works.

### 4.2 Framing

- One frame = UTF-8 JSON + `\n`. Strip one trailing `\r` before parsing.
- Inbound cap **1 MiB** (`DEFAULT_CXP_MAX_LINE_LENGTH`; `defaultCxpMaxLineLength`
  in `crux_cxp`), measured on the accumulated buffer *and* on a completed line;
  exceeding it is fatal to the connection.
- Outbound pending-write cap **8 MiB** (`DEFAULT_CXP_MAX_PENDING_WRITE_BYTES`;
  `defaultCxpMaxPendingWriteBytes`); a peer that stops reading gets dropped.
- Trailing data with no final newline at EOF is emitted (parity with LineSplitter).

### 4.3 Envelope

`{cxp_version, message_id, from, kind, payload}` — all five required, all
type-checked; wrong type or missing ⇒ `malformed_envelope`. Unknown envelope
fields ignored. `message_id` is a UUID.

**A frame that is not an envelope closes the connection**, in both roles, after
the `malformed_envelope` answer — as both halves of `crux_cxp` do since 0.6.0.
A browser `fetch()` to a fixed port with a `text/plain` body needs no CORS
preflight; answering the request line and reading on would dispatch an NDJSON
body as a handshake and a stream of requests. An envelope with an undecodable
payload (`malformed_payload`) or an unknown kind (`unknown_kind`) still leaves
the connection open.

### 4.4 Handshake

`hello` MUST be first. `hello.payload = {identity, token?}`.
`hello_ack.payload = {identity, in_reply_to}`. Non-hello before handshake ⇒
`handshake_required`. Major mismatch ⇒ `unsupported_version` + close; a dialling
peer fails its pending handshake. `goodbye.payload = {reason?}`; receiver closes
and does **not** redial.

**Authentication (wire 1.2).** Every product binds a fixed loopback port
(54322–54325), reachable by processes §11's trust model never included —
another local user, a sandboxed app, a container. So a server publishes a
128-bit `token` in its manifest (§4.8) and requires it in the `hello`:

- `LocalCxpServer` requires `authToken` by default; `CxpManifestWriter`
  publishes it. Both default to one lazily minted process token
  (`cxpProcessAuthToken()` in `cxp/auth-token.ts`: `crypto.randomBytes(16)` as
  32 lowercase hex digits), and `CxpPeerHost` hands one value to both.
- A dialler presents the target manifest's `token`: the connector and
  `sendOneShotRequest` pass `manifest.token` to `LocalCxpClient.connect`. No
  token ⇒ no `token` key at all, so the `hello` is the pre-1.2 frame.
- A `hello` whose token does not match (`crypto.timingSafeEqual` over UTF-16
  code units, after a length check) is answered `error_response` code
  `unauthorized`, message `A hello to this peer must carry the token published
  in its manifest.` (crux_cxp's text), `in_reply_to` the hello's `message_id`,
  and the connection is closed — before identity, presence or dispatch.
- An empty or non-string `token` on the wire is no token.
- The token never appears in an error message, a log line, or a reply. Never
  log a manifest or a decoded `hello` whole.

Interop with the real `crux_cxp` is tested by `test/cxp/dart-interop.test.ts`
against `tool/dart-conformance/cxp_peer.dart`, in both directions. It needs
Dart and the sibling `crux-shared` checkout, so it skips in CI: **run it on a
development machine before any release that touches `cxp/`.**

### 4.5 Kinds (13)

`hello`, `hello_ack`, `goodbye`, `subscribe`, `unsubscribe`, `notify_selection`,
`request_highlight`, `request_highlight_ack`, `request_open_source`,
`request_open_source_ack`, `request_open_artifact`, `request_open_artifact_ack`,
`error_response`.

Unknown kind ⇒ `unknown_kind` **and keep the connection open**. Unknown element
kind ⇒ preserve intact. Unknown error code ⇒ treat as `internal_error`. Never
send `error_response` in reply to `error_response`.

### 4.6 Identity

`{peer_id, product_name, product_version, capabilities[]}`. `capabilities` is
advisory; a receiver must still answer correctly (`unsupported`) regardless.

**`peer_id` shape.** `vscode-<workspaceHash8>-<pid>-<startedAtMillis>`
(`mintVscodePeerId` in `cxp/peer-id.ts`), deliberately not the simpler
`vscode-<stable hash of the workspace folder>`. That is a two-segment id, and
`pidFromPeerId()` in `crux_cxp/process_liveness.dart` reads the pid from the
**second-to-last hyphen segment** of the conventional
`<product>-<pid>-<startedAtMillis>` form. A two-segment id yields
`PidLiveness.indeterminate` on every Dart peer, so our manifest would only ever
be reaped by the 24 h TTL after a crash instead of immediately. Four segments
keep the workspace-stable component, stay filename-legal, and put the pid where
every Dart peer already looks — so neither the prefix nor the hash may ever
contain a hyphen. `product_name` is `VSCode` for the whole window.

### 4.7 Error codes (9)

`malformed_envelope`, `unknown_kind`, `malformed_payload`, `handshake_required`,
`unsupported_version`, `unauthorized` (1.2), `element_not_found`, `unsupported`,
`internal_error`.

### 4.8 Discovery — behaviour, including the hygiene rules

Directory (wire-level constant, **not** an app-private container):
macOS `$HOME/Library/Application Support/crux/cxp/peers`;
Windows `%APPDATA%\crux\cxp\peers`;
POSIX `${XDG_DATA_HOME:-$HOME/.local/share}/crux/cxp/peers`. Create if absent.

Manifest `<peer_id>.json` = `{identity, host, port, started_at, token?}`
(`started_at` in epoch ms; `token` since wire 1.2, absent from a pre-1.2 peer's
manifest — §4.4).

- **Atomic write**: temp then rename. `crux_io`'s scratch name is
  `<peer>.json.<micros>-<counter>.tmp` — a real orphan therefore does **not** end
  in `.json.tmp`, it ends in `.tmp`. Match any `.tmp` when sweeping, or genuine
  orphans slip through.
- **Heartbeat 30 s**, rewriting `started_at`. Non-negotiable: a peer that
  publishes once and never refreshes is silently non-conforming.
- **Scan 2 s.**
- **Prune from view** at `started_at` older than **5 min**.
- **Delete from disk** — the asymmetry that must not be re-derived:
  - own stale manifest: delete immediately;
  - foreign manifest whose **pid is provably dead**: delete immediately
    (definitive, so safe);
  - foreign stale manifest otherwise: only past **24 h** (`reapThreshold`).
  Deleting foreign files at the 5-minute mark turns laptop sleep into a
  suite-wide disconnect — on wake every product scans before any product
  heartbeats. Do not reintroduce it.
- **Orphaned `*.tmp`**: delete when `mtime` older than the 5-min cutoff.
- **Dedupe** live manifests by `product_name|host|port`, newest `started_at`
  wins — one process cannot hold two listening sockets.
- **Ignore own manifest** when scanning.
- **Delete own manifest** on clean shutdown *and* on extension `deactivate`.

### 4.9 Dialling

Retry every 5 s with backoff `0, 1, 3, 7, 15 …` skipped ticks, capped at 12
(≈1 attempt/min). Reset on successful handshake. Never dial self. Drop the link
when the manifest disappears. Surface dial failures rather than swallowing them
— a refused token is one, a `CxpHandshakeError` with code `unauthorized`.
Never redial a peer that sent `goodbye` while its manifest stays. Present the
manifest's `token` in every `hello` (§4.4).

**Dial loopback and nothing else.** The manifest directory is user-writable,
so a dialler that honoured any `host` would subscribe to, and gossip
selections to, whatever address one planted file named. The connector and
`sendOneShotRequest` both check `isCxpLoopbackHost` (`cxp/loopback.ts`:
`127.0.0.0/8`, `::1`, bracketed or not, or `localhost`) **before a socket
exists**; anything else is a `CxpDialRefusedError` dial failure with the usual
backoff, not counted in `dialAttempts`, carrying `crux_cxp`'s reason text.
What is dialled is the literal that passed the check, never a respelling.

`crux_cxp` parses a literal through the platform C library, so it also
accepts, platform-dependently, spellings such as `0127.0.0.1`, `::00001` and
`::1%lo0`. This rule refuses those — `net.isIP` rejects them, so a dialler
would hand them to `getaddrinfo`, and `inet_aton` reads a leading `0` as octal.
Every host accepted here is accepted by `crux_cxp`; `dart-interop.test.ts`
holds both that and exact agreement on every portable spelling.

Tie-break (CXP §10.5, a SHOULD): only the lexicographically smaller `peer_id`
dials (`CxpPeerConnector.shouldDial`). This is the one place the TypeScript
peer departs from `crux_cxp`, which dials symmetrically. It is safe for a
single reason, and that reason is a rule: **the server keeps accepting inbound
connections from every peer the tie-break declined to dial**, so a Dart peer
still reaches us. A flipped comparison yields zero links, not one, against
another tie-breaking peer; `dialTieBreak: false` restores symmetric dialling.

Auto-subscribe immediately after handshake (Dart sends `Subscribe` with
`cxpSubscribeToAll` before anything else can happen on the link, so no broadcast
window is missed).

### 4.10 Payload shapes used by the editor surfaces

- `notify_selection`: `{elements[], display_name?, coordinate?, metadata?}`.
  `elements` is **required and MAY be empty** — an empty array is a *cleared
  selection* (CXP §9.3). `crux_cxp` accepts it from 0.4.4, and this build
  matches, message text included. Missing, or present and not an array, is
  still `malformed_payload`: absence is not emptiness, and reading a malformed
  frame as "cleared" would blank a peer's view of the selection. **Routing**
  follows CXP §9.1.1 and §9.1.2 (§6h): a retraction bypasses element filters
  entirely, and both filters are existential over *all* referenced elements.
- `request_highlight`: `{element, coordinate?, metadata?}` → ack
  `{in_reply_to, honored, reason?}`
- `request_open_source`: `{file_path, line (1-based), column? (1-based)}` → ack
  same shape. Security (CXP §11): resolve against directories the user already
  opened; refuse anything outside with `honored:false`.
- `request_open_artifact` (1.1): `{design_id, kind, path?}` → ack same shape.
  `path` is a hint; the receiver's own workspace entry wins (§6g).
- `metadata` may carry `crux.design_id`.

## 5. What the editor replaces

`dispatchCxpOpenSource` (wavecrux, `cxp_inbound_handlers.dart`) reads
`settings.cxpEditorCommand`, defaults to empty, and answers
`honored:false, reason:'no editor command configured'`. Inside VSCode this
becomes `vscode.window.showTextDocument` with a `Selection` — no configuration,
no process spawn. The Dart shell-out stays as the non-VSCode fallback.

## 6. Stems — what the port must preserve

`StemsParser` line forms: `++ comp <id> file <path>`,
`++ module|scope <full.path> <fileRef> <line>`, `++ var <full.path> <fileRef> <line>`,
`+++ var <localName> <fileRef> <line>` (prefixed with the most recent scope).
`fileRef` = integer index into the comp table **or** an inline path. Quoted runs
are one token. `#` and `//` are comments. **Unrecognised lines are skipped
silently** — third-party stems carry extra directives and throwing on them makes
adoption painful. Keep that tolerance.

Index is **bidirectional**: `path → file+line` and
`file+line+identifier → candidate paths[]`. The second direction is what RTL
annotation needs per *visible line*, not per request. Ambiguity returns **all**
candidates for a quick-pick; never silently pick the first.

## 6a. Editor surfaces

**Settings namespace is `edacrux.*`, not a product's.** host-core is shared and a
window is *one* peer however many extensions are installed, so a window-level
toggle cannot live under one product's name. Three keys; the two that answer
another application default **on**:

| Key | Governs | Default |
|---|---|---|
| `edacrux.crossProbe.revealSelection` | bring the tab forward on `notify_selection` | on |
| `edacrux.crossProbe.openSourceFocusesEditor` | move the caret into the editor on `request_open_source` | on |
| `edacrux.crossProbe.followWaveformSelection` | reveal a signal's RTL declaration when it is selected in a waveform panel **in this window** (§6f) | **off** |

**Attention.** A message from another application never steals focus: that
rule is absolute for the cross-process case, and there is deliberately **no call
site** in host-core that could raise or focus the VSCode window. Revealing a
tab *inside* the window is a different act: `preserveFocus: true, preview: true`
for a selection announcement (a statement), `preserveFocus: false,
preview: false` for an open request (something the user just asked for in the
other app).

**Containment (CXP §11) — normative.** `request_open_source` resolves against
`workspace.workspaceFolders` only. `realpath` runs **before** the containment
test, so an in-workspace symlink pointing outside is refused, and the value
opened is the value checked. Refusal reasons never echo `file_path`, `path`,
`display_name` or an element kind — the ack is rendered in the *peer's* UI.

**Highlight routing** extends `CruxSurface` with an optional `highlight`
handler; there is no second registry. Three outcomes — `honored`, `refused`
(surface owns the element and still cannot act; routing stops), `declined`
(routing continues). `undefined` and a thrown error both mean declined.

**Command ids**: `edacrux.sendSelectionToPeer`, `edacrux.highlightSelectionInPeer`.
A single connected peer is sent to directly, with no confirmation quick-pick;
several are offered in a quick-pick, ranked by whether they advertise the kind.

**Contributions.** host-core has no manifest of its own, so every palette
command and setting it handles is contributed by the product manifests,
referencing the `crux.*` keys present in every `package.nls*.json` (internal
ids such as `edacrux.openInDesktop.<product>` are registered but not
contributed). A `contributes.commands` entry whose handler nobody registered is
a palette item that errors, and the handlers for the window-level `edacrux.*`
commands are registered by the elected window host alone (§6d). Contributing
the same id from four extensions
does *not* duplicate the Settings row — measured in §6d: VSCode keeps the first
registration, drops every later one with a warning, and shows one row — so all
four contribute the block, identically, and a test enforces that they agree.

**l10n.** `vscode.l10n.t()` resolves against the *extension's* bundle and
host-core is bundled into each one, so host-core's strings live in
`packages/host-core/l10n/` and `tool/sync-l10n.mjs` copies them outward.
`tool/sync-l10n.mjs --check` runs in CI. Add a string to host-core, run the
sync.

**Not here**: identifier → design path. `ElementPathResolver` is the seam; its
default, `passThroughElementPathResolver`, sends the selected identifier
verbatim, and `names/NameResolver` (§6b) is the stems-backed implementation.

## 6b. Names

`names/NameResolver` implements `ElementPathResolver`. The seam's return type
is `(string | ElementPathChoice)[]` so a candidate can carry its provenance
into the quick-pick; the pass-through default returns bare strings.

**Where it is wired.** NetCrux's *what drives this* command, WaveCrux's RTL
annotation and the waveform-selection follow (§6f) run on a `NameResolver`.
The window-level `edacrux.sendSelectionToPeer` /
`edacrux.highlightSelectionInPeer` commands run on the same resolvers: NetCrux
and WaveCrux each pass theirs to `joinCruxWindow`, which carries it in the
extension's `CruxWindowContribution.resolver`, so it reaches the elected host
whichever extension that is. The host asks each contributed resolver in turn
and takes the first non-empty answer; when none has one — no stems file, an
identifier stems does not know, or only LintCrux and SimCrux installed — the
selected identifier is sent verbatim, exactly as the pass-through default
does. A contributed resolver that throws is logged and skipped. The
contribution is structural and optional, so an older host that ignores it and
an older guest that omits it both still join (§6d).

**Candidate origins**, ranked, and the ordering the quick-pick shows:
`stems-declaration` (the queried file+line *is* the declaration site) →
`stems-file` → `stems-name` → `hierarchy-name`. `isExactMatch()` is true for
all three stems origins. The hierarchy is consulted **only when stems produced
nothing** — mixing exact answers with guesses would make the ranking meaningless.

**Seams**, all injected, none of them requiring a live `vscode`:
`DesignHierarchyProvider` (an empty list is the correct answer for a window
with no peer), `StemsFileWatcher`, `Scheduler`, and the file reader.
`vscodeStemsWatcher` / `vscodeStemsReader` are the thin adapters.

**Bounds** (a stems file is workspace content, not a manifest we wrote):
`maxLength` 16 MiB checked against `stat` *before* the read, `maxEntries`
500 000, and every stems `sourceFile` handed to the editor goes through
`editor/workspace-paths.ts`'s `resolveWorkspacePath` — the same CXP §11 gate a
peer-supplied path does, not a second copy.

**Conformance finding worth keeping.** Dart's `int.tryParse` parses `0x…` as
hexadecimal with no radix argument and tolerates surrounding whitespace. A
`comp 0x10` line therefore builds a *different file table* in a naive port, and
every entry referencing it resolves to a different file or to none — silently.
Found by generating `test/fixtures/stems/expected.json` from the Dart parser and
asserting the port against it, which is how that corpus must stay maintained.

## 6c. LintCrux diagnostics

**Results are read, never run.** Established by reading the product, not
assumed: a **GUI** lint run writes no results file (violations live in
`InMemoryViolationStore`; export is user-initiated), while the **CLI** is the
machine contract — `--export <sarif|json|csv|html> --out <path>`, with
`--sarif <path>` as shorthand. So the extension reads a results file and spawns
nothing. Both machine-readable shapes are accepted and the format is **sniffed
from the content**, not the extension. Default path `edacrux.lint.resultsPath`
= `lintcrux.sarif`, relative to each workspace folder (LintCrux has no
conventional output filename, so this extension names one rather than guessing).

**Severity is five onto four, and the two lossy rows say so.** `fatal`→`Error`
+ `source` `LintCrux (fatal)`; `error`→`Error`; `warning`→`Warning`;
`note`→`Information` (**not** `Hint` — a Hint has no Problems-panel entry, so a
note the app lists would vanish); `none`→`Warning` + `source`
`LintCrux (unclassified)`, matching `SarifReader._levelToSeverity`'s own
fallback. Carrying the collapsed level in `source` mirrors what the product
already does for SARIF (`properties.lintcrux.severity = "fatal"`) and leaves
the message byte-identical to the app's.

**Waivers are written in the app's format, confirmed by round-trip.**
`<project-root>/.lintcrux-waivers.json`, `version: 1`, the exact `_waiverToJson`
key set, two-space indent, no trailing newline, sibling `.tmp` + `rename`. A
`version` that is not 1 refuses the write instead of producing a file neither
build reads; absent/non-integer is v1, as `JsonFileWaiverStore._parse` has it.
Existing entries and unknown top-level keys are re-emitted **verbatim** (the
Dart round-trip drops unmodelled fields; this one does not, so appending from
the editor never truncates a newer build's file). Verified by writing a file
with the extension and loading it with the real `JsonFileWaiverStore` +
`WaiverMatcher`: both waivers load, matching agrees line-for-line, and a Dart
re-save is byte-identical. **Known divergence**: the Dart matcher resolves rule
ids through an alias table that lives in a Flutter asset, so a waiver written
against a renamed rule's old id keeps matching in the app and stops matching
here. Showing a violation waived elsewhere is the safe direction.

**Boundary.** Editor = violations in the file you are editing. App = triage
across the design, new-vs-old, waiver management, trends. `handoff.ts` is the
only place a user meets it: peer present → `edacrux.openInDesktop.lintcrux`;
no peer → one non-modal boundary message + `https://lintcrux.app`. The handoff
itself is `request_open_artifact` over CXP with `openExternal` as the fallback,
the same mechanism as the other three products (§6g).

**Capabilities.** `lintcrux.diagnostics` only. Deliberately not
`request_highlight`: no `highlight` handler is registered, and the surface
fixture in `host-core/test/surface.test.ts` and the real surface are the same
list.

**Shared in host-core**: `status/registerProductStatusSurface` (discovery +
detector + instrumentation + handoff command registration — things every
product needs identically; the status bar itself belongs to the elected window
host, §6d) and `status/cruxProductInstallUrl` (so a boundary message and the
capabilities panel cannot point at different URLs). All four products call
the first and supply only their handoff behaviour.

## 6d. One window, one peer — the multi-extension election

**The constraint.** All four extensions run in one extension-host process,
and esbuild bundles a **separate copy of host-core into each VSIX**. There is
no shared module instance, so nothing a window may have exactly one of can be
constructed independently by four extensions. Without the election, with all
four installed:

```
[error] Activating extension ferrite-engineering.netcrux failed due to an error:
[error] Error: command 'edacrux.openCapabilitiesPanel' already exists
```

LintCrux activates; **the other three do not**. `registerCommand` throws on a
duplicate id and the throw escapes `activate()`.

**The mechanism** — `host-core/src/window/`, called identically by all four:

```ts
const membership = hostCore.window.joinCruxWindow({ context, product, surface, copy, record, log });
return membership.api;                                  // becomes `exports`
export function deactivate() { return hostCore.window.deactivateCruxWindow(); }
```

Every extension returns a `CruxWindowApi` from `activate()`. Exactly one
reports `isWindowHost()`; it builds the `SurfaceRegistry`, the `CxpPeerHost`,
the `CxpEditorDispatcher`, the ONE status bar and the `edacrux.*` command
handlers. The others `join()` it with their surface, their panel words and,
where they have one, their name resolver (§6b).

**Activation.** All four activate on `onStartupFinished`, and that carries
weight: `activate()` is where each extension joins the election, so an
activation event tied to opening a file would leave a window with no CXP peer
until that file was opened.

**Election, three rules in order:**

1. **An incumbent wins**, whatever the priority order says — any sibling whose
   `exports` reports `isWindowHost()`. Synchronous, no activation. This is what
   makes a mid-session install correct.
2. Otherwise the first installed product in `CRUX_WINDOW_HOST_ORDER`
   (`lintcrux, netcrux, simcrux, wavecrux` — extension id ascending) hosts. At a
   cold start nobody is an incumbent yet, so all four reach the same answer from
   the same static list: no race, no lock, no handshake. WaveCrux last is a free
   bonus of alphabetical order and worth keeping: it is the only VSIX with a
   Flutter payload.
3. A winner that **cannot** host — activation failed, or it is an older build
   exporting nothing recognisable — is excluded and the election re-runs. Every
   guest excludes the same candidate for the same reason, so they converge.

Hosting is never **handed over** mid-session: a handover would have to move a
listening socket and a published `peer_id` between bundles, and rule 1 already
prevents a second host appearing.

**`extensionDependencies` was rejected.** It guarantees activation order and
also makes the named extension a hard *install* dependency — installing
LintCrux would silently install WaveCrux's 7 MB VSIX. The ordering guarantee
comes from `getExtension(id).activate()` instead.

### What VSCode actually does — measured, VSCode 1.130.0, macOS 15

| Behaviour | Evidence |
|---|---|
| `exports` **throws** for a not-yet-activated extension | `Error: Extension 'ferrite-engineering.lintcrux' is not known or not activated` — crashed a probe extension's `activate()` |
| `isActive` is `true` even when `activate()` **threw** | the three failed activations above all reported active, with `exports === undefined` |
| `getExtension(id).activate()` wakes an extension **with no firing activation event** | `_doActivateExtension ferrite-engineering.lintcrux, activationEvent: 'api', root cause: ferrite-engineering.simcrux`, with LintCrux's `activationEvents` set to `onLanguage:cobol` |
| a duplicate `contributes.commands` id is **dropped, first wins** | `[info] Command 'edacrux.openCapabilitiesPanel' already registered by LintCrux RTL Lint` — one palette entry, no error |
| a duplicate `contributes.configuration` id is **dropped whole, first wins** | `[warning] Cannot register 'edacrux.crossProbe.revealSelection'. This property is already registered.` — with a deliberately different `default`, the first-scanned extension's value was the effective one |
| an **uninstall** does not deactivate | the window kept the uninstalled surface's capability until reload; VSCode completes the removal on reload |
| an extension that declares **no** `capabilities.untrustedWorkspaces` is **disabled** in a restricted workspace | with none of the four declaring it: `extensions.all` carried none of them, `getExtension` returned `undefined` for all four, and **zero** CXP manifests were published — silently. Fixed in §6e |
| a **trust-disabled** extension is `undefined` from `getExtension` | not a handle with `isActive === false`. So restricted mode looks exactly like "not installed" to the election, and no code path in `election.ts` is special |
| an `extensionPack` manifest with no `main` **never settles** `activate()` | `ferrite-engineering.edacrux`: handle returned, `isActive` false, `activate()` unresolved after 30 s, in a trusted *and* an untrusted workspace |

### Where `edacrux.crossProbe.*` lives, and why

**All four manifests, identically.** The measured answer is above: the first
registration of a configuration id wins, later ones are dropped with a warning,
and the Settings UI shows exactly **one** row. So declaring in all four is safe,
and it is the only arrangement where *every standalone install is correct* — a
LintCrux-only user obeys these settings and must be able to find them. Because
the surviving declaration is chosen by scan order,
`host-core/test/window/manifest-contributions.test.ts` requires the four
declarations to be **byte-identical** and to match `DEFAULT_CROSS_PROBE_SETTINGS`,
so which one wins cannot matter. The same rule covers
`edacrux.openCapabilitiesPanel`, `edacrux.sendSelectionToPeer` and
`edacrux.highlightSelectionInPeer`: contributed by all four, *handled* by the
elected host alone.

## 6e. Workspace trust — what each extension does in a restricted workspace

VSCode disables an extension that declares no
`capabilities.untrustedWorkspaces` whenever the folder is untrusted. Left
undeclared, the whole pack is inert in a restricted workspace with nothing
anywhere saying why — the worst possible first impression for someone who has
just installed it from the Marketplace. Each manifest answers deliberately, and
`host-core/src/window/trust.ts` is the single statement the five manifests are
checked against (`test/window/untrusted-workspaces.test.ts`).

| Extension | `supported` | `restrictedConfigurations` |
|---|---|---|
| `wavecrux` | `"limited"` | `edacrux.rtlAnnotation.enabled` |
| `netcrux` | `"limited"` | — |
| `lintcrux` | `"limited"` | `edacrux.lint.resultsPath` |
| `simcrux` | `false` | — |
| `edacrux` (pack) | `true` | — |

**SimCrux is the only `false`**, and the only one that executes anything:
`tasks.ts` builds a `ShellExecution` from `edacrux.sim.executable` and a config
path, both workspace-controlled. The other three read files and render.

**The pack declares `true`** because it has no `main` and contributes nothing;
reporting it as disabled would read as though its members were, which is false
for three of the four.

**Two settings are restricted, and only two.** `edacrux.lint.resultsPath`
accepts an *absolute* path, so an untrusted folder could otherwise choose any
file on the machine and have it parsed into the Problems panel.
`edacrux.rtlAnnotation.enabled` is the one boolean that qualifies: it puts text
into the user's own source, and `toggleRtlAnnotationEnabled` writes it
**globally** precisely because it is a reading preference rather than a
property of a repository. The `edacrux.crossProbe.*` toggles and
`edacrux.lint.waiverAuthor` are deliberately not restricted — a workspace can
only make cross-probing less eager, and an author name redirects nothing.

**The election survives it** because a trust-disabled extension is `undefined`
from `getExtension`, exactly like an uninstalled one. SimCrux is simply not a
candidate, no `activate()` is attempted on it, and the first surviving product
in `CRUX_WINDOW_HOST_ORDER` hosts. The one changed outcome is a
SimCrux + WaveCrux window: SimCrux hosts it when trusted, WaveCrux when not. A
SimCrux-only window has no peer host in a restricted workspace, which is
correct — nothing is left to host one.

## 6f. The cross-probe loop, both directions

The two halves of one gesture: an inbound `request_highlight` reaches the
waveform panel, and a selection in the waveform panel navigates to the RTL
line.

### Inbound — `request_highlight` reaches the waveform

Route, end to end, with no parallel implementation anywhere on it:

```
peer → CxpPeerHost → CxpEditorDispatcher → routeRequestHighlight
     → wavecrux CruxSurface.highlight → WebviewHighlightTarget
     → postMessage → EditorHostBridge._dispatch → dispatchCxpHighlight
```

`dispatchCxpHighlight` is the CXP *server's* own handler in the WaveCrux app —
the same one a desktop peer reaches — so `signalGroupsProvider.addSignals`,
`selectedSignalProvider.select` and `cursorStateProvider.placePrimary` are
reached through one implementation with a third front door.

**Correlation.** One request, one answer, correlated on the posted frame's
`message_id` via the ack's `in_reply_to` — unlike `value-query.ts` next door,
which correlates on a `query_id` because *its* query stands and is answered
again on every cursor move.

**The answer → ack mapping**, and every arm is a decision:

| The app said | Outcome | Reason on the wire |
|---|---|---|
| `honored: true` | `honored` | — |
| `honored: false` | `refused` | `the element is not in the loaded waveform` |
| `error_response` | `refused` | `the waveform panel could not highlight it` |
| nothing in 5 s | `refused` | `the waveform panel did not answer` |
| no panel open / not yet delivered | `refused` | `no waveform is open in this window` |
| an element kind this surface does not own | `declined` | routing continues |

Two of those are worth the argument.

**A timeout is `refused`, never `declined`.** `declined` falls through, and with
nothing else handling waveform elements the peer would read "no installed Crux
surface handles this element" — false, and unactionable, when a surface took the
request and went quiet. `HIGHLIGHT_ACK_TIMEOUT_MS` is 5 s — a shade above the
value query's 4 s, because a highlight may have to load a signal the viewer
never held and can fall back to resolving the design's waveform out of the
shared workspace (§6g) before it answers; and bounded at all because, unlike a
value query answered into decorations nobody waits on, this one holds a
**peer's** socket open.

**"No panel open" is also `refused`**, for the same reason, and what makes that
affordable is the **kind gate**: `WAVECRUX_HIGHLIGHT_ELEMENT_KINDS` claims only
`signal`, `instance`, `net`, `port`, `scope`, `marker` — mirroring the arms of
`_dispatchCxpHighlight` in `cxp_inbound_handlers.dart`. Anything else, including
an unrecognised kind a later peer minted, is declined before the panel is
consulted, so this surface can never answer for another product's elements. (The
Dart list also includes `source`; this one deliberately does not — inside VSCode
a source element names a file the *editor* owns, not the waveform panel.)

**Reasons are never echoed from the app.** The Dart reasons interpolate the
element path and kind the peer sent (`element not found: top.x`), and the ack is
rendered in the *peer's* UI — the CXP §11 hop `editor/strings.ts` refuses to
make. The app's own words go to the output channel as a diagnostic; the peer
gets one of `wavecrux/src/strings.ts`'s localized phrases.

**Capability.** `request_highlight`, declared on the surface that handles it.
Composition stays honest because the string lives on the *surface*: a window
without WaveCrux registers no such surface and advertises no `request_highlight`
(pinned in `wavecrux/test/surface.test.ts` and `host-core/test/surface.test.ts`).
It is advertised whenever the extension is installed rather than only while a
waveform is open — a capability describes what the surface can act on, and
"is a tab open right now" is state a manifest refreshed every 30 s could not
track honestly anyway.

### Outbound — a waveform selection navigates to the RTL line

```
webview selection → EditorHostBridge.postCxp(notify_selection)
     → panel router → parseWebviewSelection → designPathOf
     → editor.revealDesignPathInEditor → NameResolver.sourceLocationFor
     → openContainedSourceLocation  (the SAME open path request_open_source uses)
```

`openContainedSourceLocation` is shared with `handleRequestOpenSource` rather
than copied. CXP §11 containment is the last place in this codebase that should
have two implementations, and the two callers differ in exactly one thing — how
the editor is presented — so that is the parameter.

The path has already been through `resolveWorkspacePath` once inside
`sourceLocationFor` (a stems file is workspace content and can name
`../../../.ssh/id_ed25519`); the second pass is kept because "the value checked
is the value opened" has to hold *at the open site*, not two calls upstream.

**Which elements name a design path**: `signal`, `instance`, `net`, `port`,
`scope`. `marker` is excluded although the emitter sends it — a marker's path is
a letter, and looking one up would miss or, worse, hit a one-letter signal. A
cleared selection resolves to nothing, which is correct: deselecting is not a
request to navigate.

**Focus**: `preserveFocus: true, preview: true`, always, not configurably. The
user is driving a panel in this window; taking the keyboard away from it would
break the next scroll.

**Which editor group.** `showTextDocument` with no `viewColumn` uses the
*active* editor group — and a waveform panel **is** an editor tab, so the source
would open on top of the panel the user just clicked in, leaving the second
click of the gesture with nothing to click on. `ShowDocumentOptions.viewColumn`
carries the group, and `revealColumnBeside()` in `wavecrux/src/extension.ts`
picks the group the panel is *not* in.

**`edacrux.crossProbe.followWaveformSelection`, default off.** The other two
`crossProbe.*` toggles are responses to an act in *another application* — one
deliberate cross-probe per message — and default on. This one fires on every
selection change inside a panel the user is already looking at, and most of
those clicks are reading, not a request to go anywhere. Opt-in for the same
reason `edacrux.rtlAnnotation.enabled` is: a feature that changes what the
user's own source view shows has to be something they asked for. Declared
byte-identically in all four manifests (`manifest-contributions.test.ts`).

**Not in `restrictedConfigurations`**, and it is the one cross-probe toggle a
workspace could make *more* eager. Turning it on can at most reveal a file
already inside that workspace — `resolveWorkspacePath` is between the stems
entry and the editor — which is what the already-default-on `revealSelection`
does for a `source` element. It puts nothing into the user's source (unlike
`rtlAnnotation.enabled`) and redirects no read (unlike `lint.resultsPath`).

## 6g. The artifact link, both directions

`request_open_artifact` keys on a `design_id`, and `cxp_design_id.dart` is a
fully specified deterministic function — normalize and strip a trailing
separator; resolve to the containing directory; canonicalize it against the
filesystem resolving symlinks, else lexically; first 16 hex of the sha256. Its
dartdoc's "all four apps MUST use this one helper" is a warning about
*divergence*, not a claim that only Dart can compute it. So the TypeScript peer
carries a second copy, and drift is a failing test.

### The port, and what holds it to the original

`cxp/design-id.ts` is that port. Four places where a natural TypeScript
version diverges, each found by running both implementations rather than by
reading:

| Trap | What happens if you miss it |
|---|---|
| Dart's `p.normalize('/a/b/')` is `/a/b`; Node's keeps the slash | `/a/b/` and `/a/b` are two designs here, one design there |
| `p.canonicalize` case-folds under the **Windows** style only — *not* on macOS, whose volume is case-insensitive but whose path style is posix | folding on darwin merges two designs the reference keeps apart |
| `fs.realpathSync` is a JS walk; `.native` is the `realpath(3)`/`GetFinalPathNameByHandle` Dart calls | Windows casing differs |
| the fallback canonicalizes the **directory**, not the input | a not-yet-created file gets its own token instead of its folder's |

**The conformance test, and what makes it fail.**
`test/cxp/design-id-conformance.test.ts` runs ONE shared corpus
(`test/fixtures/design-id/corpus.json`) through **both** implementations, in
three layers:

1. **Live cross-run** — spawns the real Dart `cxpDesignIdForPath` through
   `tool/dart-conformance/design_id_tokens.dart`, over the same materialised
   temp tree and with the same working directory, and requires byte-identical
   tokens for every case. This is the only layer that can catch a symlink,
   existence or case-folding drift. It needs a Dart toolchain and a sibling
   `crux-shared` checkout; crux-vscode CI has neither, so it logs a warning
   rather than skipping quietly.
   `--packages=<crux-shared>/.dart_tool/package_config.json` is what lets the
   harness import the unmodified reference implementation with no `pub get`
   and **no file written into that repository**.
2. **Committed goldens** — `expected.json`, generated by that same Dart
   implementation for the corpus's `lexical` cases (paths under a directory
   that cannot exist, so the answer is machine-independent on POSIX). Runs
   everywhere, CI included.
3. **Relational invariants** — file ≡ its folder, trailing separator
   irrelevant, symlink ≡ target, distinct folders distinct, shape
   `[0-9a-f]{16}`. No Dart needed.

Mutating the port (16 → 14 hex) fails 12 of 21 cases across layers 1 and 2.
The Windows lexical rules, which no macOS or Linux run reaches, are covered
separately in `test/cxp/design-id.test.ts` against values produced by
`package:path`'s own `windows` context.

The corpus's sharpest case is one nobody would write by hand: a **directory
that does not exist** cannot be identified as one, so the derivation takes its
*parent*. `/x/design` and `/x/design/top.v` therefore disagree until the
directory exists. Both implementations do it; a port that guessed
directory-ness from the absence of an extension would break the join.

### Inbound — the editor answers `request_open_artifact`

Resolution order is the reference implementation's: **the receiver's own**
workspace-manifest entry for `(design_id, kind)` first, the request's `path`
hint second. Both go through `resolveWorkspacePath` — the same CXP §11 gate, not
a second copy — because a workspace document is a user-writable file in a
user-writable directory, so "we resolved it ourselves" is not a provenance
claim. The test that matters most is the one where the *manifest* names
`~/.ssh/id_ed25519`; a containment check applied only to `path` would miss it
entirely.

**The `design_id` itself is contained too**, before any file is touched.
The store turns the id into `<workspace>/<design_id>.json`, and the id came
off a socket: `../../evil` walks out of the directory, and an absolute id names
a file anywhere. `CxpWorkspaceStore.isValidDesignId` — `crux_cxp`'s rule,
answer for answer — accepts an id only when it is non-empty, carries no NUL,
and the file it names stays strictly inside the workspace directory (resolved
lexically, as `p.isWithin` does). An invalid id is a design with no records:
reads are empty, `resolveArtifact` finds nothing, and `upsertArtifact` writes
nothing anywhere. It is containment, not a parse — `designs/cdc_capture` still
keys a file one level down. `dart-interop.test.ts` runs the shared corpus in
`test/fixtures/cxp-containment/` through both implementations.

**No artifact-kind allow-list.** LintCrux opens only `source` and WaveCrux
only `waveform` because each app has one thing it can do with a file. An
editor's answer to "open this file" does not depend on what the sender calls
it, and `EditorHost.openArtifact` goes through `vscode.open`, so a `.vcd`
still lands in WaveCrux's custom editor when that extension is installed and
in the text editor when it is not. Containment, not vocabulary, is what makes
it safe.

`request_open_artifact` is therefore a **base window capability**
(`BASE_VSCODE_CAPABILITIES`), not a surface's: a window with no Crux surface
at all genuinely honours it.

### Outbound — the desktop handoff goes over CXP, not through the OS

Handing a product's project file to `env.openExternal` gives the path to
whatever the OS thinks owns the extension: a user whose default `.vcd` handler
is GTKWave would get GTKWave, from a button labelled "Open in WaveCrux
Desktop". So `desktop-detect/artifact-handoff.ts` asks the running app first:

| What happened | What we do | Why |
|---|---|---|
| ack `honored: true` | nothing more | the app opened it |
| ack `honored: false` | report the refusal, **no** OS fallback | the app is running and has just said no; handing it to the OS then would launch whatever owns the extension — the exact defect being avoided |
| `error_response` | `openExternal` | a build older than 1.1 answers `unknown_kind`; the request was not refused, it was not understood |
| no ack in time | `openExternal` | no answer is not an answer |
| no peer / unreachable | `openExternal` | launching the app is still right when it is not running |

The UI says which happened. "Opened in WaveCrux Desktop." and "WaveCrux
Desktop is not answering, so this was opened with your system's default
application for it." are different sentences because they are different
events, and the second is the one that explains why the user is looking at
GTKWave. A peer's `reason` never reaches a toast (CXP §11); it goes to the
output channel.

**The publish is not politeness.** The handoff upserts the artifact into
`crux/cxp/workspace/<design_id>.json` *before* sending, because LintCrux's
`_dispatchRequestOpenArtifact` resolves through its workspace store alone and
never reads the `path` hint — without the upsert a running LintCrux would
refuse a project file the user is looking at. WaveCrux's handler does fall
back to the hint.

Each product contributes exactly two things: its **artifact kind**
(`waveform` for WaveCrux; `source` for the other three, matching what their
own Dart producers write) and **which file is the subject**. SimCrux's is the
one worth stating: the `simcrux.yaml`, so the id is rooted at the project
directory the desktop app keys its dumps by — never the output directory a VCD
lands in.

`cxp/one-shot.ts` (dial, handshake, send, await, hang up) is shared with
NetCrux's `sendHighlightToNetCrux`, which runs on it, and
`desktop-detect/discover-peer.ts` generalises `discoverNetCruxPeer`.

## 6h. The subscription predicate (CXP §9.1.1, §9.1.2)

`subscriptionMatches` implements both rulings, in step with `crux_cxp`:

- **CXP §9.1.1** — `path_prefix` is existential over *all* referenced elements,
  not a test of `elements[0]`. `elements` is in the sender's own order, so a
  positional test would make routing depend on click order and drop a
  multi-select spanning two scopes whenever the user clicked the other scope
  first.
- **CXP §9.1.2** — a `notify_selection` with an empty `elements` array is a
  retraction and bypasses element filtering entirely, so a filtered subscriber
  can learn that a selection it *was* told about has been withdrawn. The
  exemption is deliberately narrow: that kind, an empty array, nothing else —
  a `request_open_source` still satisfies no element-filtered subscription.

## 6i. The cross-probe panel, both directions

WaveCrux's Cross-Probe dock tab, running inside the webview.
`wavecrux/lib/app.dart` instantiates `cxpLifecycleBridgeProvider` only when
`!kIsWeb && (linux || macOS || windows)`, and `kIsWeb` is true in a webview, so
the Dart CXP server never starts there. **That gate is correct** — a webview
has no `dart:io` and cannot bind a TCP socket. The window's peer is the
extension host, so the panel's peer list, activity log and send have to come
from it: on desktop the panel reads `cxpPeersProvider`, `cxpEventLogProvider`,
`cxpDialFailuresProvider` and `cxpServerProvider.isRunning`, and inside a
webview all four are structurally empty.

### The two frames, and why there are exactly two

| Direction | Kind | Carries |
|---|---|---|
| host → webview | `crux.cross_probe_state` | `online`, `peers` (CXP §8.1 `PeerIdentity` JSON verbatim), `unreachable`, `events`, optional `send_failure` |
| webview → host | `crux.cross_probe_send` | `peer_id` + a CXP §9.3 `notify_selection` payload under `selection` |

One constant per direction in `host_bridge_messages.dart`, one `_dispatch`
branch (the state frame; the send is outbound and has none), routed by the same
`onCxpEnvelope` claimant chain as the value query and the highlight bridge.
**No second `postMessage` listener and no second channel** — a webview delivers
to every registered listener, so a second one would double the telemetry relay
and split CXP routing.

**Peer presence and an activity log have no CXP message**, which is why they are
`crux.*` and not a protocol addition. Everything that *does* have a CXP shape
keeps it: a peer is a `PeerIdentity` sent as its own JSON and decoded by
`PeerIdentity.fromJson`, and the send is a `notify_selection` decoded on this
side by `decodeCxpMessage` — one hardened decoder, not a second one written by
hand.

**One snapshot, not four pushes.** The four values are one consistent state;
four independent frames would let the panel render one instant's peer list
against another's event log.

### Correlation — a third scheme, and it earns its place

`value-query.ts` correlates on `query_id` (one standing query, many answers);
`highlight-bridge.ts` on `in_reply_to` (one request, one answer). A cross-probe
send is neither: **the state push is the ack**. A delivered send is already an
event in the next snapshot, so nothing extra has to be said. Only a *refusal*
needs an id, because the panel shows it as a toast and the host re-pushes its
whole snapshot on every peer change — without one the same toast would re-fire
on each push. So `send_failure` carries `in_reply_to`, the Dart side shows each
id once, and the refusal is deliberately **sticky** on the host rather than
one-shot (clearing it would race the host's own pushes).

`notify_selection` has no ack in CXP (CXP §9.3 — a statement, not a request),
so `delivered` is as far as an outcome can honestly go. Inventing "the peer
acted on it" would be worse than reporting only what happened.

### Where each half lives

`host-core/src/cross-probe/` — `CrossProbeHost` composes what the window
already knew: `CxpPeerHost.isRunning`, the union of `discovery.peers` and
`server.connectedPeers`, `connector.lastDialFailures`, and a 50-entry log fed
from `server.onPresence` and `server.onInbound`. **Push, never poll**: it
listens to the four sources the window already runs and starts no timer and no
second filesystem scanner (`desktop-detect`'s rule). In host-core and not in
the WaveCrux package because the panel is WaveCrux's but "who are this window's
peers, what has crossed the wire, and send this to that one" is not — the other
three products have the same panel in their own apps.

`wavecrux/src/webview/cross-probe.ts` — the wiring to the waveform webview:
frame encode/decode and `WebviewCrossProbeBridge`, one per waveform tab with
the same `open()`/`close()` lifetime as its `WebviewValueSource` and
`WebviewHighlightTarget`. It **subscribes in the constructor and gates only
posting on `open()`**, because the window's CXP peer starts on the 750 ms
settle delay — long after a tab can exist — and that subscription is what
carries the first real snapshot down when it does.

`CruxWindowApi.crossProbe?()` is how a guest reaches it, and it is **optional
and additive**: `exports` may be an older sibling's bundle, and the api's
standing rule is that refusing to join is always worse than joining. What it
returns is a **stable relay** built in `CruxWindowHost`'s constructor, not the
`CrossProbeHost` itself — that cannot exist until the peer starts, and four
plain functions cross a bundle boundary where an `instanceof` never could. The
window host emits one snapshot explicitly after `peer.start()`, because
`online` flips there and nothing in `CrossProbeHost` observes the bind.

The Dart half — how the panel controller chooses between the desktop CXP
providers and the host's snapshot — is `WaveCruxCrossProbePanelController` in
the WaveCrux open-core repo, `lib/features/remote/widgets/cross_probe_panel.dart`.

## 7. Telemetry

**`form_factor` is `vscode`** for every event this pack sends
(`TELEMETRY_FORM_FACTOR` in `telemetry/vocabulary.ts`). `kIsWeb` is true in a
webview, so a bucket inferred from it would report every extension user as
`web`, destroying both the adoption signal and the web-vs-desktop split.
`vscode` is therefore a first-class bucket in `crux_telemetry`'s
`kTelemetryFormFactors` and in the ingest service's accepted set (an unknown
bucket rejects the whole batch), and WaveCrux maps `EditorHostKind.vscode` to
it.

Extension-side: the gate is `vscode.env.isTelemetryEnabled`, read live when an
event is recorded and again at flush (`telemetry/gate.ts`,
`telemetry/client.ts`), so VSCode's own telemetry setting is the only switch
and withdrawing consent drops the queue. The host owns the one sender and the
envelope; the webview posts a `crux.telemetry` event descriptor that
`TelemetryClient.recordFromWebview` sanitizes, and never gains a sender.
