// Security: Disable all logging in production
const DEBUG = false;
const log = DEBUG ? console.log : () => {};
const logError = DEBUG ? console.error : () => {};

// State management
let selectedDocument = null;
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

// NEW: API Key storage expiration (7 days)
const API_KEY_EXPIRY_DAYS = 7;
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
  
  // Support Enter key in document search
  elements.documentSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleClip();
    }
  });
}

/**
 * Setup protection for the https:// prefix in server URL input
 */
function setupServerUrlProtection() {
  const HTTPS_PREFIX = 'https://';
  const PREFIX_LENGTH = HTTPS_PREFIX.length;
  
  // Set cursor position after https:// on focus
  elements.serverUrl.addEventListener('focus', (e) => {
    if (e.target.value === HTTPS_PREFIX) {
      setTimeout(() => {
        e.target.setSelectionRange(PREFIX_LENGTH, PREFIX_LENGTH);
      }, 0);
    }
  });
  
  // Prevent deletion of https:// prefix
  elements.serverUrl.addEventListener('input', (e) => {
    if (!e.target.value.startsWith(HTTPS_PREFIX)) {
      e.target.value = HTTPS_PREFIX;
      e.target.setSelectionRange(PREFIX_LENGTH, PREFIX_LENGTH);
    }
  });
  
  // Handle backspace and delete keys
  elements.serverUrl.addEventListener('keydown', (e) => {
    const cursorPos = e.target.selectionStart;
    const value = e.target.value;
    
    // Prevent deleting any part of https://
    if ((e.key === 'Backspace' && cursorPos <= PREFIX_LENGTH) || 
        (e.key === 'Delete' && cursorPos < PREFIX_LENGTH)) {
      e.preventDefault();
    }
    
    // Prevent selecting and deleting https://
    if ((e.key === 'Backspace' || e.key === 'Delete') && 
        e.target.selectionStart < PREFIX_LENGTH && e.target.selectionEnd > PREFIX_LENGTH) {
      e.preventDefault();
      // If user tried to delete selection including prefix, just delete the part after
      if (e.target.selectionEnd > PREFIX_LENGTH) {
        e.target.value = HTTPS_PREFIX + value.substring(e.target.selectionEnd);
        e.target.setSelectionRange(PREFIX_LENGTH, PREFIX_LENGTH);
      }
    }
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
    
    // Save API key with expiration if checkbox is checked
    if (rememberApiKey) {
      const expiresAt = Date.now() + API_KEY_EXPIRY_MS;
      await chrome.storage.local.set({
        savedApiKey: apiKey,
        apiKeyExpiresAt: expiresAt,
        rememberApiKey: true
      });
      log('API key saved persistently (expires in', API_KEY_EXPIRY_DAYS, 'days)');
    } else {
      // Clear any previously saved API key
      await chrome.storage.local.remove(['savedApiKey', 'apiKeyExpiresAt', 'rememberApiKey']);
      log('API key not saved (checkbox unchecked or default)');
    }
    
    // Use promisified message sending
    const response = await sendMessageAsync({ 
      action: 'startAuth', 
      serverUrl: normalizedUrl,
      apiKey 
    });
    
    if (response && response.success) {
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
      content,
      note: note || '',
      sourceUrl: tab.url,
      sourceTitle: tab.title
    });
    
    showScreen('clipper-screen');
    
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

    // Send PDF clip request to background script
    const response = await sendMessageAsync({
      action: 'clipPdf',
      targetDoc,
      note: note || '',
      sourceUrl: tab.url,
      sourceTitle: tab.title,
      tabId: tab.id
    });

    showScreen('clipper-screen');

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
        documents = [...documents, ...response.documents];
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


function handleDocumentSearch(e) {
  // Debounce search input
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const query = e.target.value.toLowerCase().trim();
    
    if (!query) {
      // Show all documents when search is empty
      selectedDocument = null;
      renderDocuments(documents);
      hideCreateHint();
      return;
    }
    
    const filtered = documents.filter(doc => 
      doc.name.toLowerCase().includes(query)
    );
    
    // Check if there's an exact match
    const exactMatch = documents.find(doc => 
      doc.name.toLowerCase() === query
    );
    
    if (exactMatch) {
      selectedDocument = exactMatch;
    } else {
      selectedDocument = null;
    }
    
    renderDocuments(filtered);
    
    // Show create hint if no exact match found and query is not empty
    if (!exactMatch && query) {
      showCreateHint();
    } else {
      hideCreateHint();
    }
  }, SEARCH_DEBOUNCE_MS);
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
    
    const selectDocument = () => {
      document.querySelectorAll('.document-item').forEach(i => {
        i.classList.remove('selected');
        i.setAttribute('aria-selected', 'false');
      });
      item.classList.add('selected');
      item.setAttribute('aria-selected', 'true');
      selectedDocument = doc;
      elements.documentSearch.value = doc.name;
      hideCreateHint();
    };
    
    // Click handler
    item.addEventListener('click', selectDocument);
    
    // Keyboard handler (Enter or Space)
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectDocument();
      }
    });
    
    elements.documentList.appendChild(item);
  });
}

function showCreateHint() {
  elements.createHint.style.display = 'flex';
}

function hideCreateHint() {
  elements.createHint.style.display = 'none';
}

/**
 * Ensure content script is injected into the active tab
 */
async function ensureContentScriptInjected(tabId) {
  try {
    // Try to ping the content script to see if it's already there
    const response = await sendTabMessageAsync(tabId, { action: 'ping' });
    if (response) {
      log('Content script already injected');
      return; // Content script already present
    }
  } catch (error) {
    // Content script not present, need to inject it
    log('Content script not present, injecting...');
  }
  
  try {
    // Inject the content script
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });
    log('Content script injected successfully');
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
    
    // Tell background script to clear session
    try {
      await sendMessageAsync({ action: 'logout' });
    } catch (error) {
      // Background script might not have logout handler yet, that's ok
      log('Background logout call failed (may not be implemented):', error.message);
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

