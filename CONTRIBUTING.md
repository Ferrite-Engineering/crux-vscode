# Contributing to crux-vscode

Thanks for your interest in contributing. This document covers the
practical bits — license, sign-off, and the change submission flow.

## License of contributions

Every contribution to this repository is licensed under **Apache License,
Version 2.0**, the same license as the rest of the repo. By submitting a
pull request you assert that you have the right to license your
contribution under those terms.

There is no Contributor License Agreement. The Developer Certificate of
Origin sign-off (below) is sufficient.

## Developer Certificate of Origin (DCO)

Every commit must be signed off, attesting that you wrote the code (or
have the right to submit it) and agree to license it under the project
terms. The DCO text is at <https://developercertificate.org>.

In practice this means appending a `Signed-off-by:` line to every commit
message. The easiest way is `git commit -s`:

```
feat: add stems bidirectional index

Signed-off-by: Random Developer <random@developer.example.org>
```

CI rejects PRs whose commits are missing the sign-off line.

## Submission flow

1. Open an issue describing the change first if it's a non-trivial design
   decision (new CXP message kind, a change to a module boundary, a new
   dependency).
2. Fork, branch from `main` (`feature/...`, `fix/...`, etc).
3. Make your changes. Keep commits focused; squash the noisy ones before
   the PR.
4. Run `pnpm -r lint`, `pnpm -r typecheck`, and `pnpm -r test`. CI runs the
   same checks.
5. Open a PR against `main` with a clear summary and a test plan.
6. CI must be green before merge.

## Code style

* TypeScript, strict mode, no implicit `any`.
* ESLint clean at zero warnings (`eslint . --max-warnings=0`).
* No hardcoded user-facing strings — add `package.nls.json` / `l10n/`
  entries instead. See [`README.md`](README.md) for the localization
  workflow.
* Shared behaviour belongs in `packages/host-core`; a product package
  (`wavecrux`, `lintcrux`, `simcrux`, `netcrux`) may import from
  `host-core`, but `host-core` never imports from a product package.
* New host-core modules require unit tests in the same change
  (`vitest`, colocated under the package's `test/` directory).

## What you cannot do

* Do not hardcode a user-facing string in TypeScript. It goes through
  `vscode.l10n.t()` (runtime) or `package.nls.json` (manifest fields),
  with EN populated and zh-Hans/ja/ko entries added alongside.
* Do not copy-paste behaviour across the four product packages that
  belongs in `host-core`. That duplication is the failure this
  architecture exists to prevent.
* Do not add a CI job without `timeout-minutes`. A hung job has drained a
  month's Actions budget before; every job carries a cap, no exceptions.
* Do not change `publisher` or `name` in any package's `package.json`.
  The extension ID is permanent once published.

## Reporting security issues

Please do not open a public issue for a security report. Contact Ferrite
Engineering directly.
