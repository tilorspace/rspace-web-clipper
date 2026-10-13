#!/usr/bin/env node
// Exploratory end-to-end session: pokes at edge cases that the scripted harness (run.js) does
// not cover. Each scenario records ok / FAIL / info; "info" lines are observations for a human
// to judge rather than assertions.
//
//   node --env-file=/path/to/.env scripts/e2e/explore.js
//   EXPLORE_ONLY=AB ... runs only the listed scenario letters
//
// External sites (Wikipedia, developer.chrome.com) are used for the real-world scenarios and
// skipped if unreachable.

const fs = require('fs');
const path = require('path');
const L = require('./lib');

const PREFIX = 'Clipper EXP ';
const STAMP = L.stamp();
const name = (label) => `${PREFIX}${label} ${STAMP}`;

const EXTERNAL = [
  { name: 'Wikipedia article', url: 'https://en.wikipedia.org/wiki/Electronic_lab_notebook', origin: 'https://en.wikipedia.org', selectIn: '#mw-content-text p' },
  { name: 'Chrome extension docs (JS heavy)', url: 'https://developer.chrome.com/docs/extensions/develop/concepts/activeTab', origin: 'https://developer.chrome.com', selectIn: 'main p' },
];

const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Clipper EXP page</title></head><body>
<main>
<h1>Exploratory page</h1>
<p id="p1">First paragraph with a <a href="/rel">relative link</a> and an inline image <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="dot"> here.</p>
<p id="p2">Second paragraph. <b>Bold</b> and <i>italic</i> and <code>code</code>.</p>
<ul><li>one</li><li>two</li></ul>
</main></body></html>`;

// ---------------------------------------------------------------- Scenarios

async function scenarioFormDocuments(R, popup, page, artifacts) {
  const forms = await (await L.api('/api/v1/forms?pageSize=50')).json();
  const form = (forms.forms || [])[0];
  if (!form) return R.info('A. no Form on this server, skipping Form scenarios');

  const formDetail = await (await L.api(`/api/v1/forms/${form.id}`)).json();
  const textFields = (formDetail.fields || []).filter((f) => String(f.type).toUpperCase() === 'TEXT').map((f) => f.name);
  const formDocName = name('form');
  const create = await L.api('/api/v1/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: formDocName, form: { id: form.id } }) });
  const formDoc = await create.json();
  R.ok('A1. Form document created via API', create.ok, `${formDoc.globalId} from form "${form.name}"`);

  // The list was loaded before the document existed; the server search finds it anyway
  await popup.fill('#document-search', formDocName);
  R.ok('A2. typing the exact name of a Form document shows the field selector', await L.appears(popup.locator('#field-selector-section'), 8000));
  const options = await popup.locator('#field-select option').allTextContents();
  R.ok('A3. only TEXT fields are offered', JSON.stringify(options) === JSON.stringify(textFields), `offered: ${options.join(' | ')}`);
  await popup.screenshot({ path: path.join(artifacts, 'A-field-selector.png') });

  const target = textFields[textFields.length - 1];
  await popup.selectOption('#field-select', { label: target });
  await L.selectText(page, '#p1');
  const s = await L.clip(popup, { type: 'selection', note: 'into ' + target });
  R.ok('A4. selection clip into the chosen Form field', s.ok, s.text);
  const full = await L.docContent(formDoc.id);
  const targetField = full.fields.find((f) => f.name === target);
  const otherText = full.fields.filter((f) => f.name !== target && String(f.type).toUpperCase() === 'TEXT');
  R.ok('A5. content landed in the chosen field only', targetField && targetField.content.includes('First paragraph') && otherText.every((f) => !(f.content || '').includes('First paragraph')));
  R.ok('A6. field selector still shown after the clip', await popup.locator('#field-selector-section').isVisible());

  await L.selectType(popup, 'url-only');
  R.ok('A7. field selector persists when switching content type', await popup.locator('#field-selector-section').isVisible());

  await popup.fill('#document-search', formDocName.slice(0, 10));
  R.ok('A8. editing the search box to a non-match hides the field selector', await L.appears(popup.locator('#field-selector-section'), 5000, 'hidden'));

  // Simulate a Form with no TEXT fields
  await popup.evaluate(() => {
    window.__realSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = async (msg) => msg.action === 'getDocumentFields'
      ? { success: true, fields: [{ id: 1, name: 'Only string', type: 'STRING' }, { id: 2, name: 'A number', type: 'NUMBER' }] }
      : window.__realSend(msg);
  });
  await popup.fill('#document-search', formDocName);
  R.ok('A9. Form with no text fields shows the incompatible message and disables Save', await L.appears(popup.locator('#no-compatible-fields-msg')) && (await popup.locator('#clip-btn').isDisabled()));
  await popup.screenshot({ path: path.join(artifacts, 'A-no-compatible-fields.png') });
  await popup.evaluate(() => { chrome.runtime.sendMessage = window.__realSend; });
  await popup.fill('#document-search', '');
  await L.appears(popup.locator('#field-selector-section'), 5000, 'hidden');
  R.ok('A10. clearing the search re-enables Save', !(await popup.locator('#clip-btn').isDisabled()));
}

async function scenarioHostileInputs(R, popup, page, origin) {
  const hostile = `${PREFIX}<img src=x onerror=alert(1)> "quotes" & ünïcödé 🧪 ${STAMP}`;
  await L.selectText(page, '#p2');
  let s = await L.clip(popup, { type: 'selection', docName: hostile, note: 'hostile name' });
  R.ok('B1. document with HTML/unicode/emoji in the name is created', s.ok, s.text);
  const d = await L.docByName(hostile);
  if (d) {
    await popup.fill('#document-search', 'ünïcödé');
    R.ok('B2. hostile name is rendered as text in the list (no img element)', await L.appears(popup.locator('.document-item', { hasText: 'ünïcödé' })) && (await popup.locator('.document-item img').count()) === 0);
    R.info('B2. stored name as returned by the API', JSON.stringify(d.name));
  }

  s = await L.clip(popup, { type: 'url-only', docName: PREFIX + 'x'.repeat(260) });
  R.ok('B3. 260 character document name is rejected client side', !s.ok && /too long/i.test(s.text), s.text);
  s = await L.clip(popup, { type: 'url-only', docName: name('note'), note: 'n'.repeat(10001) });
  R.ok('B4. 10001 character note is rejected client side', !s.ok && /too long/i.test(s.text), s.text);

  await page.evaluate(() => window.getSelection().removeAllRanges());
  s = await L.clip(popup, { type: 'selection', docName: name('empty') });
  R.ok('B5. selection clip with nothing selected gives a clear error', !s.ok && /No text selected/i.test(s.text), s.text);
  R.ok('B6. no document is created when the clip fails validation', !(await L.docByName(name('empty'))));

  const caseName = name('Case Test');
  await L.clip(popup, { type: 'url-only', docName: caseName });
  await L.clip(popup, { type: 'url-only', docName: caseName.toLowerCase() });
  const sameName = (await L.recentDocuments(20)).filter((d) => d.name.toLowerCase() === caseName.toLowerCase());
  R.ok('B7. a name differing only in case reuses the existing document', sameName.length === 1, `${sameName.length} document(s)`);
}

async function scenarioContentFidelity(R, popup, page, origin, artifacts) {
  const docName = name('content');
  await L.selectText(page, 'main');
  const s = await L.clip(popup, { type: 'selection', docName, note: 'note with <b>html</b> & "quotes"' });
  R.ok('C1. selection of the whole main area clips', s.ok, s.text);
  const d = await L.docByName(docName);
  if (!d) return;
  const content = (await L.docContent(d.id)).fields[0].content;
  fs.writeFileSync(path.join(artifacts, 'C-content.html'), content);
  R.ok('C2. note HTML is escaped, not rendered', content.includes('&lt;b&gt;html&lt;/b&gt;') && !content.includes('<b>html</b>'));
  R.ok('C3. relative link made absolute', content.includes(`href="${origin}/rel"`));
  R.ok('C4. data: image kept (image data URIs are allowed)', /<img[^>]+src="data:image\/gif/.test(content));
  R.ok('C5. inline formatting preserved', /<b>Bold<\/b>/.test(content) && /<code>code<\/code>/.test(content));
}

async function scenarioDoubleClick(R, popup) {
  const docName = name('double');
  await L.clip(popup, { type: 'url-only', docName });
  const d = await L.docByName(docName);
  const count = async () => ((await L.docContent(d.id)).fields[0].content.match(/Clipped from/g) || []).length;
  const before = await count();
  await popup.evaluate(() => { const b = document.getElementById('clip-btn'); b.click(); b.click(); b.click(); });
  await L.waitForStatus(popup, 30000);
  await L.appears(popup.locator('.document-item.selected', { hasText: docName }));
  R.ok('D1. triple click on Save appends exactly one clip', (await count()) === before + 1, `before ${before}, after ${await count()}`);
}

async function scenarioScrollAndKeyboard(R, popup) {
  await popup.fill('#document-search', '');
  const initial = await popup.locator('.document-item').count();
  let count = initial;
  for (let i = 0; i < 8; i++) {
    await popup.evaluate(() => { const s = document.querySelector('.document-section'); s.scrollTop = s.scrollHeight; });
    const grew = await popup.waitForFunction((n) => document.querySelectorAll('.document-item').length > n, count, { timeout: 3000 }).then(() => true, () => false);
    if (!grew) break;
    count = await popup.locator('.document-item').count();
  }
  const total = (await (await L.api('/api/v1/documents?pageSize=1')).json()).totalHits;
  R.ok('E1. infinite scroll loads further pages', count > initial, `${initial} -> ${count} items (server has ${total})`);
  const ids = await popup.locator('.document-item').evaluateAll((els) => els.map((e) => e.dataset.id));
  R.ok('E2. no duplicate documents after scrolling', new Set(ids).size === ids.length);

  await popup.evaluate(() => { document.querySelector('.document-section').scrollTop = 0; });
  await popup.focus('#document-search');
  await popup.keyboard.press('Tab');
  const focused = await popup.evaluate(() => document.activeElement && document.activeElement.className);
  R.info('E3. Tab from the search box focuses', focused || 'nothing');
  if (focused && focused.includes('document-item')) {
    await popup.keyboard.press('Enter');
    R.ok('E4. Enter on a focused list item selects it', await L.appears(popup.locator('.document-item.selected')) && (await popup.inputValue('#document-search')).length > 0);
  }
}

async function scenarioExternalSites(R, ext, artifacts) {
  for (const site of EXTERNAL) {
    let page, tab;
    try {
      ({ page, tab } = await L.openTab(ext, R, site.url, site.name));
    } catch (e) {
      R.info(`F. ${site.name} unreachable, skipped`, e.message.split('\n')[0]);
      if (page) await page.close();
      continue;
    }
    const popup = await L.openPopup(ext, R, tab);
    await L.waitForClipper(popup);
    const docName = name(site.name);
    const selLen = await L.selectText(page, site.selectIn);
    let s = await L.clip(popup, { type: 'selection', docName });
    R.ok(`F1. ${site.name}: selection clip (${selLen} chars selected)`, s.ok, s.text);
    s = await L.clip(popup, { type: 'full-page', timeoutMs: 90000 });
    R.ok(`F2. ${site.name}: full-page clip`, s.ok, `${s.text} in ${s.ms} ms`);
    s = await L.clip(popup, { type: 'pdf', timeoutMs: 180000 });
    R.ok(`F3. ${site.name}: PDF clip`, s.ok, `${s.text} in ${s.ms} ms`);
    const slug = site.name.replace(/\W+/g, '_');
    await popup.screenshot({ path: path.join(artifacts, `F-${slug}.png`) });
    const d = await L.docByName(docName);
    if (d) {
      const content = (await L.docContent(d.id)).fields[0].content;
      fs.writeFileSync(path.join(artifacts, `F-${slug}.html`), content);
      const clips = (content.match(/Clipped from/g) || []).length;
      R.ok(`F4. ${site.name}: all three clips in one document`, clips === 2 && /PDF clipped from/.test(content), `${clips} HTML clips, ${Math.round(content.length / 1024)} KB, scripts: ${(content.match(/<script/gi) || []).length}, on* attrs: ${(content.match(/\son\w+=/gi) || []).length}`);
      const report = await L.fetchPdfReport('', path.join(artifacts, `F-${slug}.pdf`));
      if (report) R.info(`F5. ${site.name}: PDF "${report.pdf.name}"`, report.describe);
    }
    await popup.close();
    await page.close();
  }
}

async function scenarioSessionLoss(R, ext, popup, testTab, artifacts) {
  // The worker caches credentials after the first read, so log out first and then plant a
  // bad key in session storage: the next request reads it and the server answers 401
  await popup.evaluate((url) => chrome.runtime.sendMessage({ action: 'logout' }).then(() => chrome.storage.session.set({ serverUrl: url, accessToken: 'revoked-key' })), L.RSPACE_URL);
  await L.selectType(popup, 'url-only');
  await popup.fill('#document-search', name('expired'));
  await L.appears(popup.locator('#create-hint'));
  await popup.click('#clip-btn');
  const authShown = await L.appears(popup.locator('#auth-screen'), 10000);
  R.ok('H1. clipping with a revoked key returns to the connect screen', authShown, authShown ? (await popup.locator('#auth-error').textContent()).trim() : '');
  await popup.screenshot({ path: path.join(artifacts, 'H-expired.png') });
  const p = await L.openPopup(ext, R, testTab);
  R.ok('H2. a popup opened afterwards shows the connect screen', await L.appears(p.locator('#auth-screen')));
  await p.close();
  R.ok('H3. reconnecting works', await L.connect(popup));
}

async function scenarioUnreachable(R, popup) {
  await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'logout' }).then(() => chrome.storage.session.set({ serverUrl: 'http://127.0.0.1:9', accessToken: 'k' })));
  const s = await L.clip(popup, { type: 'url-only', docName: name('offline'), timeoutMs: 45000 });
  R.ok('I1. unreachable server produces a clear error, not a hang', !s.ok && /reach/i.test(s.text), `${s.text} after ${s.ms} ms`);
}

async function scenarioSearchQueries(R, popup) {
  for (const q of ['🧪', '"quotes"', 'a & b', 'ünïcödé']) {
    const r = await popup.evaluate((query) => chrome.runtime.sendMessage({ action: 'getDocuments', pageNumber: 0, query }), q);
    R.info(`J. server search for ${JSON.stringify(q)}`, r && r.success ? `${r.documents.length} results` : `error: ${r && r.error}`);
  }
}

// ---------------------------------------------------------------- Main

L.runHarness({
  name: 'explore',
  port: 8766,
  serve: (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(TEST_PAGE); },
  origins: EXTERNAL.map((e) => e.origin),
  prefix: PREFIX,
  async body({ ext, R, artifacts, origin }) {
    const { page, tab } = await L.openTab(ext, R, `${origin}/`);
    const popup = await L.openPopup(ext, R, tab);
    R.ok('connected', await L.connect(popup));

    const scenarios = {
      A: () => scenarioFormDocuments(R, popup, page, artifacts),
      B: () => scenarioHostileInputs(R, popup, page, origin),
      C: () => scenarioContentFidelity(R, popup, page, origin, artifacts),
      D: () => scenarioDoubleClick(R, popup),
      E: () => scenarioScrollAndKeyboard(R, popup),
      F: () => scenarioExternalSites(R, ext, artifacts),
      J: () => scenarioSearchQueries(R, popup),
      H: () => scenarioSessionLoss(R, ext, popup, tab, artifacts),
      I: () => scenarioUnreachable(R, popup),
    };
    const only = process.env.EXPLORE_ONLY;
    for (const [letter, run] of Object.entries(scenarios)) {
      if (!only || only.includes(letter)) await run();
    }
  },
});
