#!/usr/bin/env node
// Runs content.js in a minimal simulated page context to verify injection behaviour:
//   1. Injecting it twice does not throw and registers exactly one message listener.
//   2. The ping response reports whether the PDF libraries are present.
//
//   node scripts/test-content-script.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

function makeContext() {
  const listeners = [];
  const sandbox = {
    console,
    window: {},
    document: {},
    chrome: {
      runtime: {
        onMessage: {
          addListener(fn) {
            listeners.push(fn);
          },
        },
      },
    },
  };
  // Make `window` the global object so `typeof html2canvas` and window.* line up
  sandbox.window = sandbox;
  return { ctx: vm.createContext(sandbox), listeners };
}

function inject(ctx) {
  vm.runInContext(source, ctx, { filename: 'content.js' });
}

function ping(listeners) {
  let reply;
  listeners[0]({ action: 'ping' }, {}, (r) => { reply = r; });
  return reply;
}

// 1. Double injection is a no-op
{
  const { ctx, listeners } = makeContext();
  inject(ctx);
  assert.doesNotThrow(() => inject(ctx), 'second injection must not throw');
  assert.strictEqual(listeners.length, 1, 'exactly one message listener after two injections');
  console.log('ok  double injection is a no-op');
}

// 2. Ping reports missing PDF libs
{
  const { ctx, listeners } = makeContext();
  inject(ctx);
  const reply = ping(listeners);
  assert.strictEqual(reply.status, 'ready');
  assert.strictEqual(reply.pdfLibs, false);
  console.log('ok  ping reports pdfLibs: false before libraries are injected');
}

// 3. Ping reports present PDF libs once the globals exist (libraries injected after content.js)
{
  const { ctx, listeners } = makeContext();
  inject(ctx);
  vm.runInContext('var html2canvas = function () {}; var jspdf = { jsPDF: function () {} };', ctx);
  const reply = ping(listeners);
  assert.strictEqual(reply.status, 'ready');
  assert.strictEqual(reply.pdfLibs, true);
  console.log('ok  ping reports pdfLibs: true after libraries are injected');
}

// 4. printPage without libraries returns a clear error instead of throwing
{
  const { ctx, listeners } = makeContext();
  inject(ctx);
  listeners[0]({ action: 'printPage' }, {}, (r) => {
    assert.strictEqual(r.success, false);
    assert.match(r.error, /PDF libraries not available/);
    console.log('ok  printPage without libraries returns an error response');
  });
}

// Give the async printPage handler a tick to respond before exiting
setTimeout(() => {}, 10);
