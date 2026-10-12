#!/usr/bin/env node
// End-to-end test: loads the real extension into Chromium with Playwright, drives the popup
// against a running RSpace instance, and verifies the results through the RSpace API.
//
//   node --env-file=/path/to/.env scripts/e2e/run.js
//
// Required environment: RSPACE_URL (e.g. http://localhost:8080), RSPACE_API_KEY.
// Optional: HEADED=1 to watch the browser, E2E_KEEP=1 to keep the created document.
//
// Test-only deviation from the shipped manifest: the copy of the extension that is loaded gets
// `host_permissions` for the RSpace origin and the local test page, because Chrome's native
// permission prompt (chrome.permissions.request) and the activeTab grant from a toolbar click
// cannot be driven by Playwright. Everything else is the code as committed.
//
// Scenarios, all in ONE tab without reloading (this is the WP3 regression):
//   1. Selection clip into a new document
//   2. PDF clip into that document
//   3. Selection clip again (content.js already injected, PDF libs already present)
//   4. URL-only clip
//   5. Full-page clip
// Then the document and the uploaded PDF are fetched through the API and checked.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const RSPACE_URL = (process.env.RSPACE_URL || '').replace(/\/$/, '');
const API_KEY = process.env.RSPACE_API_KEY;
if (!RSPACE_URL || !API_KEY) {
  console.error('RSPACE_URL and RSPACE_API_KEY must be set (use node --env-file=...)');
  process.exit(2);
}

const root = path.resolve(__dirname, '..', '..');
const artifacts = path.join(root, 'web-ext-artifacts', 'e2e');
fs.mkdirSync(artifacts, { recursive: true });

const TEST_PORT = 8765;
const TEST_ORIGIN = `http://127.0.0.1:${TEST_PORT}`;
const DOC_NAME = `Clipper E2E ${new Date().toISOString().replace(/[:.]/g, '-')}`;

// Sentinels we look for in the saved content
const SENTINEL_TEXT = 'Sentinel paragraph for the selection clip. configuration_id=5, onclick=handler and the word javascript: appear here as plain text.';
const NOTES = {
  selection1: 'note one selection',
  pdf: 'note two pdf',
  selection2: 'note three selection again',
  urlOnly: 'note four url only',
  fullPage: 'note five full page',
};

const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Clipper E2E page</title>
<style>body{font-family:sans-serif;margin:24px}.block{height:900px;border:1px solid #ccc;margin:12px 0;padding:12px;background:linear-gradient(#fff,#eef)}td{border:1px solid #999;padding:4px 8px}</style>
</head><body>
<main>
<h1>Clipper E2E page</h1>
<p id="sentinel">${SENTINEL_TEXT}</p>
<table><tr><td>a</td><td colspan="2">merged</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>
<p><a href="/relative/link">relative link</a> <a href="javascript:alert(1)">js link</a> <img src="x.png" onerror="alert(1)" alt="img"></p>
<div class="block">Block 1</div><div class="block">Block 2</div><div class="block">Block 3</div><div class="block">Block 4</div>
</main>
</body></html>`;

const RADIO_LABEL = { selection: 'type-selection', 'url-only': 'type-url', 'full-page': 'type-page', pdf: 'type-pdf' };
const consoleLog = [];
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`);
}

async function api(pathname, opts = {}) {
  const res = await fetch(`${RSPACE_URL}${pathname}`, {
    ...opts,
    headers: { apiKey: API_KEY, ...(opts.headers || {}) },
  });
  return res;
}

function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/x.png')) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(TEST_PAGE);
    });
    server.listen(TEST_PORT, '127.0.0.1', () => resolve(server));
  });
}

function buildTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspace-clipper-e2e-'));
  for (const f of ['manifest.json', 'background.js', 'config.js', 'content.js', 'popup.js', 'popup.html', 'popup.css', 'html2canvas.min.js', 'jspdf.umd.min.js']) {
    fs.copyFileSync(path.join(root, f), path.join(dir, f));
  }
  fs.mkdirSync(path.join(dir, 'icons'));
  for (const f of fs.readdirSync(path.join(root, 'icons'))) {
    fs.copyFileSync(path.join(root, 'icons', f), path.join(dir, 'icons', f));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [`${new URL(RSPACE_URL).origin}/*`, `${TEST_ORIGIN}/*`];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

async function waitForStatus(popup, timeoutMs) {
  // Resolve with whichever of success/error becomes visible first
  const success = popup.locator('#clip-success.show');
  const error = popup.locator('#clip-error.show');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await success.isVisible()) return { ok: true, text: (await success.textContent()).trim() };
    if (await error.isVisible()) return { ok: false, text: (await error.textContent()).trim() };
    await popup.waitForTimeout(100);
  }
  return { ok: false, text: 'timed out waiting for a result' };
}

async function clip(popup, { type, note, timeoutMs = 30000 }) {
  // The radio inputs are visually hidden behind styled labels; click the label like a user would
  await popup.click(`label[for="${RADIO_LABEL[type]}"]`);
  await popup.waitForFunction((t) => document.querySelector('input[name="content-type"]:checked').value === t, type);
  await popup.fill('#document-search', DOC_NAME);
  await popup.waitForTimeout(500); // search debounce, selects the exact match once the doc exists
  await popup.fill('#note', note);
  await popup.click('#clip-btn');
  const status = await waitForStatus(popup, timeoutMs);
  await popup.screenshot({ path: path.join(artifacts, `popup-${type}-${Date.now()}.png`) });
  return status;
}

(async () => {
  const server = await startTestServer();
  const extDir = buildTestExtension();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rspace-clipper-profile-'));
  let context;

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: !process.env.HEADED,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    });

    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(sw.url()).host;
    record('extension loaded', true, extensionId);

    // The page we clip from
    const page = await context.newPage();
    page.on('console', (m) => consoleLog.push(`[page ${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleLog.push(`[page pageerror] ${e.message}`));
    await page.goto(`${TEST_ORIGIN}/`);
    await page.evaluate(() => {
      const el = document.getElementById('sentinel');
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    const [testTab] = await sw.evaluate((url) => chrome.tabs.query({ url: url + '/*' }), TEST_ORIGIN);
    record('test page open in a tab', !!testTab, `tab ${testTab && testTab.id}`);

    // The popup, opened as a page. chrome.tabs.query({active, currentWindow}) would return the
    // popup tab itself, so it is pointed at the test tab instead.
    const popup = await context.newPage();
    await popup.addInitScript((tab) => {
      const original = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = (q, cb) => {
        if (q && q.active && q.currentWindow) {
          const p = original({});
          return p.then((tabs) => {
            const t = tabs.filter((x) => x.id === tab.id);
            if (cb) cb(t);
            return t;
          });
        }
        return original(q, cb);
      };
    }, testTab);
    popup.on('console', (m) => consoleLog.push(`[popup ${m.type()}] ${m.text()}`));
    popup.on('pageerror', (e) => consoleLog.push(`[popup pageerror] ${e.message}`));
    sw.on('console', (m) => consoleLog.push(`[worker ${m.type()}] ${m.text()}`));
    const flushLog = () => fs.writeFileSync(path.join(artifacts, 'console.log'), consoleLog.join('\n'));
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    // Connect
    await popup.waitForSelector('#auth-screen', { state: 'visible' });
    const localStore = (keys) => popup.evaluate((k) => chrome.storage.local.get(k), keys);

    // URL input: deleting the scheme must prepend https:// rather than wipe the input.
    // The popup attaches its input listeners after an async auth check, so poll briefly.
    let prefixed = false;
    for (let i = 0; i < 20 && !prefixed; i++) {
      await popup.fill('#server-url', 'example.org');
      prefixed = (await popup.inputValue('#server-url')) === 'https://example.org';
      if (!prefixed) await popup.waitForTimeout(100);
    }
    record('url input restores https:// in front of a bare host', prefixed);

    // Wrong key with "remember" checked must not be persisted
    await popup.fill('#server-url', RSPACE_URL);
    record('url input accepts http://localhost', (await popup.inputValue('#server-url')) === RSPACE_URL);
    await popup.check('#remember-api-key');
    await popup.fill('#api-key', 'not-a-valid-key');
    await popup.click('#connect-btn');
    await popup.waitForSelector('#auth-error.show', { timeout: 20000 });
    let stored = await localStore(['savedApiKey', 'apiKeyExpiresAt']);
    record('invalid API key is not persisted', !stored.savedApiKey && !stored.apiKeyExpiresAt);

    // Correct key with "remember" checked is persisted with an expiry
    await popup.fill('#api-key', API_KEY);
    await popup.click('#connect-btn');
    try {
      await popup.waitForSelector('#clipper-screen', { state: 'visible', timeout: 20000 });
      record('connect to RSpace', true);
      stored = await localStore(['savedApiKey', 'apiKeyExpiresAt', 'savedServerUrl']);
      record('valid API key persisted with future expiry', stored.savedApiKey === API_KEY && stored.apiKeyExpiresAt > Date.now());
      record('server url persisted', stored.savedServerUrl === RSPACE_URL);
    } catch (e) {
      const err = await popup.locator('#auth-error').textContent();
      await popup.screenshot({ path: path.join(artifacts, 'popup-connect-failed.png') });
      flushLog();
      record('connect to RSpace', false, err.trim() || 'no error text shown');
      throw new Error('cannot continue without a connection');
    }
    await popup.screenshot({ path: path.join(artifacts, 'popup-connected.png') });

    // 1. Selection clip into a new document
    let s = await clip(popup, { type: 'selection', note: NOTES.selection1 });
    record('1 selection clip (new document)', s.ok, s.text);

    // 2. PDF clip, same tab, content.js already injected
    s = await clip(popup, { type: 'pdf', note: NOTES.pdf, timeoutMs: 90000 });
    record('2 pdf clip after selection clip, same tab', s.ok, s.text);

    // 3. Selection clip again, both content.js and PDF libs already present
    s = await clip(popup, { type: 'selection', note: NOTES.selection2 });
    record('3 selection clip after pdf clip, same tab', s.ok, s.text);

    // 4. URL only
    s = await clip(popup, { type: 'url-only', note: NOTES.urlOnly });
    record('4 url-only clip', s.ok, s.text);

    // 5. Full page
    s = await clip(popup, { type: 'full-page', note: NOTES.fullPage });
    record('5 full-page clip', s.ok, s.text);

    // WP6: malformed ids from the popup side are rejected by the worker without a server call
    const bad = await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'clipContent', targetDoc: { isNew: false, id: '1/../2' }, content: { html: '<p>x</p>' } }));
    record('worker rejects a malformed document id', bad && bad.success === false && /Invalid document id/.test(bad.error), bad && bad.error);
    const badField = await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'getDocumentFields', documentId: 'abc' }));
    record('worker rejects a malformed field lookup id', badField && badField.success === false, badField && badField.error);

    // Logout via Settings > Clear Saved Data must wipe local storage, session and the worker cache
    // The popup reloads the document list after a clip; wait for that to repopulate the cache
    let cached = false;
    for (let i = 0; i < 50 && !cached; i++) {
      cached = await sw.evaluate(() => Array.isArray(documentsCache.data));
      if (!cached) await popup.waitForTimeout(100);
    }
    record('worker cache populated after clipping', cached);
    await popup.click('#settings-btn');
    await popup.click('#clear-data-btn');
    await popup.waitForTimeout(500);
    stored = await localStore(['savedApiKey', 'apiKeyExpiresAt', 'savedServerUrl', 'rememberApiKey']);
    const session = await popup.evaluate(() => chrome.storage.session.get(['serverUrl', 'accessToken']));
    record('clear saved data removes persisted credentials', Object.keys(stored).length === 0, JSON.stringify(Object.keys(stored)));
    record('clear saved data clears session', !session.serverUrl && !session.accessToken);
    record('clear saved data clears worker cache', await sw.evaluate(() => documentsCache.data === null && activeRequests.size === 0));
    await popup.screenshot({ path: path.join(artifacts, 'popup-after-clear.png') });

    // WP3 regression: re-injecting content.js must not throw in the page
    const redeclared = consoleLog.filter((l) => /already been declared/.test(l));
    record('no redeclaration error in page console on re-injection', redeclared.length === 0, redeclared[0] || '');

    // Verify through the API
    const list = await (await api(`/api/v1/documents?pageSize=20&orderBy=lastModified%20desc`)).json();
    const doc = (list.documents || []).find((d) => d.name === DOC_NAME);
    record('document exists via API', !!doc, doc && doc.globalId);
    if (doc) {
      const full = await (await api(`/api/v1/documents/${doc.id}`)).json();
      const content = (full.fields && full.fields[0] && full.fields[0].content) || '';
      fs.writeFileSync(path.join(artifacts, 'document-content.html'), content);

      record('tag web-clipper applied', (full.tags || '').includes('web-clipper'), full.tags);
      const clippedCount = (content.match(/Clipped from/g) || []).length;
      record('four HTML clips present', clippedCount === 4, `found ${clippedCount}`);
      record('one PDF clip present', /PDF clipped from/.test(content));
      for (const [k, v] of Object.entries(NOTES)) {
        record(`note "${k}" present`, content.includes(v));
      }
      record('sentinel text intact (sanitizer does not corrupt prose)', content.includes(SENTINEL_TEXT), content.includes(SENTINEL_TEXT) ? '' : (content.match(/Sentinel paragraph[^<]*/) || ['sentinel missing'])[0]);
      record('table colspan preserved', /colspan="2"/.test(content));
      record('source url and title captured from the tab', content.includes(`href="${TEST_ORIGIN}/"`) && content.includes('Clipper E2E page</a>'));
      record('relative link made absolute', content.includes(`${TEST_ORIGIN}/relative/link`));
      record('javascript: href removed', !/href="javascript:/i.test(content));
      record('onerror handler removed', !/onerror=/i.test(content));
      record('PDF attachment linked in document', /<fileId=\d+>|data-fileid|\/files\/|attachment/i.test(content));

      // Find the uploaded PDF
      const files = await (await api(`/api/v1/files?pageSize=10&orderBy=created%20desc`)).json();
      const pdf = (files.files || []).find((f) => f.name && f.name.startsWith('Clipper_E2E_page') && f.name.endsWith('.pdf'));
      record('PDF file uploaded', !!pdf, pdf && `${pdf.name} ${pdf.size} bytes`);
      if (pdf) {
        const bytes = Buffer.from(await (await api(`/api/v1/files/${pdf.id}/file`)).arrayBuffer());
        fs.writeFileSync(path.join(artifacts, 'clipped.pdf'), bytes);
        const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
        record('PDF is valid and multi-page', bytes.slice(0, 5).toString() === '%PDF-' && pages > 1, `${pages} pages, ${bytes.length} bytes`);
      }

    }

    if (!process.env.E2E_KEEP) {
      // Delete this run's document and any "Clipper E2E ..." leftovers from aborted runs
      const recent = await (await api(`/api/v1/documents?pageSize=50&orderBy=lastModified%20desc`)).json();
      const mine = (recent.documents || []).filter((d) => d.name.startsWith('Clipper E2E '));
      let deleted = 0;
      for (const d of mine) {
        const del = await api(`/api/v1/documents/${d.id}`, { method: 'DELETE' });
        if (del.ok) deleted++;
      }
      record('cleanup: test documents deleted', deleted === mine.length, `${deleted}/${mine.length}`);
    }
  } catch (e) {
    record('harness', false, e.message);
  } finally {
    fs.writeFileSync(path.join(artifacts, 'console.log'), consoleLog.join('\n'));
    if (context) await context.close();
    server.close();
    fs.rmSync(extDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Artifacts in ${path.relative(root, artifacts)}/`);
  process.exit(failed.length ? 1 : 0);
})();
