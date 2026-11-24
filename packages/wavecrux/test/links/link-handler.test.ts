/**
 * The WaveCrux link handler end to end, short of the window: the editor-form
 * rewrite, the parser, the file check on a real filesystem, the open-tab
 * check, the confirmation and the open, composed as `links/register.ts`
 * composes them. Every untrusted-link rule has a case here.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { links } from '@crux-vscode/host-core';
import { parseWaveCruxLink, vetWaveCruxLinkTarget, type WaveCruxLink } from '../../src/links/wavecrux-link';

const EXTENSION = 'ferrite-engineering.wavecrux';

interface Seen {
  readonly notices: links.CruxLinkNotice[];
  readonly confirmed: string[];
  readonly opened: Array<{ path: string; link: WaveCruxLink }>;
}

function handler(
  options: {
    openTabs?: readonly string[];
    answer?: boolean;
    vet?: (file: string) => Promise<links.LinkTargetResult>;
  } = {},
): { run: (rewrite: links.DesktopLinkRewrite) => Promise<links.CruxLinkOutcome>; seen: Seen } {
  const seen: Seen = { notices: [], confirmed: [], opened: [] };
  const flow: links.CruxLinkFlow<WaveCruxLink> = {
    parse: parseWaveCruxLink,
    vet: options.vet ?? ((file) => vetWaveCruxLinkTarget(file)),
    openTabPath: (resolved) => links.findOpenedPath(resolved, options.openTabs ?? []),
    confirm: (resolved) => {
      seen.confirmed.push(resolved);
      return Promise.resolve(options.answer ?? true);
    },
    open: (opened, link) => {
      seen.opened.push({ path: opened, link });
      return Promise.resolve();
    },
    notify: (notice) => seen.notices.push(notice),
  };
  return { run: (rewrite) => links.openCruxLink(rewrite, flow), seen };
}

const fromText = (text: string): links.DesktopLinkRewrite => links.desktopLinkFromText(text, 'wavecrux', EXTENSION);
const encode = links.encodeLinkValue;

const posix = process.platform !== 'win32';

describe.runIf(posix)('a WaveCrux link', () => {
  let root = '';
  let dump = '';

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'wavecrux-link-')));
    dump = path.join(root, 'run 1', 'dump.vcd');
    await mkdir(path.dirname(dump));
    await mkdir(path.join(root, 'dir.vcd'));
    await writeFile(dump, '$enddefinitions $end\n');
    await writeFile(path.join(root, 'trace.fsdb'), 'x');
    await writeFile(path.join(root, 'saved.wavecrux'), '{}');
    await writeFile(path.join(root, 'id_ed25519'), 'secret');
    await symlink(dump, path.join(root, 'alias.vcd'));
    await symlink(path.join(root, 'id_ed25519'), path.join(root, 'trap.vcd'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('opens the file, after asking, and carries the signal and time to the panel', async () => {
    const { run, seen } = handler();
    const outcome = await run(
      fromText(`wavecrux://open?file=${encode(dump)}&signal=top.u_alu.result&t=1500ns`),
    );
    expect(outcome).toEqual({ kind: 'opened', path: dump, confirmed: true });
    expect(seen.confirmed).toEqual([dump]);
    expect(seen.opened).toEqual([
      { path: dump, link: { file: dump, signal: 'top.u_alu.result', time: '1500ns', timePs: 1_500_000 } },
    ]);
  });

  it('reads the editor form exactly as the desktop form', async () => {
    const desktop = handler();
    const editor = handler();
    await desktop.run(fromText(`wavecrux://open?file=${encode(dump)}&signal=top.clk&t=42`));
    await editor.run(
      links.desktopLinkFromEditorUri(
        // What VS Code hands the URI handler for the same link: the query decoded once.
        { path: '/open', query: `file=${dump}&signal=top.clk&t=42`, fragment: '' },
        'wavecrux',
      ),
    );
    await editor.run(fromText(`vscode://${EXTENSION}/open?file=${encode(dump)}&signal=top.clk&t=42`));
    expect(editor.seen.opened).toEqual([...desktop.seen.opened, ...desktop.seen.opened]);
  });

  it('opens nothing when the user cancels', async () => {
    const { run, seen } = handler({ answer: false });
    expect(await run(fromText(`wavecrux://open?file=${encode(dump)}`))).toEqual({ kind: 'cancelled', path: dump });
    expect(seen.opened).toEqual([]);
  });

  it('asks nothing for a file open in a tab, even through another spelling', async () => {
    const { run, seen } = handler({ openTabs: [path.join(root, 'alias.vcd')] });
    expect(await run(fromText(`wavecrux://open?file=${encode(dump)}`))).toEqual({
      kind: 'opened',
      path: path.join(root, 'alias.vcd'),
      confirmed: false,
    });
    expect(seen.confirmed).toEqual([]);
  });

  it('opens what a symbolic link resolves to, and shows that path when it asks', async () => {
    const { run, seen } = handler();
    await run(fromText(`wavecrux://open?file=${encode(path.join(root, 'alias.vcd'))}`));
    expect(seen.confirmed).toEqual([dump]);
    expect(seen.opened.map((entry) => entry.path)).toEqual([dump]);
  });

  it.each<readonly [string, () => string, links.CruxLinkNotice]>([
    ['a relative path', () => 'wavecrux://open?file=run%201%2Fdump.vcd', { kind: 'path' }],
    ['a padded path', () => `wavecrux://open?file=${encode(` ${dump}`)}`, { kind: 'path' }],
    ['an FSDB file, which would run a converter', () => `wavecrux://open?file=${encode(path.join(root, 'trace.fsdb'))}`, { kind: 'wrong-kind', fileName: 'trace.fsdb' }],
    ['a session, which names further files', () => `wavecrux://open?file=${encode(path.join(root, 'saved.wavecrux'))}`, { kind: 'wrong-kind', fileName: 'saved.wavecrux' }],
    ['a waveform name that resolves to a key', () => `wavecrux://open?file=${encode(path.join(root, 'trap.vcd'))}`, { kind: 'wrong-kind', fileName: 'trap.vcd' }],
    ['a missing file', () => `wavecrux://open?file=${encode(path.join(root, 'gone.vcd'))}`, { kind: 'not-found', fileName: 'gone.vcd' }],
    ['a directory', () => `wavecrux://open?file=${encode(path.join(root, 'dir.vcd'))}`, { kind: 'not-found', fileName: 'dir.vcd' }],
    ['an unknown key', () => `wavecrux://open?file=${encode(dump)}&run=x`, { kind: 'invalid' }],
    ['a bad time', () => `wavecrux://open?file=${encode(dump)}&t=soon`, { kind: 'invalid' }],
    ['a control character', () => `wavecrux://open?file=${encode(dump)}&signal=a%0Ab`, { kind: 'invalid' }],
    ['another product', () => `netcrux://open?file=${encode(dump)}`, { kind: 'invalid' }],
  ])('refuses %s, says why, and opens nothing', async (_, link, notice) => {
    const { run, seen } = handler();
    expect((await run(fromText(link()))).kind).toBe('refused');
    expect(seen.notices).toEqual([notice]);
    expect(seen.confirmed).toEqual([]);
    expect(seen.opened).toEqual([]);
  });

  it('refuses an editor-form value VS Code could not decode, and opens nothing', async () => {
    const { run, seen } = handler();
    await run(links.desktopLinkFromEditorUri({ path: '/open', query: `file=${root}/a%41.vcd`, fragment: '' }, 'wavecrux'));
    expect(seen.notices).toEqual([{ kind: 'invalid' }]);
    expect(seen.opened).toEqual([]);
  });

  /**
   * The oracle for the absolute-path rule: a link whose file is relative
   * opens nothing and asks nothing. Returns what went wrong.
   */
  async function relativePathProblems(
    vet: (file: string) => Promise<links.LinkTargetResult>,
  ): Promise<string[]> {
    const { run, seen } = handler({ vet });
    await run(fromText('wavecrux://open?file=run%201%2Fdump.vcd'));
    const problems: string[] = [];
    if (seen.confirmed.length > 0) problems.push(`asked about ${seen.confirmed.join(', ')}`);
    if (seen.opened.length > 0) problems.push(`opened ${seen.opened.map((entry) => entry.path).join(', ')}`);
    return problems;
  }

  it('the shipped handler passes the relative-path oracle', async () => {
    expect(await relativePathProblems((file) => vetWaveCruxLinkTarget(file))).toEqual([]);
  });

  it('mutation: a handler that opens a relative path fails the relative-path oracle', async () => {
    // The file check with its path rule replaced by one that accepts any
    // spelling, on a filesystem where the relative name resolves (as it would
    // against whatever directory the editor started in).
    const resolvesRelative: links.LinkTargetFs = {
      isFile: (file) => Promise.resolve(file === 'run 1/dump.vcd' || file === dump),
      isFileNoFollow: (file) => Promise.resolve(file === dump),
      realpath: (file) => Promise.resolve(file === 'run 1/dump.vcd' ? dump : file),
    };
    const mutant = (file: string): Promise<links.LinkTargetResult> =>
      vetWaveCruxLinkTarget(file, { fs: resolvesRelative, refusePath: () => undefined });
    expect(await relativePathProblems(mutant)).not.toEqual([]);
    // The same filesystem with the shipped rule still refuses it.
    expect(
      await relativePathProblems((file) => vetWaveCruxLinkTarget(file, { fs: resolvesRelative })),
    ).toEqual([]);
  });
});
