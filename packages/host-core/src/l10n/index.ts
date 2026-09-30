/**
 * An intentionally empty module: host-core has no localization helper of its
 * own, and nothing should be added here without a reason.
 *
 * Every user-facing string goes straight through `vscode.l10n.t()` in the
 * owning module's `strings.ts` (runtime strings) or `package.nls.json`
 * (manifest-field strings). `vscode.l10n.t()` resolves against the *calling
 * extension's* bundle, and host-core is bundled into each extension, so
 * host-core's runtime strings live in `packages/host-core/l10n/` and
 * `tool/sync-l10n.mjs` copies them into every extension's `l10n/` (checked
 * in CI with `--check`). EN is populated first, with zh-Hans/ja/ko alongside.
 *
 * The export stays so `hostCore.l10n` keeps its place in the module map.
 * See docs/implementation-map.md §2 (`l10n`) and §6a (l10n).
 */
export {};
