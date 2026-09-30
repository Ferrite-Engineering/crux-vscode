import { describe, expect, it } from 'vitest';
import { WHAT_DRIVES_THIS_COMMAND, activate, deactivate } from '../src/extension';

describe('netcrux extension entry points', () => {
  it('exports activate and deactivate', () => {
    expect(typeof activate).toBe('function');
    expect(typeof deactivate).toBe('function');
  });
});

describe('command ids', () => {
  it('namespaces the product command under `netcrux.`', () => {
    expect(WHAT_DRIVES_THIS_COMMAND).toBe('netcrux.whatDrivesThis');
  });
});
