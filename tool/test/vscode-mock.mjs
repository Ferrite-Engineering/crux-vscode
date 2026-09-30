// Minimal `vscode` module stand-in for unit tests run under vitest (plain
// Node, no extension host). Real VSCode integration behaviour belongs in an
// @vscode/test-electron suite, not here — this only lets host-core and
// extension entry points import `vscode` without crashing module
// resolution, so unit tests can exercise the surrounding logic.
//
// `l10n.t()` returns its source string unchanged (matches VSCode's own
// English-locale fallback). Everything else auto-mocks: any property
// access or call returns another no-op auto-mock, so code paths this
// scaffold doesn't yet exercise don't need a hand-written stub here —
// extend this file as real API surface gets used.
function makeAutoMock() {
  const target = () => makeAutoMock();
  return new Proxy(target, {
    get(_obj, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return makeAutoMock();
    },
    apply() {
      return makeAutoMock();
    },
    construct() {
      return makeAutoMock();
    },
  });
}

const auto = makeAutoMock();

// Matches VSCode's own English-locale fallback: the source string is
// returned, with `{0}`/`{1}`/… substituted from the arguments. Substituting
// matters — a caller that builds `"{0} = {1}"` renders exactly that literal
// without it, and a test asserting on the rendered text would be asserting
// on the mock rather than on the code.
export const l10n = {
  t: (message, ...args) =>
    args.length === 0
      ? message
      : String(message).replace(/\{(\d+)\}/g, (match, index) => {
          const value = args[Number(index)];
          return value === undefined ? match : String(value);
        }),
};

// --- Real value objects -----------------------------------------------
//
// The auto-mock is fine for *services* (a call whose return value the code
// under test only passes along), but not for the plain data classes VSCode
// asks an extension to construct: `new vscode.Diagnostic(...)` under the
// auto-mock produces an opaque proxy, so a test asserting "this violation
// maps to Warning at line 41" would be asserting on the mock rather than
// on the mapping. These carry no behaviour beyond their fields, so
// re-implementing them here is faithful rather than approximate — the
// numeric enum values are VSCode's own and are part of its public API.

/** Mirrors `vscode.DiagnosticSeverity` exactly, values included. */
export const DiagnosticSeverity = Object.freeze({
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
});

export class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

export class Range {
  // VSCode's overloads: (start, end) or (startLine, startChar, endLine, endChar).
  constructor(a, b, c, d) {
    if (a instanceof Position && b instanceof Position) {
      this.start = a;
      this.end = b;
    } else {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    }
  }
}

export class Diagnostic {
  constructor(range, message, severity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

/** Only the members this repo constructs; `QuickFix` is the one that matters. */
export class CodeActionKind {
  constructor(value) {
    this.value = value;
  }
}
CodeActionKind.QuickFix = new CodeActionKind('quickfix');

export class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}

// --- Testing / task / terminal value objects ----------------------------
//
// SimCrux's Test Explorer surface constructs `TestMessage`, `Location`,
// `MarkdownString`, `TestTag`, `Task` and `TerminalLink` and hands them
// straight to VSCode. Under the auto-mock a test asserting "the failing
// property's message names the verdict" would assert on a proxy, so these
// get the same real-value-object treatment the four above got. The
// TestController/TestItem *services* stay auto-mocked; the code under test
// reaches them through its own injected sink, which is what makes the
// mapping assertable without an extension host.

/**
 * `vscode.Uri`, enough of it to be honest: `file`, `parse`, `joinPath`,
 * `fsPath` and `toString`. Real rather than auto-mocked because the
 * counterexample handoff's whole assertion is *which URI was resolved*,
 * and a proxy cannot answer that.
 */
export class Uri {
  constructor(scheme, authority, path, query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  get fsPath() {
    return this.path;
  }

  static file(path) {
    return new Uri('file', '', path);
  }

  static parse(value) {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/.exec(
      value,
    );
    if (match === null) return new Uri('file', '', value);
    return new Uri(match[1], match[3] ?? '', match[4] ?? '', match[6] ?? '', match[8] ?? '');
  }

  static joinPath(base, ...parts) {
    const joined = [base.path, ...parts].join('/').replace(/\/+/g, '/');
    return new Uri(base.scheme, base.authority, joined);
  }

  toString() {
    const authority = this.authority === '' ? '' : `//${this.authority}`;
    const query = this.query === '' ? '' : `?${this.query}`;
    const fragment = this.fragment === '' ? '' : `#${this.fragment}`;
    return `${this.scheme}:${authority}${this.path}${query}${fragment}`;
  }
}

/** Mirrors `vscode.ViewColumn`, values included. `Beside` is the one that matters. */
export const ViewColumn = Object.freeze({
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
});

/**
 * Mirrors `vscode.StatusBarAlignment`, values included.
 *
 * A namespace import (`import * as vscode`) reads *named* exports, so an
 * enum missing here is `undefined` rather than an auto-mock — and
 * `vscode.StatusBarAlignment.Right` then throws where the auto-mock would
 * have shrugged. That is what it looked like from the outside when
 * `window/` first constructed a `StatusBarController` under vitest.
 */
export const StatusBarAlignment = Object.freeze({
  Left: 1,
  Right: 2,
});

/**
 * Mirrors `vscode.ExtensionMode`, values included. Named for the same reason
 * `StatusBarAlignment` is: every product's `activate()` reads
 * `vscode.ExtensionMode.Production` to pick a telemetry endpoint.
 */
export const ExtensionMode = Object.freeze({
  Production: 1,
  Development: 2,
  Test: 3,
});

/** Mirrors `vscode.TestRunProfileKind`, values included. */
export const TestRunProfileKind = Object.freeze({
  Run: 1,
  Debug: 2,
  Coverage: 3,
});

export class Location {
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    this.range = rangeOrPosition instanceof Position
      ? new Range(rangeOrPosition, rangeOrPosition)
      : rangeOrPosition;
  }
}

export class MarkdownString {
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
    this.isTrusted = undefined;
  }

  appendText(text) {
    this.value += text.replace(/[\\`*_{}[\]()#+\-.!]/g, (c) => `\\${c}`);
    return this;
  }

  appendMarkdown(markdown) {
    this.value += markdown;
    return this;
  }
}

export class TestMessage {
  constructor(message) {
    this.message = message;
    this.location = undefined;
    this.expectedOutput = undefined;
    this.actualOutput = undefined;
  }

  static diff(message, expected, actual) {
    const created = new TestMessage(message);
    created.expectedOutput = expected;
    created.actualOutput = actual;
    return created;
  }
}

export class TestTag {
  constructor(id) {
    this.id = id;
  }
}

/** Mirrors `vscode.TaskScope`, values included. */
export const TaskScope = Object.freeze({
  Global: 1,
  Workspace: 2,
});

/** Mirrors `vscode.ShellQuoting`, values included. */
export const ShellQuoting = Object.freeze({
  Escape: 1,
  Strong: 2,
  Weak: 3,
});

/**
 * Both of VSCode's overloads: `(commandLine, options?)` and
 * `(command, args, options?)`. Which one was used is observable, because
 * only the second lets VSCode apply the launching shell's own quoting —
 * and asserting that we take it is the point of the test.
 */
export class ShellExecution {
  constructor(a, b, c) {
    if (Array.isArray(b)) {
      this.command = a;
      this.args = b;
      this.options = c;
    } else {
      this.commandLine = a;
      this.options = b;
    }
  }
}

export class Task {
  constructor(definition, scope, name, source, execution, problemMatchers) {
    this.definition = definition;
    this.scope = scope;
    this.name = name;
    this.source = source;
    this.execution = execution;
    this.problemMatchers = problemMatchers;
    this.group = undefined;
    this.presentationOptions = {};
    this.detail = undefined;
  }
}

export class TaskGroup {
  constructor(id, label) {
    this.id = id;
    this.label = label;
  }
}
TaskGroup.Test = new TaskGroup('test', 'Test');
TaskGroup.Build = new TaskGroup('build', 'Build');

/** Mirrors `vscode.TaskRevealKind`, values included. */
export const TaskRevealKind = Object.freeze({
  Always: 1,
  Silent: 2,
  Never: 3,
});

/** Mirrors `vscode.TaskPanelKind`, values included. */
export const TaskPanelKind = Object.freeze({
  Shared: 1,
  Dedicated: 2,
  New: 3,
});

export class TerminalLink {
  constructor(startIndex, length, tooltip) {
    this.startIndex = startIndex;
    this.length = length;
    this.tooltip = tooltip;
  }
}

export const window = auto.window;
export const workspace = auto.workspace;
export const commands = auto.commands;
export const env = auto.env;
export const tests = auto.tests;
export const tasks = auto.tasks;
export const extensions = auto.extensions;
export const languages = auto.languages;

export default new Proxy(
  {
    l10n,
    window,
    workspace,
    commands,
    env,
    tests,
    tasks,
    extensions,
    languages,
    Uri,
    ViewColumn,
    CodeAction,
    CodeActionKind,
    Diagnostic,
    DiagnosticSeverity,
    ExtensionMode,
    Location,
    MarkdownString,
    Position,
    Range,
    ShellExecution,
    ShellQuoting,
    StatusBarAlignment,
    Task,
    TaskGroup,
    TaskPanelKind,
    TaskRevealKind,
    TaskScope,
    TerminalLink,
    TestMessage,
    TestRunProfileKind,
    TestTag,
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return makeAutoMock();
    },
  },
);
