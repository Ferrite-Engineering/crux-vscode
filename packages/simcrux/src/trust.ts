/**
 * What SimCrux does in a folder VSCode has not been told to trust.
 *
 * SimCrux declares `capabilities.untrustedWorkspaces.supported: "limited"`,
 * not `false`, so the extension is present in a restricted workspace
 * instead of vanishing from it without a word. What "limited" means here is
 * one sentence: it **reads** (the test tree and its saved results render
 * as usual) and it **never runs anything**.
 *
 * Running is the one thing that cannot be allowed. A regression launches the
 * binary named by `edacrux.sim.executable` with a config taken from the
 * workspace, and an untrusted folder must not choose what gets executed.
 * Every path that would start a process goes through [requireTrustToRun]
 * first: the Run Regression command, the Test Explorer run profile, and the
 * `simcrux` task provider (which offers and resolves nothing while
 * untrusted, see `tasks.ts`).
 *
 * Silence is the failure this module exists to prevent. A run that does
 * nothing, or a tree whose Run button is dead, reads as a broken extension,
 * so each refusal says why and offers the one action that fixes it.
 *
 * The decisions take an injected [TrustHost], so every branch is testable
 * without an extension host; the real one is [vscodeTrustHost], at the end.
 */
import * as vscode from 'vscode';

/** The command VSCode (and its forks) register for the trust management UI. */
export const MANAGE_WORKSPACE_TRUST_COMMAND = 'workbench.trust.manage';

/** The part of VSCode's workspace-trust surface this extension uses. */
export interface TrustHost {
  /** `vscode.workspace.isTrusted`, read live. */
  readonly isTrusted: () => boolean;
  /** Non-modal warning with buttons; resolves to the chosen label. */
  readonly showWarning: (
    message: string,
    ...actions: readonly string[]
  ) => Promise<string | undefined>;
  /** Open the Workspace Trust editor. */
  readonly manageTrust: () => Promise<void>;
}

/** Why a regression will not start, and what to do about it. */
export function trustRequiredToRunMessage(): string {
  return vscode.l10n.t(
    'SimCrux runs your simulator, so it needs a trusted folder. This folder is not trusted: saved results are still shown, but no regression will run until you trust it.',
  );
}

/** Label on the message's one button. */
export function manageTrustLabel(): string {
  return vscode.l10n.t('Manage Workspace Trust');
}

/**
 * Whether a process may be started now.
 *
 * Returns `true` silently in a trusted workspace. In an untrusted one it
 * says why, offers to open the trust editor, and returns `false`; the caller
 * returns without starting anything.
 */
export async function requireTrustToRun(host: TrustHost): Promise<boolean> {
  if (host.isTrusted()) return true;
  const choice = await host.showWarning(trustRequiredToRunMessage(), manageTrustLabel());
  if (choice === manageTrustLabel()) await host.manageTrust();
  return false;
}

/**
 * The activation-time hint: shown once per window, only when this folder
 * actually has a SimCrux project (so an unrelated untrusted folder is not
 * nagged), and only while untrusted.
 *
 * Returns whether the hint was shown, for tests.
 */
export function hintIfUntrusted(
  host: TrustHost,
  options: { readonly hasProject: boolean },
): boolean {
  if (host.isTrusted() || !options.hasProject) return false;
  void requireTrustToRun(host);
  return true;
}

/** The real [TrustHost]. */
export const vscodeTrustHost: TrustHost = {
  isTrusted: () => vscode.workspace.isTrusted,
  showWarning: async (message, ...actions) =>
    await vscode.window.showWarningMessage(message, ...actions),
  manageTrust: async () => {
    await vscode.commands.executeCommand(MANAGE_WORKSPACE_TRUST_COMMAND);
  },
};
