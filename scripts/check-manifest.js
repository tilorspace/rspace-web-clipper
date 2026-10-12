#!/usr/bin/env node
// Static checks for the Chrome extension manifest and the files it references.
//
//   npm run check-manifest
//
// web-ext lint is Firefox-oriented (it rejects background.service_worker and requires an
// add-on ID), so this script covers the Chrome MV3 essentials instead:
//   - manifest.json parses and is manifest_version 3
//   - name, version, description, action.default_popup, background.service_worker are present
//   - every referenced file (popup, worker, icons, injected scripts) exists
//   - no permission or host pattern outside the allowlist below sneaks in
//   - every .js file in the extension root passes a syntax check (node --check)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const problems = [];

function fail(msg) {
  problems.push(msg);
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

// Permissions the extension is allowed to request. Adding one is a deliberate decision
// that should update this list and the README privacy section together.
const ALLOWED_PERMISSIONS = new Set(['activeTab', 'scripting', 'storage', 'tabs']);
const ALLOWED_OPTIONAL_HOSTS = new Set(['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']);

// Files injected at runtime via chrome.scripting.executeScript (see popup.js).
const INJECTED_FILES = ['content.js', 'html2canvas.min.js', 'jspdf.umd.min.js'];

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
} catch (e) {
  console.error(`manifest.json does not parse: ${e.message}`);
  process.exit(1);
}

if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
for (const key of ['name', 'version', 'description']) {
  if (!manifest[key]) fail(`manifest.${key} is missing`);
}
if (manifest.version && !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
  fail(`manifest.version "${manifest.version}" must be 1 to 4 dot-separated integers`);
}

const popup = manifest.action && manifest.action.default_popup;
if (!popup) fail('action.default_popup is missing');
else if (!exists(popup)) fail(`action.default_popup "${popup}" does not exist`);

const worker = manifest.background && manifest.background.service_worker;
if (!worker) fail('background.service_worker is missing');
else if (!exists(worker)) fail(`background.service_worker "${worker}" does not exist`);

for (const group of [manifest.icons || {}, (manifest.action && manifest.action.default_icon) || {}]) {
  for (const [size, file] of Object.entries(group)) {
    if (!exists(file)) fail(`icon ${size} "${file}" does not exist`);
  }
}

for (const p of manifest.permissions || []) {
  if (!ALLOWED_PERMISSIONS.has(p)) fail(`permission "${p}" is not in the allowlist`);
}
if (manifest.host_permissions && manifest.host_permissions.length) {
  fail('host_permissions must stay empty; use optional_host_permissions and request per origin');
}
for (const h of manifest.optional_host_permissions || []) {
  if (!ALLOWED_OPTIONAL_HOSTS.has(h)) fail(`optional_host_permission "${h}" is not in the allowlist`);
}

for (const f of INJECTED_FILES) {
  if (!exists(f)) fail(`injected file "${f}" does not exist`);
}

if (manifest.web_accessible_resources && manifest.web_accessible_resources.length) {
  fail('web_accessible_resources should stay empty for this extension');
}

const csp = manifest.content_security_policy && manifest.content_security_policy.extension_pages;
if (!csp || !/script-src 'self'/.test(csp)) fail("content_security_policy.extension_pages must include script-src 'self'");

// Syntax check every JS file that ships (root level only; scripts/ and node_modules are tooling).
for (const file of fs.readdirSync(root)) {
  if (!file.endsWith('.js')) continue;
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  } catch (e) {
    fail(`${file} failed syntax check:\n${e.stderr.toString().trim()}`);
  }
}

if (problems.length) {
  console.error('Manifest check failed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`manifest.json OK (${manifest.name} ${manifest.version}, ${(manifest.permissions || []).length} permissions)`);
