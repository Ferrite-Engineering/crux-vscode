import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HISTORY_COMMAND,
  OPEN_COUNTEREXAMPLE_COMMAND,
  REFRESH_COMMAND,
  RUN_REGRESSION_COMMAND,
  activate,
  deactivate,
} from '../src/extension';
import { SIMCRUX_TASK_TYPE } from '../src/tasks';
import { SIM_SETTING_KEYS } from '../src/settings';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Manifest {
  readonly activationEvents: readonly string[];
  readonly contributes: {
    readonly commands: ReadonlyArray<{ command: string; title: string; category: string }>;
    readonly menus: Record<string, ReadonlyArray<{ command: string }>>;
    readonly taskDefinitions: ReadonlyArray<{ type: string; properties: Record<string, unknown> }>;
    readonly configuration: { properties: Record<string, unknown> };
  };
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as Manifest;
}

describe('simcrux extension entry points', () => {
  it('exports activate and deactivate', () => {
    expect(typeof activate).toBe('function');
    expect(typeof deactivate).toBe('function');
  });
});

describe('command ids', () => {
  it('namespaces product commands under `simcrux.`', () => {
    expect(REFRESH_COMMAND).toBe('simcrux.refreshResults');
    expect(RUN_REGRESSION_COMMAND).toBe('simcrux.runRegression');
    expect(OPEN_COUNTEREXAMPLE_COMMAND).toBe('simcrux.openCounterexample');
    expect(HISTORY_COMMAND).toBe('simcrux.openHistoryInDesktop');
  });
});

describe('the manifest and the code agree', () => {
  it('contributes every command the extension registers', () => {
    // The drift this catches is a command that works from the code and is
    // invisible in the palette, or a palette entry that errors.
    const contributed = new Set(manifest().contributes.commands.map((entry) => entry.command));
    for (const id of [
      REFRESH_COMMAND,
      RUN_REGRESSION_COMMAND,
      OPEN_COUNTEREXAMPLE_COMMAND,
      HISTORY_COMMAND,
    ]) {
      expect(contributed.has(id)).toBe(true);
    }
  });

  it('localizes every command title and category', () => {
    for (const command of manifest().contributes.commands) {
      expect(command.title).toMatch(/^%.+%$/);
      expect(command.category).toBe('%crux.command.category%');
    }
  });

  it('declares the task type the provider registers', () => {
    const definitions = manifest().contributes.taskDefinitions;
    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.type).toBe(SIMCRUX_TASK_TYPE);
    expect(Object.keys(definitions[0]?.properties ?? {}).sort()).toEqual(['config', 'filter']);
  });

  it('declares every setting the code reads, under the shared namespace', () => {
    const declared = Object.keys(manifest().contributes.configuration.properties);
    for (const key of Object.values(SIM_SETTING_KEYS)) {
      expect(declared).toContain(`edacrux.${key}`);
    }
    for (const key of declared) expect(key.startsWith('edacrux.')).toBe(true);
  });

  it('puts the counterexample command on the Test Explorer item menu', () => {
    // Clicking a failing property is the gesture; a
    // palette-only command would not be that gesture.
    expect(manifest().contributes.menus['testing/item/context']).toEqual([
      { command: OPEN_COUNTEREXAMPLE_COMMAND, group: 'simcrux@1' },
    ]);
  });

  it('activates on startup, so the tree exists before anything is clicked', () => {
    expect(manifest().activationEvents).toEqual(['onStartupFinished']);
  });
});
