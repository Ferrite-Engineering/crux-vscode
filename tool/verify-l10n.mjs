#!/usr/bin/env node
// Enforces the repo's "no hardcoded user-facing strings" policy at the file
// level: every package that carries manifest localization (package.nls.json)
// or runtime localization (l10n/bundle.l10n.json) must carry a stub for
// every locale the suite ships — EN + zh-Hans + ja + ko. A locale that is
// missing here silently falls back to English at runtime instead of failing
// loud in CI, which is how l10n gaps ship unnoticed.
//
// Usage: node tool/verify-l10n.mjs

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const packagesDir = path.join(repoRoot, 'packages');

// VSCode's own locale identifiers (vscode.env.language / NLS file suffixes).
// zh-Hans is the suite's product-facing locale name; VSCode's file-naming
// convention for it is the lowercase "zh-hans".
const requiredLocales = ['zh-hans', 'ja', 'ko'];

let failures = 0;

for (const name of readdirSync(packagesDir)) {
  const pkgDir = path.join(packagesDir, name);

  const manifestDefault = path.join(pkgDir, 'package.nls.json');
  if (existsSync(manifestDefault)) {
    for (const locale of requiredLocales) {
      const stub = path.join(pkgDir, `package.nls.${locale}.json`);
      if (!existsSync(stub)) {
        console.error(`[l10n] missing ${path.relative(repoRoot, stub)}`);
        failures++;
      }
    }
  }

  const l10nDir = path.join(pkgDir, 'l10n');
  const bundleDefault = path.join(l10nDir, 'bundle.l10n.json');
  if (existsSync(bundleDefault)) {
    for (const locale of requiredLocales) {
      const stub = path.join(l10nDir, `bundle.l10n.${locale}.json`);
      if (!existsSync(stub)) {
        console.error(`[l10n] missing ${path.relative(repoRoot, stub)}`);
        failures++;
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} locale stub(s) missing.`);
  process.exit(1);
}

console.log('l10n: every localized package carries EN + zh-Hans + ja + ko.');
