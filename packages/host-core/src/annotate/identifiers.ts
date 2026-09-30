/**
 * Finding the identifiers on one line of HDL, cheaply enough to do it for
 * every visible line on every cursor move.
 *
 * ### Why a scanner and not a parser
 *
 * The annotation loop runs on scroll. A real Verilog/VHDL front end is the
 * right tool for "what does this identifier bind to" and entirely the wrong
 * tool for "what words are on these forty lines, sixty times a second" — it
 * would need the whole file, a preprocessor, and an include path, and it
 * would still be answering a question the stems index has already answered
 * exactly. So this is a word scanner with three exclusions (comments,
 * string literals, keywords) and no opinions.
 *
 * The consequence is honest and worth stating: a word that *looks* like a
 * signal but is a macro argument, a parameter, or a function name is
 * offered to the index, which answers "no such declaration" and the line is
 * not annotated. False positives cost a failed hash lookup. There is no
 * category of false *annotation* here, because nothing is annotated that
 * the stems file did not name.
 *
 * ### Block comments
 *
 * A slash-star block comment is stripped only within a line. One spanning lines
 * would need state carried across the viewport, and the payoff is
 * annotating nothing inside a commented-out module — which is the same
 * outcome as annotating it, since a commented-out signal still has a stems
 * entry and still has a value. The cost of being wrong is an annotation on
 * a dead line, not a wrong value on a live one.
 */

/** HDL dialects this module knows how to strip comments for. */
export type HdlDialect = 'verilog' | 'vhdl';

/**
 * VSCode language ids this module will annotate, mapped to their dialect.
 *
 * Deliberately a closed list. Annotating an arbitrary text document because
 * it happens to contain a word that matches a stems entry is exactly the
 * intrusion the whole feature is gated to avoid.
 */
export const HDL_LANGUAGE_IDS: Readonly<Record<string, HdlDialect>> = {
  verilog: 'verilog',
  systemverilog: 'verilog',
  'verilog-header': 'verilog',
  'systemverilog-header': 'verilog',
  vhdl: 'vhdl',
};

/** The dialect for [languageId], or `undefined` if it is not HDL. */
export function hdlDialectFor(languageId: string): HdlDialect | undefined {
  return HDL_LANGUAGE_IDS[languageId];
}

/**
 * Words that are never a signal, so never worth a lookup.
 *
 * Not a complete reserved-word list and not trying to be: this is a
 * *performance* filter over the words that dominate real RTL, and the
 * correctness filter is the stems index itself. Adding every keyword in
 * IEEE 1800 would make the set slower to consult and no more correct.
 */
const COMMON_KEYWORDS: ReadonlySet<string> = new Set([
  // Verilog / SystemVerilog
  'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic',
  'bit', 'byte', 'integer', 'int', 'real', 'time', 'parameter', 'localparam',
  'always', 'always_ff', 'always_comb', 'always_latch', 'initial', 'assign',
  'begin', 'end', 'if', 'else', 'case', 'casex', 'casez', 'endcase',
  'default', 'for', 'while', 'repeat', 'forever', 'function', 'endfunction',
  'task', 'endtask', 'posedge', 'negedge', 'or', 'and', 'not', 'nand', 'nor',
  'xor', 'xnor', 'buf', 'generate', 'endgenerate', 'genvar', 'signed',
  'unsigned', 'typedef', 'struct', 'union', 'enum', 'package', 'endpackage',
  'import', 'export', 'interface', 'endinterface', 'modport', 'class',
  'endclass', 'extends', 'virtual', 'static', 'automatic', 'const', 'ref',
  'return', 'break', 'continue', 'unique', 'priority', 'wait', 'fork', 'join',
  // VHDL
  'entity', 'architecture', 'signal', 'variable', 'constant', 'process',
  'port', 'map', 'component', 'library', 'use', 'is', 'of', 'then', 'elsif',
  'when', 'others', 'loop', 'downto', 'to', 'std_logic', 'std_logic_vector',
  'in', 'out', 'buffer', 'type', 'subtype', 'array', 'record', 'null',
  'procedure', 'generic', 'attribute', 'with', 'select',
]);

/** Verilog/VHDL identifier: a letter or `_` then letters, digits, `_`, `$`. */
const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_$]*/g;

/**
 * Strip what is not code: line comments, in-line block comments, and string
 * literals.
 *
 * Replaced with spaces rather than removed so every surviving character
 * keeps its column — the caller does not need columns today, but a decorator
 * that wanted to underline the identifier would, and a scanner that
 * silently renumbers columns is a trap laid for that change.
 */
export function stripNonCode(line: string, dialect: HdlDialect): string {
  const blanked = line.replace(/"(?:[^"\\]|\\.)*"?/g, (match) => ' '.repeat(match.length));
  const withoutBlocks = blanked.replace(/\/\*.*?(?:\*\/|$)/g, (match) => ' '.repeat(match.length));
  // `//` for Verilog, `--` for VHDL — not both for both. SystemVerilog's
  // `--` decrement operator would otherwise blank the rest of a live line.
  const lineComment = dialect === 'vhdl' ? withoutBlocks.indexOf('--') : withoutBlocks.indexOf('//');
  return lineComment < 0 ? withoutBlocks : withoutBlocks.slice(0, lineComment);
}

/**
 * The distinct identifiers on [line], in source order, capped at [limit].
 *
 * Order is source order and the cap applies after de-duplication, so a line
 * that mentions one signal eight times spends one lookup and leaves seven
 * slots for the rest of the line. Case is preserved — the index folds it —
 * so the annotation can echo the word the user actually wrote.
 */
export function identifiersOnLine(
  line: string,
  dialect: HdlDialect,
  limit: number,
): readonly string[] {
  if (limit <= 0) return [];
  const code = stripNonCode(line, dialect);
  const found: string[] = [];
  const seen = new Set<string>();
  IDENTIFIER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER.exec(code)) !== null) {
    const word = match[0];
    const folded = word.toLowerCase();
    if (COMMON_KEYWORDS.has(folded) || seen.has(folded)) continue;
    seen.add(folded);
    found.push(word);
    if (found.length >= limit) break;
  }
  return found;
}
