// Background service worker for RSpace Web Clipper.
// Handles authentication, RSpace API calls and content saving for the popup.
//
// Every message handler describes the happy path and throws on failure: ClipError carries a
// message meant for the user, NotAuthenticated means the session is gone. handleMessage maps
// every error to the response object the popup sees.

importScripts('config.js');

/** Thrown when there are no credentials or the server rejected them (HTTP 401). */
class NotAuthenticated extends Error {}

/** An error whose message is safe and useful to show to the user. */
class ClipError extends Error {}

// Credentials are read from session storage once and kept here until logout or a 401.
let credentials = null;

// Only one clip runs at a time; a second request while one is running shares its result.
let clipInFlight = null;

const MESSAGE_HANDLERS = {
  startAuth: (r) => handleAuth(r.serverUrl, r.apiKey),
  logout: handleLogout,
  getDocuments: (r) => getDocuments(r.pageNumber, r.query),
  getDocumentFields: (r) => getDocumentFields(r.documentId),
  clipContent: (r) => runClip(() => clipContent(r), 'Content saved successfully!'),
  clipPdf: (r) => runClip(() => clipPdf(r), 'PDF saved successfully!'),
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request).then(sendResponse);
  return true;
});

/** Dispatch a popup message to its handler and turn any thrown error into a response object. */
async function handleMessage(request) {
  const handler = request && MESSAGE_HANDLERS[request.action];
  if (!handler) return { success: false, error: 'Unknown action' };
  try {
    return await handler(request);
  } catch (error) {
    return failureResponse(error);
  }
}

function failureResponse(error) {
  logError('Request failed:', error);
  if (error instanceof NotAuthenticated) return { success: false, code: 'NOT_AUTHENTICATED', error: 'Not authenticated' };
  if (error instanceof ClipError) return { success: false, error: error.message };
  if (error.message === 'Request timeout') return { success: false, error: 'Request timeout. Please try again.' };
  if (error instanceof TypeError) return { success: false, error: 'Could not reach the RSpace server. Please check the server URL and your connection.' };
  return { success: false, error: 'An unexpected error occurred. Please try again.' };
}

// ---------------------------------------------------------------- HTTP helpers

function getHttpErrorMessage(response, fallback = 'Request failed. Please try again.') {
  if (response.status === 403) return 'Permission denied. Check your access rights.';
  if (response.status === 404) return 'Not found on the server.';
  if (response.status === 429) return 'Too many requests. Please wait and try again.';
  if (response.status >= 500) return 'Server error. Please try again later.';
  return fallback;
}

/** Throw a user-facing ClipError for a failed response, logging the server's own text. */
async function ensureOk(response, fallback) {
  if (response.ok) return response;
  logError('API error', response.status, await response.text());
  throw new ClipError(getHttpErrorMessage(response, fallback));
}

async function fetchWithTimeout(url, options = {}, timeout = CONFIG.API.REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request timeout');
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getCredentials() {
  if (!credentials) {
    const { serverUrl, accessToken } = await chrome.storage.session.get(['serverUrl', 'accessToken']);
    if (serverUrl && accessToken) credentials = { serverUrl, accessToken };
  }
  if (!credentials) throw new NotAuthenticated();
  return credentials;
}

async function clearCredentials() {
  credentials = null;
  await chrome.storage.session.clear();
}

/**
 * Call the RSpace API with the stored credentials. A 401 clears the session and throws
 * NotAuthenticated so the popup returns to the connect screen.
 */
async function apiFetch(path, options = {}, timeout = CONFIG.API.REQUEST_TIMEOUT_MS) {
  const { serverUrl, accessToken } = await getCredentials();
  const response = await fetchWithTimeout(`${serverUrl}${path}`, {
    ...options,
    headers: { apiKey: accessToken, ...(options.headers || {}) }
  }, timeout);
  if (response.status === 401) {
    await clearCredentials();
    throw new NotAuthenticated();
  }
  return response;
}

/** Accept only positive integers for ids that end up in API paths. */
function isValidId(value) {
  return Number.isInteger(value) && value > 0;
}

// ---------------------------------------------------------------- Auth

async function handleAuth(serverUrl, apiKey) {
  const response = await fetchWithTimeout(`${serverUrl}/api/v1/status`, { headers: { apiKey } });
  if (response.status === 401) throw new ClipError('Invalid API key');
  if (response.status === 404) throw new ClipError('Server endpoint not found. Please check the URL.');
  await ensureOk(response);

  // Session storage is in memory and cleared when the browser closes
  credentials = { serverUrl, accessToken: apiKey };
  await chrome.storage.session.set(credentials);
  return { success: true };
}

async function handleLogout() {
  await clearCredentials();
  return { success: true };
}

// ---------------------------------------------------------------- Documents

/** List the user's documents, newest first. `query` runs a server-side search. */
async function getDocuments(pageNumber = 0, query = '') {
  query = typeof query === 'string' ? query.trim().slice(0, 200) : '';
  const pageSize = CONFIG.API.DEFAULT_PAGE_SIZE;
  let path = `/api/v1/documents?pageSize=${pageSize}&pageNumber=${pageNumber}&orderBy=lastModified desc`;
  if (query) path += `&query=${encodeURIComponent(query)}`;

  const data = await (await ensureOk(await apiFetch(path))).json();
  const documents = (data.documents || []).map((doc) => ({ id: doc.id, globalId: doc.globalId, name: doc.name }));
  const totalPages = Math.ceil((data.totalHits || documents.length) / pageSize);
  return { success: true, documents, hasMore: pageNumber + 1 < totalPages };
}

/** Fields of a document, so the popup can offer a field choice for Form documents. */
async function getDocumentFields(documentId) {
  if (!isValidId(documentId)) throw new ClipError('Invalid document id');
  const doc = await (await ensureOk(await apiFetch(`/api/v1/documents/${documentId}`))).json();
  return { success: true, fields: fieldSummary(doc.fields) };
}

function fieldSummary(fields) {
  return (fields || []).map((f) => ({ id: f.id, name: f.name, type: f.type }));
}

async function createDocument(title) {
  const response = await apiFetch('/api/v1/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: title, tags: 'web-clipper', fields: [{ content: '' }] })
  });
  const doc = await (await ensureOk(response, 'Unable to create document. Please try again.')).json();
  return { documentId: doc.id, globalId: doc.globalId, fields: doc.fields };
}

/**
 * Validate the popup's request and resolve (or create) the document to write to.
 * @returns {Promise<{documentId: number, globalId: string, fields?: Array}>} fields are known
 *   for a freshly created document, saving a round trip in appendToField
 */
async function resolveTargetDocument(request) {
  const targetDoc = request && request.targetDoc;
  if (!targetDoc || typeof targetDoc !== 'object') throw new ClipError('No target document specified');
  if (request.targetField && !isValidId(request.targetField.id)) throw new ClipError('Invalid field id');

  if (targetDoc.isNew) {
    const title = typeof targetDoc.title === 'string' ? targetDoc.title.trim() : '';
    if (!title || title.length > CONFIG.LIMITS.MAX_DOC_TITLE_LENGTH) throw new ClipError('Invalid document title');
    return createDocument(title);
  }
  if (!isValidId(targetDoc.id)) throw new ClipError('Invalid document id');
  return { documentId: targetDoc.id, globalId: targetDoc.globalId };
}

/**
 * Append HTML to one field of a document and return the document's fields.
 * @param {{documentId: number, fields?: Array}} target - fields, when known, skip the GET
 * @param {{id: number}|null} targetField - the field chosen in the popup (Form documents)
 * @param {string} html
 */
async function appendToField(target, targetField, html) {
  let fields = target.fields;
  if (!fields) {
    const response = await apiFetch(`/api/v1/documents/${target.documentId}`);
    fields = (await (await ensureOk(response, 'Document not found')).json()).fields;
  }
  fields = fields || [];
  if (fields.length === 0) throw new ClipError('Document has no editable fields. Please select a different document.');

  let field;
  if (targetField) {
    field = fields.find((f) => f.id === targetField.id);
    if (!field) throw new ClipError('Selected field not found in document. Please re-select the document and try again.');
  } else if (fields.length === 1) {
    field = fields[0];
  } else {
    throw new ClipError('This document has multiple fields. Please select a field to save to.');
  }

  await ensureOk(await apiFetch(`/api/v1/documents/${target.documentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: [{ id: field.id, content: (field.content || '') + html }] })
  }));
  return fields;
}

// ---------------------------------------------------------------- Clipping

/**
 * Run one clip at a time and remember its outcome in session storage, so a popup that was
 * closed while the clip was running can show the result when it is reopened.
 */
function runClip(fn, successMessage) {
  if (clipInFlight) return clipInFlight;

  clipInFlight = (async () => {
    let result;
    try {
      result = await fn();
    } catch (error) {
      result = failureResponse(error);
    }
    try {
      await chrome.storage.session.set({
        lastClipResult: {
          success: !!result.success,
          message: result.success ? successMessage : result.error,
          globalId: result.globalId || null,
          at: Date.now()
        }
      });
    } catch (error) {
      logError('Could not store clip result:', error);
    }
    return result;
  })().finally(() => { clipInFlight = null; });

  return clipInFlight;
}

async function clipContent(request) {
  const html = request.content && request.content.html;
  if (!html) throw new ClipError('Nothing to save');
  const target = await resolveTargetDocument(request);
  return finishClip(target, request, clipBlock(request, 'Clipped from', `<div>${sanitizeClippedHtml(html)}</div>`));
}

async function clipPdf(request) {
  const pdfData = await generatePdfFromTab(request.tabId);
  const target = await resolveTargetDocument(request);
  const fileId = await uploadPdf(pdfData, `${sanitizeFilename(request.sourceTitle || 'page')}.pdf`);
  // RSpace turns <fileId=N> into the attachment markup
  return finishClip(target, request, clipBlock(request, 'PDF clipped from', `<p><fileId=${fileId}></p>`));
}

async function finishClip(target, request, html) {
  const fields = await appendToField(target, request.targetField, html);
  return { success: true, documentId: target.documentId, globalId: target.globalId, fields: fieldSummary(fields) };
}

/** Ask the content script (injected by the popup) to render the page to a PDF data URL. */
async function generatePdfFromTab(tabId) {
  let result;
  try {
    result = await chrome.tabs.sendMessage(tabId, { action: 'printPage' });
  } catch (error) {
    throw new ClipError('Failed to access page. Try refreshing the page.');
  }
  if (!result || !result.pdfData) throw new ClipError((result && result.error) || 'Failed to generate PDF from page');
  return result.pdfData;
}

/** Upload a PDF (data URL) to the RSpace gallery and return its file id. */
async function uploadPdf(pdfDataUrl, fileName) {
  const blob = await (await fetch(pdfDataUrl)).blob();
  const formData = new FormData();
  formData.append('file', blob, fileName);

  const response = await apiFetch('/api/v1/files', { method: 'POST', body: formData }, CONFIG.API.UPLOAD_TIMEOUT_MS);
  const data = await (await ensureOk(response, 'Failed to upload PDF file')).json();
  const fileId = data.id || data.globalId?.match(/GL(\d+)/)?.[1] || data._links?.self?.match(/\/files\/(\d+)/)?.[1];
  if (!fileId) throw new ClipError('Failed to upload PDF file');
  return fileId;
}

// ---------------------------------------------------------------- HTML building

/** The block appended to the document for every clip: source link, timestamp, note, body. */
function clipBlock(request, label, bodyHtml) {
  const safeNote = escapeHtml(request.note);
  let html = '<div style="border-left: 3px solid #4a90e2; padding-left: 12px; margin: 20px 0;">';
  html += `<p style="color: #666; font-size: 0.9em; margin: 0 0 8px 0;">${label} <a href="${escapeHtml(request.sourceUrl)}">${escapeHtml(request.sourceTitle)}</a> on ${escapeHtml(formatTimestamp(new Date()))}</p>`;
  if (safeNote) {
    html += `<p style="background: #fffde7; padding: 8px; border-radius: 4px; margin: 8px 0;"><strong>Note:</strong> ${safeNote}</p>`;
  }
  return html + bodyHtml + '</div>';
}

function formatTimestamp(date) {
  // Example: 2026-01-08 14:35:22 GMT+1
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetMins = Math.abs(offsetMinutes) % 60;
  const timezone = `GMT${sign}${offsetHours}${offsetMins ? ':' + pad(offsetMins) : ''}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${timezone}`;
}

/**
 * Second sanitization layer, applied in the worker where no DOM parser is available.
 * The primary sanitizer is cleanHtml() in content.js. This pass only drops script blocks and,
 * strictly inside tags, on* handlers and script-scheme URL attributes; text is never altered.
 */
function sanitizeClippedHtml(html) {
  if (!html) return '';
  let cleaned = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  cleaned = cleaned.replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => {
    let t = tag.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    t = t.replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, (match, name, value) => {
      const v = value.replace(/^["']|["']$/g, '').replace(/[\s\u0000-\u001f]/g, '').toLowerCase();
      return v.startsWith('javascript:') || v.startsWith('vbscript:') ? '' : match;
    });
    return t;
  });
  return cleaned;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9_\-\.]/g, '_').substring(0, 100);
}
