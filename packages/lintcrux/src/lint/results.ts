/**
 * Reading a LintCrux run's results off disk.
 *
 * ### Why this reads a file instead of running the app
 *
 * Established by reading the product, not assumed:
 *
 * - A **GUI** lint run writes no results file at all. Violations live in
 *   `InMemoryViolationStore`; export is a user-initiated File → Export to a
 *   path the user picks. There is nothing to watch.
 * - The **CLI** (`lintcrux` / `lintcrux_pro`, `bin/*.dart`) is the machine
 *   contract: `--export <sarif|json|csv|html> --out <path>`, with
 *   `--sarif <path>` as shorthand. SARIF is the versioned, external,
 *   CI-shaped document (`HeadlessExportWriter`: repo-relative
 *   `artifactLocation.uri` under a `%SRCROOT%` base, stable
 *   `automationDetails.id`); flat JSON is the 1:1 dump of the in-memory
 *   model.
 *
 * So the file exists precisely when someone ran lint, which is exactly
 * when the editor should have diagnostics — and reading it costs no
 * process spawn, no engine-path discovery, no cancellation model, and no
 * way for this extension to run a linter the user did not ask for. Both
 * formats are accepted and **sniffed from the content**, not the
 * extension, so `--export json --out lint.sarif` still works.
 *
 * Nothing here imports `vscode`: parsing is pure, which is what makes the
 * severity and location edge cases testable against real fixtures.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLintSeverity, type LintSeverity, type LintViolation } from './model';

/** Thrown when a results document cannot be understood at all. */
export class LintResultsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LintResultsFormatError';
  }
}

/** Which of LintCrux's two machine-readable shapes a document turned out to be. */
export type LintResultsFormat = 'sarif' | 'json';

/** A parsed results document. */
export interface LintResults {
  readonly format: LintResultsFormat;
  readonly violations: readonly LintViolation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function readPositiveInt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Resolve a SARIF `artifactLocation.uri` to an absolute filesystem path.
 *
 * Three cases, in the order the SARIF a LintCrux run actually produces
 * needs them:
 *
 * 1. an absolute path or a `file:` URI — used as-is (the in-app exporter
 *    keeps the engine's absolute paths);
 * 2. relative, with a `uriBaseId` the run declared in `originalUriBaseIds`
 *    — resolved against that base (`HeadlessExportWriter` writes
 *    `%SRCROOT%` → `file:///abs/project/`, and the checked-in example
 *    writes the same id as `./`);
 * 3. relative with no usable base — resolved against the directory holding
 *    the results file, which is the only other thing a relative URI can
 *    sensibly mean and is what makes a hand-run `--sarif out.sarif` work.
 */
function resolveArtifactUri(
  uri: string,
  uriBaseId: string | undefined,
  bases: ReadonlyMap<string, string>,
  resultsDirectory: string,
): string {
  const decoded = uri.startsWith('file:') ? fileURLToPath(uri) : decodeURIComponent(uri);
  if (path.isAbsolute(decoded)) return path.normalize(decoded);
  const base = uriBaseId === undefined ? undefined : bases.get(uriBaseId);
  const anchor = base !== undefined && path.isAbsolute(base) ? base : resultsDirectory;
  return path.normalize(path.resolve(anchor, decoded));
}

/** `originalUriBaseIds` → absolute directory paths, skipping anything unusable. */
function readUriBases(run: Record<string, unknown>): ReadonlyMap<string, string> {
  const bases = new Map<string, string>();
  const raw = run['originalUriBaseIds'];
  if (!isRecord(raw)) return bases;
  for (const [id, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const uri = readString(entry, 'uri');
    if (uri === undefined) continue;
    if (uri.startsWith('file:')) {
      bases.set(id, path.normalize(fileURLToPath(uri)));
    } else if (path.isAbsolute(uri)) {
      bases.set(id, path.normalize(uri));
    }
    // A relative base (the checked-in example's `"./"`) is deliberately
    // not recorded: there is nothing to anchor it to but the results
    // file's own directory, which is already the fallback.
  }
  return bases;
}

/**
 * SARIF `level` → [LintSeverity], mirroring `SarifReader._levelToSeverity`
 * including its default.
 *
 * An absent or unrecognised `level` becomes `warning` **because that is
 * what the app does** — matching the app matters more here than being
 * clever, since the two are meant to show the same list.
 */
function severityFromSarifLevel(level: string | undefined): LintSeverity {
  switch (level) {
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    case 'note':
      return 'note';
    case 'none':
      return 'none';
    default:
      return 'warning';
  }
}

/** `properties.lintcrux.severity` — LintCrux's `fatal` extension to SARIF's four levels. */
function severityExtension(result: Record<string, unknown>): LintSeverity | undefined {
  const properties = result['properties'];
  if (!isRecord(properties)) return undefined;
  const lintcrux = properties['lintcrux'];
  if (!isRecord(lintcrux)) return undefined;
  return parseLintSeverity(lintcrux['severity']);
}

/** Physical location of a SARIF result, if it has one this build understands. */
function sarifLocation(
  result: Record<string, unknown>,
): { region: Record<string, unknown>; uri: string; uriBaseId: string | undefined } | undefined {
  const locations: unknown = result['locations'];
  if (!Array.isArray(locations)) return undefined;
  const first: unknown = (locations as readonly unknown[])[0];
  if (!isRecord(first)) return undefined;
  const physical = first['physicalLocation'];
  if (!isRecord(physical)) return undefined;
  const artifact = physical['artifactLocation'];
  if (!isRecord(artifact)) return undefined;
  const uri = readString(artifact, 'uri');
  if (uri === undefined || uri === '') return undefined;
  const region = physical['region'];
  return {
    region: isRecord(region) ? region : {},
    uri,
    uriBaseId: readString(artifact, 'uriBaseId'),
  };
}

/**
 * The full rule id for a SARIF result.
 *
 * SARIF stores the local id (`SarifWriter` strips the `<engineId>/`
 * prefix on write) and names the engine on `tool.driver.name`. Re-adding
 * the prefix here — unless the id already carries a `/`, exactly as
 * `SarifReader` decides — is what keeps a waiver written from a SARIF-fed
 * diagnostic matchable against one the app wrote from its own model.
 */
function namespacedRuleId(rawRuleId: string, engineId: string): string {
  if (rawRuleId.includes('/') || engineId === '') return rawRuleId;
  return `${engineId}/${rawRuleId}`;
}

function parseSarif(document: Record<string, unknown>, resultsDirectory: string): LintViolation[] {
  const runs = document['runs'];
  if (!Array.isArray(runs)) {
    throw new LintResultsFormatError('SARIF document has no "runs" array');
  }
  const violations: LintViolation[] = [];
  for (const rawRun of runs) {
    if (!isRecord(rawRun)) continue;
    const tool = rawRun['tool'];
    const driver = isRecord(tool) ? tool['driver'] : undefined;
    // Lowercased to match `SarifReader`, which does the same so
    // `Verilator` and `verilator` produce one engine id rather than two.
    const engineId = (isRecord(driver) ? (readString(driver, 'name') ?? '') : '').toLowerCase();
    const bases = readUriBases(rawRun);
    const results = rawRun['results'];
    if (!Array.isArray(results)) continue;
    for (const rawResult of results) {
      if (!isRecord(rawResult)) continue;
      const location = sarifLocation(rawResult);
      // A result with no physical location cannot become a squiggle in
      // anyone's source. Dropped rather than pinned to line 1 of an
      // arbitrary file — a diagnostic in the wrong place is worse than a
      // diagnostic the Problems panel never showed.
      if (location === undefined) continue;
      const message = rawResult['message'];
      const suppressions = rawResult['suppressions'];
      const endLine = readPositiveInt(location.region, 'endLine');
      const endColumn = readPositiveInt(location.region, 'endColumn');
      violations.push({
        engineId,
        ruleId: namespacedRuleId(readString(rawResult, 'ruleId') ?? '', engineId),
        severity: severityExtension(rawResult) ?? severityFromSarifLevel(readString(rawResult, 'level')),
        message: (isRecord(message) ? readString(message, 'text') : undefined) ?? '',
        file: resolveArtifactUri(location.uri, location.uriBaseId, bases, resultsDirectory),
        line: readPositiveInt(location.region, 'startLine') ?? 1,
        column: readPositiveInt(location.region, 'startColumn') ?? 1,
        ...(endLine === undefined ? {} : { endLine }),
        ...(endColumn === undefined ? {} : { endColumn }),
        suppressed: Array.isArray(suppressions) && suppressions.length > 0,
      });
    }
  }
  return violations;
}

/**
 * `lintcrux --export json` — a bare JSON array, no envelope and no version
 * field (`ViolationExporters.toJson`). Keys: `engineId`, `ruleId`,
 * `severity`, `message`, `location{file,line,column}`, `relatedLocations`,
 * `suppressed`, `raw`.
 *
 * `location` here carries no `endLine`/`endColumn` — the exporter drops
 * them — so a JSON-fed diagnostic covers the identifier at the start
 * position and nothing more. That is a property of the format, not a
 * shortcut taken here.
 */
function parseFlatJson(entries: readonly unknown[], resultsDirectory: string): LintViolation[] {
  const violations: LintViolation[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const location = entry['location'];
    if (!isRecord(location)) continue;
    const file = readString(location, 'file');
    if (file === undefined || file === '') continue;
    const ruleId = readString(entry, 'ruleId');
    if (ruleId === undefined || ruleId === '') continue;
    violations.push({
      engineId: readString(entry, 'engineId') ?? '',
      ruleId,
      // Unlike SARIF there is no level to fall back through: this file is
      // written from `severity.name` directly, so an unrecognised value
      // means the document came from a build with a severity this one has
      // never heard of. `warning` keeps it visible rather than dropping
      // it, matching the SARIF reader's own default.
      severity: parseLintSeverity(entry['severity']) ?? 'warning',
      message: readString(entry, 'message') ?? '',
      file: path.isAbsolute(file)
        ? path.normalize(file)
        : path.normalize(path.resolve(resultsDirectory, file)),
      line: readPositiveInt(location, 'line') ?? 1,
      column: readPositiveInt(location, 'column') ?? 1,
      suppressed: entry['suppressed'] === true,
    });
  }
  return violations;
}

/**
 * Parse a LintCrux results document, sniffing SARIF vs. the flat JSON
 * export from its shape.
 *
 * [resultsDirectory] anchors relative paths — pass the directory
 * containing the file [text] came from.
 */
export function parseLintResults(text: string, resultsDirectory: string): LintResults {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new LintResultsFormatError(`not valid JSON: ${String(error)}`);
  }
  if (Array.isArray(decoded)) {
    return { format: 'json', violations: parseFlatJson(decoded, resultsDirectory) };
  }
  if (isRecord(decoded) && Array.isArray(decoded['runs'])) {
    return { format: 'sarif', violations: parseSarif(decoded, resultsDirectory) };
  }
  throw new LintResultsFormatError(
    'expected a SARIF document (an object with "runs") or a LintCrux JSON export (an array)',
  );
}
