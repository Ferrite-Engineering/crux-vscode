/**
 * The CXP element kind (§8.2) NetCrux's "what drives this" command sends.
 *
 * ## `net`, not `signal` or `instance` — established by reading the receiver
 *
 * CXP §8.2's element vocabulary is open (`signal`, `scope`, `instance`,
 * `net`, `port`, …) and advisory only, so the right answer is whatever
 * NetCrux's own inbound handler actually does with each kind — not which
 * word sounds closest to "a register in RTL". Read directly from the
 * NetCrux desktop source
 * (`netcrux/lib/services/remote/cxp/cxp_inbound_handler.dart`,
 * `_applySignalLike`):
 *
 * - `ElementKind.net` is resolved **exactly**: `_resolveNetSelection` looks
 *   the trailing path segment up in `module.nets[netName]` on the loaded
 *   netlist and, on a hit, selects and highlights the *whole net* — every
 *   wire segment the net's bits are drawn on. This is the primary path, not
 *   a fallback.
 * - `ElementKind.instance` and `ElementKind.signal` are resolved through
 *   `_localToSelection`, which for `instance` expects the trailing segment
 *   to be a **cell id** — a synthesized name like `$procdff$9`, not the RTL
 *   register's source name — and for `signal` resolves to nothing at all
 *   directly. Both then fall through to `_applyLeafMatch`'s best-effort
 *   leaf match, which tries a named net first anyway.
 *
 * The reason `net` hits directly is a fact about what Yosys does to a
 * register during synthesis, and NetCrux's own **outbound** cross-probe
 * encodes the identical fact in reverse: `cxp_selection_resolver.dart`'s
 * `_registerOutputNetName` deliberately re-maps a selected register/flop
 * *cell* to `ElementKind.net` before sending, with the comment "Yosys keeps
 * the RTL reg name as the flop's Q-output net" — because the elaborated
 * netlist has no register object at all, only combinational cells feeding a
 * named net that still carries the RTL name the engineer wrote. Sending
 * `net` with that same RTL name is therefore not a guess at NetCrux's
 * vocabulary; it is the one kind whose exact-match path is defined in terms
 * of the exact fact this command relies on — "the identifier the engineer
 * selected in Verilog source is the net name after synthesis" — and it is
 * what lands directly on the net whose fanin *is* the cone of influence the
 * engineer asked to follow, with no leaf-match guesswork in between.
 */
export const NETCRUX_HIGHLIGHT_ELEMENT_KIND = 'net';
