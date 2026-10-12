// Popup for RSpace Web Clipper.
// config.js (CONFIG, log, logError) is loaded before this file by popup.html.

// ---------------------------------------------------------------- State
//
// selectedDocument is the document the next Save appends to; null means "create a new
// document named after the search box". It is only ever changed through setSelectedDocument(),
// which also loads the document's fields so Form documents get a field choice.
let selectedDocument = null;   // { id, globalId, name } | null
let selectedField = null;      // { id, name, type } for Form documents, otherwise null
let currentDocFields = null;   // all fields of a selected Form document, otherwise null
let saveBlocked = false;       // true when the selected Form document has no compatible field

let documents = [];            // documents loaded so far (newest first)
let currentPage = 0;
let hasMoreDocuments = true;
let isLoadingMore = false;
let searchTimeout = null;
let searchSequence = 0;        // ignores server search responses for an older query

const elements = {};
const AUTH_STORAGE_KEYS = ['savedServerUrl', 'savedApiKey', 'apiKeyExpiresAt', 'rememberServer', 'rememberApiKey'];
const API_KEY_EXPIRY_MS = CONFIG.STORAGE.API_KEY_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

document.addEventListener('DOMContentLoaded', async () => {
  cacheElements();
  setupEventListeners();
  await checkAuthStatus();
});

function cacheElements() {
  for (const id of ['connect-btn', 'back-btn', 'server-url', 'api-key', 'auth-error', 'clip-btn', 'settings-btn',
    'document-search', 'search-clear', 'document-list', 'loading-indicator', 'create-hint', 'create-hint-name',
    'note', 'clip-error', 'clip-success', 'empty-state', 'field-selector-section', 'field-select',
    'no-compatible-fields-msg', 'remember-server', 'remember-api-key', 'clear-data-btn']) {
    elements[id.replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = document.getElementById(id);
  }
  elements.documentSection = document.querySelector('.document-section');
}

function setupEventListeners() {
  elements.connectBtn.addEventListener('click', handleConnect);
  elements.backBtn.addEventListener('click', () => { elements.backBtn.style.display = 'none'; showScreen('clipper-screen'); });
  elements.clearDataBtn.addEventListener('click', handleClearSavedData);
  elements.settingsBtn.addEventListener('click', handleSettings);
  elements.clipBtn.addEventListener('click', handleSave);

  elements.documentSearch.addEventListener('input', () => { updateSearchClearButton(); handleDocumentSearch(); });
  elements.documentSearch.addEventListener('keydown', handleSearchEnter);
  elements.searchClear.addEventListener('click', () => {
    elements.documentSearch.value = '';
    elements.documentSearch.focus();
    updateSearchClearButton();
    handleDocumentSearch();
  });
  elements.documentSection.addEventListener('scroll', handleInfiniteScroll);

  document.querySelectorAll('input[name="content-type"]').forEach((radio) => {
    radio.addEventListener('change', () => { if (currentDocFields) updateFieldSelector(); });
  });
  elements.fieldSelect.addEventListener('change', () => {
    const id = parseInt(elements.fieldSelect.value, 10);
    selectedField = (currentDocFields || []).find((f) => f.id === id) || null;
  });
}

// ---------------------------------------------------------------- Auth screen

async function checkAuthStatus() {
  try {
    const session = await chrome.storage.session.get(['serverUrl', 'accessToken']);
    if (session.accessToken && session.serverUrl) {
      showScreen('clipper-screen');
      await showPendingClipResult(session.serverUrl);
      await loadDocuments();
      return;
    }
  } catch (error) {
    logError('Error checking auth status:', error);
  }
  await fillAuthForm();
  elements.backBtn.style.display = 'none';
  showScreen('auth-screen');
}

/** Pre-fill the connect form from persistent storage (remembered URL and, if opted in, key). */
async function fillAuthForm() {
  elements.connectBtn.disabled = false;
  elements.connectBtn.textContent = 'Connect to RSpace';
  elements.authError.classList.remove('show');

  const stored = await chrome.storage.local.get(AUTH_STORAGE_KEYS);

  const url = stored.rememberServer !== false ? validateStoredUrl(stored.savedServerUrl) : null;
  elements.serverUrl.value = url || 'https://';
  elements.rememberServer.checked = stored.rememberServer !== false;

  const keyValid = stored.rememberApiKey && stored.savedApiKey && stored.apiKeyExpiresAt && Date.now() < stored.apiKeyExpiresAt;
  if (stored.savedApiKey && !keyValid) {
    await chrome.storage.local.remove(['savedApiKey', 'apiKeyExpiresAt']);
  }
  elements.apiKey.value = keyValid ? stored.savedApiKey : '';
  elements.rememberApiKey.checked = !!keyValid;
}

async function handleSettings() {
  await fillAuthForm();
  elements.backBtn.style.display = 'block';
  showScreen('auth-screen');
}

/** The session is gone or was rejected: go back to the connect screen. */
async function handleNotAuthenticated() {
  await chrome.storage.session.clear();
  await fillAuthForm();
  elements.backBtn.style.display = 'none';
  showScreen('auth-screen');
  showError('auth-error', 'Your session has expired. Please reconnect.');
}

async function handleConnect() {
  let serverUrl = elements.serverUrl.value.trim();
  const apiKey = elements.apiKey.value.trim();

  if (!serverUrl || serverUrl === 'https://') return showError('auth-error', 'Please enter your RSpace server URL');
  if (serverUrl.length > CONFIG.LIMITS.MAX_SERVER_URL_LENGTH) return showError('auth-error', 'Server URL is too long');
  if (!apiKey) return showError('auth-error', 'Please enter your API key');

  // Accept a bare host name; https:// is the default scheme
  if (!/^https?:\/\//i.test(serverUrl)) serverUrl = 'https://' + serverUrl;

  let url;
  try {
    url = new URL(serverUrl);
  } catch (error) {
    return showError('auth-error', 'Invalid server URL format. Please enter a valid URL (e.g., https://your-server.com)');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    return showError('auth-error', 'HTTPS is required for security. HTTP connections are not allowed for remote servers.');
  }
  const normalizedUrl = serverUrl.replace(/\/$/, '');
  elements.serverUrl.value = normalizedUrl;

  // Ask only for access to this server, nothing else
  try {
    const granted = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!granted) return showError('auth-error', 'Permission required to connect to your RSpace server. Please allow access when prompted.');
  } catch (error) {
    logError('Permission request error:', error);
    return showError('auth-error', 'Could not request permission to access your server.');
  }

  elements.connectBtn.disabled = true;
  elements.connectBtn.textContent = 'Connecting...';
  elements.authError.classList.remove('show');

  try {
    await chrome.storage.session.clear();
    // Forget any previously saved key; a new one is stored only after the server accepts it
    await chrome.storage.local.remove(['savedApiKey', 'apiKeyExpiresAt', 'rememberApiKey']);
    if (elements.rememberServer.checked) {
      await chrome.storage.local.set({ savedServerUrl: normalizedUrl, rememberServer: true });
    } else {
      await chrome.storage.local.remove(['savedServerUrl', 'rememberServer']);
    }

    const response = await sendMessageAsync({ action: 'startAuth', serverUrl: normalizedUrl, apiKey });
    if (!response || !response.success) {
      elements.apiKey.value = '';
      throw new Error(response?.error || 'Authentication failed');
    }

    if (elements.rememberApiKey.checked) {
      await chrome.storage.local.set({ savedApiKey: apiKey, apiKeyExpiresAt: Date.now() + API_KEY_EXPIRY_MS, rememberApiKey: true });
    }
    elements.backBtn.style.display = 'none';
    showScreen('clipper-screen');
    await loadDocuments();
  } catch (error) {
    showError('auth-error', error.message);
  } finally {
    elements.connectBtn.disabled = false;
    elements.connectBtn.textContent = 'Connect to RSpace';
  }
}

/** Log out and forget everything stored on this device. */
async function handleClearSavedData() {
  try {
    await chrome.storage.local.remove(AUTH_STORAGE_KEYS);
    const response = await sendMessageAsync({ action: 'logout' });
    if (!response || !response.success) throw new Error('Background worker did not confirm logout');
    await fillAuthForm();
    showError('auth-error', 'All saved data cleared and logged out successfully');
  } catch (error) {
    logError('Error clearing saved data:', error);
    showError('auth-error', 'Failed to clear saved data');
  }
}

/** A stored server URL is only reused if it still parses as http(s) and carries no credentials. */
function validateStoredUrl(url) {
  try {
    if (!url || url.length > CONFIG.LIMITS.MAX_SERVER_URL_LENGTH) return null;
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, '')}`;
  } catch (error) {
    return null;
  }
}

// ---------------------------------------------------------------- Saving

async function handleSave() {
  const contentType = document.querySelector('input[name="content-type"]:checked').value;
  const isPdf = contentType === 'pdf';
  const note = elements.note.value;
  const docName = elements.documentSearch.value.trim();

  if (!docName) return showError('clip-error', 'Please enter a document name');
  if (docName.length > CONFIG.LIMITS.MAX_DOC_TITLE_LENGTH) return showError('clip-error', `Document name too long (max ${CONFIG.LIMITS.MAX_DOC_TITLE_LENGTH} characters)`);
  if (note.length > CONFIG.LIMITS.MAX_NOTE_LENGTH) return showError('clip-error', `Note too long (max ${CONFIG.LIMITS.MAX_NOTE_LENGTH} characters)`);
  if (currentDocFields && !selectedField) return showError('clip-error', 'Please select a field to save to');

  const targetDoc = selectedDocument
    ? { isNew: false, id: selectedDocument.id, globalId: selectedDocument.globalId }
    : { isNew: true, title: docName };

  setBusy(isPdf ? 'Generating PDF...' : 'Saving...');
  try {
    const [tab] = await queryTabsAsync({ active: true, currentWindow: true });
    if (!tab) return failSave('No active tab found. Please try again.');

    try {
      await ensureContentScriptInjected(tab.id, isPdf);
    } catch (error) {
      logError('Content script injection error:', error);
      return failSave('Failed to access page. Try refreshing the page.');
    }

    const message = {
      action: isPdf ? 'clipPdf' : 'clipContent',
      targetDoc,
      targetField: selectedField,
      note,
      sourceUrl: tab.url,
      sourceTitle: tab.title,
      tabId: tab.id
    };
    if (!isPdf) {
      let content;
      try {
        content = await sendTabMessageAsync(tab.id, { action: 'getContent', contentType });
      } catch (error) {
        logError('Content extraction error:', error);
        return failSave('Failed to extract content from page.');
      }
      if (!content || !content.html) {
        return failSave(contentType === 'selection'
          ? 'No text selected. Please highlight text on the page first, then try again.'
          : 'Failed to extract content from page. Try refreshing the page and try again.');
      }
      message.content = content;
    }

    const response = await sendMessageAsync(message);
    // The worker stored this result for a popup that might have been closed; we are showing it now
    await chrome.storage.session.remove('lastClipResult');

    if (!response || !response.success) {
      if (response && response.error === 'Not authenticated') return handleNotAuthenticated();
      return failSave(response?.error || 'Failed to save');
    }

    // Reload the list and keep the document selected, so another Save appends to it instead
    // of creating a duplicate. This happens while the loading screen is still up, so the user
    // cannot type into the search box and have the re-selection overwrite it.
    await loadDocuments();
    const saved = documents.find((d) => d.id === response.documentId)
      || { id: response.documentId, globalId: response.globalId, name: docName };
    await setSelectedDocument(saved);

    elements.note.value = '';
    showScreen('clipper-screen');
    await showSuccessWithLink(isPdf ? 'PDF saved successfully!' : 'Content saved successfully!', response.globalId);
  } catch (error) {
    logError('Save error:', error);
    failSave('An unexpected error occurred: ' + error.message);
  } finally {
    setBusy(null);
  }
}

function setBusy(label) {
  elements.clipBtn.disabled = !!label || saveBlocked;
  elements.clipBtn.textContent = label || 'Save to RSpace';
  if (label) showScreen('loading-screen');
}

function failSave(message) {
  showScreen('clipper-screen');
  showError('clip-error', message);
}

/**
 * Make sure content.js (and for PDF clips the two libraries) is present in the tab, injecting
 * only what the content script's ping says is missing. All injected files share one isolated
 * world, so content.js is never injected twice.
 */
async function ensureContentScriptInjected(tabId, includePdfLibs) {
  let contentScriptPresent = false;
  let pdfLibsPresent = false;
  try {
    const response = await sendTabMessageAsync(tabId, { action: 'ping' });
    if (response && response.status === 'ready') {
      contentScriptPresent = true;
      pdfLibsPresent = response.pdfLibs === true;
    }
  } catch (error) {
    // No listener in the tab yet
  }

  const files = [];
  if (includePdfLibs && !pdfLibsPresent) files.push('html2canvas.min.js', 'jspdf.umd.min.js');
  if (!contentScriptPresent) files.push('content.js');
  if (files.length) {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  }
}

/** Show the outcome of a clip that finished after the popup was closed. Shown once. */
async function showPendingClipResult(serverUrl) {
  try {
    const { lastClipResult } = await chrome.storage.session.get('lastClipResult');
    if (!lastClipResult) return;
    await chrome.storage.session.remove('lastClipResult');
    if (Date.now() - lastClipResult.at > 10 * 60 * 1000) return;
    if (lastClipResult.success) {
      await showSuccessWithLink(lastClipResult.message, lastClipResult.globalId, serverUrl);
    } else {
      showError('clip-error', lastClipResult.message);
    }
  } catch (error) {
    logError('Could not read pending clip result:', error);
  }
}

// ---------------------------------------------------------------- Document list and search

async function loadDocuments(append = false) {
  if (!append) {
    currentPage = 0;
    documents = [];
    hasMoreDocuments = true;
  }
  try {
    const response = await sendMessageAsync({ action: 'getDocuments', pageNumber: currentPage });
    if (!response || !response.success) {
      if (response && response.error === 'Not authenticated') return handleNotAuthenticated();
      return showError('clip-error', response?.error || 'Failed to load documents');
    }
    documents = append ? mergeDocuments(documents, response.documents) : response.documents;
    hasMoreDocuments = response.hasMore;
    renderDocuments(documents);
    elements.emptyState.style.display = documents.length ? 'none' : 'block';
    elements.documentList.style.display = documents.length ? 'block' : 'none';
  } catch (error) {
    logError('Load documents error:', error);
    showError('clip-error', 'Failed to load documents: ' + error.message);
  }
}

async function handleInfiniteScroll() {
  if (isLoadingMore || !hasMoreDocuments) return;
  const s = elements.documentSection;
  if (s.scrollHeight - s.scrollTop - s.clientHeight > 100) return;

  isLoadingMore = true;
  elements.loadingIndicator.style.display = 'block';
  currentPage++;
  await loadDocuments(true);
  elements.loadingIndicator.style.display = 'none';
  isLoadingMore = false;
}

/** Merge two document lists, keeping the first occurrence of each id. */
function mergeDocuments(existing, incoming) {
  const seen = new Set(existing.map((doc) => doc.id));
  return [...existing, ...incoming.filter((doc) => !seen.has(doc.id))];
}

/** Documents loaded so far that match the query: the exact name match and all partial matches. */
function findMatches(query) {
  const q = query.toLowerCase();
  return {
    exact: documents.find((doc) => doc.name.toLowerCase() === q) || null,
    partial: documents.filter((doc) => doc.name.toLowerCase().includes(q))
  };
}

/**
 * Debounced search. Filters the loaded documents; when nothing matches exactly and the server
 * has more pages than are loaded, asks the server to search as well. An exact name match
 * becomes the selected document; otherwise Save will create a new document.
 */
function handleDocumentSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const query = elements.documentSearch.value.trim();
    const sequence = ++searchSequence;

    if (!query) {
      await setSelectedDocument(null);
      renderDocuments(documents);
      hideCreateHint();
      return;
    }

    let { exact, partial } = findMatches(query);
    if (!exact && query.length >= 2 && hasMoreDocuments) {
      try {
        const response = await sendMessageAsync({ action: 'getDocuments', pageNumber: 0, query });
        if (sequence !== searchSequence) return; // the user typed something else since
        if (response && response.success) {
          documents = mergeDocuments(documents, response.documents);
          ({ exact, partial } = findMatches(query));
        }
      } catch (error) {
        logError('Server search failed:', error);
      }
    }

    if (exact) {
      if (!selectedDocument || selectedDocument.id !== exact.id) {
        await setSelectedDocument(exact, { fillSearch: false });
      }
    } else {
      await setSelectedDocument(null);
    }
    renderDocuments(partial);
    if (exact) hideCreateHint(); else showCreateHint();
  }, CONFIG.UI.SEARCH_DEBOUNCE_MS);
}

/** Enter in the search box selects the exact or only partial match; it never saves. */
function handleSearchEnter(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const query = elements.documentSearch.value.trim();
  if (!query) return;
  const { exact, partial } = findMatches(query);
  const match = exact || (partial.length === 1 ? partial[0] : null);
  if (match) {
    clearTimeout(searchTimeout);
    renderDocuments(partial);
    setSelectedDocument(match);
  }
}

/**
 * The single place that changes which document a Save goes to. Highlights it in the list,
 * optionally writes its name into the search box, and loads its fields so Form documents
 * show the field selector. Passing null means "create a new document".
 */
async function setSelectedDocument(doc, { fillSearch = true } = {}) {
  selectedDocument = doc;
  selectedField = null;
  currentDocFields = null;
  hideFieldSelector();

  document.querySelectorAll('.document-item').forEach((item) => {
    const on = !!doc && Number(item.dataset.id) === doc.id;
    item.classList.toggle('selected', on);
    item.setAttribute('aria-selected', String(on));
  });
  if (!doc) return;

  if (fillSearch) {
    elements.documentSearch.value = doc.name;
    updateSearchClearButton();
  }
  hideCreateHint();

  try {
    const response = await sendMessageAsync({ action: 'getDocumentFields', documentId: doc.id });
    // Ignore the answer if the selection moved on meanwhile
    if (selectedDocument !== doc || !response || !response.success || !response.isFormDoc) return;
    currentDocFields = response.fields;
    updateFieldSelector();
  } catch (error) {
    logError('Error fetching document fields:', error);
  }
}

function renderDocuments(docs) {
  elements.documentList.innerHTML = '';
  for (const doc of docs) {
    const item = document.createElement('div');
    item.className = 'document-item';
    item.textContent = doc.name;
    item.dataset.id = doc.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `Select document: ${doc.name}`);
    const on = !!selectedDocument && selectedDocument.id === doc.id;
    item.classList.toggle('selected', on);
    item.setAttribute('aria-selected', String(on));
    item.addEventListener('click', () => setSelectedDocument(doc));
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setSelectedDocument(doc);
      }
    });
    elements.documentList.appendChild(item);
  }
}

function updateSearchClearButton() {
  elements.searchClear.classList.toggle('visible', elements.documentSearch.value.trim().length > 0);
}

function showCreateHint() {
  elements.createHintName.textContent = elements.documentSearch.value.trim();
  elements.createHint.style.display = 'flex';
}

function hideCreateHint() {
  elements.createHint.style.display = 'none';
}

// ---------------------------------------------------------------- Form field selector

/** Only text fields can hold clipped HTML, whatever the content type. */
function updateFieldSelector() {
  const compatible = (currentDocFields || []).filter((f) => f.type && f.type.toUpperCase() === 'TEXT');
  elements.fieldSelectorSection.style.display = 'block';
  elements.fieldSelect.innerHTML = '';

  saveBlocked = compatible.length === 0;
  elements.fieldSelect.style.display = saveBlocked ? 'none' : 'block';
  elements.noCompatibleFieldsMsg.style.display = saveBlocked ? 'block' : 'none';
  elements.clipBtn.disabled = saveBlocked;

  for (const field of compatible) {
    const option = document.createElement('option');
    option.value = field.id;
    option.textContent = field.name;
    elements.fieldSelect.appendChild(option);
  }
  selectedField = compatible[0] || null;
}

function hideFieldSelector() {
  saveBlocked = false;
  elements.fieldSelectorSection.style.display = 'none';
  elements.fieldSelect.innerHTML = '';
  elements.noCompatibleFieldsMsg.style.display = 'none';
  elements.clipBtn.disabled = false;
}

// ---------------------------------------------------------------- Screens and messages

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((screen) => { screen.style.display = 'none'; });
  document.getElementById(screenId).style.display = screenId === 'clipper-screen' ? 'flex' : 'block';
}

function showError(elementId, message) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
  setTimeout(() => el.classList.remove('show'), CONFIG.UI.ERROR_DISPLAY_MS);
}

async function showSuccessWithLink(message, globalId, serverUrl) {
  if (!serverUrl) {
    ({ serverUrl } = await chrome.storage.session.get('serverUrl'));
  }
  const el = elements.clipSuccess;
  el.textContent = message + ' ';
  const link = document.createElement('a');
  link.href = `${serverUrl}/globalId/${globalId}`;
  link.target = '_blank';
  link.textContent = 'View →';
  link.style.cssText = 'color: inherit; font-weight: 600; text-decoration: underline;';
  el.appendChild(link);
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), CONFIG.UI.SUCCESS_DISPLAY_MS);
}

// ---------------------------------------------------------------- Chrome API helpers

function sendMessageAsync(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function queryTabsAsync(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(tabs);
    });
  });
}

function sendTabMessageAsync(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}
