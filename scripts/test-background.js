#!/usr/bin/env node
// Unit tests for the background service worker, run in a vm context with a stubbed chrome API
// and fetch. Everything goes through handleMessage(), the same entry point the popup uses.
//
//   node scripts/test-background.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const sources = {};
for (const file of ['config.js', 'background.js']) {
  sources[file] = new vm.Script(fs.readFileSync(path.join(root, file), 'utf8'), { filename: file });
}

function makeWorker({ fetchImpl, session = { serverUrl: 'http://rspace.test', accessToken: 'k' } } = {}) {
  const calls = [];
  const state = { session: { ...session } };
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    AbortController,
    TypeError,
    FormData: class { append() {} },
    fetch: (url, opts) => {
      calls.push({ url, opts });
      return fetchImpl(url, opts);
    },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      storage: {
        session: {
          get: async (keys) => {
            const out = {};
            for (const k of [].concat(keys)) if (k in state.session) out[k] = state.session[k];
            return out;
          },
          set: async (obj) => { Object.assign(state.session, obj); },
          clear: async () => { state.session = {}; },
        },
      },
      tabs: { sendMessage: async () => ({ pdfData: 'data:application/pdf;base64,AA==' }) },
    },
    importScripts(file) {
      sources[file].runInContext(ctx);
    },
  };
  const ctx = vm.createContext(sandbox);
  sources['background.js'].runInContext(ctx);
  const send = (request) => vm.runInContext('handleMessage', ctx)(request);
  return { ctx, calls, state, send, get: (name) => vm.runInContext(name, ctx) };
}

const jsonResponse = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const hang = (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

(async () => {
  // 1. fetchWithTimeout default comes from CONFIG and aborts a hanging request
  {
    const w = makeWorker({ fetchImpl: hang });
    const CONFIG = w.get('CONFIG');
    assert.strictEqual(typeof CONFIG.API.REQUEST_TIMEOUT_MS, 'number');
    assert.strictEqual(typeof CONFIG.API.UPLOAD_TIMEOUT_MS, 'number');
    const started = Date.now();
    await assert.rejects(w.get('fetchWithTimeout')('http://x', {}, 50), /Request timeout/);
    assert.ok(Date.now() - started < 1000, 'aborted promptly');
    const r = await w.send({ action: 'getDocuments' });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /timeout/i);
    console.log('ok  timeouts abort and are reported to the popup');
  }

  // 2. Invalid ids, titles and targets are rejected before any network call
  {
    const w = makeWorker({ fetchImpl: () => { throw new Error('fetch must not be called'); } });
    for (const bad of ['abc', '42', '1/../2', -1, 0, 1.5, null, undefined, {}]) {
      const r = await w.send({ action: 'clipContent', targetDoc: { isNew: false, id: bad }, content: { html: 'x' } });
      assert.strictEqual(r.success, false, `id ${String(bad)} must be rejected`);
      assert.match(r.error, /Invalid document id/);
    }
    assert.match((await w.send({ action: 'getDocumentFields', documentId: 'abc' })).error, /Invalid document id/);
    assert.match((await w.send({ action: 'clipContent', targetDoc: { isNew: false, id: 5 }, targetField: { id: 'x' }, content: { html: 'x' } })).error, /Invalid field id/);
    assert.match((await w.send({ action: 'clipContent', targetDoc: { isNew: true, title: '   ' }, content: { html: 'x' } })).error, /Invalid document title/);
    assert.match((await w.send({ action: 'clipContent', content: { html: 'x' } })).error, /No target document/);
    assert.match((await w.send({ action: 'clipContent', targetDoc: { isNew: false, id: 5 } })).error, /Nothing to save/);
    assert.match((await w.send({ action: 'nope' })).error, /Unknown action/);
    assert.strictEqual(w.calls.length, 0, 'no fetch calls were made');
    console.log('ok  invalid requests are rejected without network calls');
  }

  // 3. A valid clip appends to the existing field content and one clip runs at a time
  {
    let gets = 0;
    const w = makeWorker({
      fetchImpl: async (url, opts) => {
        if (url.endsWith('/documents/42') && (!opts || !opts.method)) { gets++; return jsonResponse({ fields: [{ id: 7, content: '<p>old</p>' }] }); }
        return jsonResponse({});
      },
    });
    const req = { action: 'clipContent', targetDoc: { isNew: false, id: 42 }, content: { html: '<p>new</p>' }, sourceUrl: 'http://s', sourceTitle: 't', note: 'n <b>' };
    const [a, b] = await Promise.all([w.send(req), w.send(req)]);
    assert.strictEqual(a.success, true, JSON.stringify(a));
    assert.strictEqual(a, b, 'concurrent clip shares the in-flight result');
    assert.strictEqual(gets, 1, 'document fetched once');
    const put = w.calls.find((c) => c.opts && c.opts.method === 'PUT');
    const content = JSON.parse(put.opts.body).fields[0].content;
    assert.ok(content.startsWith('<p>old</p>'), 'existing content preserved');
    assert.ok(content.includes('Clipped from <a href="http://s">t</a>'), 'header present');
    assert.ok(content.includes('<strong>Note:</strong> n &lt;b&gt;'), 'note escaped');
    assert.ok(content.endsWith('<div><p>new</p></div></div>'), 'body appended');
    assert.strictEqual(w.state.session.lastClipResult.success, true, 'result remembered for a closed popup');
    console.log('ok  clip appends to the field, remembers its result, and deduplicates');
  }

  // 3b. A clip into a new document needs no GET: the POST response carries the field
  {
    const w = makeWorker({
      fetchImpl: async (url, opts) => (opts && opts.method === 'POST')
        ? jsonResponse({ id: 99, globalId: 'SD99', fields: [{ id: 5, content: '' }] })
        : jsonResponse({}),
    });
    const r = await w.send({ action: 'clipContent', targetDoc: { isNew: true, title: 'New' }, content: { html: '<p>x</p>' }, sourceUrl: 'u', sourceTitle: 't' });
    assert.strictEqual(r.success, true, JSON.stringify(r));
    assert.deepStrictEqual(w.calls.map((c) => (c.opts && c.opts.method) || 'GET'), ['POST', 'PUT']);
    assert.strictEqual(r.documentId, 99);
    assert.strictEqual(r.fields.length, 1, 'fields returned for the popup');
    console.log('ok  new-document clip is a POST and a PUT, no GET');
  }

  // 4. Form document without a chosen field, and with a chosen field
  {
    const fields = [{ id: 1, content: 'a' }, { id: 2, content: 'b' }];
    const w = makeWorker({ fetchImpl: async (url, opts) => (opts && opts.method === 'PUT') ? jsonResponse({}) : jsonResponse({ fields }) });
    const base = { action: 'clipContent', targetDoc: { isNew: false, id: 9 }, content: { html: 'x' } };
    assert.match((await w.send(base)).error, /multiple fields/);
    assert.match((await w.send({ ...base, targetField: { id: 3 } })).error, /Selected field not found/);
    const ok = await w.send({ ...base, targetField: { id: 2 } });
    assert.strictEqual(ok.success, true);
    const put = w.calls.find((c) => c.opts && c.opts.method === 'PUT');
    assert.strictEqual(JSON.parse(put.opts.body).fields[0].id, 2);
    console.log('ok  Form documents require a field and write to the chosen one');
  }

  // 5. A 401 clears the session and reports "Not authenticated"
  {
    const w = makeWorker({ fetchImpl: async () => jsonResponse({}, 401) });
    const r = await w.send({ action: 'getDocuments' });
    assert.deepStrictEqual(Object.keys(w.state.session), []);
    assert.strictEqual(r.error, 'Not authenticated');
    assert.strictEqual(r.code, 'NOT_AUTHENTICATED');
    const r2 = await w.send({ action: 'getDocuments' });
    assert.strictEqual(r2.error, 'Not authenticated', 'no credentials afterwards');
    assert.strictEqual(w.calls.length, 1, 'no request without credentials');
    console.log('ok  401 clears the session and maps to Not authenticated');
  }

  // 5b. Credentials are read from storage once, not per request
  {
    let reads = 0;
    const w = makeWorker({ fetchImpl: async () => jsonResponse({ documents: [], totalHits: 0 }) });
    const original = w.ctx.chrome.storage.session.get;
    w.ctx.chrome.storage.session.get = async (k) => { reads++; return original(k); };
    await w.send({ action: 'getDocuments' });
    await w.send({ action: 'getDocuments' });
    await w.send({ action: 'getDocumentFields', documentId: 1 });
    assert.strictEqual(reads, 1, `storage read ${reads} times`);
    console.log('ok  credentials are cached after the first read');
  }

  // 6. Network failure and server error messages
  {
    const w = makeWorker({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    assert.match((await w.send({ action: 'getDocuments' })).error, /Could not reach/);
    const w2 = makeWorker({ fetchImpl: async () => jsonResponse({ message: 'internal regexp detail' }, 500) });
    const r = await w2.send({ action: 'clipContent', targetDoc: { isNew: true, title: 'T' }, content: { html: 'x' } });
    assert.match(r.error, /Server error/);
    assert.doesNotMatch(r.error, /regexp/, 'server text is not shown to the user');
    console.log('ok  network and server errors map to user-facing messages');
  }

  // 7. Stalled PDF upload times out; PDF clip links the file
  {
    const w = makeWorker({
      fetchImpl: (url, opts) => {
        if (String(url).startsWith('data:')) return Promise.resolve({ blob: async () => ({}) });
        if (String(url).endsWith('/files')) return hang(url, opts);
        return Promise.resolve(jsonResponse({ fields: [{ id: 1, content: '' }] }));
      },
    });
    w.get('CONFIG').API.UPLOAD_TIMEOUT_MS = 30;
    const r = await w.send({ action: 'clipPdf', tabId: 1, targetDoc: { isNew: false, id: 3 }, sourceTitle: 'Page' });
    assert.match(r.error, /timeout/i);

    const w2 = makeWorker({
      fetchImpl: async (url, opts) => {
        if (String(url).startsWith('data:')) return { blob: async () => ({}) };
        if (String(url).endsWith('/files')) return jsonResponse({ id: 77 });
        return jsonResponse({ fields: [{ id: 1, content: '' }] });
      },
    });
    const ok = await w2.send({ action: 'clipPdf', tabId: 1, targetDoc: { isNew: false, id: 3 }, sourceTitle: 'My Page/1' });
    assert.strictEqual(ok.success, true, JSON.stringify(ok));
    const put = w2.calls.find((c) => c.opts && c.opts.method === 'PUT');
    assert.ok(JSON.parse(put.opts.body).fields[0].content.includes('<fileId=77>'));
    console.log('ok  PDF upload times out when stalled and links the file when it succeeds');
  }

  console.log('all background tests passed');
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
