import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NameIndex } from '../../src/names/name-index';
import { parseStems, type StemsEntry } from '../../src/names/stems-parser';
import {
  DEFAULT_ANNOTATION_LIMITS,
  PinnedPathStore,
  resolveViewport,
  type ResolvedIdentifier,
  type ViewportLine,
} from '../../src/annotate/model';

const FIXTURES = fileURLToPath(new URL('../fixtures/stems', import.meta.url));

function fixture(name: string): readonly StemsEntry[] {
  return parseStems(readFileSync(`${FIXTURES}/${name}`, 'utf8')).entries;
}

/**
 * The two-instantiation fixture: `/ws/rtl/alu.sv:21` declares BOTH
 * `top.alu_a.result` and `top.alu_b.result`, and `/ws/rtl/top.sv:4` declares
 * `top.clk` — which `alu.sv` also has two `clk`s of, under other scopes.
 */
function loaded(): NameIndex {
  const index = new NameIndex('linux');
  index.replace('/ws/top.stems', fixture('ambiguous-instantiations.stems'));
  return index;
}

function lines(...entries: [number, string][]): readonly ViewportLine[] {
  return entries.map(([line, text]) => ({ line, text }));
}

function resolve(
  fsPath: string,
  viewport: readonly ViewportLine[],
  options: { languageId?: string; pinned?: PinnedPathStore } = {},
): ReturnType<typeof resolveViewport> {
  return resolveViewport({
    index: loaded(),
    fsPath,
    languageId: options.languageId ?? 'systemverilog',
    lines: viewport,
    ...(options.pinned !== undefined ? { pinned: options.pinned } : {}),
  });
}

function identifiersOf(resolution: ReturnType<typeof resolveViewport>): ResolvedIdentifier[] {
  return resolution.lines.flatMap((line) => [...line.identifiers]);
}

describe('resolveViewport — gating', () => {
  it('resolves nothing in a non-HDL document', () => {
    const resolution = resolve('/ws/rtl/top.sv', lines([4, 'wire clk;']), {
      languageId: 'plaintext',
    });
    expect(resolution).toEqual({ lines: [], paths: [], linesScanned: 0, lookups: 0 });
  });

  it('resolves nothing for a file the index has never heard of', () => {
    // `clk` is a stems entry three times over — in `top.sv` and twice in
    // `alu.sv`. None of them says anything about *this* file, so nothing is
    // annotated. A quick-pick would offer them (labelled as name matches);
    // ambient text in someone's source may not.
    const resolution = resolve('/ws/rtl/unknown.sv', lines([4, 'wire clk;']));
    expect(resolution.lines).toEqual([]);
    expect(resolution.paths).toEqual([]);
  });

  it('drops a same-named signal declared only in another covered file', () => {
    // `result` exists in `alu.sv` and nowhere in `top.sv`. Annotating
    // `top.sv`'s `result` with `top.alu_a.result` would be a cross-file
    // guess wearing an exact-match label.
    const resolution = resolve('/ws/rtl/top.sv', lines([30, '  result = 1;']));
    expect(resolution.lines).toEqual([]);
  });
});

describe('resolveViewport — unambiguous', () => {
  it('annotates a declaration line with its one path', () => {
    const resolution = resolve('/ws/rtl/top.sv', lines([4, '  wire clk;']));
    expect(identifiersOf(resolution)).toEqual([
      { kind: 'unique', identifier: 'clk', path: 'top.clk' },
    ]);
    expect(resolution.paths).toEqual(['top.clk']);
  });

  it('does not let same-named signals in other files make a declaration '
    + 'ambiguous', () => {
    // `alu.sv` declares `top.alu_a.clk` and `top.alu_b.clk`. Those are
    // `stems-name` matches from another file; the queried line IS the
    // declaration of `top.clk`, so the better tier wins outright. Without
    // that narrowing every clock in every design would render as ambiguous.
    const resolution = resolve('/ws/rtl/top.sv', lines([4, '  wire clk;']));
    const [only] = identifiersOf(resolution);
    expect(only?.kind).toBe('unique');
  });

  it('annotates a usage line, not only a declaration', () => {
    // The whole point of the reverse index being per-line rather than
    // per-declaration: line 30 is not where `clk` was declared.
    const resolution = resolve('/ws/rtl/top.sv', lines([30, '  if (clk) begin']));
    expect(identifiersOf(resolution)).toEqual([
      { kind: 'unique', identifier: 'clk', path: 'top.clk' },
    ]);
  });

  it('de-duplicates paths across the viewport', () => {
    const resolution = resolve(
      '/ws/rtl/top.sv',
      lines([4, 'wire clk;'], [30, 'if (clk) begin'], [31, 'clk <= 0;']),
    );
    expect(resolution.paths).toEqual(['top.clk']);
    expect(resolution.lines).toHaveLength(3);
  });
});

describe('resolveViewport — ambiguity is shown, never guessed', () => {
  it('reports every candidate rather than taking the first', () => {
    const resolution = resolve('/ws/rtl/alu.sv', lines([21, '  wire [31:0] result;']));
    expect(identifiersOf(resolution)).toEqual([
      {
        kind: 'ambiguous',
        identifier: 'result',
        paths: ['top.alu_a.result', 'top.alu_b.result'],
      },
    ]);
  });

  it('asks for no value for an ambiguous identifier', () => {
    // Nothing is queried, so nothing can come back and be attributed to the
    // wrong instance.
    const resolution = resolve('/ws/rtl/alu.sv', lines([21, '  wire [31:0] result;']));
    expect(resolution.paths).toEqual([]);
  });

  it('orders candidates deterministically', () => {
    const first = resolve('/ws/rtl/alu.sv', lines([21, 'result = 1;']));
    const second = resolve('/ws/rtl/alu.sv', lines([21, 'result = 1;']));
    expect(first.lines).toEqual(second.lines);
  });

  it('honours a pinned choice, and only one that is actually a candidate', () => {
    const pinned = new PinnedPathStore();
    pinned.set('/ws/rtl/alu.sv', 'result', 'top.alu_b.result');
    expect(
      identifiersOf(resolve('/ws/rtl/alu.sv', lines([21, 'result = 1;']), { pinned })),
    ).toEqual([{ kind: 'unique', identifier: 'result', path: 'top.alu_b.result' }]);

    const bogus = new PinnedPathStore();
    bogus.set('/ws/rtl/alu.sv', 'result', 'top.somewhere.else');
    expect(
      identifiersOf(resolve('/ws/rtl/alu.sv', lines([21, 'result = 1;']), { pinned: bogus }))[0]
        ?.kind,
    ).toBe('ambiguous');
  });

  it('pins per file and identifier, case-folded', () => {
    const pinned = new PinnedPathStore();
    pinned.set('/ws/rtl/alu.sv', 'RESULT', 'top.alu_a.result');
    expect(pinned.get('/ws/rtl/alu.sv', 'result')).toBe('top.alu_a.result');
    expect(pinned.get('/ws/rtl/other.sv', 'result')).toBeUndefined();
  });
});

describe('resolveViewport — bounds', () => {
  it('stops after maxLines however many lines are handed to it', () => {
    const viewport = Array.from({ length: 5_000 }, (_, index) => ({
      line: index + 1,
      text: 'clk = 1;',
    }));
    const resolution = resolveViewport({
      index: loaded(),
      fsPath: '/ws/rtl/top.sv',
      languageId: 'systemverilog',
      lines: viewport,
      limits: { maxLines: 40 },
    });
    expect(resolution.linesScanned).toBe(40);
  });

  it('caps the paths one query may carry', () => {
    const resolution = resolveViewport({
      index: loaded(),
      fsPath: '/ws/rtl/top.sv',
      languageId: 'systemverilog',
      lines: lines([4, 'wire clk;']),
      limits: { maxPaths: 0 },
    });
    // Still resolved — the cap governs what is *asked about*, not what the
    // viewport means.
    expect(resolution.lines).toHaveLength(1);
    expect(resolution.paths).toEqual([]);
  });

  it('caps annotations per line', () => {
    const resolution = resolveViewport({
      index: loaded(),
      fsPath: '/ws/rtl/alu.sv',
      languageId: 'systemverilog',
      lines: lines([21, 'result = result + clk;']),
      limits: { entriesPerLine: 1 },
    });
    expect(resolution.lines[0]?.identifiers).toHaveLength(1);
  });

  it('counts one lookup per candidate identifier, for the profile', () => {
    const resolution = resolve('/ws/rtl/top.sv', lines([4, 'wire clk; wire nope;']));
    // `wire` is a keyword and never reaches the index.
    expect(resolution.lookups).toBe(2);
    expect(resolution.linesScanned).toBe(1);
  });

  it('documents its defaults', () => {
    expect(DEFAULT_ANNOTATION_LIMITS).toEqual({
      identifiersPerLine: 8,
      maxLines: 400,
      maxPaths: 256,
      entriesPerLine: 3,
    });
  });
});
