/**
 * Enumerating a `simcrux.yaml`'s suites and tests, *shallowly*.
 *
 * ### Why enumerate the config at all
 *
 * The premise of this extension is that SimCrux enumerates `TestSpec`s up
 * front, which maps almost exactly onto VSCode's `TestController` model. Up
 * front is the load-bearing half: a Test Explorer that is empty until you
 * have already run something is a results viewer, not a test tree — you
 * cannot click a test to run it if it is not there yet.
 *
 * It also fixes a problem the results file creates on its own. A run
 * launched with `--filter` writes a `results.ndjson` containing **only the
 * filtered tests** (the writer is one-shot and recreates the file per
 * run). A tree built purely from results would therefore delete every
 * other test from the view the moment you re-ran one. With the config as
 * the backbone, results only ever *decorate* items, and a test absent from
 * the latest run simply has no run state.
 *
 * ### Why a deliberately shallow reader, and what it does not do
 *
 * The real loader is `simcrux/lib/services/config/config_loader.dart` and
 * its five `part` files: four-level inheritance (include → project
 * `defaults:` → suite → test), Cartesian parameter sweeps, seed sweeps,
 * `includes:`, and typed `riscv:` merging. Re-implementing any of that in
 * TypeScript would be a second config loader — the exact drift this repo
 * exists to prevent, and one that would be wrong in ways no test here
 * could catch.
 *
 * So this reads **one thing**: the `suites: → <suite>: → tests: → - name:`
 * skeleton, which is the tree's shape and nothing else. The consequences
 * are stated rather than hidden:
 *
 * - **`includes:` are not followed.** Tests contributed by an include
 *   appear once they have run, not before.
 * - **Sweeps are not expanded.** A test with `parameters: {W: [8, 16]}` or
 *   `seeds: [1, 2, 3]` is one node here and fans out into several ids at
 *   run time (`<id>+W=8`, `<id>+seed=1`); those arrive with results.
 *   [SimProjectTest.mayFanOut] marks the ones this is true of, so the tree
 *   can say so instead of looking wrong.
 * - **Anything not understood is skipped, never guessed.** No value is
 *   inferred from an unrecognised construct.
 *
 * The failure mode is therefore "a test is missing from the tree until it
 * runs", never "the tree shows a test that does not exist".
 */

/** One test declared in the config. */
export interface SimProjectTest {
  /** `<suite>/<name>` — `TestSpec.id` for an unswept test. */
  readonly id: string;
  readonly name: string;
  readonly suite: string;
  /**
   * Whether this declaration carries a `parameters:` or `seeds:` sweep and
   * therefore becomes *several* ids at run time, none of them [id].
   */
  readonly mayFanOut: boolean;
}

/** What a `simcrux.yaml` declares, as far as the tree needs to know. */
export interface SimProject {
  /** Suite names in declaration order. */
  readonly suites: readonly string[];
  readonly tests: readonly SimProjectTest[];
  /**
   * `output.results_path`, verbatim, when the config overrides the default
   * `results.ndjson` beside the config file.
   */
  readonly resultsPath?: string;
}

/** Indentation width of [line], counting spaces only (YAML forbids tabs). */
function indentOf(line: string): number {
  let count = 0;
  while (count < line.length && line[count] === ' ') count += 1;
  return count;
}

/**
 * Strip a trailing comment and surrounding whitespace.
 *
 * Quote-aware, because a `#` inside a quoted scalar is data. Handled
 * rather than ignored: `pass_string: 'DONE (PASS'` is real config from the
 * shipped demo, and a naive `split('#')` would corrupt exactly the kind of
 * line a formal project is full of.
 */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || line[index - 1] === ' ')) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

/** Unquote a scalar, leaving anything else exactly as written. */
function scalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    if ((first === "'" || first === '"') && value.endsWith(first)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** `key: value` / `key:` at the head of [content], or undefined. */
function splitMapping(content: string): { key: string; value: string } | undefined {
  const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/.exec(content);
  if (match === null) return undefined;
  return { key: match[1] ?? '', value: (match[2] ?? '').trim() };
}

/**
 * Whether a mapping value opens a sweep — a YAML flow or block sequence.
 *
 * `parameters: {W: [8, 16]}` and a block `seeds:` followed by `- 1` both
 * count; `seed: 7` does not. Conservative on purpose: a false positive
 * labels a node "fans out" when it does not, which is a cosmetic error,
 * while a false negative would show an id that never runs under that name.
 */
function opensSweep(value: string): boolean {
  return value === '' || value.includes('[') || value.includes('- ');
}

/**
 * Read the `suites:` skeleton and `output.results_path` out of a
 * `simcrux.yaml`.
 *
 * Never throws. A file this reader cannot make sense of yields an empty
 * project, and the tree falls back to whatever the results file carries —
 * degrading to the results-only view rather than to an error the user
 * cannot act on.
 */
export function readSimProject(text: string): SimProject {
  const suites: string[] = [];
  const tests: SimProjectTest[] = [];
  let resultsPath: string | undefined;

  // Where we are. `section` is the top-level block; `suite` the suite name
  // when inside `suites:`; `inTests` whether we are inside that suite's
  // `tests:` sequence. Indents are recorded so a nested block (a test's own
  // `riscv:` sub-map, say) cannot be mistaken for a sibling.
  let section: string | undefined;
  let sectionIndent = 0;
  let suite: string | undefined;
  let suiteIndent = 0;
  let inTestsIndent: number | undefined;
  let currentTest: { name: string; indent: number; mayFanOut: boolean } | undefined;

  const flushTest = (): void => {
    if (currentTest === undefined || suite === undefined) return;
    tests.push({
      id: `${suite}/${currentTest.name}`,
      name: currentTest.name,
      suite,
      mayFanOut: currentTest.mayFanOut,
    });
    currentTest = undefined;
  };

  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine.replace(/\r$/, ''));
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    const content = line.slice(indent);

    // Leaving the current test / suite / section, innermost first.
    if (currentTest !== undefined && indent < currentTest.indent) flushTest();
    if (inTestsIndent !== undefined && indent <= inTestsIndent && !content.startsWith('- ')) {
      inTestsIndent = undefined;
    }
    if (suite !== undefined && indent <= suiteIndent && !content.startsWith('- ')) {
      flushTest();
      if (indent <= suiteIndent) suite = undefined;
    }
    if (section !== undefined && indent <= sectionIndent) section = undefined;

    if (indent === 0) {
      const mapping = splitMapping(content);
      if (mapping === undefined) continue;
      section = mapping.key;
      sectionIndent = 0;
      continue;
    }

    if (section === 'output') {
      const mapping = splitMapping(content);
      if (mapping?.key === 'results_path' && mapping.value !== '') {
        resultsPath = scalar(mapping.value);
      }
      continue;
    }

    if (section !== 'suites') continue;

    // Inside a `tests:` sequence: `- name: foo` opens a test, and the keys
    // indented under it belong to it.
    if (inTestsIndent !== undefined && content.startsWith('- ')) {
      flushTest();
      const mapping = splitMapping(content.slice(2).trimStart());
      if (mapping?.key === 'name' && mapping.value !== '') {
        currentTest = {
          name: scalar(mapping.value),
          // The item's keys are indented to where `name` itself starts.
          indent: indent + 2,
          mayFanOut: false,
        };
      }
      continue;
    }

    if (currentTest !== undefined && indent >= currentTest.indent) {
      const mapping = splitMapping(content);
      if (
        mapping !== undefined &&
        (mapping.key === 'parameters' || mapping.key === 'seeds') &&
        opensSweep(mapping.value)
      ) {
        currentTest = { ...currentTest, mayFanOut: true };
      }
      continue;
    }

    const mapping = splitMapping(content);
    if (mapping === undefined) continue;

    if (suite !== undefined && mapping.key === 'tests' && mapping.value === '') {
      inTestsIndent = indent;
      continue;
    }

    // A key directly under `suites:` is a suite name. Recorded on sight so
    // an empty suite still appears — "this suite has no tests" is a fact
    // worth seeing in the tree.
    if (suite === undefined && mapping.value === '') {
      suite = mapping.key;
      suiteIndent = indent;
      if (!suites.includes(suite)) suites.push(suite);
    }
  }
  flushTest();

  return {
    suites,
    tests,
    ...(resultsPath === undefined ? {} : { resultsPath }),
  };
}
