/**
 * [LintDiagnosticsPublisher] — read the results file(s), apply waivers,
 * publish diagnostics, and remember which violation is behind which
 * squiggle so the waiver code actions have something to act on.
 *
 * Every input is a seam ([LintResultsSource]), so the whole refresh cycle
 * — including a missing file, an unreadable one, a malformed one, and a
 * waiver file written by a newer build — is exercised in tests without an
 * extension host and without touching a real disk.
 */
import path from 'node:path';
import type * as vscode from 'vscode';
import type { LintWaiver } from '../waivers/model';
import { parseWaiverDocument, WaiverSchemaError } from '../waivers/store';
import { planDiagnostics } from './diagnostics';
import type { LintViolation } from './model';
import { LintResultsFormatError, parseLintResults } from './results';

/**
 * The diagnostic collection, narrowed to what this module uses and keyed
 * by **filesystem path** rather than `vscode.Uri`.
 *
 * Keying by path is what keeps the publisher testable: a `Uri` can only be
 * built by the real `vscode` module, and the mapping this class exists to
 * get right is violations → diagnostics, not paths → URIs.
 */
export interface LintDiagnosticSink {
  set(filePath: string, diagnostics: readonly vscode.Diagnostic[]): void;
  clear(): void;
  dispose(): void;
}

/** Everything [LintDiagnosticsPublisher] needs from its environment. */
export interface LintResultsSource {
  /** Absolute paths of the results file(s) to read, in order. */
  readonly resultsPaths: () => readonly string[];
  /**
   * The waiver file governing a source file, or `undefined` when there is
   * none — `resolveWaiverFile` in production, so reads and writes always
   * agree on which file a waiver lives in.
   */
  readonly waiverFileFor: (sourceFilePath: string) => string | undefined;
  /** Read a file as text; `undefined` when it does not exist or cannot be read. */
  readonly readText: (filePath: string) => string | undefined;
  /** Injected so waiver expiry is not clock-dependent in tests. */
  readonly now: () => Date;
  /** Diagnostics channel — a malformed results file must be explainable. */
  readonly log: (line: string) => void;
}

/** What one [LintDiagnosticsPublisher.refresh] did. */
export interface LintRefreshSummary {
  /** Results files that were found and parsed. */
  readonly sourcesRead: readonly string[];
  /** Results files named but absent — the ordinary "lint has not been run" case. */
  readonly sourcesMissing: readonly string[];
  /** Human-readable parse failures, already logged. */
  readonly errors: readonly string[];
  readonly filesWithDiagnostics: number;
  readonly published: number;
  readonly waived: number;
}

/**
 * Owns the diagnostic collection for one window.
 *
 * `clear()` before every publish rather than a per-file diff: a violation
 * that disappeared between runs must lose its squiggle, and a results file
 * that shrank to nothing must leave the Problems panel empty. Diffing
 * would be an optimisation whose failure mode is a stale error the user
 * cannot get rid of.
 */
export class LintDiagnosticsPublisher {
  private violations: ReadonlyMap<string, readonly LintViolation[]> = new Map();

  constructor(
    private readonly sink: LintDiagnosticSink,
    private readonly source: LintResultsSource,
  ) {}

  /** The published (i.e. unwaived) violations in [filePath]. */
  violationsFor(filePath: string): readonly LintViolation[] {
    return this.violations.get(filePath) ?? [];
  }

  /** Re-read everything and republish. Never throws. */
  refresh(): LintRefreshSummary {
    const sourcesRead: string[] = [];
    const sourcesMissing: string[] = [];
    const errors: string[] = [];
    const violations: LintViolation[] = [];

    for (const resultsPath of this.source.resultsPaths()) {
      const text = this.source.readText(resultsPath);
      if (text === undefined) {
        sourcesMissing.push(resultsPath);
        continue;
      }
      try {
        const parsed = parseLintResults(text, path.dirname(resultsPath));
        violations.push(...parsed.violations);
        sourcesRead.push(resultsPath);
      } catch (error) {
        const message =
          error instanceof LintResultsFormatError
            ? `${resultsPath}: ${error.message}`
            : `${resultsPath}: ${String(error)}`;
        errors.push(message);
        this.source.log(`   lint results unreadable: ${message}`);
      }
    }

    const waivers = this.readWaivers(violations, errors);
    const plan = planDiagnostics({ violations, waivers, now: this.source.now() });

    this.sink.clear();
    for (const [filePath, diagnostics] of plan.byFile) this.sink.set(filePath, diagnostics);
    this.violations = plan.violationsByFile;

    return {
      sourcesRead,
      sourcesMissing,
      errors,
      filesWithDiagnostics: plan.byFile.size,
      published: plan.published,
      waived: plan.waived,
    };
  }

  /** Drop every published diagnostic — used on dispose and on a settings change. */
  clear(): void {
    this.sink.clear();
    this.violations = new Map();
  }

  dispose(): void {
    this.sink.dispose();
  }

  /**
   * The waivers governing [violations], read once per distinct waiver file.
   *
   * A waiver file this build must not interpret (a future `version`) is
   * reported and then **ignored**, leaving its violations squiggled. The
   * alternative — treating an unreadable waiver file as "everything is
   * waived" — would silently hide findings on the strength of a file we
   * just admitted we cannot read.
   */
  private readWaivers(violations: readonly LintViolation[], errors: string[]): LintWaiver[] {
    const waiverFiles = new Set<string>();
    for (const violation of violations) {
      const file = this.source.waiverFileFor(violation.file);
      if (file !== undefined) waiverFiles.add(file);
    }
    const waivers: LintWaiver[] = [];
    for (const file of waiverFiles) {
      const text = this.source.readText(file);
      if (text === undefined) continue;
      try {
        waivers.push(...parseWaiverDocument(text).waivers);
      } catch (error) {
        const message =
          error instanceof WaiverSchemaError
            ? `${file}: ${error.message}`
            : `${file}: ${String(error)}`;
        errors.push(message);
        this.source.log(`   waiver file ignored: ${message}`);
      }
    }
    return waivers;
  }
}
