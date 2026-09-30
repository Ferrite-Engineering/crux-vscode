/**
 * LintCrux's settings, under the shared `edacrux.*` namespace.
 *
 * The namespace is host-core's decision (implementation-map §6a): a VSCode
 * window is one peer however many product extensions are installed, so a
 * window-level setting cannot live under one product's name. These two are
 * lint-specific but follow the same rule — `edacrux.lint.*` — so a pack
 * user sees one "EDACrux" section rather than four product sections.
 *
 * Read **live**, on every use, never cached: a user who points the results
 * path at a different file expects the next refresh to use it.
 */
import path from 'node:path';
import * as vscode from 'vscode';

/** Configuration section, matching host-core's `EDACRUX_CONFIGURATION_SECTION`. */
export const LINT_CONFIGURATION_SECTION = 'edacrux';

/** Setting keys, relative to [LINT_CONFIGURATION_SECTION]. */
export const LINT_SETTING_KEYS = {
  /** Where the results file is, relative to each workspace folder or absolute. */
  resultsPath: 'lint.resultsPath',
  /** Author recorded on waivers filed from the editor. */
  waiverAuthor: 'lint.waiverAuthor',
} as const;

/**
 * The default results path.
 *
 * LintCrux has no *conventional* output filename — `--export <fmt> --out
 * <path>` and its `--sarif <path>` shorthand both take the path from the
 * caller, and a GUI run writes nothing at all. So this extension names the
 * convention rather than guessing at one: run
 * `lintcrux <sources> --sarif lintcrux.sarif` at the workspace root and
 * the diagnostics appear. Anything else is one setting away, and the
 * format is sniffed from the content, so `--export json --out
 * lintcrux.sarif` works just as well.
 */
export const DEFAULT_RESULTS_PATH = 'lintcrux.sarif';

/** The settings this extension reads. */
export interface LintSettings {
  readonly resultsPath: string;
  /** Empty means "fall back to the OS user", matching the app's waive dialog. */
  readonly waiverAuthor: string;
}

function readString(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
  fallback: string,
): string {
  const value = configuration.get<unknown>(key);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

/** Read the current settings. */
export function readLintSettings(): LintSettings {
  const configuration = vscode.workspace.getConfiguration(LINT_CONFIGURATION_SECTION);
  return {
    resultsPath: readString(configuration, LINT_SETTING_KEYS.resultsPath, DEFAULT_RESULTS_PATH),
    waiverAuthor: readString(configuration, LINT_SETTING_KEYS.waiverAuthor, ''),
  };
}

/**
 * The absolute results paths to read, given the setting and the open
 * workspace folders.
 *
 * An absolute setting names exactly one file, whatever the workspace is —
 * the case where lint runs somewhere else and drops its report on a shared
 * path. A relative one is resolved against **every** workspace folder, so
 * a multi-root workspace with one report per repository picks up all of
 * them rather than only the first. Duplicates are collapsed.
 */
export function resolveResultsPaths(
  resultsPath: string,
  workspaceFolders: readonly string[],
): readonly string[] {
  if (path.isAbsolute(resultsPath)) return [path.normalize(resultsPath)];
  const paths = new Set<string>();
  for (const folder of workspaceFolders) {
    paths.add(path.normalize(path.resolve(folder, resultsPath)));
  }
  return [...paths];
}
