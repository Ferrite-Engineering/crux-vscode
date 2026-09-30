# RTL fixtures

`rv32_cpu.v` is the single-cycle RV32I core from the EDACrux EDU pack
`single-cycle-cpu` (`edacrux-edu-packs/packs/single-cycle-cpu/src/rv32_cpu.v`),
copied verbatim, SPDX header intact — CC-BY-4.0, © 2026 Ferrite Engineering.

It is here because RTL annotation's performance claim is about **real HDL**: the cost of
one annotation pass is dominated by how many identifiers a line actually
carries, and a synthetic file of `wire a; wire b;` would under-report it by a
wide margin. A hand-written core with continuous assignments, a bit-sliced
decode block and an instantiation port map is the shape the profile has to
answer for.

Copied rather than referenced across repos so `pnpm -r test` in this repo
depends on nothing outside it.
