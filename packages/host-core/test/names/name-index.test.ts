import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NameIndex, isExactMatch } from '../../src/names/name-index';
import { parseStems, type StemsEntry } from '../../src/names/stems-parser';

const FIXTURES = fileURLToPath(new URL('../fixtures/stems', import.meta.url));

function fixture(name: string): readonly StemsEntry[] {
  return parseStems(readFileSync(`${FIXTURES}/${name}`, 'utf8')).entries;
}

/** A Linux-shaped index: case-sensitive paths, so assertions are exact. */
function index(): NameIndex {
  return new NameIndex('linux');
}

function loaded(): NameIndex {
  const nameIndex = index();
  nameIndex.replace('/ws/top.stems', fixture('ambiguous-instantiations.stems'));
  return nameIndex;
}

describe('NameIndex — forward direction (path → file+line)', () => {
  it('resolves an exact path', () => {
    expect(loaded().locationsFor('top.alu_a.result')).toEqual([
      { path: 'top.alu_a.result', sourceFile: '/ws/rtl/alu.sv', lineNumber: 21, kind: 'variable' },
    ]);
  });

  it('falls back to a case-insensitive path match', () => {
    expect(loaded().locationsFor('TOP.ALU_A.RESULT')[0]?.path).toBe('top.alu_a.result');
  });

  it('falls back to the trailing component, bit range stripped', () => {
    const nameIndex = index();
    nameIndex.replace('/ws/a.stems', fixture('mixed-case-and-bitrange.stems'));
    // The waveform calls it `sim.dut.data[7:0]`; stems calls it `data[7:0]`
    // under a different scope. Tier 3 still finds the declaration.
    expect(nameIndex.locationsFor('sim.dut.data[7:0]')[0]?.lineNumber).toBe(11);
  });

  it('prefers a variable over a scope at the same tier', () => {
    const nameIndex = index();
    nameIndex.replace('/ws/a.stems', [
      { path: 'top.thing', sourceFile: '/s.v', lineNumber: 3, kind: 'scope' },
      { path: 'top.thing', sourceFile: '/s.v', lineNumber: 4, kind: 'variable' },
    ]);
    expect(nameIndex.locationsFor('top.thing')).toEqual([
      { path: 'top.thing', sourceFile: '/s.v', lineNumber: 4, kind: 'variable' },
    ]);
  });

  it('returns every match at the winning tier, not just the first', () => {
    // `result` exists under both instantiations; tier 3 must offer both.
    expect(loaded().locationsFor('result').map((entry) => entry.path)).toEqual([
      'top.alu_a.result',
      'top.alu_b.result',
    ]);
  });

  it('answers nothing for an unknown path, without throwing', () => {
    expect(loaded().locationsFor('nope.not.here')).toEqual([]);
    expect(loaded().locationsFor('   ')).toEqual([]);
  });
});

describe('NameIndex — reverse direction (file+line → paths)', () => {
  it('returns declarations at a line with two hash lookups', () => {
    expect(loaded().declarationsAt('/ws/rtl/alu.sv', 21)).toHaveLength(2);
    expect(loaded().declarationsAt('/ws/rtl/alu.sv', 999)).toEqual([]);
    expect(loaded().declarationsAt('/ws/rtl/nothing.sv', 21)).toEqual([]);
  });

  it('answers a visible range without scanning the index', () => {
    const nameIndex = loaded();
    // Lines 12..21 of alu.sv: two module headers, two `clk`, two `result`.
    const visible = nameIndex.declarationsInRange('/ws/rtl/alu.sv', 12, 21);
    expect(visible.map((entry) => entry.path).sort()).toEqual([
      'top.alu_a',
      'top.alu_a.clk',
      'top.alu_a.result',
      'top.alu_b',
      'top.alu_b.clk',
      'top.alu_b.result',
    ]);
  });

  it('clamps a reversed or absurd range instead of walking it', () => {
    const nameIndex = loaded();
    expect(nameIndex.declarationsInRange('/ws/rtl/alu.sv', 30, 10)).toEqual([]);
    expect(nameIndex.declarationsInRange('/ws/rtl/alu.sv', -1_000_000, 4)).toEqual([]);
  });

  it('matches a stems file that recorded a relative source path', () => {
    const nameIndex = index();
    nameIndex.replace('/ws/a.stems', fixture('relative-paths.stems'));
    // Stems says `rtl/alu.sv`; the editor has the absolute real path.
    expect(nameIndex.declarationsAt('/ws/project/rtl/alu.sv', 21)).toHaveLength(1);
  });

  it('prefers a full-path match over the basename fallback', () => {
    const nameIndex = index();
    nameIndex.replace('/ws/a.stems', [
      { path: 'a.sig', sourceFile: '/ws/one/alu.sv', lineNumber: 5, kind: 'variable' },
      { path: 'b.sig', sourceFile: '/ws/two/alu.sv', lineNumber: 5, kind: 'variable' },
    ]);
    expect(nameIndex.declarationsAt('/ws/one/alu.sv', 5).map((entry) => entry.path)).toEqual([
      'a.sig',
    ]);
  });

  it('folds path case on the platforms whose filesystems do', () => {
    const entries = fixture('mixed-case-and-bitrange.stems');
    const mac = new NameIndex('darwin');
    mac.replace('/ws/a.stems', entries);
    expect(mac.declarationsAt('/ws/rtl/regfile.sv', 11)).toHaveLength(1);

    const linux = new NameIndex('linux');
    linux.replace('/ws/a.stems', entries);
    expect(linux.declarationsAt('/ws/rtl/regfile.sv', 11)).toEqual([]);
  });
});

describe('NameIndex — candidates and ambiguity', () => {
  it('returns every instantiation, never just the first', () => {
    const candidates = loaded().candidatesFor({
      fsPath: '/ws/rtl/alu.sv',
      line: 21,
      identifier: 'result',
    });
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'top.alu_a.result',
      'top.alu_b.result',
    ]);
    expect(candidates.every((candidate) => candidate.origin === 'stems-declaration')).toBe(true);
  });

  it('ranks the declaration line above a file match above a name match', () => {
    // Three declarations of `sig`: one on the queried line, one elsewhere
    // in the queried file, one in another file entirely.
    const nameIndex = index();
    nameIndex.replace('/ws/a.stems', [
      { path: 'top.a.sig', sourceFile: '/ws/a.sv', lineNumber: 10, kind: 'variable' },
      { path: 'top.b.sig', sourceFile: '/ws/a.sv', lineNumber: 40, kind: 'variable' },
      { path: 'top.c.sig', sourceFile: '/ws/b.sv', lineNumber: 7, kind: 'variable' },
    ]);
    const candidates = nameIndex.candidatesFor({
      fsPath: '/ws/a.sv',
      line: 10,
      identifier: 'sig',
    });
    expect(candidates.map((candidate) => [candidate.path, candidate.origin])).toEqual([
      ['top.a.sig', 'stems-declaration'],
      ['top.b.sig', 'stems-file'],
      ['top.c.sig', 'stems-name'],
    ]);
  });

  it('is deterministic — same query, same order, every time', () => {
    const nameIndex = loaded();
    const query = { fsPath: '/ws/rtl/alu.sv', line: 18, identifier: 'clk' } as const;
    const first = nameIndex.candidatesFor(query);
    const second = nameIndex.candidatesFor(query);
    expect(second).toEqual(first);
  });

  it('matches a selection with a bit range against a plain declaration', () => {
    const nameIndex = index();
    nameIndex.replace('/ws/a.stems', fixture('mixed-case-and-bitrange.stems'));
    expect(
      nameIndex
        .candidatesFor({ fsPath: '/ws/rtl/Regfile.SV', identifier: 'DATA[3:1]' })
        .map((candidate) => candidate.path),
    ).toEqual(['Top.RegFile.data[7:0]']);
  });

  it('reports the declaration site with each candidate', () => {
    const [candidate] = loaded().candidatesFor({
      fsPath: '/ws/rtl/alu.sv',
      identifier: 'result',
    });
    expect(candidate?.declaredAt).toEqual({ fsPath: '/ws/rtl/alu.sv', lineNumber: 21 });
  });

  it('answers nothing for a blank identifier', () => {
    expect(loaded().candidatesFor({ fsPath: '/ws/rtl/alu.sv', identifier: '  ' })).toEqual([]);
  });

  it('labels every stems origin as exact and the hierarchy one as not', () => {
    expect(isExactMatch('stems-declaration')).toBe(true);
    expect(isExactMatch('stems-file')).toBe(true);
    expect(isExactMatch('stems-name')).toBe(true);
    expect(isExactMatch('hierarchy-name')).toBe(false);
  });
});

describe('NameIndex — incremental shards', () => {
  it('replaces one stems file without disturbing the others', () => {
    const nameIndex = index();
    nameIndex.replace('/ws/top.stems', fixture('ambiguous-instantiations.stems'));
    nameIndex.replace('/ws/other.stems', fixture('relative-paths.stems'));
    const before = nameIndex.locationsFor('top.alu_a.result');

    nameIndex.replace('/ws/other.stems', [
      { path: 'other.sig', sourceFile: '/ws/other.sv', lineNumber: 2, kind: 'variable' },
    ]);

    expect(nameIndex.locationsFor('top.alu_a.result')).toEqual(before);
    expect(nameIndex.locationsFor('top.alu.carry')).toEqual([]);
    expect(nameIndex.locationsFor('other.sig')).toHaveLength(1);
    expect([...nameIndex.stemsFiles].sort()).toEqual(['/ws/other.stems', '/ws/top.stems']);
  });

  it('removes exactly one shard from every bucket it shared', () => {
    const nameIndex = index();
    const shared: StemsEntry = {
      path: 'top.clk',
      sourceFile: '/ws/top.sv',
      lineNumber: 4,
      kind: 'variable',
    };
    nameIndex.replace('/ws/a.stems', [shared]);
    nameIndex.replace('/ws/b.stems', [shared]);
    expect(nameIndex.declarationsAt('/ws/top.sv', 4)).toHaveLength(2);

    nameIndex.remove('/ws/a.stems');
    expect(nameIndex.declarationsAt('/ws/top.sv', 4)).toHaveLength(1);
    expect(nameIndex.locationsFor('top.clk')).toHaveLength(1);
  });

  it('leaves no residue behind after removing everything', () => {
    const nameIndex = loaded();
    nameIndex.remove('/ws/top.stems');
    expect(nameIndex.size).toBe(0);
    expect(nameIndex.isEmpty).toBe(true);
    expect(nameIndex.locationsFor('top.alu_a.result')).toEqual([]);
    expect(nameIndex.declarationsAt('/ws/rtl/alu.sv', 21)).toEqual([]);
    expect(nameIndex.candidatesFor({ fsPath: '/ws/rtl/alu.sv', identifier: 'result' })).toEqual([]);
  });

  it('ignores removal of a stems file it never had', () => {
    const nameIndex = loaded();
    expect(() => {
      nameIndex.remove('/ws/never.stems');
    }).not.toThrow();
    expect(nameIndex.size).toBe(8);
  });

  it('reindexing the same file twice is idempotent, not additive', () => {
    const nameIndex = index();
    const entries = fixture('ambiguous-instantiations.stems');
    nameIndex.replace('/ws/top.stems', entries);
    const size = nameIndex.size;
    nameIndex.replace('/ws/top.stems', entries);
    expect(nameIndex.size).toBe(size);
    expect(nameIndex.declarationsAt('/ws/rtl/alu.sv', 21)).toHaveLength(2);
  });
});
