import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NETLIST_VIEW_TYPE } from '../../src/preview/editor';
import {
  IS_NETLIST_CONTEXT_KEY,
  OPEN_IN_NETCRUX_COMMAND,
  OPEN_PREVIEW_COMMAND,
} from '../../src/preview/register';
import { DEFAULT_MAX_FILE_SIZE_MB, MAX_MAX_FILE_SIZE_MB, MIN_MAX_FILE_SIZE_MB } from '../../src/preview/size-plan';

const root = path.resolve(__dirname, '../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string; title: string }[];
    customEditors: { viewType: string; priority: string; selector: { filenamePattern: string }[]; displayName: string }[];
    menus: Record<string, { command: string; when?: string }[]>;
    configuration: { properties: Record<string, { default: unknown; minimum?: number; maximum?: number }> };
  };
  scripts: Record<string, string>;
};
const nls = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8')) as Record<string, string>;

const referencedNlsKeys = (value: unknown): string[] =>
  JSON.stringify(value).match(/%[A-Za-z0-9.]+%/g)?.map((key) => key.slice(1, -1)) ?? [];

describe('the manifest', () => {
  const editor = manifest.contributes.customEditors[0];

  it('registers the preview as an option, never as the default for JSON', () => {
    // A `.json` is almost never a netlist. Anything but `option` would make
    // every package.json open as a schematic viewer.
    expect(manifest.contributes.customEditors).toHaveLength(1);
    expect(editor?.viewType).toBe(NETLIST_VIEW_TYPE);
    expect(editor?.priority).toBe('option');
    expect(editor?.selector).toEqual([{ filenamePattern: '*.json' }]);
  });

  it('declares the two commands the code registers', () => {
    const ids = manifest.contributes.commands.map((c) => c.command);
    expect(ids).toContain(OPEN_PREVIEW_COMMAND);
    expect(ids).toContain(OPEN_IN_NETCRUX_COMMAND);
  });

  it('puts "Open Schematic Preview" on a .json in the explorer and on its tab', () => {
    const entry = (menu: string, command: string) =>
      manifest.contributes.menus[menu]?.find((item) => item.command === command);
    expect(entry('explorer/context', OPEN_PREVIEW_COMMAND)?.when).toContain('resourceExtname == .json');
    expect(entry('editor/title/context', OPEN_PREVIEW_COMMAND)?.when).toContain('resourceExtname == .json');
  });

  it('shows the title-bar button on a netlist only, by the context key the code sets', () => {
    const title = manifest.contributes.menus['editor/title']?.find((i) => i.command === OPEN_PREVIEW_COMMAND);
    expect(title?.when).toContain(IS_NETLIST_CONTEXT_KEY);
  });

  it('offers "Open in NetCrux" from the preview itself', () => {
    const title = manifest.contributes.menus['editor/title']?.find((i) => i.command === OPEN_IN_NETCRUX_COMMAND);
    expect(title?.when).toBe(`activeCustomEditorId == ${NETLIST_VIEW_TYPE}`);
  });

  it('only menus commands that exist', () => {
    const ids = new Set(manifest.contributes.commands.map((c) => c.command));
    for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
      for (const item of items) expect(ids.has(item.command), `${menu}: ${item.command}`).toBe(true);
    }
  });

  it('carries a size limit setting that agrees with the code', () => {
    const setting = manifest.contributes.configuration.properties['netcrux.preview.maxFileSizeMB'];
    expect(setting?.default).toBe(DEFAULT_MAX_FILE_SIZE_MB);
    expect(setting?.minimum).toBe(MIN_MAX_FILE_SIZE_MB);
    expect(setting?.maximum).toBe(MAX_MAX_FILE_SIZE_MB);
  });

  it('has every localized string it refers to', () => {
    for (const key of referencedNlsKeys(manifest)) expect(nls[key], key).toBeTruthy();
  });

  it('refuses to package without the viewer it embeds', () => {
    expect(manifest.scripts['package']).toContain('build-netcrux-web.mjs --check');
    expect(manifest.scripts['build:web']).toContain('build-netcrux-web.mjs');
  });
});
