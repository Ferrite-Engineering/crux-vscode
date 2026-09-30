import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  revealDesignPathInEditor,
  type DesignPathSourceResolver,
} from '../../src/editor/design-path-navigation';
import { NameIndex } from '../../src/names/name-index';
import { NameResolver } from '../../src/names/resolver';
import { parseStems } from '../../src/names/stems-parser';
import { FakeEditorHost } from './harness';

/** A resolver over one synthetic stems file, contained by [folders]. */
function resolverFor(lines: readonly string[], folders: readonly string[]): NameResolver {
  const index = new NameIndex();
  index.replace('/w/design.stems', parseStems(lines.join('\n')).entries);
  return new NameResolver({ index, workspaceFolders: () => folders });
}

/**
 * The waveform-selection follow, end to end against the **real**
 * `NameResolver` over a **real** stems file on a **real** temp workspace.
 *
 * Deliberately not a stubbed resolver on the happy path: the value of this
 * feature is that the stems index, the §11 containment gate and the caret
 * arithmetic agree with each other, and each of those is exactly the kind
 * of thing a fake agrees with by construction.
 */
describe('revealDesignPathInEditor — over a real stems index', () => {
  let root: string;
  let sourcePath: string;
  let stemsLines: readonly string[];
  let resolver: NameResolver;
  let editor: FakeEditorHost;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'crux-follow-')));
    await mkdir(join(root, 'rtl'), { recursive: true });
    sourcePath = join(root, 'rtl', 'alu.v');
    await writeFile(sourcePath, 'module alu;\n  wire [31:0] result;\nendmodule\n', 'utf8');

    stemsLines = [
      `++ comp 1 file ${sourcePath}`,
      '++ module top.cpu.alu 1 1',
      '++ var top.cpu.alu.result 1 2',
    ];
    resolver = resolverFor(stemsLines, [root]);
    editor = new FakeEditorHost(
      [root],
      new Map([[sourcePath, ['module alu;', '  wire [31:0] result;', 'endmodule']]]),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reveals the declaration line of the selected signal', async () => {
    const outcome = await revealDesignPathInEditor('top.cpu.alu.result', {
      resolver,
      editor,
      enabled: () => true,
    });
    expect(outcome).toEqual({ kind: 'revealed', fsPath: sourcePath, lineNumber: 2 });
    // Stems counts lines from 1 and `Position` from 0. An off-by-one here
    // does not fail — it silently lands one line away from the declaration.
    expect(editor.shown[0]?.position).toEqual({ line: 1, character: 0 });
  });

  it('resolves a scope as well as a signal', async () => {
    const outcome = await revealDesignPathInEditor('top.cpu.alu', {
      resolver,
      editor,
      enabled: () => true,
    });
    expect(outcome).toMatchObject({ kind: 'revealed', lineNumber: 1 });
  });

  it('never moves focus out of the waveform the user is driving', async () => {
    await revealDesignPathInEditor('top.cpu.alu.result', {
      resolver,
      editor,
      enabled: () => true,
    });
    // `preview: true` as well, so twenty clicks replace one tab rather than
    // filling the editor group.
    expect(editor.shown[0]?.options).toEqual({ preserveFocus: true, preview: true });
  });

  it('reveals into the group the caller names, not the active one', async () => {
    // A waveform panel is an editor tab, so the active group when the user
    // clicks a signal is the panel's own — revealing there covers the thing
    // they are driving. Caught by live verification, not by a test.
    await revealDesignPathInEditor('top.cpu.alu.result', {
      resolver,
      editor,
      enabled: () => true,
      viewColumn: () => 1,
    });
    expect(editor.shown[0]?.options).toEqual({
      preserveFocus: true,
      preview: true,
      viewColumn: 1,
    });
  });

  it('does nothing at all when the setting is off — not even a lookup', async () => {
    let asked = 0;
    const counting: DesignPathSourceResolver = {
      sourceLocationFor: async (path) => {
        asked += 1;
        return await resolver.sourceLocationFor(path);
      },
    };
    const outcome = await revealDesignPathInEditor('top.cpu.alu.result', {
      resolver: counting,
      editor,
      enabled: () => false,
    });
    expect(outcome).toEqual({ kind: 'disabled' });
    expect(asked).toBe(0);
    expect(editor.shown).toEqual([]);
  });

  it('reads the setting per call, so a mid-session change takes effect', async () => {
    let on = false;
    const options = { resolver, editor, enabled: (): boolean => on };
    expect((await revealDesignPathInEditor('top.cpu.alu.result', options)).kind).toBe('disabled');
    on = true;
    expect((await revealDesignPathInEditor('top.cpu.alu.result', options)).kind).toBe('revealed');
  });

  it('is silent for a path no stems entry knows', async () => {
    const outcome = await revealDesignPathInEditor('top.cpu.nowhere', {
      resolver,
      editor,
      enabled: () => true,
    });
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'unknown-path' });
    expect(editor.shown).toEqual([]);
  });

  it('is silent for an empty path', async () => {
    const outcome = await revealDesignPathInEditor('', { resolver, editor, enabled: () => true });
    expect(outcome.kind).toBe('unresolved');
    expect(editor.shown).toEqual([]);
  });

  it('refuses a stems file that names something outside the workspace (§11)', async () => {
    // A stems file is workspace content — generated by a tool, often
    // checked in, and entirely capable of naming ~/.ssh/id_ed25519.
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'crux-outside-')));
    const secret = join(outside, 'id_ed25519');
    await writeFile(secret, 'PRIVATE KEY\n', 'utf8');
    const leaky = resolverFor([`++ comp 1 file ${secret}`, '++ var top.leak 1 1'], [root]);

    const outcome = await revealDesignPathInEditor('top.leak', {
      resolver: leaky,
      editor,
      enabled: () => true,
    });
    expect(outcome).toEqual({ kind: 'unresolved', reason: 'outside-workspace' });
    expect(editor.shown).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });

  it('refuses an in-workspace symlink that points outside it', async () => {
    // `realpath` runs before the containment test, so the value checked and
    // the value opened are the same one.
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'crux-outside-')));
    const secret = join(outside, 'secret.v');
    await writeFile(secret, 'nope\n', 'utf8');
    const link = join(root, 'rtl', 'link.v');
    await symlink(secret, link);
    const linked = resolverFor([`++ comp 1 file ${link}`, '++ var top.link 1 1'], [root]);

    const outcome = await revealDesignPathInEditor('top.link', {
      resolver: linked,
      editor,
      enabled: () => true,
    });
    expect(outcome.kind).toBe('unresolved');
    expect(editor.shown).toEqual([]);
    await rm(outside, { recursive: true, force: true });
  });

  it('reports rather than throws when the editor refuses the document', async () => {
    editor.openRejects = true;
    const outcome = await revealDesignPathInEditor('top.cpu.alu.result', {
      resolver,
      editor,
      enabled: () => true,
    });
    expect(outcome.kind).toBe('open-failed');
  });

  it('resolves nothing with no workspace folder open — no consent, no reveal', async () => {
    const homeless = resolverFor(stemsLines, []);
    const outcome = await revealDesignPathInEditor('top.cpu.alu.result', {
      resolver: homeless,
      editor: new FakeEditorHost([], new Map()),
      enabled: () => true,
    });
    expect(outcome.kind).toBe('unresolved');
  });
});
