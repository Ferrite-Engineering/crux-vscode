import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXECUTABLE,
  DEFAULT_PROJECT_FILE,
  DEFAULT_RESULTS_FILE,
  SIM_CONFIGURATION_SECTION,
  SIM_SETTING_KEYS,
  resolveResultsPath,
} from '../src/settings';

const CONFIG = '/work/design/simcrux.yaml';

describe('the settings namespace', () => {
  it('lives under the shared edacrux section, not a per-product one', () => {
    // A VSCode window is one peer however many product extensions are
    // installed, so a pack user sees one "EDACrux" section.
    expect(SIM_CONFIGURATION_SECTION).toBe('edacrux');
    for (const key of Object.values(SIM_SETTING_KEYS)) {
      expect(key.startsWith('sim.')).toBe(true);
    }
  });

  it('defaults to the conventions the product itself uses', () => {
    expect(DEFAULT_PROJECT_FILE).toBe('simcrux.yaml');
    expect(DEFAULT_RESULTS_FILE).toBe('results.ndjson');
    expect(DEFAULT_EXECUTABLE).toBe('simcrux');
  });
});

describe('resolveResultsPath', () => {
  it('falls back to results.ndjson beside the config — the --ci convention', () => {
    expect(resolveResultsPath(CONFIG, '', undefined)).toBe('/work/design/results.ndjson');
  });

  it('honours the config’s own output.results_path', () => {
    expect(resolveResultsPath(CONFIG, '', 'build/run.ndjson')).toBe(
      '/work/design/build/run.ndjson',
    );
  });

  it('resolves a relative override against the config’s directory, not the workspace root', () => {
    // A multi-project workspace would otherwise point every project at one
    // file.
    expect(resolveResultsPath('/a/b/simcrux.yaml', '', '../out/results.ndjson')).toBe(
      '/a/out/results.ndjson',
    );
  });

  it('lets the setting win over the config', () => {
    expect(resolveResultsPath(CONFIG, 'fetched.ndjson', 'build/run.ndjson')).toBe(
      '/work/design/fetched.ndjson',
    );
  });

  it('takes an absolute setting outright — the results-fetched-from-CI case', () => {
    expect(resolveResultsPath(CONFIG, '/tmp/nightly.ndjson', 'build/run.ndjson')).toBe(
      '/tmp/nightly.ndjson',
    );
  });

  it('takes an absolute value from the config too', () => {
    expect(resolveResultsPath(CONFIG, '', '/shared/results.ndjson')).toBe(
      '/shared/results.ndjson',
    );
  });
});
