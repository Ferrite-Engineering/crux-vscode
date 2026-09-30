#!/usr/bin/env node
// Propagates host-core's localized strings into every extension package.
//
// Why this exists: `vscode.l10n.t()` resolves against the *extension's* own
// bundle, and host-core is not an extension — it is bundled into each of the
// four by esbuild. A string host-core emits therefore has to appear in the
// bundle of whichever extension is hosting it, or it silently falls back to
// English for every non-English user. Rather than hand-maintain the same
// entries in four places (which drifts the moment one is edited), host-core
// owns them and this script copies them outward.
//
// Extension-owned entries are never touched, and an entry an extension has
// already translated differently is left alone — host-core seeds, it does
// not overwrite.
//
// Usage: node tool/sync-l10n.mjs [--check]
//   --check  report what would change and exit non-zero, for CI.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const packagesDir = path.join(repoRoot, 'packages');
const sourcePackage = 'host-core';
const checkOnly = process.argv.includes('--check');

// EN + the three the suite ships. Kept in step with tool/verify-l10n.mjs.
const locales = ['', 'zh-hans', 'ja', 'ko'];

function bundleFile(pkgDir, locale) {
  return path.join(pkgDir, 'l10n', locale ? `bundle.l10n.${locale}.json` : 'bundle.l10n.json');
}

function nlsFile(pkgDir, locale) {
  return path.join(pkgDir, locale ? `package.nls.${locale}.json` : 'package.nls.json');
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const sourceDir = path.join(packagesDir, sourcePackage);
const targets = readdirSync(packagesDir).filter((name) => {
  if (name === sourcePackage) return false;
  // Only packages that already localize: a package with no bundle has no
  // runtime strings of its own, and one with no package.nls has no manifest
  // strings. Seeding files into a package that does not localize would
  // create bundles nothing loads.
  return existsSync(path.join(packagesDir, name, 'package.json'));
});

let changed = 0;

for (const resolveFile of [bundleFile, nlsFile]) {
  for (const locale of locales) {
    const source = readJson(resolveFile(sourceDir, locale));
    if (source === undefined) continue;
    for (const target of targets) {
      const targetFile = resolveFile(path.join(packagesDir, target), locale);
      const existing = readJson(targetFile);
      // Absent target file means the package does not carry this class of
      // localization at all (the pack has no runtime bundle). Skip it.
      if (existing === undefined) continue;
      const merged = { ...existing };
      let touched = false;
      for (const [key, value] of Object.entries(source)) {
        if (Object.prototype.hasOwnProperty.call(merged, key)) continue;
        merged[key] = value;
        touched = true;
      }
      if (!touched) continue;
      changed++;
      const relative = path.relative(repoRoot, targetFile);
      if (checkOnly) {
        console.error(`[l10n] ${relative} is missing host-core keys`);
      } else {
        writeJson(targetFile, merged);
        console.log(`[l10n] updated ${relative}`);
      }
    }
  }
}

if (checkOnly && changed > 0) {
  console.error(`\n${changed} file(s) out of date. Run: node tool/sync-l10n.mjs`);
  process.exit(1);
}

console.log(
  checkOnly
    ? 'l10n: every extension bundle carries host-core’s shared strings.'
    : `l10n: sync complete (${changed} file(s) updated).`,
);
