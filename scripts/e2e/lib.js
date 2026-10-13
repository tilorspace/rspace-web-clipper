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

/** A file-name safe timestamp for fixture names. */
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ---------------------------------------------------------------- Reporting

function makeReporter() {
  const counts = { ok: 0, fail: 0, info: 0 };
  const consoleLog = [];
  function record(status, name, detail = '') {
    counts[status]++;
    const tag = status === 'ok' ? 'ok  ' : status === 'fail' ? 'FAIL' : 'info';
    console.log(`${tag} ${name}${detail ? '  (' + detail + ')' : ''}`);
  }
  return {
    consoleLog,
    ok: (name, cond, detail) => record(cond ? 'ok' : 'fail', name, detail),
    info: (name, detail) => record('info', name, detail),
    summary(artifacts) {
      fs.writeFileSync(path.join(artifacts, 'console.log'), consoleLog.join('\n'));
      console.log(`\n${counts.ok} ok, ${counts.fail} failed, ${counts.info} observations. Artifacts in ${path.relative(root, artifacts)}/`);
      return counts.fail;
    },
  };
}

// ---------------------------------------------------------------- RSpace API

async function api(pathname, opts = {}) {
  return fetch(`${RSPACE_URL}${pathname}`, { ...opts, headers: { apiKey: API_KEY, ...(opts.headers || {}) } });
}

async function recentDocuments(pageSize = 50, pageNumber = 0) {
  const list = await (await api(`/api/v1/documents?pageSize=${pageSize}&pageNumber=${pageNumber}&orderBy=lastModified%20desc`)).json();
  return list.documents || [];
}

async function docByName(name) {
  return (await recentDocuments(20)).find((d) => d.name === name);
}

async function docContent(id) {
  return (await api(`/api/v1/documents/${id}`)).json();
}

/** Delete every document whose name starts with the prefix (only the scripts' own fixtures). */
async function deleteDocumentsByPrefix(prefix) {
  const mine = (await recentDocuments(50)).filter((d) => d.name.startsWith(prefix));
  let deleted = 0;
  for (const d of mine) {
    if ((await api(`/api/v1/documents/${d.id}`, { method: 'DELETE' })).ok) deleted++;
  }
  return { deleted, total: mine.length };
}

// A blank white JPEG page compresses to a few hundred bytes; real content is well above this
const MIN_PAGE_IMAGE_BYTES = 2000;

/**
 * Download the newest uploaded PDF whose name starts with namePrefix, save it, and report
 * page count and whether every page carries an image stream of plausible size.
 */
async function fetchPdfReport(namePrefix, savePath) {
  const files = await (await api('/api/v1/files?pageSize=10&orderBy=created%20desc')).json();
  const pdf = (files.files || []).find((f) => f.name && f.name.startsWith(namePrefix) && f.name.endsWith('.pdf'));
  if (!pdf) return null;
  const bytes = Buffer.from(await (await api(`/api/v1/files/${pdf.id}/file`)).arrayBuffer());
  if (savePath) fs.writeFileSync(savePath, bytes);
  const text = bytes.toString('latin1');
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
  const imageLengths = [];
  const re = /\/Subtype\s*\/Image[^>]*?\/Length\s+(\d+)/g;
  let m;
  while ((m = re.exec(text))) imageLengths.push(Number(m[1]));
  return {
    pdf, bytes, pages, imageLengths,
    valid: bytes.slice(0, 5).toString() === '%PDF-',
    allPagesHaveContent: imageLengths.length === pages && imageLengths.every((n) => n > MIN_PAGE_IMAGE_BYTES),
    describe: `${pages} pages, ${Math.round(bytes.length / 1024)} KB, image bytes: ${imageLengths.join(', ')}`,
  };
}

// ---------------------------------------------------------------- Browser and extension

function startTestServer(port, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const NOT_SHIPPED = new Set(['node_modules', 'scripts', 'web-ext-artifacts', 'package.json', 'package-lock.json']);

/** Copy the extension (everything in the repo root that ships) with test host permissions. */
function buildTestExtension(origins) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspace-clipper-e2e-'));
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.') || NOT_SHIPPED.has(name) || /\.md$/i.test(name)) continue;
    fs.cpSync(path.join(root, name), path.join(dir, name), { recursive: true });
  }
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [new URL(RSPACE_URL).origin, ...origins].map((o) => `${o}/*`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

function captureConsole(target, reporter, label) {
  target.on('console', (m) => reporter.consoleLog.push(`[${label} ${m.type()}] ${m.text()}`));
  if (typeof target.on === 'function' && label !== 'worker') {
    target.on('pageerror', (e) => reporter.consoleLog.push(`[${label} pageerror] ${e.message}`));
  }
}

/** Launch Chromium with the extension and return { context, sw, extensionId, close }. */
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
  captureConsole(sw, reporter, 'worker');
  return {
    context,
    sw,
    extensionId: new URL(sw.url()).host,
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
  captureConsole(page, reporter, label);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const [tab] = await ext.sw.evaluate((u) => chrome.tabs.query({ url: u + '*' }), url);
  return { page, tab };
}

/**
 * Open the popup as a page whose "active tab" is the given tab. chrome.tabs.query({active,
 * currentWindow}) would otherwise return the popup's own tab.
 */
async function openPopup(ext, reporter, tab) {
  const popup = await ext.context.newPage();
  captureConsole(popup, reporter, 'popup');
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

/** Resolve true when the locator reaches the state within the timeout, false otherwise. */
const appears = (locator, timeout = 5000, state = 'visible') => locator.waitFor({ state, timeout }).then(() => true, () => false);

/** Connect through the UI. Returns true on success. */
async function connect(popup, { apiKey = API_KEY, remember = false } = {}) {
  await popup.waitForSelector('#auth-screen', { state: 'visible' });
  await popup.fill('#server-url', RSPACE_URL);
  await popup.fill('#api-key', apiKey);
  await popup.setChecked('#remember-api-key', remember);
  await popup.click('#connect-btn');
  return appears(popup.locator('#clipper-screen'), 20000).then((ok) => ok && waitForClipper(popup).then(() => true));
}

/** Wait for the clipper screen and its first document load (or empty state). */
async function waitForClipper(popup) {
  await popup.waitForSelector('#clipper-screen', { state: 'visible', timeout: 20000 });
  await popup.waitForFunction(() => document.querySelectorAll('.document-item').length > 0 || document.getElementById('empty-state').style.display === 'block', null, { timeout: 20000 });
}

const RADIO_ID = { selection: 'type-selection', 'url-only': 'type-url', 'full-page': 'type-page', pdf: 'type-pdf' };

/** Pick a content type. The radio inputs are visually hidden, so click the label like a user. */
async function selectType(popup, type) {
  await popup.click(`label[for="${RADIO_ID[type]}"]`);
  await popup.waitForFunction((t) => document.querySelector('input[name="content-type"]:checked').value === t, type);
}

/** Wait for a success or error banner after Save. */
async function waitForStatus(popup, timeoutMs) {
  const started = Date.now();
  const banner = popup.locator('#clip-success.show, #clip-error.show').first();
  if (!(await appears(banner, timeoutMs))) return { ok: false, text: 'timed out waiting for a result', ms: Date.now() - started };
  return { ok: await banner.evaluate((el) => el.id === 'clip-success'), text: (await banner.textContent()).trim(), ms: Date.now() - started };
}

/**
 * Drive one clip through the popup. `docName` is typed only when it differs from what is in the
 * search box, so an existing selection (and Form field choice) is kept.
 */
async function clip(popup, { type, docName, note = '', timeoutMs = 60000 }) {
  await selectType(popup, type);
  if (docName !== undefined && (await popup.inputValue('#document-search')) !== docName) {
    await popup.fill('#document-search', docName);
    // The debounced search ends in either a selected document or the create hint
    await appears(popup.locator('.document-item.selected, #create-hint').first(), 10000);
  }
  await popup.fill('#note', note);
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

/**
 * Setup and teardown shared by both scripts: env check, reporter, artifacts folder, test
 * server, browser with the extension, fixture cleanup and the exit code.
 * `body({ ext, R, artifacts, origin })` runs the scenarios.
 */
async function runHarness({ name, port, serve, origins = [], prefix, body }) {
  if (!RSPACE_URL || !API_KEY) {
    console.error('RSPACE_URL and RSPACE_API_KEY must be set (use node --env-file=...)');
    process.exit(2);
  }
  const R = makeReporter();
  const artifacts = path.join(root, 'web-ext-artifacts', name);
  fs.mkdirSync(artifacts, { recursive: true });
  const origin = `http://127.0.0.1:${port}`;
  const server = await startTestServer(port, serve);
  let ext;
  try {
    ext = await launchExtension(R, [origin, ...origins]);
    R.ok('extension loaded', true, ext.extensionId);
    await body({ ext, R, artifacts, origin });
  } catch (e) {
    R.ok('harness', false, e.message);
  } finally {
    if (!process.env.E2E_KEEP) {
      const { deleted, total } = await deleteDocumentsByPrefix(prefix);
      R.ok('cleanup: test documents deleted', deleted === total, `${deleted}/${total}`);
    }
    if (ext) await ext.close();
    server.close();
  }
  process.exit(R.summary(artifacts) ? 1 : 0);
}

module.exports = {
  root, RSPACE_URL, API_KEY, stamp, runHarness,
  api, recentDocuments, docByName, docContent, fetchPdfReport,
  openTab, openPopup, appears, selectType, connect, waitForClipper, waitForStatus, clip, selectText,
};
