import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_FILE_SIZE_MB,
  MAX_MAX_FILE_SIZE_MB,
  MIN_MAX_FILE_SIZE_MB,
  normalizeMaxFileSizeMb,
  planNetlist,
} from '../../src/preview/size-plan';

const MIB = 1024 * 1024;

describe('planNetlist', () => {
  it('previews a file within the threshold, boundary included', () => {
    expect(planNetlist(MIB, 32)).toEqual({ kind: 'preview' });
    expect(planNetlist(32 * MIB, 32)).toEqual({ kind: 'preview' });
  });

  it('offers the desktop app for a file over the threshold', () => {
    expect(planNetlist(32 * MIB + 1, 32)).toEqual({ kind: 'too-large', limitMb: 32 });
    expect(planNetlist(5000 * MIB, 32)).toEqual({ kind: 'too-large', limitMb: 32 });
  });

  it('says an empty file is empty before it asks about size', () => {
    expect(planNetlist(0, 32)).toEqual({ kind: 'empty' });
    expect(planNetlist(-1, 32)).toEqual({ kind: 'empty' });
  });

  it('follows the setting', () => {
    expect(planNetlist(50 * MIB, 64)).toEqual({ kind: 'preview' });
    expect(planNetlist(50 * MIB, 16)).toEqual({ kind: 'too-large', limitMb: 16 });
  });

  it('defaults to 32 MB', () => {
    expect(DEFAULT_MAX_FILE_SIZE_MB).toBe(32);
    expect(planNetlist(33 * MIB, undefined)).toEqual({ kind: 'too-large', limitMb: 32 });
  });
});

describe('normalizeMaxFileSizeMb', () => {
  it('clamps to the setting bounds', () => {
    expect(normalizeMaxFileSizeMb(0)).toBe(MIN_MAX_FILE_SIZE_MB);
    expect(normalizeMaxFileSizeMb(-5)).toBe(MIN_MAX_FILE_SIZE_MB);
    expect(normalizeMaxFileSizeMb(100000)).toBe(MAX_MAX_FILE_SIZE_MB);
  });

  it('floors a fraction and ignores a value that is not a number', () => {
    expect(normalizeMaxFileSizeMb(12.9)).toBe(12);
    expect(normalizeMaxFileSizeMb('64')).toBe(DEFAULT_MAX_FILE_SIZE_MB);
    expect(normalizeMaxFileSizeMb(Number.NaN)).toBe(DEFAULT_MAX_FILE_SIZE_MB);
    expect(normalizeMaxFileSizeMb(null)).toBe(DEFAULT_MAX_FILE_SIZE_MB);
  });
});
