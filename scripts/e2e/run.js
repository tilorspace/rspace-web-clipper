#!/usr/bin/env node
// End-to-end test: loads the real extension into Chromium with Playwright, drives the popup
// against a running RSpace instance, and verifies the results through the RSpace API.
//
//   node --env-file=/path/to/.env scripts/e2e/run.js
//
// Required environment: RSPACE_URL (e.g. http://localhost:8080), RSPACE_API_KEY.
// Optional: HEADED=1 to watch the browser, E2E_KEEP=1 to keep the created documents.
// See lib.js for the one deviation from the shipped manifest (host_permissions).

const path = require('path');
const fs = require('fs');
const L = require('./lib');

const PREFIX = 'Clipper E2E ';
const DOC_NAME = PREFIX + L.stamp();
const TALL_DOC = DOC_NAME + ' tall';

const SENTINEL_TEXT = 'Sentinel paragraph for the selection clip. configuration_id=5, onclick=handler and the word javascript: appear here as plain text.';
const NOTES = {
  selection1: 'note one selection',
  pdf: 'note two pdf',
  selection2: 'note three selection again',
  urlOnly: 'note four url only',
  fullPage: 'note five full page',
  lifecycle: 'note six after popup closed',
  again: 'note seven save again without retyping',
};

function testPage(blocks, title = 'Clipper E2E page') {
  const html = Array.from({ length: blocks }, (_, i) => `<div class="block">Block ${i + 1}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:sans-serif;margin:24px}.block{height:900px;border:1px solid #ccc;margin:12px 0;padding:12px;background:linear-gradient(#fff,#eef)}td{border:1px solid #999;padding:4px 8px}</style>
</head><body>
<main>
<h1>Clipper E2E page</h1>
<p id="sentinel">${SENTINEL_TEXT}</p>
<table><tr><td>a</td><td colspan="2">merged</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>
<p><a href="/relative/link">relative link</a> <a href="javascript:alert(1)">js link</a> <img src="x.png" onerror="alert(1)" alt="img"></p>
${html}
</main>
</body></html>`;
}

function serve(req, res) {
  if (req.url.startsWith('/x.png')) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  // /tall is about 20 000 px: above Chrome's single-canvas limit, so only chunked rendering copes
  res.end(req.url.startsWith('/tall') ? testPage(22, 'Clipper E2E tall page') : testPage(4));
}

const localStore = (popup, keys) => popup.evaluate((k) => chrome.storage.local.get(k), keys);

// ---------------------------------------------------------------- Scenarios

async function scenarioConnect(R, popup, artifacts) {
  await popup.waitForSelector('#auth-screen', { state: 'visible' });
  await popup.fill('#server-url', 'example.org');
  R.ok('url input accepts a bare host (https:// is added on connect)', (await popup.inputValue('#server-url')) === 'example.org');

  R.ok('connect with an invalid key fails', !(await L.connect(popup, { apiKey: 'not-a-valid-key', remember: true })));
  let stored = await localStore(popup, ['savedApiKey', 'apiKeyExpiresAt']);
  R.ok('invalid API key is not persisted', !stored.savedApiKey && !stored.apiKeyExpiresAt);

  R.ok('connect to RSpace', await L.connect(popup, { remember: true }));
  stored = await localStore(popup, ['savedApiKey', 'apiKeyExpiresAt', 'savedServerUrl']);
  R.ok('valid API key persisted with future expiry', stored.savedApiKey === L.API_KEY && stored.apiKeyExpiresAt > Date.now());
  R.ok('server url persisted', stored.savedServerUrl === L.RSPACE_URL);
  await popup.screenshot({ path: path.join(artifacts, 'popup-connected.png') });
}

async function scenarioClips(R, popup, page) {
  await L.selectText(page, '#sentinel');
  let s = await L.clip(popup, { type: 'selection', docName: DOC_NAME, note: NOTES.selection1 });
  R.ok('1 selection clip (new document)', s.ok, s.text);
  R.ok('new document stays selected after the clip', await L.appears(popup.locator('.document-item.selected', { hasText: DOC_NAME })));

  s = await L.clip(popup, { type: 'pdf', note: NOTES.pdf, timeoutMs: 90000 });
  R.ok('2 pdf clip after selection clip, same tab', s.ok, s.text);
  s = await L.clip(popup, { type: 'selection', note: NOTES.selection2 });
  R.ok('3 selection clip after pdf clip, same tab', s.ok, s.text);
  s = await L.clip(popup, { type: 'url-only', note: NOTES.urlOnly });
  R.ok('4 url-only clip', s.ok, s.text);
  s = await L.clip(popup, { type: 'full-page', note: NOTES.fullPage });
  R.ok('5 full-page clip', s.ok, s.text);

  // Regression: Save again without touching the search box must append, not create
  s = await L.clip(popup, { type: 'url-only', note: NOTES.again });
  R.ok('6 save again without retyping the name', s.ok, s.text);
  R.ok('only one document with that name exists', (await L.recentDocuments(20)).filter((d) => d.name === DOC_NAME).length === 1);

  const redeclared = R.consoleLog.filter((l) => /already been declared/.test(l));
  R.ok('no redeclaration error in page console on re-injection', redeclared.length === 0, redeclared[0] || '');
}

async function scenarioSearch(R, ext, popup, testTab, artifacts) {
  const farDoc = (await L.recentDocuments(50, 2)).find((d) => d.name.length > 3 && !d.name.startsWith(PREFIX));
  R.ok('a document beyond the first page exists for the search test', !!farDoc, farDoc && farDoc.name);
  if (farDoc) {
    await popup.fill('#document-search', farDoc.name);
    R.ok('server search lists and selects a document outside the loaded pages', await L.appears(popup.locator('.document-item.selected', { hasText: farDoc.name })));
    R.ok('create hint hidden when an exact match exists', !(await popup.locator('#create-hint').isVisible()));
  }

  await popup.fill('#document-search', DOC_NAME.slice(0, 12));
  await L.appears(popup.locator('#create-hint'));
  await L.appears(popup.locator('#clip-success.show'), 5000, 'hidden'); // banner from the last clip
  await popup.press('#document-search', 'Enter');
  R.ok('Enter selects the single partial match', await L.appears(popup.locator('.document-item.selected', { hasText: DOC_NAME })) && (await popup.inputValue('#document-search')) === DOC_NAME);
  R.ok('Enter does not start a clip', !(await popup.locator('#loading-screen').isVisible()) && !(await popup.locator('#clip-success.show').isVisible()));

  // A clip that finishes after the popup was closed is reported on the next open, once
  await L.selectType(popup, 'url-only');
  await popup.fill('#note', NOTES.lifecycle);
  await popup.click('#clip-btn');
  await popup.close();
  await ext.sw.evaluate(async () => { while (!(await chrome.storage.session.get('lastClipResult')).lastClipResult) await new Promise((r) => setTimeout(r, 100)); });
  const reopened = await L.openPopup(ext, R, testTab);
  const pending = await L.appears(reopened.locator('#clip-success.show'));
  R.ok('result of a clip finished after popup close is shown on reopen', pending, pending ? (await reopened.locator('#clip-success').textContent()).trim() : '');
  await reopened.screenshot({ path: path.join(artifacts, 'popup-reopened.png') });
  await reopened.close();
  const again = await L.openPopup(ext, R, testTab);
  await L.waitForClipper(again);
  R.ok('pending result is shown only once', !(await again.locator('#clip-success.show').isVisible()));
  return again;
}

async function scenarioTallPdf(R, ext, origin, artifacts) {
  const { page, tab } = await L.openTab(ext, R, `${origin}/tall`, 'tall');
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const popup = await L.openPopup(ext, R, tab);
  await L.waitForClipper(popup);
  const s = await L.clip(popup, { type: 'pdf', docName: TALL_DOC, timeoutMs: 180000 });
  R.ok(`7 pdf clip of a ${height}px tall page`, s.ok, s.text);
  await popup.screenshot({ path: path.join(artifacts, 'popup-tall-pdf.png') });
  if (s.ok) {
    const report = await L.fetchPdfReport('Clipper_E2E_tall_page', path.join(artifacts, 'clipped-tall.pdf'));
    R.ok('tall PDF uploaded', !!report);
    if (report) R.ok('tall PDF has many pages, each with content', report.valid && report.pages >= 8 && report.allPagesHaveContent, report.describe);
  }
  await popup.close();
  await page.close();
}

async function scenarioWorkerValidation(R, popup) {
  const bad = await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'clipContent', targetDoc: { isNew: false, id: '1/../2' }, content: { html: '<p>x</p>' } }));
  R.ok('worker rejects a malformed document id', bad && bad.success === false && /Invalid document id/.test(bad.error), bad && bad.error);
  const badField = await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'getDocumentFields', documentId: 'abc' }));
  R.ok('worker rejects a malformed field lookup id', badField && badField.success === false, badField && badField.error);
}

async function scenarioLogout(R, popup, artifacts) {
  await popup.click('#settings-btn');
  await popup.click('#clear-data-btn');
  await L.appears(popup.locator('#auth-error.show'));
  const stored = await localStore(popup, ['savedApiKey', 'apiKeyExpiresAt', 'savedServerUrl', 'rememberApiKey']);
  const session = await popup.evaluate(() => chrome.storage.session.get(['serverUrl', 'accessToken']));
  R.ok('clear saved data removes persisted credentials', Object.keys(stored).length === 0, JSON.stringify(Object.keys(stored)));
  R.ok('clear saved data clears session', !session.serverUrl && !session.accessToken);
  await popup.screenshot({ path: path.join(artifacts, 'popup-after-clear.png') });
}

async function verifyViaApi(R, origin, artifacts) {
  const doc = await L.docByName(DOC_NAME);
  R.ok('document exists via API', !!doc, doc && doc.globalId);
  if (!doc) return;
  const full = await L.docContent(doc.id);
  const content = (full.fields && full.fields[0] && full.fields[0].content) || '';
  fs.writeFileSync(path.join(artifacts, 'document-content.html'), content);

  R.ok('tag web-clipper applied', (full.tags || '').includes('web-clipper'), full.tags);
  const clippedCount = (content.match(/Clipped from/g) || []).length;
  R.ok('six HTML clips present', clippedCount === 6, `found ${clippedCount}`);
  R.ok('one PDF clip present', /PDF clipped from/.test(content));
  for (const [k, v] of Object.entries(NOTES)) R.ok(`note "${k}" present`, content.includes(v));
  R.ok('sentinel text intact (sanitizer does not corrupt prose)', content.includes(SENTINEL_TEXT), content.includes(SENTINEL_TEXT) ? '' : (content.match(/Sentinel paragraph[^<]*/) || ['sentinel missing'])[0]);
  R.ok('table colspan preserved', /colspan="2"/.test(content));
  R.ok('source url and title captured from the tab', content.includes(`href="${origin}/"`) && content.includes('Clipper E2E page</a>'));
  R.ok('relative link made absolute', content.includes(`${origin}/relative/link`));
  R.ok('javascript: href removed', !/href="javascript:/i.test(content));
  R.ok('onerror handler removed', !/onerror=/i.test(content));
  R.ok('PDF attachment linked in document', /<fileId=\d+>|data-fileid|\/files\/|attachment/i.test(content));

  const report = await L.fetchPdfReport('Clipper_E2E_page', path.join(artifacts, 'clipped.pdf'));
  R.ok('PDF file uploaded', !!report, report && report.pdf.name);
  if (report) {
    R.ok('PDF is valid and multi-page', report.valid && report.pages > 1, report.describe);
    R.ok('every PDF page carries rendered content', report.allPagesHaveContent);
  }
}

// ---------------------------------------------------------------- Main

L.runHarness({
  name: 'e2e',
  port: 8765,
  serve,
  prefix: PREFIX,
  async body({ ext, R, artifacts, origin }) {
    const { page, tab: testTab } = await L.openTab(ext, R, `${origin}/`);
    R.ok('test page open in a tab', !!testTab, `tab ${testTab && testTab.id}`);

    let popup = await L.openPopup(ext, R, testTab);
    await scenarioConnect(R, popup, artifacts);
    await scenarioClips(R, popup, page);
    popup = await scenarioSearch(R, ext, popup, testTab, artifacts);
    await scenarioTallPdf(R, ext, origin, artifacts);
    await scenarioWorkerValidation(R, popup);
    await scenarioLogout(R, popup, artifacts);
    await verifyViaApi(R, origin, artifacts);
  },
});
