/**
 * Making simulator output clickable.
 *
 * This is a terminal-link provider for simulator output. The
 * useful reading of that is narrow: a regression terminal is thousands of
 * lines of engine chatter, and exactly two things in it are worth a click.
 *
 * 1. **A source reference** — `tb_alu.sv:128`, `%Error: tb.sv:41:7:`,
 *    `tb.v:128: $finish called`. VSCode already linkifies bare paths it
 *    can resolve, but it does **not** carry the line number through for
 *    every one of these shapes, and landing on line 1 of a 4,000-line
 *    testbench is the same as not landing anywhere. So these are claimed
 *    explicitly, with the line and column.
 * 2. **A trace file** — `Writing trace to VCD file: engine_0/trace.vcd`,
 *    `summary: counterexample trace: insn_sub_ch0/engine_0/trace.vcd`.
 *    Clicking one opens it in the WaveCrux tab beside the terminal,
 *    through the *same* handoff the Test Explorer's counterexample command
 *    uses — including the same boundary when WaveCrux is not installed.
 *    This is the counterexample gesture reachable from the raw `sby` log, which is
 *    where an engineer watching a proof actually is.
 *
 * Everything else is left to VSCode's own link detection. A provider that
 * claims a range VSCode would have linkified better is a regression, not a
 * feature.
 *
 * ### Why the detection is pure
 *
 * [detectSimTerminalLinks] takes a line and returns offsets. No `vscode`
 * types, no filesystem: the regexes are the risky part and they are
 * asserted directly against real `sby`, Verilator, Icarus and GHDL output
 * shapes. The adapter below turns the offsets into `vscode.TerminalLink`s
 * and is the only part that cannot be unit-tested.
 */
import * as vscode from 'vscode';

/** What a detected link points at. */
export type SimTerminalLinkTarget =
  /** A source location — open the file and put the caret on it. */
  | { readonly kind: 'source'; readonly path: string; readonly line: number; readonly column?: number }
  /** A waveform/trace file — hand it to the WaveCrux tab. */
  | { readonly kind: 'trace'; readonly path: string };

/** One link within a terminal line. */
export interface SimTerminalLink {
  /** Offset of the link text within the line. */
  readonly startIndex: number;
  readonly length: number;
  readonly target: SimTerminalLinkTarget;
}

/**
 * Waveform containers SimCrux and its engines write.
 *
 * Matches WaveCrux's own supported set. `.fsdb` is deliberately included
 * even though it is proprietary: a link that opens it and reports "this
 * format needs a licensed reader" is more use than no link at all, and
 * that message is WaveCrux's to give, not this provider's to pre-empt.
 */
const TRACE_EXTENSIONS = ['vcd', 'fst', 'ghw', 'lxt', 'lxt2', 'fsdb'] as const;

/**
 * `sby`'s two trace announcements, plus the generic case.
 *
 * Anchored on the announcement text rather than on "any path ending
 * `.vcd`": an engine that merely *mentions* a filename it did not write
 * would otherwise produce a link to a file that does not exist. The
 * spellings are the ones `SbyLogReader` itself parses
 * (`_traceWritten` / `_traceSummary`), so the provider and the product's
 * own reader recognise the same lines.
 */
const TRACE_PATTERNS: readonly RegExp[] = [
  /Writing trace to (?:VCD|FST) file:\s*(\S+)/,
  /summary:\s*(?:counterexample|cover)\s+trace:\s*(\S+)/,
];

/**
 * A source reference: `path.ext:LINE[:COLUMN]`.
 *
 * The extension list is anchored so that a bare `12:34` timestamp in
 * `sby`'s own progress output (`##   0:00:04  Checking assertions…`) is
 * never mistaken for a file at line 34 — the single most common false
 * positive in a formal log, and the reason this is not a generic
 * `(\S+):(\d+)` pattern.
 */
const SOURCE_PATTERN =
  /(?<![\w/.-])((?:[A-Za-z]:)?[\w./\\@+-]*\.(?:sv|svh|v|vh|vhd|vhdl|py|sby|cpp|cc|h))(?::(\d+))(?::(\d+))?/g;

function traceExtensionOf(candidate: string): string | undefined {
  const dot = candidate.lastIndexOf('.');
  if (dot < 0) return undefined;
  const extension = candidate.slice(dot + 1).toLowerCase();
  return (TRACE_EXTENSIONS as readonly string[]).includes(extension) ? extension : undefined;
}

/**
 * Find the links in one terminal line.
 *
 * Trace announcements are matched first and their span suppresses any
 * source reference inside it, so `engine_0/trace.vcd` is one trace link
 * rather than a trace link overlapping a spurious source link. Overlapping
 * links are rejected by VSCode outright, so this is correctness rather
 * than tidiness.
 */
export function detectSimTerminalLinks(line: string): readonly SimTerminalLink[] {
  const links: SimTerminalLink[] = [];
  const claimed: Array<{ start: number; end: number }> = [];

  for (const pattern of TRACE_PATTERNS) {
    const match = pattern.exec(line);
    const path = match?.[1];
    if (match === null || match === undefined || path === undefined) continue;
    if (traceExtensionOf(path) === undefined) continue;
    const startIndex = match.index + match[0].lastIndexOf(path);
    links.push({ startIndex, length: path.length, target: { kind: 'trace', path } });
    claimed.push({ start: startIndex, end: startIndex + path.length });
  }

  SOURCE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SOURCE_PATTERN.exec(line)) !== null) {
    const path = match[1];
    const rawLine = match[2];
    if (path === undefined || rawLine === undefined) continue;
    const startIndex = match.index;
    const length = match[0].length;
    if (claimed.some((span) => startIndex < span.end && startIndex + length > span.start)) continue;
    const lineNumber = Number.parseInt(rawLine, 10);
    if (!Number.isFinite(lineNumber) || lineNumber < 1) continue;
    const rawColumn = match[3];
    const column = rawColumn === undefined ? undefined : Number.parseInt(rawColumn, 10);
    links.push({
      startIndex,
      length,
      target: {
        kind: 'source',
        path,
        line: lineNumber,
        ...(column === undefined || !Number.isFinite(column) || column < 1 ? {} : { column }),
      },
    });
  }

  return links.sort((a, b) => a.startIndex - b.startIndex);
}

/** A `vscode.TerminalLink` carrying the target through to `handleTerminalLink`. */
export interface SimTerminalLinkHandle extends vscode.TerminalLink {
  readonly target: SimTerminalLinkTarget;
}

/** What [SimTerminalLinkProvider] needs from `activate()`. */
export interface SimTerminalLinkProviderOptions {
  /** Open a source file at a 1-based line/column. */
  readonly openSource: (target: { path: string; line: number; column?: number }) => Promise<void>;
  /** Hand a trace to the WaveCrux tab — the same handoff the tree uses. */
  readonly openTrace: (path: string) => Promise<void>;
}

/** The tooltip on a source link. */
export function sourceLinkTooltip(): string {
  return vscode.l10n.t('Open in the editor');
}

/** The tooltip on a trace link. */
export function traceLinkTooltip(): string {
  return vscode.l10n.t('Open the waveform in WaveCrux');
}

/**
 * Registers the two link kinds above.
 *
 * `provideTerminalLinks` is called for **every** line of every terminal in
 * the window, so it must stay cheap and must claim nothing it is not sure
 * about — a provider that throws or hangs degrades link handling for the
 * whole workbench, not just for SimCrux's terminal.
 */
export class SimTerminalLinkProvider
  implements vscode.TerminalLinkProvider<SimTerminalLinkHandle>
{
  constructor(private readonly options: SimTerminalLinkProviderOptions) {}

  provideTerminalLinks(context: vscode.TerminalLinkContext): SimTerminalLinkHandle[] {
    return detectSimTerminalLinks(context.line).map((link) => {
      const handle = new vscode.TerminalLink(
        link.startIndex,
        link.length,
        link.target.kind === 'trace' ? traceLinkTooltip() : sourceLinkTooltip(),
      ) as vscode.TerminalLink & { target: SimTerminalLinkTarget };
      handle.target = link.target;
      return handle;
    });
  }

  async handleTerminalLink(link: SimTerminalLinkHandle): Promise<void> {
    if (link.target.kind === 'trace') {
      await this.options.openTrace(link.target.path);
      return;
    }
    await this.options.openSource({
      path: link.target.path,
      line: link.target.line,
      ...(link.target.column === undefined ? {} : { column: link.target.column }),
    });
  }
}
