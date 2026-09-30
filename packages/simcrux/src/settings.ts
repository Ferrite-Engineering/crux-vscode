/**
 * SimCrux's settings, under the shared `edacrux.*` namespace.
 *
 * The namespace is host-core's decision (implementation-map §6a): a VSCode
 * window is one peer however many product extensions are installed, so a
 * pack user sees one "EDACrux" section rather than four product sections.
 *
 * Read **live**, on every use, never cached — a user who points the config
 * path at a different project expects the next refresh to use it.
 *
 * Only three settings, and each earns its place by naming something this
 * extension genuinely cannot discover:
 *
 * - **`sim.projectFile`** — a workspace may hold several `simcrux.yaml`s
 *   and the CLI takes any filename; the default is the convention.
 * - **`sim.resultsPath`** — the run's output path is a convention
 *   (`results.ndjson` beside the config) that `output: { results_path: … }`
 *   can override, and this extension reads the *shallow* config, so an
 *   override that lives behind an `includes:` is invisible to it.
 * - **`sim.executable`** — the SimCrux binary is not on every PATH, and a
 *   guessed path is a failed task with a confusing message.
 *
 * There is deliberately no "auto-run on save" setting: launching a
 * simulation is a decision with a cost, and this surface never makes it
 * for the user.
 */
import path from 'node:path';
import * as vscode from 'vscode';

/** Configuration section, matching host-core's `EDACRUX_CONFIGURATION_SECTION`. */
export const SIM_CONFIGURATION_SECTION = 'edacrux';

/** Setting keys, relative to [SIM_CONFIGURATION_SECTION]. */
export const SIM_SETTING_KEYS = {
  projectFile: 'sim.projectFile',
  resultsPath: 'sim.resultsPath',
  executable: 'sim.executable',
} as const;

/**
 * The conventional project filename. `simcrux [config.yaml …]` accepts any
 * name, but every shipped example, every fixture and the importer's own
 * output use this one.
 */
export const DEFAULT_PROJECT_FILE = 'simcrux.yaml';

/**
 * The conventional results filename.
 *
 * `CiRunner._resolveStreamingPath` writes `<dir of simcrux.yaml>/results.ndjson`
 * whenever `--ci` is used, which is what makes a zero-configuration default
 * possible here — LintCrux had to name a convention because its CLI took
 * the output path from the caller; SimCrux's already has one.
 */
export const DEFAULT_RESULTS_FILE = 'results.ndjson';

/** The binary name, resolved on PATH unless the setting overrides it. */
export const DEFAULT_EXECUTABLE = 'simcrux';

/** The settings this extension reads. */
export interface SimSettings {
  /** Relative to each workspace folder, or absolute. */
  readonly projectFile: string;
  /**
   * Empty means "derive it": `output.results_path` from the config if the
   * shallow reader saw one, else `results.ndjson` beside the config.
   */
  readonly resultsPath: string;
  readonly executable: string;
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
export function readSimSettings(): SimSettings {
  const configuration = vscode.workspace.getConfiguration(SIM_CONFIGURATION_SECTION);
  return {
    projectFile: readString(configuration, SIM_SETTING_KEYS.projectFile, DEFAULT_PROJECT_FILE),
    resultsPath: readString(configuration, SIM_SETTING_KEYS.resultsPath, ''),
    executable: readString(configuration, SIM_SETTING_KEYS.executable, DEFAULT_EXECUTABLE),
  };
}

/**
 * Where to read results for a project at [configPath].
 *
 * Precedence, most explicit first:
 *
 * 1. the `sim.resultsPath` setting — absolute wins outright, relative is
 *    resolved against the config's own directory (not the workspace root:
 *    a multi-project workspace would otherwise point every project at one
 *    file);
 * 2. the config's own `output.results_path`, resolved the same way, which
 *    is how the app itself resolves it;
 * 3. `results.ndjson` beside the config — the `--ci` convention.
 */
export function resolveResultsPath(
  configPath: string,
  settingsResultsPath: string,
  configuredResultsPath: string | undefined,
): string {
  const directory = path.dirname(configPath);
  const candidate =
    settingsResultsPath !== ''
      ? settingsResultsPath
      : (configuredResultsPath ?? DEFAULT_RESULTS_FILE);
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.normalize(path.resolve(directory, candidate));
}
