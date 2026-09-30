#!/usr/bin/env node
// Shared esbuild bundler for every product extension package.
//
// Run from the extension package directory (each package's "build" script
// invokes this via a relative path). Bundles src/extension.ts into a single
// dist/extension.js CommonJS file, with the `vscode` module — provided by
// the extension host at runtime, never bundled — marked external.
//
// Usage: node ../../tool/build-extension.mjs [--watch] [--minify]

import { build, context } from 'esbuild';
import { readFileSync } from 'node:fs';

const cwd = process.cwd();
const pkg = JSON.parse(readFileSync(new URL('./package.json', `file://${cwd}/`), 'utf8'));

const watch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`[${pkg.name}] watching for changes...`);
} else {
  await build(options);
}
