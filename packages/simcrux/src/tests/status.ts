/**
 * Projecting SimCrux's nine `TestStatus` values onto VSCode's four run
 * states — the one place the projection happens, and the one place its
 * loss is accounted for.
 *
 * VSCode's `TestRun` has `passed`, `failed`, `skipped` and `errored`.
 * SimCrux has nine statuses. Any mapping is lossy, so the question is not
 * *whether* to lose something but **what the four buckets are allowed to
 * mean**, and then to carry the original word alongside so nothing is
 * actually gone.
 *
 * The rule:
 *
 * - `passed` — SimCrux said this test passed.
 * - `failed` — SimCrux said this test failed. A real verdict about the
 *   design.
 * - `errored` — the run produced **no trustworthy verdict**. This is the
 *   bucket the interesting cases fall into and it is why `errored` is used
 *   at all rather than folding everything into `failed`.
 * - `skipped` — the test did not run.
 *
 * Two placements are worth defending:
 *
 * **`vacuous` → `errored`, not `passed`.** A vacuous pass is
 * success-equivalent to the scheduler, but SimCrux's own enum doc says it
 * "flags broken testbench setup" — the antecedent never held, so the
 * property never had a chance to be false. Rendering that as a green check
 * is how a testbench that tests nothing looks like a testbench that
 * passes, and this repo's whole formal argument is that an unproven thing
 * must not read as a proved one. It is not `failed` either, because the
 * design was not shown to be wrong.
 *
 * **`timeout` → `errored`, not `failed`.** `TestStatus.timeout` means
 * *SimCrux killed the job* — its own per-test timer, `SIGTERM` then
 * `SIGKILL`. Nothing was learned about the design. (Note this is a
 * different fact from a SymbiYosys `TIMEOUT` verdict, which is the
 * engine's own budget expiring and arrives as `TestStatus.fail`; the two
 * are deliberately kept apart on the Dart side and stay apart here.)
 *
 * In every case [simStatusLabel] puts SimCrux's own word on the item, so
 * the projection narrows what the icon says and never what the tree says.
 */
import * as vscode from 'vscode';
import type { SimTestStatus } from '../run/model';

/** Which `TestRun` method a status calls. */
export type VscodeRunState = 'passed' | 'failed' | 'errored' | 'skipped' | 'started';

/** The projection. Total over [SimTestStatus] — no default arm. */
export function vscodeRunStateFor(status: SimTestStatus): VscodeRunState {
  switch (status) {
    case 'pass':
    case 'cover':
      return 'passed';
    case 'fail':
      return 'failed';
    case 'vacuous':
    case 'timeout':
    case 'unknown':
      return 'errored';
    case 'skipped':
    case 'cancelled':
      return 'skipped';
    case 'running':
      return 'started';
  }
}

/**
 * SimCrux's own word for a status, for the item description and the
 * message.
 *
 * `pass` and `fail` return `undefined`: the icon already says exactly
 * that, and repeating it would push the informative part of a description
 * (the formal verdict) further from the label. Every status whose icon is
 * *narrower* than the truth gets its word back.
 */
export function simStatusLabel(status: SimTestStatus): string | undefined {
  switch (status) {
    case 'pass':
    case 'fail':
      return undefined;
    case 'vacuous':
      return vscode.l10n.t('vacuous — the property never enabled');
    case 'cover':
      return vscode.l10n.t('cover point reached');
    case 'running':
      return vscode.l10n.t('running');
    case 'skipped':
      return vscode.l10n.t('skipped');
    case 'timeout':
      return vscode.l10n.t('timed out — SimCrux killed the job');
    case 'cancelled':
      return vscode.l10n.t('cancelled');
    case 'unknown':
      return vscode.l10n.t('no verdict — the detector could not classify the run');
  }
}
