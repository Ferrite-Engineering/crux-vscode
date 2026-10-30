import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NetlistDocument, classifyNetlist, noticeFor, readNetlistHead } from '../../src/preview/editor';
import { NETLIST_SNIFF_BYTES } from '../../src/preview/netlist-detect';

const MIB = 1024 * 1024;

const NETLIST = JSON.stringify({
  creator: 'Yosys 0.40',
  modules: { top: { attributes: {}, ports: {}, cells: {}, netnames: {} } },
});

let dir: string;
const fileAt = (name: string, contents: string | Buffer): vscode.Uri => {
  const file = path.join(dir, name);
  writeFileSync(file, contents);
  return vscode.Uri.file(file);
};

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'netcrux-preview-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('classifyNetlist', () => {
  it('previews a netlist within the threshold', async () => {
    const uri = fileAt('top.json', NETLIST);
    const { sizeBytes, disposition } = await classifyNetlist(uri, 32);
    expect(sizeBytes).toBe(NETLIST.length);
    expect(disposition).toEqual({ kind: 'preview' });
  });

  it('offers the desktop app for a netlist over the threshold, and does not read it all', async () => {
    // A 3 MiB netlist against a 1 MiB limit: sniffed from its first
    // kilobytes, never loaded.
    const padding = ' '.repeat(3 * MIB);
    const uri = fileAt('big.json', `${NETLIST.slice(0, -1)}${padding}}`);
    const { disposition } = await classifyNetlist(uri, 1);
    expect(disposition).toEqual({ kind: 'too-large', limitMb: 1 });
  });

  it('says a file that is not a netlist is not one, whatever its size', async () => {
    const uri = fileAt('package.json', '{"name":"x","version":"1.0.0"}');
    expect((await classifyNetlist(uri, 32)).disposition).toEqual({ kind: 'not-netlist' });
  });

  it('says an oversized file that is not a netlist is not one, instead of calling it too large', async () => {
    const uri = fileAt('big-other.json', `{"name":"x","pad":"${'a'.repeat(2 * MIB)}"}`);
    expect((await classifyNetlist(uri, 1)).disposition).toEqual({ kind: 'not-netlist' });
  });

  it('says an empty file is empty', async () => {
    const uri = fileAt('empty.json', '');
    expect((await classifyNetlist(uri, 32)).disposition).toEqual({ kind: 'empty' });
  });

  it('treats a file that vanished as empty', async () => {
    const uri = vscode.Uri.file(path.join(dir, 'gone.json'));
    expect((await classifyNetlist(uri, 32)).disposition).toEqual({ kind: 'empty' });
  });
});

describe('readNetlistHead', () => {
  it('reads no more than the sniff window', async () => {
    const uri = fileAt('window.json', 'x'.repeat(NETLIST_SNIFF_BYTES * 2));
    const head = await readNetlistHead(uri, NETLIST_SNIFF_BYTES * 2);
    expect(head?.length).toBe(NETLIST_SNIFF_BYTES);
  });

  it('is undefined for a file it cannot open', async () => {
    expect(await readNetlistHead(vscode.Uri.file(path.join(dir, 'nope.json')), 10)).toBeUndefined();
  });
});

describe('noticeFor', () => {
  const doc = (disposition: NetlistDocument['disposition'], size = 0) =>
    new NetlistDocument(vscode.Uri.file('/w/top.json'), size, disposition);

  it('has none for a netlist the viewer will draw', () => {
    expect(noticeFor(doc({ kind: 'preview' }))).toBeUndefined();
  });

  it('says why a netlist is too large, in megabytes, and offers the way out', () => {
    const notice = noticeFor(doc({ kind: 'too-large', limitMb: 32 }, 90 * MIB));
    expect(notice?.message).toContain('32 MB');
    expect(notice?.message).toContain('90 MB');
    expect(notice?.actions.map((a) => a.action)).toEqual(['open-in-netcrux', 'change-size-limit']);
  });

  it('shows a fractional size for a file just over a small limit', () => {
    const notice = noticeFor(doc({ kind: 'too-large', limitMb: 1 }, 1.5 * MIB));
    expect(notice?.message).toContain('1.5 MB');
  });

  it('offers text for a file that is not a netlist, and nothing for an empty one', () => {
    expect(noticeFor(doc({ kind: 'not-netlist' }))?.actions.map((a) => a.action)).toEqual(['open-as-text']);
    expect(noticeFor(doc({ kind: 'empty' }))?.actions).toEqual([]);
  });

  it('uses the new disposition when the file changed on disk', () => {
    const notice = noticeFor(doc({ kind: 'preview' }), { kind: 'too-large', limitMb: 8 }, 20 * MIB);
    expect(notice?.message).toContain('8 MB');
    expect(notice?.message).toContain('20 MB');
  });
});

describe('NetlistDocument', () => {
  it('is named after its file', () => {
    expect(doc('/w/build/top.json').displayName).toBe('top.json');
  });

  function doc(p: string): NetlistDocument {
    return new NetlistDocument(vscode.Uri.file(p), 1, { kind: 'preview' });
  }
});
