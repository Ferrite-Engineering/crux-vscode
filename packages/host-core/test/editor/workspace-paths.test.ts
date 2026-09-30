import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspacePath } from '../../src/editor/workspace-paths';

// These run against a real filesystem on purpose. The rule this module
// enforces is about symlinks and `..`, and a mocked `realpath` would be a
// test of the mock's opinion of those rather than of the platform's.
let root: string;
let workspace: string;
let outside: string;

beforeEach(async () => {
  // `realpath` the temp root: on macOS `/var` is a symlink to
  // `/private/var`, and a test that compared the two forms would be
  // asserting about the platform rather than about this module.
  root = await realpath(await mkdtemp(join(tmpdir(), 'crux-editor-paths-')));
  workspace = join(root, 'workspace');
  outside = join(root, 'outside');
  await mkdir(join(workspace, 'rtl'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, 'rtl', 'alu.sv'), 'module alu;\nendmodule\n');
  await writeFile(join(outside, 'secrets.txt'), 'private key\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveWorkspacePath — the happy path', () => {
  it('accepts an absolute path inside an open folder', async () => {
    const result = await resolveWorkspacePath(join(workspace, 'rtl', 'alu.sv'), {
      workspaceFolders: [workspace],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fsPath.endsWith(join('rtl', 'alu.sv'))).toBe(true);
  });

  it('accepts a path relative to an open folder', async () => {
    const result = await resolveWorkspacePath(join('rtl', 'alu.sv'), {
      workspaceFolders: [workspace],
    });
    expect(result.ok).toBe(true);
  });

  it('tries every open folder for a relative path', async () => {
    const second = join(root, 'second');
    await mkdir(join(second, 'rtl'), { recursive: true });
    await writeFile(join(second, 'rtl', 'cpu.sv'), 'module cpu;\nendmodule\n');
    const result = await resolveWorkspacePath(join('rtl', 'cpu.sv'), {
      workspaceFolders: [workspace, second],
    });
    expect(result.ok).toBe(true);
  });

  it('resolves a workspace folder that is itself reached through a symlink', async () => {
    // `~/src -> /Volumes/work/src` is a very common setup. If only the
    // candidate were realpath'd and not the roots, every file in such a
    // workspace would look like an escape.
    const link = join(root, 'linked-workspace');
    await symlink(workspace, link, 'dir');
    const result = await resolveWorkspacePath(join(link, 'rtl', 'alu.sv'), {
      workspaceFolders: [link],
    });
    expect(result.ok).toBe(true);
  });
});

describe('resolveWorkspacePath — CXP §11 containment', () => {
  it('refuses an absolute path outside every open folder', async () => {
    const result = await resolveWorkspacePath(join(outside, 'secrets.txt'), {
      workspaceFolders: [workspace],
    });
    expect(result).toEqual({ ok: false, reason: 'outside-workspace' });
  });

  it('refuses a `..` traversal out of the workspace', async () => {
    const result = await resolveWorkspacePath(
      join(workspace, 'rtl', '..', '..', 'outside', 'secrets.txt'),
      { workspaceFolders: [workspace] },
    );
    expect(result).toEqual({ ok: false, reason: 'outside-workspace' });
  });

  it('refuses a relative `..` traversal out of the workspace', async () => {
    const result = await resolveWorkspacePath(join('..', 'outside', 'secrets.txt'), {
      workspaceFolders: [workspace],
    });
    expect(result).toEqual({ ok: false, reason: 'outside-workspace' });
  });

  it('refuses a symlink inside the workspace that points outside it', async () => {
    // The escape the containment check exists for: the path *looks* like it
    // is under the workspace and resolves somewhere else entirely.
    await symlink(join(outside, 'secrets.txt'), join(workspace, 'rtl', 'leak.sv'), 'file');
    const result = await resolveWorkspacePath(join(workspace, 'rtl', 'leak.sv'), {
      workspaceFolders: [workspace],
    });
    expect(result).toEqual({ ok: false, reason: 'outside-workspace' });
  });

  it('refuses a symlinked *directory* inside the workspace pointing outside it', async () => {
    await symlink(outside, join(workspace, 'escape'), 'dir');
    const result = await resolveWorkspacePath(join(workspace, 'escape', 'secrets.txt'), {
      workspaceFolders: [workspace],
    });
    expect(result).toEqual({ ok: false, reason: 'outside-workspace' });
  });

  it('does not treat a sibling with the folder name as a prefix as inside it', async () => {
    // `/work/project-secrets` must not count as inside `/work/project`.
    const sibling = `${workspace}-secrets`;
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, 'notes.txt'), 'x\n');
    const result = await resolveWorkspacePath(join(sibling, 'notes.txt'), {
      workspaceFolders: [workspace],
    });
    expect(result).toEqual({ ok: false, reason: 'outside-workspace' });
  });

  it('refuses everything when no folder is open', async () => {
    const result = await resolveWorkspacePath(join(workspace, 'rtl', 'alu.sv'), {
      workspaceFolders: [],
    });
    expect(result).toEqual({ ok: false, reason: 'no-workspace' });
  });

  it('refuses a blank path', async () => {
    for (const blank of ['', '   ']) {
      expect(await resolveWorkspacePath(blank, { workspaceFolders: [workspace] })).toEqual({
        ok: false,
        reason: 'empty-path',
      });
    }
  });

  it('reports a missing file inside the workspace as not-found, not as an escape', async () => {
    const result = await resolveWorkspacePath(join(workspace, 'rtl', 'nope.sv'), {
      workspaceFolders: [workspace],
    });
    expect(result).toEqual({ ok: false, reason: 'not-found' });
  });

  it('reports a missing file *outside* the workspace as an escape, not not-found', async () => {
    const result = await resolveWorkspacePath(join(outside, 'nope.txt'), {
      workspaceFolders: [workspace],
    });
    expect(result).toEqual({ ok: false, reason: 'outside-workspace' });
  });
});

describe('resolveWorkspacePath — path-case comparison', () => {
  it('folds case on darwin/win32 and not elsewhere', async () => {
    const injected = new Map<string, string>([
      [`${sep}Work${sep}Project`, `${sep}Work${sep}Project`],
      [`${sep}work${sep}project${sep}alu.sv`, `${sep}work${sep}project${sep}alu.sv`],
    ]);
    const realpath = (path: string): Promise<string> => {
      const resolved = injected.get(path);
      return resolved === undefined
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(resolved);
    };
    const options = {
      workspaceFolders: [`${sep}Work${sep}Project`],
      realpath,
    };
    const target = `${sep}work${sep}project${sep}alu.sv`;

    expect(await resolveWorkspacePath(target, { ...options, platform: 'darwin' })).toMatchObject({
      ok: true,
    });
    expect(await resolveWorkspacePath(target, { ...options, platform: 'linux' })).toEqual({
      ok: false,
      reason: 'outside-workspace',
    });
  });
});
