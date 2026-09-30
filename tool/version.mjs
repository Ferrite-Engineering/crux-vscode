#!/usr/bin/env node
// Single source of truth for the version shared by all five packages
// (wavecrux, lintcrux, simcrux, netcrux, and the pack). They must move
// together: the pack's `extensionPack` field names the other four by ID with
// no version pin, so a Marketplace listing implicitly promises "these are the
// versions built and published together" — this script is what keeps that
// promise true instead of aspirational, and what a CI job can enforce.
//
// The root VERSION file (plain semver, e.g. "0.1.0") is the source. Every
// package.json under packages/ must carry that exact "version".
//
// Usage:
//   node tool/version.mjs                     check all five agree with VERSION (exit 1 on drift)
//   node tool/version.mjs --check              same, explicit
//   node tool/version.mjs --write <semver>     write <semver> into VERSION and all five package.json
//   node tool/version.mjs --assert-tag <tag>   verify a tag like vscode-v0.1.0 matches VERSION
//
// The release workflow's tag shape is `vscode-v<semver>` — chosen so it
// cannot be confused with the suite bundle's date-stamp tags or any other
// product's tags, none of which this repo shares a tag namespace with anyway
// (crux-vscode is its own repo).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const versionFile = path.join(repoRoot, 'VERSION');

// pack last: reading its extensionPack list as "the five" reads naturally
// from the flagship (were it buildable here) down to the manifest-only pack.
const PACKAGES = ['wavecrux', 'lintcrux', 'simcrux', 'netcrux', 'pack'];

const SEMVER = /^\d+\.\d+\.\d+$/;

function readVersionFile() {
  if (!existsSync(versionFile)) {
    console.error(`[version] no VERSION file at ${path.relative(repoRoot, versionFile)}`);
    process.exit(1);
  }
  return readFileSync(versionFile, 'utf8').trim();
}

function packageJsonPath(name) {
  return path.join(repoRoot, 'packages', name, 'package.json');
}

function readPackageVersion(name) {
  const file = packageJsonPath(name);
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  return pkg.version;
}

function check() {
  const version = readVersionFile();
  if (!SEMVER.test(version)) {
    console.error(`[version] VERSION file content is not plain semver: "${version}"`);
    process.exit(1);
  }

  const drifted = [];
  for (const name of PACKAGES) {
    const actual = readPackageVersion(name);
    if (actual !== version) {
      drifted.push({ name, actual });
    }
  }

  if (drifted.length > 0) {
    console.error(`[version] VERSION is ${version}, but ${drifted.length} package(s) disagree:`);
    for (const { name, actual } of drifted) {
      console.error(`  packages/${name}/package.json: ${actual}`);
    }
    console.error('\nRun: node tool/version.mjs --write ' + version);
    process.exit(1);
  }

  console.log(`[version] all five packages agree: ${version}`);
}

function write(version) {
  if (!SEMVER.test(version)) {
    console.error(`[version] not plain semver (no "v" prefix, no build metadata): "${version}"`);
    process.exit(1);
  }

  writeFileSync(versionFile, `${version}\n`, 'utf8');
  console.log(`[version] wrote VERSION = ${version}`);

  for (const name of PACKAGES) {
    const file = packageJsonPath(name);
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    pkg.version = version;
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    console.log(`[version] packages/${name}/package.json -> ${version}`);
  }
}

function assertTag(tag) {
  const match = /^vscode-v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match) {
    console.error(`[version] tag "${tag}" does not match the required shape "vscode-v<semver>"`);
    console.error('e.g. vscode-v0.1.0 — see the header of .github/workflows/release.yml.');
    process.exit(1);
  }

  const tagVersion = match[1];
  const fileVersion = readVersionFile();
  if (tagVersion !== fileVersion) {
    console.error(
      `[version] tag "${tag}" asks for ${tagVersion}, but VERSION file says ${fileVersion}.`,
    );
    console.error(
      'Bump VERSION (node tool/version.mjs --write <semver>), commit, push, THEN tag.',
    );
    process.exit(1);
  }

  console.log(`[version] tag ${tag} matches VERSION (${fileVersion})`);
}

const args = process.argv.slice(2);
if (args.includes('--write')) {
  const value = args[args.indexOf('--write') + 1];
  if (!value) {
    console.error('[version] --write requires a semver argument, e.g. --write 0.1.0');
    process.exit(1);
  }
  write(value);
} else if (args.includes('--assert-tag')) {
  const value = args[args.indexOf('--assert-tag') + 1];
  if (!value) {
    console.error('[version] --assert-tag requires a tag argument, e.g. --assert-tag vscode-v0.1.0');
    process.exit(1);
  }
  assertTag(value);
} else {
  check();
}
