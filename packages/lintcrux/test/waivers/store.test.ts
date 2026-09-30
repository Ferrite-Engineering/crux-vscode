import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WaiverSchemaError,
  appendWaiver,
  createWaiver,
  defaultWaiverAuthor,
  parseWaiverDocument,
  readWaiverDocument,
  serializeWaiverDocument,
  waiverToJson,
} from '../../src/waivers/store';
import { WAIVER_FILE_NAME, WAIVER_SCHEMA_VERSION } from '../../src/waivers/model';

const NOW = new Date('2026-08-10T12:00:00.000Z');

let directory: string;
let waiverFile: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'lintcrux-waivers-'));
  waiverFile = path.join(directory, WAIVER_FILE_NAME);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('createWaiver', () => {
  it('produces exactly the fields the app requires', () => {
    const waiver = createWaiver({
      ruleId: 'verilator/UNUSEDSIGNAL',
      filePath: '/work/design/rtl/cpu.sv',
      lineStart: 42,
      reason: 'Refactor planned for Q3 (LIN-321)',
      author: 'mfink',
      now: NOW,
      id: '11111111-2222-3333-4444-555555555555',
    });
    expect(waiverToJson(waiver)).toEqual({
      id: '11111111-2222-3333-4444-555555555555',
      ruleId: 'verilator/UNUSEDSIGNAL',
      filePath: '/work/design/rtl/cpu.sv',
      lineStart: 42,
      reason: 'Refactor planned for Q3 (LIN-321)',
      author: 'mfink',
      createdAt: '2026-08-10T12:00:00.000Z',
    });
  });

  it('omits the line fields entirely for a whole-file waiver', () => {
    const json = waiverToJson(
      createWaiver({
        ruleId: 'verible/case-missing-default',
        filePath: '/work/design/alu.sv',
        reason: 'legacy',
        author: 'mfink',
        now: NOW,
        id: 'id',
      }),
    );
    expect('lineStart' in json).toBe(false);
    expect('lineEnd' in json).toBe(false);
  });

  it('never writes an expiresAt the user did not ask for', () => {
    const json = waiverToJson(
      createWaiver({
        ruleId: 'r/x',
        filePath: '/f.sv',
        reason: 'r',
        author: 'a',
        now: NOW,
        id: 'id',
      }),
    );
    expect('expiresAt' in json).toBe(false);
  });

  it('mints a UUID when none is supplied', () => {
    const waiver = createWaiver({
      ruleId: 'r/x',
      filePath: '/f.sv',
      reason: 'r',
      author: 'a',
      now: NOW,
    });
    expect(waiver.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('refuses an empty reason or author, which the Dart parser would throw on', () => {
    const base = { ruleId: 'r/x', filePath: '/f.sv', author: 'a', now: NOW };
    expect(() => createWaiver({ ...base, reason: '   ' })).toThrow(WaiverSchemaError);
    expect(() => createWaiver({ ...base, reason: 'r', author: '' })).toThrow(WaiverSchemaError);
  });
});

describe('defaultWaiverAuthor — the app’s `_osUser()`, character for character', () => {
  it('prefers USER, then USERNAME, then unknown', () => {
    expect(defaultWaiverAuthor({ USER: 'mfink', USERNAME: 'other' })).toBe('mfink');
    expect(defaultWaiverAuthor({ USERNAME: 'winuser' })).toBe('winuser');
    expect(defaultWaiverAuthor({})).toBe('unknown');
  });
});

describe('parseWaiverDocument — version policy', () => {
  it('accepts v1', () => {
    const document = parseWaiverDocument(JSON.stringify({ version: 1, waivers: [] }));
    expect(document.version).toBe(WAIVER_SCHEMA_VERSION);
  });

  it('treats an absent version as v1, as the Dart parser does', () => {
    expect(parseWaiverDocument(JSON.stringify({ waivers: [] })).waivers).toEqual([]);
  });

  it('treats a non-integer version as v1, as the Dart parser does', () => {
    expect(parseWaiverDocument(JSON.stringify({ version: 'one', waivers: [] })).waivers).toEqual([]);
  });

  it('refuses a version this build does not understand', () => {
    expect(() => parseWaiverDocument(JSON.stringify({ version: 2, waivers: [] }))).toThrow(
      /Unsupported waiver schema version|unsupported waiver schema version/i,
    );
  });

  it('refuses a top level that is not an object', () => {
    expect(() => parseWaiverDocument('[]')).toThrow(WaiverSchemaError);
  });

  it('skips a malformed entry instead of losing the whole file', () => {
    const document = parseWaiverDocument(
      JSON.stringify({
        version: 1,
        waivers: [
          { id: 'a' },
          {
            id: 'b',
            ruleId: 'r/x',
            filePath: '/f.sv',
            reason: 'r',
            author: 'a',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(document.waivers.map((w) => w.id)).toEqual(['b']);
    // The raw entries are all still there — they are what gets re-emitted.
    expect(document.entries).toHaveLength(2);
  });
});

describe('readWaiverDocument', () => {
  it('treats a missing file as no waivers, not as an error', () => {
    expect(readWaiverDocument(waiverFile).waivers).toEqual([]);
  });
});

describe('appendWaiver — what lands on disk', () => {
  const waiver = createWaiver({
    ruleId: 'verilator/UNUSEDSIGNAL',
    filePath: '/work/design/rtl/cpu.sv',
    lineStart: 42,
    reason: 'Refactor planned for Q3 (LIN-321)',
    author: 'mfink',
    now: NOW,
    id: '11111111-2222-3333-4444-555555555555',
  });

  it('creates the file with the v1 envelope', () => {
    appendWaiver(waiverFile, waiver);
    expect(JSON.parse(readFileSync(waiverFile, 'utf8'))).toEqual({
      version: 1,
      waivers: [waiverToJson(waiver)],
    });
  });

  it('formats it the way writeJsonAtomic does — two spaces, no trailing newline', () => {
    appendWaiver(waiverFile, waiver);
    const text = readFileSync(waiverFile, 'utf8');
    expect(text).toBe(JSON.stringify({ version: 1, waivers: [waiverToJson(waiver)] }, null, 2));
    expect(text.endsWith('\n')).toBe(false);
  });

  it('appends without disturbing the entries already there', () => {
    const existing = {
      id: 'existing',
      ruleId: 'verible/case-missing-default',
      filePath: '/work/design/alu.sv',
      reason: 'legacy',
      author: 'someone',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    writeFileSync(waiverFile, JSON.stringify({ version: 1, waivers: [existing] }, null, 2), 'utf8');
    appendWaiver(waiverFile, waiver);
    const decoded = JSON.parse(readFileSync(waiverFile, 'utf8')) as {
      waivers: Record<string, unknown>[];
    };
    expect(decoded.waivers).toHaveLength(2);
    expect(decoded.waivers[0]).toEqual(existing);
  });

  it('preserves fields and top-level keys a newer build wrote', () => {
    writeFileSync(
      waiverFile,
      JSON.stringify({
        version: 1,
        generatedBy: 'lintcrux 2.0',
        waivers: [
          {
            id: 'future',
            ruleId: 'r/x',
            filePath: '/f.sv',
            reason: 'r',
            author: 'a',
            createdAt: '2026-01-01T00:00:00.000Z',
            approvedBy: 'a-field-this-build-does-not-model',
          },
        ],
      }),
      'utf8',
    );
    appendWaiver(waiverFile, waiver);
    const decoded = JSON.parse(readFileSync(waiverFile, 'utf8')) as Record<string, unknown>;
    expect(decoded['generatedBy']).toBe('lintcrux 2.0');
    expect((decoded['waivers'] as Record<string, unknown>[])[0]?.['approvedBy']).toBe(
      'a-field-this-build-does-not-model',
    );
  });

  it('refuses to touch a file whose schema version it does not understand', () => {
    const original = JSON.stringify({ version: 99, waivers: [] });
    writeFileSync(waiverFile, original, 'utf8');
    expect(() => appendWaiver(waiverFile, waiver)).toThrow(WaiverSchemaError);
    // And the file is exactly as it was — a refused write is not a
    // partial write.
    expect(readFileSync(waiverFile, 'utf8')).toBe(original);
  });

  it('leaves no temp file behind', () => {
    appendWaiver(waiverFile, waiver);
    expect(() => readFileSync(`${waiverFile}.tmp`, 'utf8')).toThrow();
  });
});

describe('serializeWaiverDocument', () => {
  it('always writes the version this build understands', () => {
    const text = serializeWaiverDocument({ version: 1, entries: [], waivers: [], extra: {} }, []);
    expect(JSON.parse(text)).toEqual({ version: 1, waivers: [] });
  });
});
