#!/usr/bin/env node
// Enforces the things a Marketplace / Open VSX *listing* needs, which no
// other gate in this repo looks at.
//
// Why this exists as its own gate rather than being left to `vsce package`:
//
//   1. `vsce` catches a missing icon file, but only at package time — and the
//      one extension whose VSIX CI cannot build today (wavecrux, which needs
//      the Flutter payload) is exactly the one whose listing matters most.
//      This runs in the lint job, on every package, with no toolchain.
//   2. `vsce` does not care whether a non-English locale actually translated
//      anything. `package.nls.<locale>.json` files shipped with the English
//      displayName and description sitting in them for four locales before
//      anyone noticed — a silent, invisible-in-CI l10n hole of exactly the
//      class tool/verify-l10n.mjs was written to close for *files*. This
//      closes it for the two strings the Marketplace actually renders.
//   3. The Marketplace rewrites a relative README link against the
//      `repository` URL, so a relative link in a listing README lands a
//      stranger inside this monorepo's internals — or on a 404 whenever the
//      repository is not publicly readable. Listing READMEs therefore use
//      absolute URLs to public destinations, and this is what keeps that true.
//
// Usage: node tool/verify-listing.mjs

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const packagesDir = path.join(repoRoot, 'packages');

/** The five published listings, in the order tool/version.mjs uses. */
const PACKAGES = ['wavecrux', 'lintcrux', 'simcrux', 'netcrux', 'pack'];

/** Locales the suite ships. '' is the English default. */
const LOCALES = ['', 'zh-hans', 'ja', 'ko'];

/** The two strings the Marketplace renders as the listing's title and subtitle. */
const LISTING_KEYS = ['extension.displayName', 'extension.description'];

/**
 * VSCode's fixed category vocabulary. A category outside this set is silently
 * dropped by the Marketplace rather than rejected, so a typo would cost a
 * browse surface with no error anywhere.
 */
const VALID_CATEGORIES = new Set([
  'AI',
  'Azure',
  'Chat',
  'Data Science',
  'Debuggers',
  'Education',
  'Extension Packs',
  'Formatters',
  'Keymaps',
  'Language Packs',
  'Linters',
  'Machine Learning',
  'Notebooks',
  'Other',
  'Programming Languages',
  'SCM Providers',
  'Snippets',
  'Testing',
  'Themes',
  'Visualization',
]);

/**
 * The Marketplace caps an extension at 30 tags. `vsce` does not enforce it —
 * it merges `keywords` with tags it derives from the manifest into one set and
 * ships whatever that is — so the cap has to be checked here or discovered at
 * publish time.
 */
const MAX_KEYWORDS = 30;

/** Marketplace icons must be a raster PNG; `vsce` rejects SVG outright. */
const ICON_EDGE_PX = 128;

const failures = [];

function fail(pkg, message) {
  failures.push(`packages/${pkg}: ${message}`);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Width and height from a PNG's IHDR, or undefined if [file] is not a PNG.
 * IHDR is required by the spec to be the first chunk, so this reads a fixed
 * 24-byte prefix rather than walking the file.
 */
function pngSize(file) {
  const head = readFileSync(file).subarray(0, 24);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (head.length < 24 || !head.subarray(0, 8).equals(signature)) return undefined;
  if (head.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function checkIcon(pkg, manifest, pkgDir) {
  if (typeof manifest.icon !== 'string' || manifest.icon === '') {
    fail(pkg, 'no "icon" in package.json — the listing would render a placeholder');
    return;
  }
  if (!manifest.icon.toLowerCase().endsWith('.png')) {
    fail(pkg, `icon "${manifest.icon}" is not a .png (vsce rejects SVG icons)`);
    return;
  }
  const iconFile = path.join(pkgDir, manifest.icon);
  if (!existsSync(iconFile)) {
    fail(pkg, `icon "${manifest.icon}" is declared but missing on disk`);
    return;
  }
  const size = pngSize(iconFile);
  if (size === undefined) {
    fail(pkg, `icon "${manifest.icon}" is not a readable PNG`);
    return;
  }
  if (size.width !== ICON_EDGE_PX || size.height !== ICON_EDGE_PX) {
    fail(
      pkg,
      `icon "${manifest.icon}" is ${size.width}x${size.height}; the Marketplace wants ${ICON_EDGE_PX}x${ICON_EDGE_PX}`,
    );
  }
}

function checkGalleryBanner(pkg, manifest) {
  const banner = manifest.galleryBanner;
  if (banner === undefined) {
    fail(pkg, 'no "galleryBanner" — the listing header falls back to Marketplace default blue');
    return;
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(banner.color ?? '')) {
    fail(pkg, `galleryBanner.color "${banner.color}" is not a 6-digit hex colour`);
  }
  if (banner.theme !== 'dark' && banner.theme !== 'light') {
    fail(pkg, `galleryBanner.theme "${banner.theme}" must be "dark" or "light"`);
  }
}

function checkCategoriesAndKeywords(pkg, manifest) {
  const categories = manifest.categories ?? [];
  if (categories.length === 0) {
    fail(pkg, 'no "categories" — the extension is unbrowsable');
  }
  for (const category of categories) {
    if (!VALID_CATEGORIES.has(category)) {
      fail(pkg, `category "${category}" is not one the Marketplace recognises`);
    }
  }

  const keywords = manifest.keywords ?? [];
  if (keywords.length === 0) {
    fail(pkg, 'no "keywords" — Marketplace search ranks on these');
  }
  if (keywords.length > MAX_KEYWORDS) {
    fail(pkg, `${keywords.length} keywords exceeds the Marketplace cap of ${MAX_KEYWORDS}`);
  }
  const seen = new Set();
  for (const keyword of keywords) {
    if (keyword !== keyword.toLowerCase()) {
      fail(pkg, `keyword "${keyword}" is not lowercase; tags are matched case-sensitively`);
    }
    if (seen.has(keyword)) fail(pkg, `keyword "${keyword}" is listed twice`);
    seen.add(keyword);
  }
}

/**
 * The listing title and subtitle must come from the NLS bundles, and every
 * locale must have translated them. A non-English file that still carries the
 * English string renders English to that user with nothing anywhere reporting
 * it — the exact failure mode this check exists for.
 */
function checkLocalizedCopy(pkg, manifest, pkgDir) {
  for (const [field, key] of [
    ['displayName', 'extension.displayName'],
    ['description', 'extension.description'],
  ]) {
    if (manifest[field] !== `%${key}%`) {
      fail(pkg, `package.json "${field}" must be the NLS placeholder %${key}%, not a literal`);
    }
  }

  const english = {};
  for (const locale of LOCALES) {
    const file = path.join(pkgDir, locale ? `package.nls.${locale}.json` : 'package.nls.json');
    if (!existsSync(file)) {
      fail(pkg, `missing ${path.basename(file)}`);
      continue;
    }
    const bundle = readJson(file);
    for (const key of LISTING_KEYS) {
      const value = bundle[key];
      if (typeof value !== 'string' || value.trim() === '') {
        fail(pkg, `${path.basename(file)} has no "${key}"`);
        continue;
      }
      if (locale === '') {
        english[key] = value;
      } else if (value === english[key]) {
        fail(
          pkg,
          `${path.basename(file)} "${key}" is byte-identical to English — untranslated`,
        );
      }
    }
  }
}

/**
 * Listing READMEs are read by strangers on a web page, not by contributors in
 * a checkout. Relative links resolve against the repository — monorepo
 * internals at best, a 404 whenever it is not publicly readable.
 */
function checkReadme(pkg, pkgDir) {
  const readme = path.join(pkgDir, 'README.md');
  if (!existsSync(readme)) {
    fail(pkg, 'no README.md — the Marketplace listing body would be empty');
    return;
  }
  const body = readFileSync(readme, 'utf8');
  if (body.length < 500) {
    fail(pkg, `README.md is only ${body.length} bytes; that is not a listing`);
  }

  // ![alt](target) and [text](target). Anchors and absolute URLs are fine;
  // anything else resolves against the repo.
  const link = /!?\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of body.matchAll(link)) {
    const target = match[1].trim();
    if (target.startsWith('#')) continue;
    if (/^https?:\/\//.test(target)) continue;
    if (/^mailto:/.test(target)) continue;
    fail(
      pkg,
      `README.md links to "${target}" relatively; listing READMEs need absolute URLs ` +
        '(the Marketplace rewrites them against the repository, which a listing reader should not be sent into)',
    );
  }
}

/**
 * Each VSIX is redistributed on its own, so it carries its own licence text —
 * `vsce` warns when it cannot find one, and the Marketplace renders a Licence
 * tab from it. The copies are checked against the root file rather than merely
 * existing, because five copies of a licence are five chances to drift.
 */
function checkLicense(pkg, pkgDir, rootLicense) {
  const file = path.join(pkgDir, 'LICENSE');
  if (!existsSync(file)) {
    fail(pkg, 'no LICENSE — vsce warns and the listing has no Licence tab');
    return;
  }
  if (readFileSync(file, 'utf8') !== rootLicense) {
    fail(pkg, 'LICENSE has drifted from the repository root LICENSE');
  }
}

const rootLicense = readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8');

for (const pkg of PACKAGES) {
  const pkgDir = path.join(packagesDir, pkg);
  const manifestFile = path.join(pkgDir, 'package.json');
  if (!existsSync(manifestFile)) {
    fail(pkg, 'no package.json');
    continue;
  }
  const manifest = readJson(manifestFile);
  checkIcon(pkg, manifest, pkgDir);
  checkGalleryBanner(pkg, manifest);
  checkCategoriesAndKeywords(pkg, manifest);
  checkLocalizedCopy(pkg, manifest, pkgDir);
  checkReadme(pkg, pkgDir);
  checkLicense(pkg, pkgDir, rootLicense);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[listing] ${failure}`);
  console.error(`\n${failures.length} listing problem(s).`);
  process.exit(1);
}

console.log(
  `listing: all ${PACKAGES.length} listings carry a 128x128 icon, a gallery banner, ` +
    'valid categories/keywords, an absolute-linked README, the root LICENSE, ' +
    'and translated copy in all four locales.',
);
