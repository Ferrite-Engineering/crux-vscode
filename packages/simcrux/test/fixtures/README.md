# SimCrux fixtures

## `riscv-formal-demo.simcrux.yaml`

Provenance: the suite/test skeleton of the SimCrux product repository's
`simcrux/examples/riscv-formal-demo/simcrux.yaml`, a shipped, working demo
project that needs no SymbiYosys, no solver and no riscv-formal checkout.
Trimmed to the keys the shallow config reader looks at, plus a
representative sample of the ones it has to step over: nested `riscv:` /
`formal:` sub-maps, a `pass_fail:` block, and a quoted scalar containing a
`#` (`pass_string: 'DONE (PASS'`) that a naive comment stripper corrupts.

## `riscv-formal-demo.results.ndjson`

**Hand-authored**, unlike LintCrux's SARIF fixture, and deliberately so:
producing a real one would mean running a Flutter binary in CI. It is
written against the exact schema `StreamingResultsWriter._encodeRow`
emits — `type` / `id` / `name` / `suite` / `simulator` / `status` /
`runtime_ms` / `started_at` / `finished_at` / `exit_code` /
`waveform_path` / `stdout_path` / `stderr_path` / `failure_message` /
`kill_signal` / `metrics` — bracketed by the `meta` and `summary` lines,
with `riscv.formal.*` metric keys and verdict spellings taken from
`RiscvFormalDriver`'s constants and `RiscvFormalVerdict.wireName`.

It carries the demo's seven cases, **one per verdict**:

| id | `TestStatus` | `riscv.formal.verdict` | trace |
|---|---|---|---|
| `insn/insn_add_pass` | `pass` | `PASS` | — |
| `insn/insn_sub_counterexample` | `fail` | `FAIL` | yes |
| `pc_fwd/pc_fwd_unknown` | `fail` | `UNKNOWN` | — |
| `reg/reg_timeout` | `fail` | `TIMEOUT` | — |
| `causal/causal_error` | `fail` | `ERROR` | — |
| `liveness/liveness_no_outcome` | `fail` | `NO_OUTCOME` | — |
| `cover/cover_multi_trace` | `pass` | `PASS` | yes (cover, 2) |

Five rows share one `TestStatus.fail`. That is the whole reason this
fixture exists: any change that lets those five render identically in the
tree fails a test against this file.

`config_path` and every `*_path` are absolute paths under `/work/…` that do
not exist on any machine running these tests — which is what makes the
"this ran somewhere else" and "the trace is not here" paths assertable
without fabricating a filesystem.
