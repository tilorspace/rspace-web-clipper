#!/usr/bin/env node
// Screenshots of every popup state at the real popup size, for visual review.
//
//   node --env-file=/path/to/.env scripts/e2e/screenshots.js
//
// Writes web-ext-artifacts/screenshots/<state>[-dark].png

const path = require('path');
const L = require('./lib');

const PREFIX = 'Clipper SHOT ';
const TEST_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Screenshot page</title></head><body><main><p id="p">Some text to clip.</p></main></body></html>';

L.runHarness({
  name: 'screenshots',
  port: 8767,
  serve: (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(TEST_PAGE); },
  prefix: PREFIX,
  async body({ ext, R, artifacts, origin }) {
    const { page, tab } = await L.openTab(ext, R, `${origin}/`);
    const popup = await L.openPopup(ext, R, tab);
    await popup.setViewportSize({ width: 380, height: 500 });

    const shoot = async (state) => {
      for (const scheme of ['light', 'dark']) {
        await popup.emulateMedia({ colorScheme: scheme });
        await popup.waitForTimeout(150);
        await popup.screenshot({ path: path.join(artifacts, `${state}${scheme === 'dark' ? '-dark' : ''}.png`) });
      }
      await popup.emulateMedia({ colorScheme: 'light' });
      R.info(`captured ${state}`);
    };

    await popup.waitForSelector('#auth-screen', { state: 'visible' });
    await shoot('1-auth');
    await popup.fill('#server-url', 'https://example.org');
    await popup.click('#connect-btn'); // no key: validation error, no permission prompt
    await L.appears(popup.locator('#auth-error.show'), 20000);
    await shoot('2-auth-error');

    R.ok('connected', await L.connect(popup));
    await shoot('3-clipper');

    await popup.fill('#document-search', PREFIX + L.stamp());
    await L.appears(popup.locator('#create-hint'));
    await shoot('4-create-hint');

    await popup.fill('#document-search', '');
    await popup.waitForTimeout(400);
    await popup.locator('.document-item').first().click();
    await L.appears(popup.locator('.document-item.selected'));
    await shoot('5-selected');

    // Form document with a field selector, and one with no compatible field
    await popup.evaluate(() => {
      window.__realSend = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = async (msg) => msg.action === 'getDocumentFields'
        ? { success: true, fields: [{ id: 1, name: 'Name', type: 'STRING' }, { id: 2, name: 'Chemical details table', type: 'TEXT' }, { id: 3, name: 'Usage log', type: 'TEXT' }] }
        : window.__realSend(msg);
    });
    await popup.locator('.document-item').nth(1).click();
    await L.appears(popup.locator('#field-selector-section'));
    await shoot('6-form-fields');
    await popup.evaluate(() => {
      chrome.runtime.sendMessage = async (msg) => msg.action === 'getDocumentFields'
        ? { success: true, fields: [{ id: 1, name: 'Name', type: 'STRING' }, { id: 2, name: 'Count', type: 'NUMBER' }] }
        : window.__realSend(msg);
    });
    await popup.locator('.document-item').nth(2).click();
    await L.appears(popup.locator('#no-compatible-fields-msg'));
    await shoot('7-no-compatible-fields');
    await popup.evaluate(() => { chrome.runtime.sendMessage = window.__realSend; });

    // Note focused (textarea grows), then error and success banners
    await popup.locator('.document-item').first().click();
    await popup.fill('#note', 'A note that spans a bit of text so the box shows its expanded size');
    await popup.focus('#note');
    await shoot('8-note-focused');

    await popup.evaluate(() => showError('clip-error', 'No text selected. Please highlight text on the page first, then try again.'));
    await shoot('9-error');
    await popup.evaluate(() => { hideBanners(); showSuccessWithLink('Content saved successfully!', 'SD1'); });
    await shoot('10-success');

    await popup.evaluate(() => showScreen('loading-screen'));
    await shoot('11-loading');
    await popup.evaluate(() => showScreen('clipper-screen'));

    // Empty state
    await popup.evaluate(() => { documents = []; renderDocuments([]); document.getElementById('empty-state').style.display = 'block'; document.getElementById('document-list').style.display = 'none'; });
    await shoot('12-empty');

    // Settings (auth screen with back button)
    await popup.click('#settings-btn');
    await L.appears(popup.locator('#auth-screen'));
    await shoot('13-settings');
    await page.close();
  },
});
