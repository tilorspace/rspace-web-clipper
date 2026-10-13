#!/usr/bin/env node
// Copies the third-party browser bundles from node_modules into the extension root.
//
//   npm run copy-libs      overwrite the committed bundles with the installed versions
//   npm run check-libs     exit non-zero if the committed bundles differ from the installed versions
//
// The extension loads these files directly (manifest + chrome.scripting.executeScript),
// so they must live in the extension root. Keeping them in sync with package.json means
// `npm audit` and Dependabot see the real versions that ship.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');

const LIBS = [
  {
    pkg: 'jspdf',
    from: path.join(root, 'node_modules', 'jspdf', 'dist', 'jspdf.umd.min.js'),
    to: path.join(root, 'jspdf.umd.min.js'),
  },
  {
    pkg: 'html2canvas',
    from: path.join(root, 'node_modules', 'html2canvas', 'dist', 'html2canvas.min.js'),
    to: path.join(root, 'html2canvas.min.js'),
  },
];

const checkOnly = process.argv.includes('--check');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function installedVersion(pkg) {
  const pkgJson = path.join(root, 'node_modules', pkg, 'package.json');
  return JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
}

let failed = false;

for (const lib of LIBS) {
  if (!fs.existsSync(lib.from)) {
    console.error(`[${lib.pkg}] missing ${path.relative(root, lib.from)}. Run "npm ci" first.`);
    failed = true;
    continue;
  }

  const version = installedVersion(lib.pkg);
  const srcHash = sha256(lib.from);
  const dstHash = fs.existsSync(lib.to) ? sha256(lib.to) : null;

  if (srcHash === dstHash) {
    console.log(`[${lib.pkg}@${version}] ${path.basename(lib.to)} is up to date`);
    continue;
  }

  if (checkOnly) {
    console.error(`[${lib.pkg}@${version}] ${path.basename(lib.to)} differs from the installed package. Run "npm run copy-libs".`);
    failed = true;
    continue;
  }

  fs.copyFileSync(lib.from, lib.to);
  console.log(`[${lib.pkg}@${version}] copied to ${path.basename(lib.to)}`);
}

process.exit(failed ? 1 : 0);
