import { describe, expect, it } from 'vitest';
import { placeNetCruxLink, type NetCruxNameLocator } from '../../src/links/place';

const sameSpelling = (a: string, b: string): Promise<boolean> => Promise.resolve(a === b);

function locator(answers: Record<string, { fsPath: string; lineNumber: number }>): NetCruxNameLocator & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    sourceLocationFor: (name) => {
      asked.push(name);
      const answer = answers[name];
      return Promise.resolve(answer === undefined ? { ok: false } : { ok: true, ...answer });
    },
  };
}

describe('placeNetCruxLink', () => {
  it('puts the cursor on the line the netlist index gives, in the opened source', async () => {
    const index = locator({ 'top.u_cpu.pc_reg': { fsPath: '/rtl/cpu.sv', lineNumber: 41 } });
    expect(await placeNetCruxLink({ name: 'top.u_cpu.pc_reg' }, '/rtl/cpu.sv', index, sameSpelling)).toEqual({
      kind: 'line',
      line: 41,
    });
  });

  it('says so, rather than guessing, when the index places the element in another file or not at all', async () => {
    const index = locator({ 'top.u_cpu.pc_reg': { fsPath: '/rtl/other.sv', lineNumber: 9 } });
    expect(await placeNetCruxLink({ name: 'top.u_cpu.pc_reg' }, '/rtl/cpu.sv', index, sameSpelling)).toEqual({
      kind: 'not-placed',
    });
    expect(await placeNetCruxLink({ name: 'top.nope' }, '/rtl/cpu.sv', index, sameSpelling)).toEqual({
      kind: 'not-placed',
    });
  });

  it('refuses a line the index cannot mean', async () => {
    const index = locator({ a: { fsPath: '/rtl/cpu.sv', lineNumber: 0 } });
    expect(await placeNetCruxLink({ name: 'a' }, '/rtl/cpu.sv', index, sameSpelling)).toEqual({ kind: 'not-placed' });
  });

  it('asks the index nothing for a link with no element, or for a netlist (its preview selects)', async () => {
    const index = locator({ 'top.u': { fsPath: '/w/top.JSON', lineNumber: 3 } });
    expect(await placeNetCruxLink({}, '/rtl/cpu.sv', index, sameSpelling)).toEqual({ kind: 'opened' });
    expect(await placeNetCruxLink({ name: 'top.u' }, '/w/top.JSON', index, sameSpelling)).toEqual({
      kind: 'not-placed',
    });
    expect(index.asked).toEqual([]);
  });

  it('never throws when the index does', async () => {
    const broken: NetCruxNameLocator = { sourceLocationFor: () => Promise.reject(new Error('index gone')) };
    expect(await placeNetCruxLink({ name: 'a' }, '/rtl/cpu.sv', broken, sameSpelling)).toEqual({ kind: 'not-placed' });
  });
});
