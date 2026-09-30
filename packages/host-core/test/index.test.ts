import { describe, expect, it } from 'vitest';
import * as hostCore from '../src/index';

describe('@crux-vscode/host-core barrel', () => {
  it('exposes every module boundary as a namespace', () => {
    const moduleNames = Object.keys(hostCore);
    expect(moduleNames.sort()).toEqual(
      [
        'annotate',
        'crossProbe',
        'cxp',
        'desktopDetect',
        'editor',
        'l10n',
        'names',
        'status',
        'surface',
        'telemetry',
        'window',
      ].sort(),
    );
  });
});
