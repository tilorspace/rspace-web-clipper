// Background service worker for RSpace Web Clipper
// Handles authentication, API calls, and content saving

// Load configuration
importScripts('config.js');

// Security: Disable all logging in production
const DEBUG = false;
const log = DEBUG ? console.log : () => {};
const logError = DEBUG ? console.error : () => {};

// Document cache with TTL (first page only)
let documentsCache = emptyDocumentsCache();

function emptyDocumentsCache() {
  return {
    data: null,
    timestamp: null,
    ttl: CONFIG.CACHE.DOCUMENTS_TTL_MS,
    totalPages: null,
    pageSize: CONFIG.API.DEFAULT_PAGE_SIZE
  };
}

function resetDocumentsCache() {
  documentsCache = emptyDocumentsCache();
}

/**
 * Validate an RSpace numeric id coming from the popup before it is used in a URL.
 * @param {*} value
 * @returns {number|null} the id as a positive integer, or null if invalid
 */
function toValidId(value) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Request deduplication map
const activeRequests = new Map();

/**
 * Shared HTTP error handler - converts HTTP status codes to user-friendly messages
 * @param {Response} response - Fetch API response object
 * @returns {string} User-friendly error message
 */
function getHttpErrorMessage(response) {
  if (response.status === 401) {
    return 'Session expired. Please reconnect.';
  } else if (response.status === 403) {
    return 'Permission denied. Check your access rights.';
  } else if (response.status === 429) {
    return 'Too many requests. Please wait and try again.';
  } else if (response.status >= 500) {
    return 'Server error. Please try again later.';
  }
  return 'Request failed. Please try again.';
}

/**
 * Validate the popup's request and resolve the document (and field) to write to.
 * Creates the document when request.targetDoc.isNew is set.
 * @returns {Promise<{success: boolean, documentId?: number, globalId?: string, error?: string}>}
 */
async function resolveTargetDocument(serverUrl, accessToken, request) {
  const targetDoc = request && request.targetDoc;
  if (!targetDoc || typeof targetDoc !== 'object') {
    return { success: false, error: 'No target document specified' };
  }
  if (request.targetField && toValidId(request.targetField.id) === null) {
    return { success: false, error: 'Invalid field id' };
  }
  if (targetDoc.isNew) {
    const title = typeof targetDoc.title === 'string' ? targetDoc.title.trim() : '';
    if (!title || title.length > CONFIG.LIMITS.MAX_DOC_TITLE_LENGTH) {
      return { success: false, error: 'Invalid document title' };
    }
    return createDocument(serverUrl, accessToken, title);
  }
  const documentId = toValidId(targetDoc.id);
  if (documentId === null) {
    return { success: false, error: 'Invalid document id' };
  }
  log('Using existing document ID:', documentId);
  return { success: true, documentId, globalId: targetDoc.globalId };
}

/**
 * Create a new RSpace document
 * @param {string} serverUrl - RSpace server URL
 * @param {string} accessToken - API access token
 * @param {string} title - Document title
 * @returns {Promise<{success: boolean, documentId?: number, globalId?: string, error?: string}>}
 */
async function createDocument(serverUrl, accessToken, title) {
  log('Creating new document:', title);

  const createUrl = `${serverUrl}/api/v1/documents`;
  const createResponse = await fetchWithTimeout(createUrl, {
    method: 'POST',
    headers: {
      'apiKey': accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: title,
      tags: 'web-clipper',
      fields: [{ content: '' }]
    })
  });

  log('Create response status:', createResponse.status);

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    logError('Failed to create document:', createResponse.status, errorText);

    let errorMessage = getHttpErrorMessage(createResponse);

    // Try to extract more specific error from response
    try {
      const errorJson = JSON.parse(errorText);
      if (errorJson.message || errorJson.error) {
        errorMessage = errorJson.message || errorJson.error;
      }
    } catch (e) {
      if (errorText && errorText.length < 100) {
        errorMessage = errorText;
      }
    }

    return { success: false, error: errorMessage };
  }

  const newDoc = await createResponse.json();
  log('Created document with ID:', newDoc.id);

  return {
    success: true,
    documentId: newDoc.id,
    globalId: newDoc.globalId
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  log('Background received message:', request.action);

  if (request.action === 'startAuth') {
    handleAuth(request.serverUrl, request.apiKey).then(sendResponse);
    return true;
  }

  if (request.action === 'getDocuments') {
    getDocuments(request.pageNumber || 0, request.query || '').then(sendResponse);
    return true;
  }

  if (request.action === 'clipContent') {
    clipContent(request).then(sendResponse);
    return true;
  }

  if (request.action === 'clipPdf') {
    clipPdf(request).then(sendResponse);
    return true;
  }

  if (request.action === 'getDocumentFields') {
    getDocumentFields(request.documentId).then(sendResponse);
    return true;
  }

  if (request.action === 'logout') {
    handleLogout().then(sendResponse);
    return true;
  }
});

/**
 * Clear everything the worker holds for the current user: session credentials,
 * the in-memory document cache and any in-flight request promises.
 */
async function handleLogout() {
  try {
    await chrome.storage.session.clear();
    resetDocumentsCache();
    activeRequests.clear();
    log('Logged out, cache cleared');
    return { success: true };
  } catch (error) {
    logError('Logout error:', error);
    return { success: false, error: 'Failed to log out' };
  }
}

async function handleAuth(serverUrl, apiKey) {
  log('handleAuth called with URL:', serverUrl);
  try {
    log('Testing API key...');
    // Test the API key with timeout
    const response = await fetchWithTimeout(`${serverUrl}/api/v1/status`, {
      headers: {
        'apiKey': apiKey
      }
    });
    
    log('API response status:', response.status);

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: 'Invalid API key' };
      } else if (response.status === 404) {
        return { success: false, error: 'Server endpoint not found. Please check the URL.' };
      }
      return { success: false, error: getHttpErrorMessage(response) };
    }
    
    log('API key valid, storing credentials...');
    // Security: Store credentials in session storage (more secure than local)
    // Session storage is cleared when browser closes
    await chrome.storage.session.set({ 
      serverUrl, 
      accessToken: apiKey 
    });
    
    // Clear cache on new auth
    resetDocumentsCache();
    
    log('Credentials stored successfully');
    return { success: true };
  } catch (error) {
    logError('Auth error:', error);
    
    // Improved error messaging
    if (error.message === 'Request timeout') {
      return { success: false, error: 'Connection timeout. Please check your network and try again.' };
    }
    return { success: false, error: 'Authentication failed. Please check your connection.' };
  }
}

/**
 * List the user's documents, newest first.
 * @param {number} pageNumber
 * @param {string} [query] - optional server-side search term; results are not cached
 */
async function getDocuments(pageNumber = 0, query = '') {
  log('getDocuments called for page:', pageNumber, 'query:', query);

  query = typeof query === 'string' ? query.trim().slice(0, 200) : '';
  const cacheKey = query ? `search_${pageNumber}_${query}` : `documents_${pageNumber}`;
  
  // Request deduplication
  if (activeRequests.has(cacheKey)) {
    log('Returning existing request for:', cacheKey);
    return activeRequests.get(cacheKey);
  }
  
  const requestPromise = (async () => {
    try {
      const { serverUrl, accessToken } = await chrome.storage.session.get(['serverUrl', 'accessToken']);
      log('Got credentials from storage:', { serverUrl: serverUrl, hasToken: !!accessToken });
      
      if (!serverUrl || !accessToken) {
        return { success: false, error: 'Not authenticated', documents: [], hasMore: false };
      }
      
      // Check cache only for the first unfiltered page
      if (pageNumber === 0 && !query) {
        const now = Date.now();
        if (documentsCache.data && 
            documentsCache.timestamp && 
            (now - documentsCache.timestamp) < documentsCache.ttl) {
          log('Returning cached documents');
          return { 
            success: true, 
            documents: documentsCache.data,
            hasMore: documentsCache.totalPages > 1
          };
        }
      }
      
      const pageSize = CONFIG.API.DEFAULT_PAGE_SIZE;
      let fetchUrl = `${serverUrl}/api/v1/documents?pageSize=${pageSize}&pageNumber=${pageNumber}&orderBy=lastModified desc`;
      if (query) {
        fetchUrl += `&query=${encodeURIComponent(query)}`;
      }
      log('Fetching documents from:', fetchUrl);
      
      const response = await fetchWithTimeout(fetchUrl, {
        headers: {
          'apiKey': accessToken
        }
      });
      
      log('Documents fetch response status:', response.status);
      
      if (!response.ok) {
        logError('Documents fetch failed:', response.status, response.statusText);
        return { success: false, error: getHttpErrorMessage(response), documents: [], hasMore: false };
      }
      
      const data = await response.json();
      log('Documents fetched:', data.documents?.length || 0);
      
      const documents = data.documents.map(doc => ({
        id: doc.id,
        globalId: doc.globalId,
        name: doc.name
      }));
      
      const totalDocs = data.totalHits || documents.length;
      const totalPages = Math.ceil(totalDocs / pageSize);
      const hasMore = (pageNumber + 1) < totalPages;
      
      // Cache only the first unfiltered page
      if (pageNumber === 0 && !query) {
        documentsCache = {
          data: documents,
          timestamp: Date.now(),
          ttl: CONFIG.CACHE.DOCUMENTS_TTL_MS,
          totalPages: totalPages,
          pageSize: pageSize
        };
      }
      
      return { success: true, documents, hasMore };
    } catch (error) {
      logError('Get documents error:', error);
      
      if (error.message === 'Request timeout') {
        return { success: false, error: 'Request timeout', documents: [], hasMore: false };
      }
      return { success: false, error: 'Failed to load documents', documents: [], hasMore: false };
    } finally {
      activeRequests.delete(cacheKey);
    }
  })();
  
  activeRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

/**
 * Fetch fields for a document — used by the popup to determine if field selection is needed
 * @param {number} documentId
 * @returns {Promise<{success: boolean, isFormDoc: boolean, fields: Array, error?: string}>}
 */
async function getDocumentFields(documentId) {
  try {
    documentId = toValidId(documentId);
    if (documentId === null) {
      return { success: false, error: 'Invalid document id' };
    }
    const { serverUrl, accessToken } = await chrome.storage.session.get(['serverUrl', 'accessToken']);
    if (!serverUrl || !accessToken) {
      return { success: false, error: 'Not authenticated' };
    }

    const response = await fetchWithTimeout(`${serverUrl}/api/v1/documents/${documentId}`, {
      headers: { 'apiKey': accessToken }
    });

    if (!response.ok) {
      return { success: false, error: getHttpErrorMessage(response) };
    }

    const doc = await response.json();
    const fields = (doc.fields || []).map(f => ({
      id: f.id,
      name: f.name,
      type: f.type  // e.g. "TEXT", "STRING", "NUMBER", etc.
    }));

    return {
      success: true,
      isFormDoc: fields.length > 1,
      fields
    };
  } catch (error) {
    logError('getDocumentFields error:', error);
    if (error.message === 'Request timeout') {
      return { success: false, error: 'Request timeout' };
    }
    return { success: false, error: 'Failed to load document fields' };
  }
}

async function clipContent(request) {
  log('clipContent called');
  
  const cacheKey = 'clipContent';
  
  // Request deduplication
  if (activeRequests.has(cacheKey)) {
    log('Clip already in progress, returning existing request');
    return activeRequests.get(cacheKey);
  }
  
  const requestPromise = (async () => {
    try {
      const { serverUrl, accessToken } = await chrome.storage.session.get(['serverUrl', 'accessToken']);
      log('Got credentials for clip:', { serverUrl: serverUrl, hasToken: !!accessToken });
      
      if (!serverUrl || !accessToken) {
        return { success: false, error: 'Not authenticated. Please reconnect.' };
      }
      
      const target = await resolveTargetDocument(serverUrl, accessToken, request);
      if (!target.success) {
        return target;
      }
      const { documentId, globalId } = target;
      
      // Get current document content
      log('Fetching document content for ID:', documentId);
      
      const getUrl = `${serverUrl}/api/v1/documents/${documentId}`;
      log('GET from:', getUrl);
      
      const getResponse = await fetchWithTimeout(getUrl, {
        headers: {
          'apiKey': accessToken
        }
      });
      
      log('Get document response status:', getResponse.status);
      
      if (!getResponse.ok) {
        const errorText = await getResponse.text();
        logError('Failed to fetch document:', getResponse.status, errorText);
        
        // Improved HTTP status code handling
        if (getResponse.status === 404) {
          return { success: false, error: 'Document not found' };
        } else if (getResponse.status === 401) {
          return { success: false, error: 'Session expired' };
        } else if (getResponse.status === 403) {
          return { success: false, error: 'Access denied' };
        }
        
        return { success: false, error: 'Failed to access document' };
      }
      
      const doc = await getResponse.json();
      log('Fetched document:', doc.name, 'with', doc.fields?.length, 'fields');

      // Check if document has no fields at all
      if (!doc.fields || doc.fields.length === 0) {
        log('Document has no fields');
        return {
          success: false,
          error: 'Document has no editable fields.\n\nThis document cannot be edited. Please select a different document.'
        };
      }

      // Resolve which field to write to
      let targetField;
      if (request.targetField) {
        // Form document: use the field the user selected in the popup
        targetField = doc.fields.find(f => f.id === request.targetField.id);
        if (!targetField) {
          return { success: false, error: 'Selected field not found in document. Please re-select the document and try again.' };
        }
      } else if (doc.fields.length === 1) {
        // Simple document: use the only field
        targetField = doc.fields[0];
      } else {
        // Form document but no field was chosen — shouldn't happen when UI is correct
        return { success: false, error: 'This document has multiple fields. Please select a field to save to.' };
      }

      // Prepare clipped content with security sanitization
      const timestamp = formatTimestamp(new Date());
      const clippedHtml = formatClippedContent(request, timestamp);

      // Append to chosen field
      const currentContent = targetField.content || '';
      const updatedContent = currentContent + clippedHtml;

      log('Updating document with clipped content...');

      const updateUrl = `${serverUrl}/api/v1/documents/${documentId}`;
      log('PUT to:', updateUrl);

      const updateResponse = await fetchWithTimeout(updateUrl, {
        method: 'PUT',
        headers: {
          'apiKey': accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fields: [{
            id: targetField.id,
            content: updatedContent
          }]
        })
      });
      
      log('Update response status:', updateResponse.status);
      
      if (!updateResponse.ok) {
        const errorText = await updateResponse.text();
        logError('Failed to update document:', updateResponse.status, errorText);
        
        // Improved HTTP status code handling
        if (updateResponse.status === 401) {
          return { success: false, error: 'Session expired' };
        } else if (updateResponse.status === 403) {
          return { success: false, error: 'Access denied' };
        } else if (updateResponse.status === 429) {
          return { success: false, error: 'Too many requests' };
        } else if (updateResponse.status >= 500) {
          return { success: false, error: 'Server error' };
        }
        
        return { success: false, error: 'Failed to save clipped content' };
      }
      
      // Invalidate cache after successful clip
      resetDocumentsCache();
      
      log('Successfully clipped content!');
      return { success: true, documentId, globalId };
    } catch (error) {
      logError('Clip content error:', error);
      
      if (error.message === 'Request timeout') {
        return { success: false, error: 'Request timeout. Please try again.' };
      }
      return { success: false, error: 'An error occurred while clipping' };
    } finally {
      activeRequests.delete(cacheKey);
    }
  })();

  activeRequests.set(cacheKey, requestPromise);
  return rememberClipResult(requestPromise, 'Content saved successfully!');
}

/**
 * Store the outcome of a clip in session storage so the popup can show it if it was closed
 * while the clip was still running. The popup removes the entry once it has displayed it.
 */
async function rememberClipResult(resultPromise, successMessage) {
  const result = await resultPromise;
  try {
    await chrome.storage.session.set({
      lastClipResult: {
        success: !!result.success,
        message: result.success ? successMessage : (result.error || 'Failed to save'),
        documentId: result.documentId || null,
        globalId: result.globalId || null,
        at: Date.now()
      }
    });
  } catch (error) {
    logError('Could not store clip result:', error);
  }
  return result;
}

function formatTimestamp(date) {
  // Format: YYYY-MM-DD HH:mm:ss TZ
  // Example: 2026-01-08 14:35:22 GMT+1
  
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  
  // Get timezone offset in hours
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetMins = Math.abs(offsetMinutes) % 60;
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  
  // Format timezone as GMT+X or GMT+X:YY
  let timezone = `GMT${offsetSign}${offsetHours}`;
  if (offsetMins > 0) {
    timezone += `:${String(offsetMins).padStart(2, '0')}`;
  }
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${timezone}`;
}

function formatClippedContent(request, timestamp) {
  // Security: Escape all user-provided and external content
  const safeUrl = escapeHtml(request.sourceUrl);
  const safeTitle = escapeHtml(request.sourceTitle);
  const safeNote = request.note ? escapeHtml(request.note) : '';
  const safeTimestamp = escapeHtml(timestamp);
  
  let html = '<div style="border-left: 3px solid #4a90e2; padding-left: 12px; margin: 20px 0;">';
  html += `<p style="color: #666; font-size: 0.9em; margin: 0 0 8px 0;">`;
  html += `Clipped from <a href="${safeUrl}">${safeTitle}</a> on ${safeTimestamp}`;
  html += `</p>`;
  
  if (safeNote) {
    html += `<p style="background: #fffde7; padding: 8px; border-radius: 4px; margin: 8px 0;"><strong>Note:</strong> ${safeNote}</p>`;
  }
  
  // Security: The content.html has already been sanitized by cleanHtml() in content.js
  // But we add an extra layer of security here
  html += `<div>${sanitizeClippedHtml(request.content.html)}</div>`;
  html += '</div>';
  
  return html;
}

/**
 * Second sanitization layer, applied in the worker where no DOM parser is available.
 *
 * The real sanitizer is cleanHtml() in content.js, which works on a parsed DOM. This pass only
 * guards against something slipping through and it operates strictly inside tags, so text such
 * as "configuration_id=5" or a sentence mentioning "javascript:" is never altered. (An earlier
 * version ran the patterns over the whole string and mangled prose.)
 */
function sanitizeClippedHtml(html) {
  if (!html) return '';

  // Drop script blocks outright
  let cleaned = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');

  // Inside each tag: strip on* handlers and any URL attribute with a script scheme
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

/**
 * Clip PDF of current page to RSpace document
 */
async function clipPdf(request) {
  log('clipPdf called');

  const cacheKey = 'clipPdf';

  // Request deduplication
  if (activeRequests.has(cacheKey)) {
    log('PDF clip already in progress, returning existing request');
    return activeRequests.get(cacheKey);
  }

  const requestPromise = (async () => {
    try {
      const { serverUrl, accessToken } = await chrome.storage.session.get(['serverUrl', 'accessToken']);
      log('Got credentials for PDF clip:', { serverUrl: serverUrl, hasToken: !!accessToken });

      if (!serverUrl || !accessToken) {
        return { success: false, error: 'Not authenticated. Please reconnect.' };
      }

      // Step 1: Generate PDF from current tab
      log('Generating PDF from tab:', request.tabId);
      const pdfData = await generatePdfFromTab(request.tabId);

      if (!pdfData) {
        return { success: false, error: 'Failed to generate PDF from page' };
      }

      // Step 2: Determine target document
      const target = await resolveTargetDocument(serverUrl, accessToken, request);
      if (!target.success) {
        return target;
      }
      const { documentId, globalId } = target;

      // Step 3: Upload PDF as file to RSpace
      log('Uploading PDF file to RSpace...');
      const fileName = `${sanitizeFilename(request.sourceTitle || 'page')}.pdf`;
      const fileId = await uploadPdfToRSpace(serverUrl, accessToken, pdfData, fileName);

      if (!fileId) {
        return { success: false, error: 'Failed to upload PDF file' };
      }

      log('PDF uploaded with file ID:', fileId);

      // Step 4: Link the file to the document
      log('Linking PDF to document...');
      const linkSuccess = await linkFileToDocument(serverUrl, accessToken, documentId, fileId, request);

      if (!linkSuccess) {
        return { success: false, error: 'Failed to link PDF to document' };
      }

      // Invalidate cache after successful clip
      resetDocumentsCache();

      log('Successfully clipped PDF!');
      return { success: true, documentId, globalId };
    } catch (error) {
      logError('Clip PDF error:', error);

      if (error.message === 'Request timeout') {
        return { success: false, error: 'Request timeout. Please try again.' };
      }
      return { success: false, error: 'An error occurred while clipping PDF: ' + error.message };
    } finally {
      activeRequests.delete(cacheKey);
    }
  })();

  activeRequests.set(cacheKey, requestPromise);
  return rememberClipResult(requestPromise, 'PDF saved successfully!');
}

/**
 * Generate PDF from tab using Chrome's native capabilities
 * Note: Chrome extensions don't have direct access to chrome.tabs.printToPDF
 * This implementation uses a hybrid approach with content script libraries
 */
async function generatePdfFromTab(tabId) {
  try {
    log('Attempting to generate PDF from tab...');

    // Chrome extensions cannot directly use chrome.tabs.printToPDF
    // That API is only available to Chrome Apps (deprecated) and headless Chrome
    //
    // Instead, we use html2canvas + jsPDF injected on demand by the popup
    // before this message is sent, so they're available in the content script.
    log('Sending printPage message to content script...');
    const result = await chrome.tabs.sendMessage(tabId, { action: 'printPage' });

    log('Received response from content script:', result);

    if (result && result.pdfData) {
      log('PDF generated successfully via content script');
      return result.pdfData;
    }

    if (result && result.error) {
      logError('Content script returned error:', result.error);
      if (result.details) {
        logError('Error details:', result.details);
      }
      throw new Error(result.error);
    }

    // If we get here, PDF generation failed with no error message
    logError('Failed to generate PDF - no data or error returned from content script');
    throw new Error('PDF generation failed - please check browser console for details');
  } catch (error) {
    logError('Error generating PDF:', error);

    // Provide helpful error message
    if (error.message && error.message.includes('Could not establish connection')) {
      logError('Content script not responding - page may need refresh');
    }

    return null;
  }
}

/**
 * Upload PDF blob to RSpace files API
 */
async function uploadPdfToRSpace(serverUrl, accessToken, pdfDataUrl, fileName) {
  try {
    // Convert data URL to blob
    const response = await fetch(pdfDataUrl);
    const blob = await response.blob();

    // Create FormData for file upload
    const formData = new FormData();
    formData.append('file', blob, fileName);

    log('Uploading file to RSpace API...');
    const uploadUrl = `${serverUrl}/api/v1/files`;

    const uploadResponse = await fetchWithTimeout(uploadUrl, {
      method: 'POST',
      headers: {
        'apiKey': accessToken
      },
      body: formData
    }, CONFIG.API.UPLOAD_TIMEOUT_MS);

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      logError('File upload failed:', uploadResponse.status, errorText);
      return null;
    }

    const data = await uploadResponse.json();
    log('File uploaded successfully:', data);

    // Extract file ID (try direct id, then globalId, then _links.self)
    const fileId = data.id ||
                   data.globalId?.match(/GL(\d+)/)?.[1] ||
                   data._links?.self?.match(/\/files\/(\d+)/)?.[1];

    if (!fileId) {
      logError('Could not extract file ID from upload response:', data);
    } else {
      log('Extracted file ID:', fileId);
    }

    return fileId;
  } catch (error) {
    logError('Error uploading PDF:', error);
    if (error.message === 'Request timeout') {
      throw error; // let clipPdf report the timeout to the user
    }
    return null;
  }
}

/**
 * Link uploaded file to document by appending HTML reference
 */
async function linkFileToDocument(serverUrl, accessToken, documentId, fileId, request) {
  try {
    // Get current document content
    const getUrl = `${serverUrl}/api/v1/documents/${documentId}`;
    const getResponse = await fetchWithTimeout(getUrl, {
      headers: {
        'apiKey': accessToken
      }
    });

    if (!getResponse.ok) {
      logError('Failed to fetch document:', getResponse.status);
      return false;
    }

    const doc = await getResponse.json();

    if (!doc.fields || doc.fields.length === 0) {
      logError('Document has no fields');
      return false;
    }

    // Resolve which field to write to
    let targetField;
    if (request.targetField) {
      targetField = doc.fields.find(f => f.id === request.targetField.id);
      if (!targetField) {
        logError('Selected field not found in document');
        return false;
      }
    } else if (doc.fields.length === 1) {
      targetField = doc.fields[0];
    } else {
      logError('Form document - no field selected for PDF clip');
      return false;
    }

    // Prepare PDF reference content
    const timestamp = formatTimestamp(new Date());
    const safeUrl = escapeHtml(request.sourceUrl);
    const safeTitle = escapeHtml(request.sourceTitle);
    const safeNote = request.note ? escapeHtml(request.note) : '';
    const safeTimestamp = escapeHtml(timestamp);

    // Add file using RSpace's special syntax for file linking
    // RSpace will automatically convert <fileId=X> to the proper attachment HTML
    log(`Linking file using RSpace API syntax: <fileId=${fileId}>`);

    const html = `
      <div style="border-left: 3px solid #4a90e2; padding-left: 12px; margin: 20px 0;">
        <p style="color: #666; font-size: 0.9em; margin: 0 0 8px 0;">
          PDF clipped from <a href="${safeUrl}">${safeTitle}</a> on ${safeTimestamp}
        </p>
        ${safeNote ? `
        <p style="background: #fffde7; padding: 8px; border-radius: 4px; margin: 8px 0;">
          <strong>Note:</strong> ${safeNote}
        </p>
        ` : ''}
        <p><fileId=${fileId}></p>
      </div>
    `.trim();

    // Append to chosen field
    const currentContent = targetField.content || '';
    const updatedContent = currentContent + html;

    // Update document
    const updateUrl = `${serverUrl}/api/v1/documents/${documentId}`;
    const updateResponse = await fetchWithTimeout(updateUrl, {
      method: 'PUT',
      headers: {
        'apiKey': accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: [{
          id: targetField.id,
          content: updatedContent
        }]
      })
    });

    if (!updateResponse.ok) {
      logError('Failed to update document:', updateResponse.status);
      return false;
    }

    log('Document updated with PDF reference');
    return true;
  } catch (error) {
    logError('Error linking file to document:', error);
    return false;
  }
}

/**
 * Sanitize filename for safe file upload
 */
function sanitizeFilename(filename) {
  return filename
    .replace(/[^a-zA-Z0-9_\-\.]/g, '_')
    .substring(0, 100);
}

/**
 * Fetch with timeout wrapper
 */
async function fetchWithTimeout(url, options = {}, timeout = CONFIG.API.REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}
