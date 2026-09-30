# Security policy

## Reporting a vulnerability

**Please do not open a public issue.** Email
[support@ferriteengineering.com](mailto:support@ferriteengineering.com) with
`Security` in the subject line.

Useful things to include, as far as you have them: the extension and version,
the VS Code version and platform, what an attacker can do, and the smallest
input or steps that show it. A workspace folder that reproduces it is worth
more than a description of one.

## What to expect

Ferrite Engineering is a small team, so here is the honest version rather than
a service-level agreement: you will get a human acknowledgement within five
business days, and from there an explanation of what we think the impact is
and what we intend to do about it. If we disagree that it is a vulnerability
we will say so and why, rather than going quiet.

We will credit you by name in the release notes if you would like to be
credited, and we will not involve lawyers over a good-faith report.

## Where we would look first

These extensions are a client. They hold no credential, sign nothing, and
verify no licence — but they do accept input from two directions at once,
which is where the interesting reports are.

- **`host-core`'s CXP transport** — framing, envelope parsing, the handshake
  and peer identity. It accepts connections from other processes on the same
  machine. Anything that lets a peer make the extension act outside the
  workspace, or read a file the workspace does not contain, is the
  highest-value report here.
- **Peer discovery and dialling** — how a desktop app is found and how the
  extension decides to talk to it. A discovery record is untrusted input.
- **Name and path resolution** — a CXP message names a design element and the
  extension resolves it to a file and a line. A path that escapes the
  workspace root is a bug in this repository.
- **The webview host** — what HTML and what payload is loaded, and what a
  message posted from the webview can cause the extension host to do.

## Not vulnerabilities

**Licence-tier gating is not a security boundary.** The open core is
Apache-2.0 and the paid overlay's gating is a commercial mechanism running on
hardware its user controls. "I can turn on Pro features by modifying my own
machine" is not a report we will treat as a vulnerability. Anything that lets
one person affect *another* person's data or machine is.

**Settings and workspace trust.** These extensions read workspace settings, so
a malicious workspace can point them at a peer of its choosing. That is why
they respect VS Code's Workspace Trust; if you find a path where they act on
untrusted-workspace settings anyway, that *is* a report.

## Where the desktop applications live

A flaw in WaveCrux, NetCrux, LintCrux or SimCrux themselves belongs with that
product, not here — each open-core repository carries its own `SECURITY.md`
and the same address reaches us either way. Report it here if the extension is
what makes it reachable.

## Third-party engines

The desktop applications invoke external EDA engines — Yosys, GHDL, Icarus
Verilog, Verilator, Verible and others — as separate processes. These
extensions do not. A flaw inside one of those engines belongs upstream with
that project.
