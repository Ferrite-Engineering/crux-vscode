# LintCrux results fixtures

## `getting-started.sarif`

Provenance: copied verbatim from the LintCrux product repository,
`lintcrux/examples/getting-started/report.sarif` — a real
`lintcrux --sarif` run over the getting-started example (verible +
verilator, two SARIF `run`s, `%SRCROOT%` base id, repo-relative
`artifactLocation.uri`).

It is here rather than hand-written on purpose: the one thing the parser
must not do is drift from what the product actually emits, and a fixture
we authored ourselves would drift with us. Re-copy it if the product's
SARIF shape changes; do not edit it in place.
