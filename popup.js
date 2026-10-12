// Security: Disable all logging in production
const DEBUG = false;
const log = DEBUG ? console.log : () => {};
const logError = DEBUG ? console.error : () => {};

// State management
let selectedDocument = null;
let selectedField = null;      // { id, name, type } for Form docs, null for simple docs
let currentDocFields = null;   // full field list when a Form doc is selected, null otherwise
let documents = [];
let searchTimeout = null;
let currentPage = 0;
let hasMoreDocuments = true;
let isLoadingMore = false;

// DOM element cache (populated on DOMContentLoaded)
const elements = {};

// Use configuration constants
const MAX_DOC_TITLE_LENGTH = CONFIG.LIMITS.MAX_DOC_TITLE_LENGTH;
const MAX_NOTE_LENGTH = CONFIG.LIMITS.MAX_NOTE_LENGTH;
const MAX_SERVER_URL_LENGTH = CONFIG.LIMITS.MAX_SERVER_URL_LENGTH;
const ERROR_DISPLAY_MS = CONFIG.UI.ERROR_DISPLAY_MS;
const SUCCESS_DISPLAY_MS = CONFIG.UI.SUCCESS_DISPLAY_MS;
const SEARCH_DEBOUNCE_MS = CONFIG.UI.SEARCH_DEBOUNCE_MS;

// API key storage expiration (see CONFIG.STORAGE)
const API_KEY_EXPIRY_DAYS = CONFIG.STORAGE.API_KEY_EXPIRY_DAYS;
const API_KEY_EXPIRY_MS = API_KEY_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

document.addEventListener('DOMContentLoaded', async () => {
  // Cache DOM elements
  cacheElements();
  
  // NEW: Run one-time migration for existing users
  await migrateSessionToLocal();
  
  await checkAuthStatus();
  setupEventListeners();
});

/**
 * Cache frequently accessed DOM elements for better performance
 */
function cacheElements() {
  elements.connectBtn = document.getElementById('connect-btn');
  elements.backBtn = document.getElementById('back-btn');
  elements.serverUrl = document.getElementById('server-url');
  elements.apiKey = document.getElementById('api-key');
  elements.authError = document.getElementById('auth-error');
  elements.clipBtn = document.getElementById('clip-btn');
  elements.settingsBtn = document.getElementById('settings-btn');
  elements.documentSearch = document.getElementById('document-search');
  elements.searchClear = document.getElementById('search-clear'); // NEW: Clear search button
  elements.documentList = document.getElementById('document-list');
  elements.documentSection = document.querySelector('.document-section'); // NEW: For infinite scroll
  elements.loadingIndicator = document.getElementById('loading-indicator'); // NEW: Loading indicator
  elements.createHint = document.getElementById('create-hint');
  elements.note = document.getElementById('note');
  elements.clipError = document.getElementById('clip-error');
  elements.clipSuccess = document.getElementById('clip-success');
  elements.emptyState = document.getElementById('empty-state');

  // Field selector (for Form-based documents)
  elements.fieldSelectorSection = document.getElementById('field-selector-section');
  elements.fieldSelect = document.getElementById('field-select');
  elements.noCompatibleFieldsMsg = document.getElementById('no-compatible-fields-msg');
  
  // NEW: Remember checkboxes and clear button
  elements.rememberServer = document.getElementById('remember-server');
  elements.rememberApiKey = document.getElementById('remember-api-key');
  elements.clearDataBtn = document.getElementById('clear-data-btn');
}

/**
 * Check authentication status and show appropriate screen
 */
async function checkAuthStatus() {
  try {
    // Check session for active authentication
    const session = await chrome.storage.session.get(['serverUrl', 'accessToken']);
    
    if (session.accessToken && session.serverUrl) {
      // User is authenticated - show clipper screen
      showScreen('clipper-screen');
      await showPendingClipResult(session.serverUrl);
      await loadDocuments();
    } else {
      // Not authenticated - prepare auth screen
      
      // Load saved credentials from persistent storage
      const stored = await chrome.storage.local.get([
        'savedServerUrl',
        'savedApiKey',
        'apiKeyExpiresAt',
        'rememberServer',
        'rememberApiKey'
      ]);
      
      // Reset button state
      elements.connectBtn.disabled = false;
      elements.connectBtn.textContent = 'Connect to RSpace';
      
      // Pre-fill server URL if saved
      if (stored.savedServerUrl && stored.rememberServer !== false) {
        const validatedUrl = validateStoredUrl(stored.savedServerUrl);
        if (validatedUrl) {
          elements.serverUrl.value = validatedUrl;
          if (elements.rememberServer) {
            elements.rememberServer.checked = true;
          }
        } else {
          // Invalid stored URL - clear it
          await chrome.storage.local.remove(['savedServerUrl']);
          elements.serverUrl.value = 'https://';
        }
      } else {
        // Default to https:// prefix
        elements.serverUrl.value = 'https://';
      }
      
      // Pre-fill API key if saved and not expired
      if (stored.savedApiKey && stored.rememberApiKey) {
        // Check expiration
        if (stored.apiKeyExpiresAt && Date.now() < stored.apiKeyExpiresAt) {
          // Valid and not expired
          elements.apiKey.value = stored.savedApiKey;
          if (elements.rememberApiKey) {
            elements.rememberApiKey.checked = true;
          }
          log('Loaded saved API key (expires in', Math.round((stored.apiKeyExpiresAt - Date.now()) / (24 * 60 * 60 * 1000)), 'days)');
        } else {
          // Expired - clear it
          await chrome.storage.local.remove(['savedApiKey', 'apiKeyExpiresAt']);
          elements.apiKey.value = '';
          log('Saved API key expired - cleared');
        }
      } else {
        // No saved API key or user opted out
        elements.apiKey.value = '';
      }
      
      // Hide back button on initial load
      elements.backBtn.style.display = 'none';
      
      showScreen('auth-screen');
    }
  } catch (error) {
    logError('Error checking auth status:', error);
    showScreen('auth-screen');
  }
}

function setupEventListeners() {
  // Auth screen
  elements.connectBtn.addEventListener('click', handleConnect);
  elements.backBtn.addEventListener('click', handleBackToClipper);
  
  // Clear data button
  if (elements.clearDataBtn) {
    elements.clearDataBtn.addEventListener('click', handleClearSavedData);
  }
  
  // Server URL input - protect the https:// prefix
  setupServerUrlProtection();
  
  // Clipper screen
  elements.clipBtn.addEventListener('click', handleClip);
  elements.settingsBtn.addEventListener('click', handleSettings);
  elements.documentSearch.addEventListener('input', handleDocumentSearch);
  
  // Search clear button
  if (elements.searchClear) {
    elements.searchClear.addEventListener('click', handleSearchClear);
    // Show/hide clear button based on input content
    elements.documentSearch.addEventListener('input', updateSearchClearButton);
    // Initial state
    updateSearchClearButton();
  }
  
  // Infinite scroll for documents (replaces Load More button)
  if (elements.documentSection) {
    elements.documentSection.addEventListener('scroll', handleInfiniteScroll);
  }

  // When content type changes, re-filter the field selector for Form docs
  document.querySelectorAll('input[name="content-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      if (currentDocFields) {
        updateFieldSelector(e.target.value);
      }
    });
  });

  // Field selection change
  if (elements.fieldSelect) {
    elements.fieldSelect.addEventListener('change', handleFieldSelectChange);
  }
  
  // Enter in the search box selects the matching document; only the Save button clips
  elements.documentSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimeout);
      const query = elements.documentSearch.value.toLowerCase().trim();
      if (!query) return;
      const exact = documents.find(doc => doc.name.toLowerCase() === query);
      const partial = documents.filter(doc => doc.name.toLowerCase().includes(query));
      const match = exact || (partial.length === 1 ? partial[0] : null);
      if (match) {
        selectDocument(match);
      } else {
        showCreateHint();
      }
    }
  });
}

/**
 * Keep a scheme on the server URL input.
 *
 * Defaults to https://, but http:// is left alone so the localhost and 127.0.0.1 URLs that
 * handleConnect explicitly allows can be typed (handleConnect still rejects http:// for any
 * other host). If the user clears the scheme entirely, https:// is put back in front of what
 * they typed rather than wiping their input.
 */
function setupServerUrlProtection() {
  const HTTPS_PREFIX = 'https://';
  const PREFIX_LENGTH = HTTPS_PREFIX.length;
  const SCHEME_RE = /^https?:\/\//i;

  // Set cursor position after https:// on focus
  elements.serverUrl.addEventListener('focus', (e) => {
    if (e.target.value === HTTPS_PREFIX) {
      setTimeout(() => {
        e.target.setSelectionRange(PREFIX_LENGTH, PREFIX_LENGTH);
      }, 0);
    }
  });

  elements.serverUrl.addEventListener('input', (e) => {
    const value = e.target.value;
    if (SCHEME_RE.test(value)) {
      return;
    }
    // Scheme was deleted (or a bare host was pasted): prepend https:// and keep the rest
    const rest = value.replace(/^[a-z]*:?\/*/i, '');
    e.target.value = HTTPS_PREFIX + rest;
    const end = e.target.value.length;
    e.target.setSelectionRange(end, end);
  });
}

/**
 * Update visibility of search clear button
 */
function updateSearchClearButton() {
  if (!elements.searchClear) return;
  
  const hasText = elements.documentSearch.value.trim().length > 0;
  if (hasText) {
    elements.searchClear.classList.add('visible');
  } else {
    elements.searchClear.classList.remove('visible');
  }
}

/**
 * Handle search clear button click
 */
function handleSearchClear() {
  elements.documentSearch.value = '';
  elements.documentSearch.focus();
  updateSearchClearButton();
  // Trigger search to show all documents
  handleDocumentSearch();
}

/**
 * Handle connection with better async/await and HTTPS enforcement
 */
async function handleConnect() {
  const serverUrl = elements.serverUrl.value.trim();
  const apiKey = elements.apiKey.value.trim();
  
  // Security: Input validation
  if (!serverUrl) {
    showError('auth-error', 'Please enter your RSpace server URL');
    return;
  }
  
  if (serverUrl.length > MAX_SERVER_URL_LENGTH) {
    showError('auth-error', 'Server URL is too long');
    return;
  }
  
  if (!apiKey) {
    showError('auth-error', 'Please enter your API key');
    return;
  }
  
  // Security: Validate URL format
  let url;
  try {
    url = new URL(serverUrl);
    
    // Only allow HTTP and HTTPS protocols
    if (!['http:', 'https:'].includes(url.protocol)) {
      showError('auth-error', 'Server URL must use HTTP or HTTPS protocol');
      return;
    }
    
    // Enforce HTTPS for non-localhost connections
    if (url.protocol === 'http:' && 
        !url.hostname.includes('localhost') && 
        !url.hostname.includes('127.0.0.1')) {
      showError('auth-error', 'HTTPS is required for security. HTTP connections are not allowed for remote servers.');
      return;
    }
    
  } catch (error) {
    logError('URL validation error:', error);
    showError('auth-error', 'Invalid server URL format. Please enter a valid URL (e.g., https://your-server.com)');
    return;
  }

  // Normalize URL (remove trailing slash)
  const normalizedUrl = serverUrl.replace(/\/$/, '');

  // Request host permission for this specific server origin.
  // This keeps the extension's required permissions minimal — we only ask for
  // access to the user's own RSpace server, not all websites.
  const serverOrigin = url.origin; // e.g. "https://rspace.myuni.edu"
  try {
    const granted = await chrome.permissions.request({
      origins: [`${serverOrigin}/*`]
    });
    if (!granted) {
      showError('auth-error', 'Permission required to connect to your RSpace server. Please allow access when prompted.');
      return;
    }
  } catch (error) {
    logError('Permission request error:', error);
    showError('auth-error', 'Could not request permission to access your server.');
    return;
  }

  // Show loading state
  elements.connectBtn.disabled = true;
  elements.connectBtn.textContent = 'Connecting...';
  elements.authError.classList.remove('show');
  
  try {
    // Clear any existing session credentials before attempting new connection
    await chrome.storage.session.clear();
    
    // Store server URL in session (always needed for this session)
    await chrome.storage.session.set({ serverUrl: normalizedUrl });
    
    // Check checkbox states
    const rememberServer = elements.rememberServer ? elements.rememberServer.checked : true;
    const rememberApiKey = elements.rememberApiKey ? elements.rememberApiKey.checked : false;
    
    // Save server URL persistently if checkbox is checked
    if (rememberServer) {
      await chrome.storage.local.set({ 
        savedServerUrl: normalizedUrl,
        rememberServer: true
      });
      log('Server URL saved persistently');
    } else {
      // Clear any previously saved URL
      await chrome.storage.local.remove(['savedServerUrl', 'rememberServer']);
      log('Server URL not saved (checkbox unchecked)');
    }
    
    // Forget any previously saved key up front. A new key is only persisted below,
    // after the server has accepted it, so a mistyped key is never stored.
    await chrome.storage.local.remove(['savedApiKey', 'apiKeyExpiresAt', 'rememberApiKey']);

    // Use promisified message sending
    const response = await sendMessageAsync({ 
      action: 'startAuth', 
      serverUrl: normalizedUrl,
      apiKey 
    });
    
    if (response && response.success) {
      if (rememberApiKey) {
        const expiresAt = Date.now() + API_KEY_EXPIRY_MS;
        await chrome.storage.local.set({
          savedApiKey: apiKey,
          apiKeyExpiresAt: expiresAt,
          rememberApiKey: true
        });
        log('API key saved persistently (expires in', API_KEY_EXPIRY_DAYS, 'days)');
      }
      showScreen('clipper-screen');
      await loadDocuments();
    } else {
      showError('auth-error', response?.error || 'Authentication failed');
      elements.connectBtn.disabled = false;
      elements.connectBtn.textContent = 'Connect to RSpace';
      
      // Clear sensitive inputs on failure
      elements.apiKey.value = '';
    }
  } catch (error) {
    logError('Connection error:', error);
    showError('auth-error', 'Failed to connect: ' + error.message);
    elements.connectBtn.disabled = false;
    elements.connectBtn.textContent = 'Connect to RSpace';
  }
}

/**
 * Handle clip with better error handling and null checks
 */
async function handleClip() {
  const contentType = document.querySelector('input[name="content-type"]:checked').value;
  const note = elements.note.value;
  const docName = elements.documentSearch.value.trim();

  // Handle PDF clipping separately
  if (contentType === 'pdf') {
    return handlePdfClip();
  }
  
  // Security: Input validation
  if (!docName) {
    showError('clip-error', 'Please enter a document name');
    return;
  }
  
  if (docName.length > MAX_DOC_TITLE_LENGTH) {
    showError('clip-error', `Document name too long (max ${MAX_DOC_TITLE_LENGTH} characters)`);
    return;
  }
  
  if (note && note.length > MAX_NOTE_LENGTH) {
    showError('clip-error', `Note too long (max ${MAX_NOTE_LENGTH} characters)`);
    return;
  }
  
  // Determine target document: use selected or create new
  let targetDoc = null;
  if (selectedDocument && selectedDocument.name === docName) {
    targetDoc = { isNew: false, id: selectedDocument.id, globalId: selectedDocument.globalId };
  } else {
    targetDoc = { isNew: true, title: docName };
  }

  // If a Form document is selected, a field must be chosen
  if (currentDocFields !== null && !selectedField) {
    showError('clip-error', 'Please select a field to save to');
    return;
  }

  // Show loading state
  elements.clipBtn.disabled = true;
  elements.clipBtn.textContent = 'Saving...';
  showScreen('loading-screen');

  try {
    // Get current tab with null check
    const tabs = await queryTabsAsync({ active: true, currentWindow: true });
    
    if (!tabs || tabs.length === 0) {
      showScreen('clipper-screen');
      showError('clip-error', 'No active tab found. Please try again.');
      elements.clipBtn.disabled = false;
      elements.clipBtn.textContent = 'Save to RSpace';
      return;
    }
    
    const tab = tabs[0];
    
    // Ensure content script is injected before sending message
    try {
      await ensureContentScriptInjected(tab.id);
    } catch (error) {
      showScreen('clipper-screen');
      showError('clip-error', 'Failed to access page. Try refreshing the page.');
      logError('Content script injection error:', error);
      elements.clipBtn.disabled = false;
      elements.clipBtn.textContent = 'Save to RSpace';
      return;
    }
    
    // Get content from the page
    let content;
    try {
      content = await sendTabMessageAsync(tab.id, { 
        action: 'getContent', 
        contentType 
      });
    } catch (error) {
      showScreen('clipper-screen');
      showError('clip-error', 'Failed to extract content from page.');
      logError('Content extraction error:', error);
      elements.clipBtn.disabled = false;
      elements.clipBtn.textContent = 'Save to RSpace';
      return;
    }
    
    if (!content || !content.html) {
      showScreen('clipper-screen');
      if (contentType === 'selection') {
        showError('clip-error', 'No text selected. Please highlight text on the page first, then try again.');
      } else {
        showError('clip-error', 'Failed to extract content from page. Try refreshing the page and try again.');
      }
      elements.clipBtn.disabled = false;
      elements.clipBtn.textContent = 'Save to RSpace';
      return;
    }
    
    // Send to background script to save
    const response = await sendMessageAsync({
      action: 'clipContent',
      targetDoc,
      targetField: selectedField || null,
      content,
      note: note || '',
      sourceUrl: tab.url,
      sourceTitle: tab.title
    });
    
    showScreen('clipper-screen');
    await chrome.storage.session.remove('lastClipResult');
    
    if (response && response.success) {
      // Get server URL for link
      const storage = await chrome.storage.session.get(['serverUrl']);
      const serverUrl = storage.serverUrl;
      
      showSuccessWithLink(
        'clip-success',
        'Content saved successfully!',
        response.documentId,
        response.globalId,
        serverUrl
      );
      
      // Clear the note field
      elements.note.value = '';
      
      // Reload documents to show newly created document (if any)
      await loadDocuments();
    } else {
      showError('clip-error', response?.error || 'Failed to save content');
    }
  } catch (error) {
    showScreen('clipper-screen');
    logError('=== UNEXPECTED ERROR IN CLIP ===');
    logError('Error:', error);
    logError('Error message:', error.message);
    logError('Error stack:', error.stack);
    
    // More descriptive error message
    let errorMsg = 'An unexpected error occurred: ' + error.message;
    
    // Check for common error scenarios
    if (error.message.includes('Cannot read property') || error.message.includes('Cannot read properties')) {
      errorMsg = '⚠️ Extension error.\n\nPlease try:\n1. Refresh the page you want to clip from\n2. Close and reopen the extension\n3. Try again\n\nTechnical details: ' + error.message;
    } else if (error.message.includes('Receiving end does not exist')) {
      errorMsg = '⚠️ Content script not loaded.\n\nPlease:\n1. Refresh the page\n2. Click the extension icon again\n3. Try clipping\n\nTechnical details: ' + error.message;
    }
    
    showError('clip-error', errorMsg);
  } finally {
    elements.clipBtn.disabled = false;
    elements.clipBtn.textContent = 'Save to RSpace';
  }
}

/**
 * Handle PDF clipping workflow
 */
async function handlePdfClip() {
  const note = elements.note.value;
  const docName = elements.documentSearch.value.trim();

  // Security: Input validation
  if (!docName) {
    showError('clip-error', 'Please enter a document name');
    return;
  }

  if (docName.length > MAX_DOC_TITLE_LENGTH) {
    showError('clip-error', `Document name too long (max ${MAX_DOC_TITLE_LENGTH} characters)`);
    return;
  }

  if (note && note.length > MAX_NOTE_LENGTH) {
    showError('clip-error', `Note too long (max ${MAX_NOTE_LENGTH} characters)`);
    return;
  }

  // Determine target document: use selected or create new
  let targetDoc = null;
  if (selectedDocument && selectedDocument.name === docName) {
    targetDoc = { isNew: false, id: selectedDocument.id, globalId: selectedDocument.globalId };
  } else {
    targetDoc = { isNew: true, title: docName };
  }

  // If a Form document is selected, a field must be chosen
  if (currentDocFields !== null && !selectedField) {
    showError('clip-error', 'Please select a field to save to');
    return;
  }

  // Show loading state
  elements.clipBtn.disabled = true;
  elements.clipBtn.textContent = 'Generating PDF...';
  showScreen('loading-screen');

  try {
    // Get current tab
    const tabs = await queryTabsAsync({ active: true, currentWindow: true });

    if (!tabs || tabs.length === 0) {
      showScreen('clipper-screen');
      showError('clip-error', 'No active tab found. Please try again.');
      elements.clipBtn.disabled = false;
      elements.clipBtn.textContent = 'Save to RSpace';
      return;
    }

    const tab = tabs[0];

    // Inject content script + PDF libraries into the active tab before requesting PDF generation
    try {
      await ensureContentScriptInjected(tab.id, true);
    } catch (error) {
      showScreen('clipper-screen');
      showError('clip-error', 'Failed to access page. Try refreshing the page.');
      logError('PDF content script injection error:', error);
      elements.clipBtn.disabled = false;
      elements.clipBtn.textContent = 'Save to RSpace';
      return;
    }

    // Send PDF clip request to background script
    const response = await sendMessageAsync({
      action: 'clipPdf',
      targetDoc,
      targetField: selectedField || null,
      note: note || '',
      sourceUrl: tab.url,
      sourceTitle: tab.title,
      tabId: tab.id
    });

    showScreen('clipper-screen');
    await chrome.storage.session.remove('lastClipResult');

    if (response && response.success) {
      // Get server URL for link
      const storage = await chrome.storage.session.get(['serverUrl']);
      const serverUrl = storage.serverUrl;

      showSuccessWithLink(
        'clip-success',
        'PDF saved successfully!',
        response.documentId,
        response.globalId,
        serverUrl
      );

      // Clear the note field
      elements.note.value = '';

      // Reload documents to show newly created document (if any)
      await loadDocuments();
    } else {
      showError('clip-error', response?.error || 'Failed to save PDF');
    }
  } catch (error) {
    showScreen('clipper-screen');
    logError('PDF clip error:', error);

    let errorMsg = 'An error occurred while saving PDF: ' + error.message;

    // Provide helpful error messages
    if (error.message.includes('PDF generation')) {
      errorMsg = '⚠️ PDF generation failed.\n\nThis feature requires browser print support. Some pages may not be compatible.\n\nTip: Try using "Full Page" or "Selection" mode instead.';
    }

    showError('clip-error', errorMsg);
  } finally {
    elements.clipBtn.disabled = false;
    elements.clipBtn.textContent = 'Save to RSpace';
  }
}

/**
 * Load documents with promisified API
 */
async function loadDocuments(append = false) {
  if (!append) {
    currentPage = 0;
    documents = [];
    hasMoreDocuments = true;
  }
  
  try {
    const response = await sendMessageAsync({ 
      action: 'getDocuments',
      pageNumber: currentPage
    });
    
    if (response && response.success) {
      if (append) {
        documents = mergeDocuments(documents, response.documents);
      } else {
        documents = response.documents;
      }
      
      // Check if there are more documents
      hasMoreDocuments = response.hasMore;
      
      renderDocuments(documents);
      // Removed: updateLoadMoreButton() - now using infinite scroll
      
      // Show empty state if no documents
      if (documents.length === 0) {
        showEmptyState();
      } else {
        hideEmptyState();
      }
    } else if (response && response.error === 'Not authenticated') {
      // Session expired, show auth screen
      showScreen('auth-screen');
    } else {
      showError('clip-error', response?.error || 'Failed to load documents');
    }
  } catch (error) {
    logError('Load documents error:', error);
    showError('clip-error', 'Failed to load documents: ' + error.message);
  }
}

async function handleLoadMore() {
  if (isLoadingMore || !hasMoreDocuments) return;
  
  isLoadingMore = true;
  
  // Show loading indicator
  if (elements.loadingIndicator) {
    elements.loadingIndicator.style.display = 'block';
  }
  
  currentPage++;
  
  await loadDocuments(true);
  
  // Hide loading indicator
  if (elements.loadingIndicator) {
    elements.loadingIndicator.style.display = 'none';
  }
  
  isLoadingMore = false;
}

/**
 * Handle infinite scroll - auto-load more documents when near bottom
 */
function handleInfiniteScroll() {
  // Don't trigger if already loading or no more documents
  if (isLoadingMore || !hasMoreDocuments) return;
  
  const scrollTop = elements.documentSection.scrollTop;
  const scrollHeight = elements.documentSection.scrollHeight;
  const clientHeight = elements.documentSection.clientHeight;
  
  // Calculate distance from bottom
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  
  // Trigger threshold: 100px from bottom
  const threshold = 100;
  
  // Load more when near bottom
  if (distanceFromBottom < threshold) {
    handleLoadMore();
  }
}


// Incremented per search so a slow server response for an older query is ignored
let searchSequence = 0;

/**
 * Merge two document lists, keeping the first occurrence of each id.
 */
function mergeDocuments(existing, incoming) {
  const seen = new Set(existing.map(doc => doc.id));
  return [...existing, ...incoming.filter(doc => !seen.has(doc.id))];
}

/**
 * Apply the current search box value to the list: filter the documents loaded so far,
 * select an exact name match, and toggle the create hint.
 */
function applySearchFilter(query) {
  const filtered = documents.filter(doc =>
    doc.name.toLowerCase().includes(query)
  );
  const exactMatch = documents.find(doc =>
    doc.name.toLowerCase() === query
  );

  selectedDocument = exactMatch || null;
  renderDocuments(filtered);

  if (!exactMatch) {
    showCreateHint();
  } else {
    hideCreateHint();
  }
  return { filtered, exactMatch };
}

function handleDocumentSearch() {
  // Clear field state immediately — it's only restored by clicking a document
  currentDocFields = null;
  selectedField = null;
  hideFieldSelector();

  // Debounce the rest
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    const query = elements.documentSearch.value.toLowerCase().trim();
    const sequence = ++searchSequence;

    if (!query) {
      // Show all documents when search is empty
      selectedDocument = null;
      renderDocuments(documents);
      hideCreateHint();
      return;
    }

    const { filtered, exactMatch } = applySearchFilter(query);

    // Only the pages scrolled so far are loaded locally. When the local match is thin and
    // the server has more documents, ask the server to search the rest.
    if (query.length < 2 || !hasMoreDocuments || (exactMatch && filtered.length >= 5)) {
      return;
    }

    try {
      const response = await sendMessageAsync({ action: 'getDocuments', pageNumber: 0, query });
      // Discard if the user has typed something else since
      if (sequence !== searchSequence) return;
      if (response && response.success && response.documents.length) {
        documents = mergeDocuments(documents, response.documents);
        applySearchFilter(query);
      }
    } catch (error) {
      logError('Server search failed:', error);
    }
  }, SEARCH_DEBOUNCE_MS);
}

/**
 * Show the outcome of a clip that finished after the popup was closed (stored by the worker).
 * Shown once; the entry is removed afterwards.
 */
async function showPendingClipResult(serverUrl) {
  try {
    const { lastClipResult } = await chrome.storage.session.get('lastClipResult');
    if (!lastClipResult) return;
    await chrome.storage.session.remove('lastClipResult');

    // Ignore stale entries (older than ten minutes)
    if (Date.now() - lastClipResult.at > 10 * 60 * 1000) return;

    if (lastClipResult.success) {
      showSuccessWithLink('clip-success', lastClipResult.message, lastClipResult.documentId, lastClipResult.globalId, serverUrl);
    } else {
      showError('clip-error', lastClipResult.message);
    }
  } catch (error) {
    logError('Could not read pending clip result:', error);
  }
}

/**
 * Select a document in the list: highlight it, put its name in the search box and
 * load its fields (to show the field selector for Form documents).
 */
async function selectDocument(doc) {
  document.querySelectorAll('.document-item').forEach(i => {
    const isTarget = Number(i.dataset.id) === doc.id;
    i.classList.toggle('selected', isTarget);
    i.setAttribute('aria-selected', String(isTarget));
  });
  selectedDocument = doc;
  elements.documentSearch.value = doc.name;
  updateSearchClearButton();
  hideCreateHint();

  // Reset field state, then fetch fields for this document
  currentDocFields = null;
  selectedField = null;
  hideFieldSelector();
  await fetchAndShowFieldSelector(doc.id);
}

function renderDocuments(docs) {
  elements.documentList.innerHTML = '';
  
  if (docs.length === 0) {
    return;
  }
  
  docs.forEach(doc => {
    const item = document.createElement('div');
    item.className = 'document-item';
    item.textContent = doc.name;
    item.dataset.id = doc.id;
    item.tabIndex = 0; // Make focusable for keyboard navigation
    item.setAttribute('role', 'button'); // Accessibility: announce as button
    item.setAttribute('aria-label', `Select document: ${doc.name}`);
    
    // Highlight if this is the selected document
    if (selectedDocument && selectedDocument.id === doc.id) {
      item.classList.add('selected');
      item.setAttribute('aria-selected', 'true');
    } else {
      item.setAttribute('aria-selected', 'false');
    }
    
    // Click handler
    item.addEventListener('click', () => selectDocument(doc));
    
    // Keyboard handler (Enter or Space)
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectDocument(doc);
      }
    });
    
    elements.documentList.appendChild(item);
  });
}

function showCreateHint() {
  const nameEl = document.getElementById('create-hint-name');
  if (nameEl) nameEl.textContent = elements.documentSearch.value.trim();
  elements.createHint.style.display = 'flex';
}

function hideCreateHint() {
  elements.createHint.style.display = 'none';
}

/**
 * Ensure content script (and optionally PDF libraries) are injected into the active tab.
 * Scripts are only injected into the tab the user is actively clipping from,
 * triggered by explicit user action — no broad host permissions required.
 * @param {number} tabId
 * @param {boolean} [includePdfLibs=false] - Also inject html2canvas and jsPDF
 */
async function ensureContentScriptInjected(tabId, includePdfLibs = false) {
  let contentScriptPresent = false;
  let pdfLibsPresent = false;

  try {
    // Ping the content script. It answers with whether the PDF libraries are loaded too.
    const response = await sendTabMessageAsync(tabId, { action: 'ping' });
    if (response && response.status === 'ready') {
      contentScriptPresent = true;
      pdfLibsPresent = response.pdfLibs === true;
      log('Content script already injected, PDF libs present:', pdfLibsPresent);
    }
  } catch (error) {
    // No listener in the tab yet: the content script is not present
    log('Content script not present, injecting...');
  }

  // Inject only what is missing. All injected files share one isolated world, so
  // content.js is never injected twice (it also guards itself, see content.js header).
  const files = [];
  if (includePdfLibs && !pdfLibsPresent) {
    files.push('html2canvas.min.js', 'jspdf.umd.min.js');
  }
  if (!contentScriptPresent) {
    files.push('content.js');
  }

  if (files.length === 0) {
    return;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files
    });
    log('Injected:', files.join(', '));
  } catch (error) {
    logError('Failed to inject content script:', error);
    throw error;
  }
}

function showEmptyState() {
  elements.emptyState.style.display = 'block';
  elements.documentList.style.display = 'none';
}

function hideEmptyState() {
  elements.emptyState.style.display = 'none';
  elements.documentList.style.display = 'block';
}

async function handleSettings() {
  // Reset the connect button to its initial state
  elements.connectBtn.disabled = false;
  elements.connectBtn.textContent = 'Connect to RSpace';
  
  // Load saved credentials and pre-fill
  const stored = await chrome.storage.local.get([
    'savedServerUrl',
    'savedApiKey',
    'apiKeyExpiresAt',
    'rememberServer',
    'rememberApiKey'
  ]);
  
  // Pre-fill server URL if saved
  if (stored.savedServerUrl && stored.rememberServer !== false) {
    const validatedUrl = validateStoredUrl(stored.savedServerUrl);
    if (validatedUrl) {
      elements.serverUrl.value = validatedUrl;
      if (elements.rememberServer) {
        elements.rememberServer.checked = true;
      }
    } else {
      elements.serverUrl.value = 'https://';
    }
  } else {
    elements.serverUrl.value = 'https://';
  }
  
  // Pre-fill API key if saved and not expired
  if (stored.savedApiKey && stored.rememberApiKey) {
    if (stored.apiKeyExpiresAt && Date.now() < stored.apiKeyExpiresAt) {
      elements.apiKey.value = stored.savedApiKey;
      if (elements.rememberApiKey) {
        elements.rememberApiKey.checked = true;
      }
    } else {
      // Expired - clear it
      await chrome.storage.local.remove(['savedApiKey', 'apiKeyExpiresAt']);
      elements.apiKey.value = '';
    }
  } else {
    elements.apiKey.value = '';
  }
  
  // Clear any error messages
  elements.authError.classList.remove('show');
  
  // Show auth screen with back button (don't clear credentials yet)
  elements.backBtn.style.display = 'block';
  showScreen('auth-screen');
}

function handleBackToClipper() {
  // Return to clipper screen without clearing credentials
  elements.backBtn.style.display = 'none';
  showScreen('clipper-screen');
}

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(screen => {
    screen.style.display = 'none';
  });
  document.getElementById(screenId).style.display = screenId === 'clipper-screen' ? 'flex' : 'block';
}

function showError(elementId, message) {
  const el = document.getElementById(elementId);
  if (!el) {
    logError('ERROR: Element not found:', elementId);
    return;
  }
  
  el.textContent = message;
  el.classList.add('show');
  
  // Auto-scroll to error message with more visibility
  setTimeout(() => {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 100);
  
  setTimeout(() => el.classList.remove('show'), ERROR_DISPLAY_MS);
}

function showSuccess(elementId, message) {
  const el = document.getElementById(elementId);
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), SUCCESS_DISPLAY_MS);
}

function showSuccessWithLink(elementId, message, documentId, globalId, serverUrl) {
  const el = document.getElementById(elementId);
  
  // Create message with link
  const messageSpan = document.createElement('span');
  messageSpan.textContent = message + ' ';
  
  const link = document.createElement('a');
  link.href = `${serverUrl}/globalId/${globalId}`;
  link.target = '_blank';
  link.textContent = 'View →';
  link.style.color = 'inherit';
  link.style.fontWeight = '600';
  link.style.textDecoration = 'underline';
  
  el.innerHTML = '';
  el.appendChild(messageSpan);
  el.appendChild(link);
  
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), SUCCESS_DISPLAY_MS);
}

// ===== PROMISIFIED CHROME API HELPERS =====

/**
 * Send a message to the background script and await the response
 * @param {Object} message - Message to send
 * @returns {Promise<any>} Response from background script
 */
async function sendMessageAsync(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Query tabs asynchronously
 * @param {Object} queryInfo - Tab query parameters
 * @returns {Promise<chrome.tabs.Tab[]>} Array of matching tabs
 */
async function queryTabsAsync(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(tabs);
      }
    });
  });
}

/**
 * Send a message to a specific tab and await the response
 * @param {number} tabId - Tab ID to send message to
 * @param {Object} message - Message to send
 * @returns {Promise<any>} Response from tab
 */
async function sendTabMessageAsync(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ===== PERSISTENT STORAGE UTILITIES =====

/**
 * One-time migration: Move existing session data to local storage
 * This helps existing users transition smoothly to the new storage model
 */
async function migrateSessionToLocal() {
  try {
    // Check if migration has already been done
    const { migrationComplete } = await chrome.storage.local.get('migrationComplete');
    
    if (migrationComplete) {
      log('Migration already complete');
      return;
    }
    
    // Try to get existing session data
    const session = await chrome.storage.session.get(['serverUrl']);
    
    if (session.serverUrl) {
      // Migrate server URL to persistent storage
      await chrome.storage.local.set({
        savedServerUrl: session.serverUrl,
        rememberServer: true,
        migrationComplete: true
      });
      log('Migrated server URL from session to local storage');
    } else {
      // No data to migrate, just mark as complete
      await chrome.storage.local.set({ migrationComplete: true });
      log('No session data to migrate');
    }
  } catch (error) {
    logError('Migration error:', error);
    // Don't block on migration errors
  }
}

/**
 * Validate a stored URL for security
 * Prevents malicious URLs from being loaded from storage
 * @param {string} url - URL to validate
 * @returns {string|null} Validated URL or null if invalid
 */
function validateStoredUrl(url) {
  try {
    // Length check
    if (!url || url.length > MAX_SERVER_URL_LENGTH) {
      return null;
    }
    
    // Parse and validate
    const parsed = new URL(url);
    
    // Only allow http and https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      logError('Invalid protocol in stored URL:', parsed.protocol);
      return null;
    }
    
    // Block dangerous protocols that might have been injected
    const dangerous = ['javascript:', 'data:', 'file:', 'ftp:'];
    if (dangerous.some(proto => url.toLowerCase().startsWith(proto))) {
      logError('Dangerous protocol detected in stored URL');
      return null;
    }
    
    // Check for embedded credentials (should not be in URL)
    if (parsed.username || parsed.password) {
      logError('Credentials detected in stored URL - removing them');
      // Return URL without credentials
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    
    // URL is valid
    return url;
  } catch (error) {
    logError('URL validation error:', error);
    return null;
  }
}

// ===== FORM FIELD SELECTOR =====

/**
 * Fetch fields for the selected document and show the field selector if it's a Form doc.
 * Guards against race conditions when the user clicks documents quickly.
 */
async function fetchAndShowFieldSelector(documentId) {
  try {
    const response = await sendMessageAsync({
      action: 'getDocumentFields',
      documentId
    });

    // If the user has since selected a different document, discard this response
    if (!selectedDocument || selectedDocument.id !== documentId) {
      return;
    }

    if (!response || !response.success) {
      // Silently fail — the user will get a clear error if they try to save to a Form doc
      return;
    }

    if (!response.isFormDoc) {
      // Simple document — no field selector needed
      currentDocFields = null;
      return;
    }

    // Form document — cache fields and render the selector
    currentDocFields = response.fields;
    const contentType = document.querySelector('input[name="content-type"]:checked').value;
    updateFieldSelector(contentType);
  } catch (error) {
    logError('Error fetching document fields:', error);
    // Silently fail
  }
}

/**
 * Filter the cached fields by content type and refresh the selector UI.
 */
function updateFieldSelector(contentType) {
  if (!currentDocFields) {
    hideFieldSelector();
    return;
  }

  const compatibleFields = getCompatibleFields(currentDocFields, contentType);
  showFieldSelector(compatibleFields);
}

/**
 * Return fields that can accept the given content type.
 * For MVP all clip types produce HTML/rich content, so only TEXT fields qualify.
 */
function getCompatibleFields(fields, contentType) {
  return fields.filter(f => f.type && f.type.toUpperCase() === 'TEXT');
}

/**
 * Populate and show the field selector dropdown.
 * If compatibleFields is empty, shows the incompatible-fields message instead.
 */
function showFieldSelector(compatibleFields) {
  if (!elements.fieldSelectorSection) return;

  elements.fieldSelectorSection.style.display = 'block';

  if (compatibleFields.length === 0) {
    elements.fieldSelect.style.display = 'none';
    elements.noCompatibleFieldsMsg.style.display = 'block';
    elements.clipBtn.disabled = true;
    selectedField = null;
    return;
  }

  // Re-enable save (might have been disabled by a previous incompatible state)
  elements.clipBtn.disabled = false;
  elements.fieldSelect.style.display = 'block';
  elements.noCompatibleFieldsMsg.style.display = 'none';

  // Rebuild options
  elements.fieldSelect.innerHTML = '';
  compatibleFields.forEach(field => {
    const option = document.createElement('option');
    option.value = field.id;
    option.textContent = field.name;
    elements.fieldSelect.appendChild(option);
  });

  // Auto-select the first compatible field
  selectedField = compatibleFields[0];
}

/**
 * Hide the field selector and reset field state.
 */
function hideFieldSelector() {
  if (!elements.fieldSelectorSection) return;
  elements.fieldSelectorSection.style.display = 'none';
  elements.fieldSelect.innerHTML = '';
  elements.noCompatibleFieldsMsg.style.display = 'none';
  if (elements.clipBtn) elements.clipBtn.disabled = false;
}

/**
 * Sync selectedField when the user picks a different option in the dropdown.
 */
function handleFieldSelectChange() {
  if (!currentDocFields || !elements.fieldSelect) return;
  const selectedId = parseInt(elements.fieldSelect.value, 10);
  selectedField = currentDocFields.find(f => f.id === selectedId) || null;
}

/**
 * Clear all saved data (server URL and API key)
 * Provides user control over persistent storage
 * Also clears active session to fully log out
 */
async function handleClearSavedData() {
  try {
    // Clear all persistent credentials from local storage
    await chrome.storage.local.remove([
      'savedServerUrl',
      'savedApiKey',
      'apiKeyExpiresAt',
      'rememberServer',
      'rememberApiKey'
    ]);
    
    // Also clear active session (logout)
    await chrome.storage.session.clear();

    // Tell the background worker to drop its in-memory document cache
    const response = await sendMessageAsync({ action: 'logout' });
    if (!response || !response.success) {
      throw new Error('Background worker did not confirm logout');
    }
    
    // Clear form fields
    elements.serverUrl.value = 'https://';
    elements.apiKey.value = '';
    
    // Uncheck checkboxes
    if (elements.rememberServer) {
      elements.rememberServer.checked = true; // Server URL defaults to checked
    }
    if (elements.rememberApiKey) {
      elements.rememberApiKey.checked = false; // API key defaults to unchecked
    }
    
    // Show success message
    showError('auth-error', 'All saved data cleared and logged out successfully');
    
    // Auto-hide after short delay
    setTimeout(() => {
      elements.authError.classList.remove('show');
    }, 2000);
    
    log('All saved data cleared and session terminated by user');
  } catch (error) {
    logError('Error clearing saved data:', error);
    showError('auth-error', 'Failed to clear saved data');
  }
}

