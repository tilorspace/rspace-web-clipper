// Shared helpers for the Playwright end-to-end scripts (run.js and explore.js).
//
// The extension is loaded into Chromium from a temporary copy whose manifest gets
// `host_permissions` for the RSpace origin and the local test pages: Chrome's native permission
// prompt and the activeTab grant from a toolbar click cannot be driven by Playwright. Everything
// else is the committed code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..', '..');

const RSPACE_URL = (process.env.RSPACE_URL || '').replace(/\/$/, '');
const API_KEY = process.env.RSPACE_API_KEY;

function requireEnv() {
  if (!RSPACE_URL || !API_KEY) {
    console.error('RSPACE_URL and RSPACE_API_KEY must be set (use node --env-file=...)');
    process.exit(2);
  }
}

// ---------------------------------------------------------------- Reporting

function makeReporter() {
  const results = [];
  const consoleLog = [];
  function record(status, name, detail = '') {
    results.push({ status, name, detail });
    const tag = status === 'ok' ? 'ok  ' : status === 'fail' ? 'FAIL' : 'info';
    console.log(`${tag} ${name}${detail ? '  (' + detail + ')' : ''}`);
  }
  return {
    results,
    consoleLog,
    ok: (name, cond, detail) => record(cond ? 'ok' : 'fail', name, detail),
    info: (name, detail) => record('info', name, detail),
    summary(artifacts) {
      fs.writeFileSync(path.join(artifacts, 'console.log'), consoleLog.join('\n'));
      const fails = results.filter((r) => r.status === 'fail').length;
      const infos = results.filter((r) => r.status === 'info').length;
      console.log(`\n${results.length - fails - infos} ok, ${fails} failed, ${infos} observations. Artifacts in ${path.relative(root, artifacts)}/`);
      return fails;
    },
  };
}

// ---------------------------------------------------------------- RSpace API

async function api(pathname, opts = {}) {
  return fetch(`${RSPACE_URL}${pathname}`, { ...opts, headers: { apiKey: API_KEY, ...(opts.headers || {}) } });
}

async function docByName(name) {
  const list = await (await api('/api/v1/documents?pageSize=20&orderBy=lastModified%20desc')).json();
  return (list.documents || []).find((d) => d.name === name);
}

async function docContent(id) {
  return (await api(`/api/v1/documents/${id}`)).json();
}

async function latestPdf(namePrefix) {
  const files = await (await api('/api/v1/files?pageSize=10&orderBy=created%20desc')).json();
  return (files.files || []).find((f) => f.name && f.name.startsWith(namePrefix) && f.name.endsWith('.pdf'));
}

async function downloadFile(id) {
  return Buffer.from(await (await api(`/api/v1/files/${id}/file`)).arrayBuffer());
}

/** Delete every document whose name starts with the prefix (only the scripts' own fixtures). */
async function deleteDocumentsByPrefix(prefix) {
  const recent = await (await api('/api/v1/documents?pageSize=50&orderBy=lastModified%20desc')).json();
  const mine = (recent.documents || []).filter((d) => d.name.startsWith(prefix));
  let deleted = 0;
  for (const d of mine) {
    if ((await api(`/api/v1/documents/${d.id}`, { method: 'DELETE' })).ok) deleted++;
  }
  return { deleted, total: mine.length };
}

/**
 * Rough structural check of a generated PDF: page count and the byte length of the image
 * stream on each page. A blank white JPEG slice compresses to a few hundred bytes, so a
 * healthy page carries a stream well above that.
 */
function inspectPdf(bytes) {
  const text = bytes.toString('latin1');
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const imageLengths = [];
  const re = /\/Subtype\s*\/Image[^>]*?\/Length\s+(\d+)/g;
  let m;
  while ((m = re.exec(text))) imageLengths.push(Number(m[1]));
  return { valid: bytes.slice(0, 5).toString() === '%PDF-', pages, imageLengths };
}

// ---------------------------------------------------------------- Browser and extension

function startTestServer(port, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function buildTestExtension(origins) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspace-clipper-e2e-'));
  for (const f of ['manifest.json', 'background.js', 'config.js', 'content.js', 'popup.js', 'popup.html', 'popup.css', 'html2canvas.min.js', 'jspdf.umd.min.js']) {
    fs.copyFileSync(path.join(root, f), path.join(dir, f));
  }
  fs.mkdirSync(path.join(dir, 'icons'));
  for (const f of fs.readdirSync(path.join(root, 'icons'))) fs.copyFileSync(path.join(root, 'icons', f), path.join(dir, 'icons', f));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [new URL(RSPACE_URL).origin, ...origins].map((o) => `${o}/*`);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

/**
 * Launch Chromium with the extension and return { context, sw, extensionId, close }.
 * Console output from the worker is collected into reporter.consoleLog.
 */
async function launchExtension(reporter, origins) {
  const extDir = buildTestExtension(origins);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspace-clipper-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  sw.on('console', (m) => reporter.consoleLog.push(`[worker ${m.type()}] ${m.text()}`));
  const extensionId = new URL(sw.url()).host;
  return {
    context,
    sw,
    extensionId,
    async close() {
      await context.close();
      fs.rmSync(extDir, { recursive: true, force: true });
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Open a page in the context with console capture and return it plus its chrome tab. */
async function openTab(ext, reporter, url, label = 'page') {
  const page = await ext.context.newPage();
  page.on('console', (m) => reporter.consoleLog.push(`[${label} ${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => reporter.consoleLog.push(`[${label} pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const tab = (await ext.sw.evaluate(() => chrome.tabs.query({}))).find((t) => (t.url || t.pendingUrl || '') === url || (t.url || '').startsWith(url));
  return { page, tab };
}

/**
 * Open the popup as a page whose "active tab" is the given tab. chrome.tabs.query({active,
 * currentWindow}) would otherwise return the popup's own tab.
 */
async function openPopup(ext, reporter, tab) {
  const popup = await ext.context.newPage();
  popup.on('console', (m) => reporter.consoleLog.push(`[popup ${m.type()}] ${m.text()}`));
  popup.on('pageerror', (e) => reporter.consoleLog.push(`[popup pageerror] ${e.message}`));
  await popup.addInitScript((t) => {
    const original = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (q, cb) => {
      if (q && q.active && q.currentWindow) {
        return original({}).then((tabs) => { const r = tabs.filter((x) => x.id === t.id); if (cb) cb(r); return r; });
      }
      return original(q, cb);
    };
  }, tab);
  await popup.goto(`chrome-extension://${ext.extensionId}/popup.html`);
  return popup;
}

/** Connect through the UI. Returns true on success. */
async function connect(popup, { apiKey = API_KEY, remember = false } = {}) {
  await popup.waitForSelector('#auth-screen', { state: 'visible' });
  await popup.fill('#server-url', RSPACE_URL);
  await popup.fill('#api-key', apiKey);
  if (remember) await popup.check('#remember-api-key'); else await popup.uncheck('#remember-api-key');
  await popup.click('#connect-btn');
  try {
    await waitForClipper(popup);
    return true;
  } catch {
    return false;
  }
}

/** Wait for the clipper screen and its first document load (or empty state). */
async function waitForClipper(popup) {
  await popup.waitForSelector('#clipper-screen', { state: 'visible', timeout: 20000 });
  await popup.waitForFunction(() => document.querySelectorAll('.document-item').length > 0 || document.getElementById('empty-state').style.display === 'block', null, { timeout: 20000 });
}

const RADIO_LABEL = { selection: 'type-selection', 'url-only': 'type-url', 'full-page': 'type-page', pdf: 'type-pdf' };

/** Wait for a success or error banner after Save. */
async function waitForStatus(popup, timeoutMs) {
  const success = popup.locator('#clip-success.show');
  const error = popup.locator('#clip-error.show');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await success.isVisible()) return { ok: true, text: (await success.textContent()).trim(), ms: Date.now() - started };
    if (await error.isVisible()) return { ok: false, text: (await error.textContent()).trim(), ms: Date.now() - started };
    await popup.waitForTimeout(100);
  }
  return { ok: false, text: 'timed out waiting for a result', ms: Date.now() - started };
}

/**
 * Drive one clip through the popup. `docName` is typed only when it differs from what is in the
 * search box, so an existing selection (and Form field choice) is kept.
 */
async function clip(popup, { type, docName, note = '', timeoutMs = 60000 }) {
  await popup.click(`label[for="${RADIO_LABEL[type]}"]`);
  await popup.waitForFunction((t) => document.querySelector('input[name="content-type"]:checked').value === t, type);
  if (docName !== undefined && (await popup.inputValue('#document-search')) !== docName) {
    await popup.fill('#document-search', docName);
    await popup.waitForTimeout(600); // debounce, local filter and possibly a server search
  }
  await popup.fill('#note', note);
  // Clear any banner left over from the previous clip so only this clip's result is read
  await popup.evaluate(() => { for (const id of ['clip-success', 'clip-error']) document.getElementById(id).classList.remove('show'); });
  await popup.click('#clip-btn');
  return waitForStatus(popup, timeoutMs);
}

/** Select the text content of an element on the page. Returns the selected length. */
async function selectText(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return 0;
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    return s.toString().length;
  }, selector);
}

module.exports = {
  root, RSPACE_URL, API_KEY, requireEnv, makeReporter,
  api, docByName, docContent, latestPdf, downloadFile, deleteDocumentsByPrefix, inspectPdf,
  startTestServer, launchExtension, openTab, openPopup, connect, waitForClipper, waitForStatus, clip, selectText,
};
