// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Single flat config for the whole workspace. ESLint resolves this file by
// walking up from the package being linted, so every package's `lint` script
// (`eslint . --max-warnings=0`) shares this one source of truth — no
// per-package config drift.
//
// Zero-warnings policy: CI and every package's `lint` script pass
// `--max-warnings=0`. A rule that is worth flagging is worth failing on.
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      // Staged Flutter web payload: generated third-party output, not ours
      // to lint. See tool/build-wavecrux-web.mjs.
      '**/media/**',
      '**/*.vsix',
      '**/node_modules/**',
      '**/l10n/**/*.json',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': 'off',
    },
  },
  {
    // tool/ scripts run under plain Node, not bundled — they need Node
    // globals (process, console, URL, …) and are not part of any
    // package's typed tsconfig project, so type-aware rules are off here.
    // `disableTypeChecked` also sets `languageOptions.parserOptions`, so
    // it must be spread before the explicit `languageOptions` below, or
    // its object would clobber the `globals` addition instead of merging.
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
);
