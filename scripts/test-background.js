#!/usr/bin/env node
// Unit tests for the background service worker, run in a vm context with a stubbed chrome API
// and fetch. Covers request validation, timeout behaviour and cache handling without a browser.
//
//   node scripts/test-background.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');

function makeWorker({ fetchImpl, session = { serverUrl: 'http://rspace.test', accessToken: 'k' } } = {}) {
  const calls = [];
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    FormData: class { append() {} },
    fetch: (url, opts) => {
      calls.push({ url, opts });
      return fetchImpl(url, opts);
    },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: { session: { get: async () => session, clear: async () => {}, set: async () => {} } },
      tabs: { sendMessage: async () => ({}) },
    },
    importScripts(file) {
      vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx, { filename: file });
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return { ctx, calls, get: (name) => vm.runInContext(name, ctx) };
}

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

(async () => {
  // 1. fetchWithTimeout default comes from CONFIG and aborts a hanging request
  {
    const w = makeWorker({ fetchImpl: (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
    const CONFIG = w.get('CONFIG');
    assert.strictEqual(typeof CONFIG.API.REQUEST_TIMEOUT_MS, 'number');
    assert.strictEqual(typeof CONFIG.API.UPLOAD_TIMEOUT_MS, 'number');
    const fetchWithTimeout = w.get('fetchWithTimeout');
    const started = Date.now();
    await assert.rejects(fetchWithTimeout('http://x', {}, 50), /Request timeout/);
    assert.ok(Date.now() - started < 1000, 'aborted promptly');
    console.log('ok  fetchWithTimeout aborts with "Request timeout"');
  }

  // 2. Invalid ids are rejected before any network call
  {
    const w = makeWorker({ fetchImpl: () => { throw new Error('fetch must not be called'); } });
    const clipContent = w.get('clipContent');
    const getDocumentFields = w.get('getDocumentFields');
    for (const bad of ['abc', '1/../2', -1, 0, 1.5, null, undefined, {}]) {
      const r = await clipContent({ targetDoc: { isNew: false, id: bad }, content: { html: 'x' } });
      assert.strictEqual(r.success, false, `id ${String(bad)} must be rejected`);
      assert.match(r.error, /Invalid document id/);
    }
    const f = await getDocumentFields('12abc');
    assert.strictEqual(f.success, false);
    assert.match(f.error, /Invalid document id/);
    const r2 = await clipContent({ targetDoc: { isNew: false, id: 5 }, targetField: { id: 'x' }, content: { html: 'x' } });
    assert.match(r2.error, /Invalid field id/);
    const r3 = await clipContent({ targetDoc: { isNew: true, title: '   ' }, content: { html: 'x' } });
    assert.match(r3.error, /Invalid document title/);
    const r4 = await clipContent({});
    assert.match(r4.error, /No target document/);
    assert.strictEqual(w.calls.length, 0, 'no fetch calls were made');
    console.log('ok  invalid ids, titles and targets are rejected without network calls');
  }

  // 3. Numeric string ids are accepted and used in the URL
  {
    const w = makeWorker({
      fetchImpl: async (url) => {
        if (url.endsWith('/documents/42')) return jsonResponse({ fields: [{ id: 7, content: '<p>old</p>' }] });
        return jsonResponse({});
      },
    });
    const clipContent = w.get('clipContent');
    const r = await clipContent({ targetDoc: { isNew: false, id: '42' }, content: { html: '<p>new</p>' }, sourceUrl: 'http://s', sourceTitle: 't' });
    assert.strictEqual(r.success, true, JSON.stringify(r));
    assert.strictEqual(r.documentId, 42);
    const put = w.calls.find((c) => c.opts && c.opts.method === 'PUT');
    assert.ok(put && put.url.endsWith('/documents/42'));
    const body = JSON.parse(put.opts.body);
    assert.ok(body.fields[0].content.startsWith('<p>old</p>'), 'existing content preserved');
    assert.ok(body.fields[0].content.includes('<p>new</p>'), 'new content appended');
    console.log('ok  valid clip appends to the existing field content');
  }

  // 4. Cache uses CONFIG TTL, is populated on first page and reset on logout
  {
    const w = makeWorker({ fetchImpl: async () => jsonResponse({ documents: [{ id: 1, globalId: 'SD1', name: 'a' }], totalHits: 1 }) });
    const CONFIG = w.get('CONFIG');
    assert.strictEqual(w.get('documentsCache').ttl, CONFIG.CACHE.DOCUMENTS_TTL_MS);
    await w.get('getDocuments')(0);
    assert.strictEqual(w.get('documentsCache').data.length, 1);
    await w.get('getDocuments')(0);
    assert.strictEqual(w.calls.length, 1, 'second call served from cache');
    await w.get('handleLogout')();
    assert.strictEqual(w.get('documentsCache').data, null);
    assert.strictEqual(w.get('activeRequests').size, 0);
    console.log('ok  document cache honours CONFIG TTL and is cleared on logout');
  }

  // 5. Upload timeout surfaces as a timeout error, not a generic failure
  {
    const w = makeWorker({ fetchImpl: (url, opts) => new Promise((_, rej) => opts.signal && opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
    const CONFIG = w.get('CONFIG');
    CONFIG.API.UPLOAD_TIMEOUT_MS = 30;
    const uploadPdfToRSpace = w.get('uploadPdfToRSpace');
    // data: URL fetch is the first call; make it resolve, then the upload hangs
    w.ctx.fetch = (url, opts) => {
      if (String(url).startsWith('data:')) return Promise.resolve({ blob: async () => ({}) });
      return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    };
    await assert.rejects(uploadPdfToRSpace('http://rspace.test', 'k', 'data:application/pdf;base64,AA==', 'x.pdf'), /Request timeout/);
    console.log('ok  stalled PDF upload times out');
  }

  console.log('all background tests passed');
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
