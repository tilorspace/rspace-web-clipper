// Background service worker for RSpace Web Clipper
// Handles authentication, API calls, and content saving

// Load configuration
importScripts('config.js');

// Security: Disable all logging in production
const DEBUG = false;
const log = DEBUG ? console.log : () => {};
const logError = DEBUG ? console.error : () => {};

// Document cache with TTL
let documentsCache = {
  data: null,
  timestamp: null,
  ttl: 5 * 60 * 1000, // 5 minutes
  totalPages: null,
  pageSize: CONFIG.API.DEFAULT_PAGE_SIZE
};

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
    getDocuments(request.pageNumber || 0).then(sendResponse);
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
});

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
    documentsCache = {
      data: null,
      timestamp: null,
      ttl: 5 * 60 * 1000,
      totalPages: null,
      pageSize: CONFIG.API.DEFAULT_PAGE_SIZE
    };
    
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

async function getDocuments(pageNumber = 0) {
  log('getDocuments called for page:', pageNumber);
  
  const cacheKey = `documents_${pageNumber}`;
  
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
      
      // Check cache only for first page
      if (pageNumber === 0) {
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
      const fetchUrl = `${serverUrl}/api/v1/documents?pageSize=${pageSize}&pageNumber=${pageNumber}&orderBy=lastModified desc`;
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
      
      // Cache only first page
      if (pageNumber === 0) {
        documentsCache = {
          data: documents,
          timestamp: Date.now(),
          ttl: 5 * 60 * 1000,
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
      
      let documentId;
      let globalId;

      if (request.targetDoc.isNew) {
        const result = await createDocument(serverUrl, accessToken, request.targetDoc.title);
        if (!result.success) {
          return result;
        }
        documentId = result.documentId;
        globalId = result.globalId;
      } else {
        documentId = request.targetDoc.id;
        globalId = request.targetDoc.globalId;
        log('Using existing document ID:', documentId);
      }
      
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
      
      // Check if document has multiple fields (Form-based documents)
      if (doc.fields && doc.fields.length > 1) {
        log('Document has multiple fields - cannot append to Form-based documents');
        return { 
          success: false, 
          error: 'Cannot clip to Form-based documents.\n\nThis document has multiple form fields. The Web Clipper can only save to simple documents with one field.\n\nPlease select or create a regular document instead.' 
        };
      }
      
      // Check if document has no fields at all
      if (!doc.fields || doc.fields.length === 0) {
        log('Document has no fields');
        return { 
          success: false, 
          error: 'Document has no editable fields.\n\nThis document cannot be edited. Please select a different document.' 
        };
      }
      
      // Prepare clipped content with security sanitization
      const timestamp = formatTimestamp(new Date());
      const clippedHtml = formatClippedContent(request, timestamp);
      
      // Append to document
      const currentContent = doc.fields[0]?.content || '';
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
            id: doc.fields[0].id,
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
      documentsCache = {
        data: null,
        timestamp: null,
        ttl: 5 * 60 * 1000,
        totalPages: null,
        pageSize: CONFIG.API.DEFAULT_PAGE_SIZE
      };
      
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
  return requestPromise;
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

function sanitizeClippedHtml(html) {
  // Additional security layer: ensure no dangerous patterns made it through
  if (!html) return '';
  
  // Remove any remaining script tags or event handlers that might have slipped through
  let cleaned = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/on\w+\s*=\s*[^\s>]*/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/vbscript:/gi, '');
  
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
      let documentId;
      let globalId;

      if (request.targetDoc.isNew) {
        const result = await createDocument(serverUrl, accessToken, request.targetDoc.title);
        if (!result.success) {
          return result;
        }
        documentId = result.documentId;
        globalId = result.globalId;
      } else {
        documentId = request.targetDoc.id;
        globalId = request.targetDoc.globalId;
        log('Using existing document ID:', documentId);
      }

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
      documentsCache = {
        data: null,
        timestamp: null,
        ttl: 5 * 60 * 1000,
        totalPages: null,
        pageSize: CONFIG.API.DEFAULT_PAGE_SIZE
      };

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
  return requestPromise;
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
    // Instead, we use html2canvas + jsPDF libraries via content script
    // Libraries are bundled and loaded via manifest.json content_scripts

    // Content script is already loaded via manifest.json, just send message
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

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'apiKey': accessToken
      },
      body: formData
    });

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

    // Check if document has multiple fields (Form-based documents)
    if (doc.fields && doc.fields.length > 1) {
      logError('Document has multiple fields - cannot append to Form-based documents');
      return false;
    }

    if (!doc.fields || doc.fields.length === 0) {
      logError('Document has no fields');
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

    // Append to document
    const currentContent = doc.fields[0]?.content || '';
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
          id: doc.fields[0].id,
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
async function fetchWithTimeout(url, options = {}, timeout = CONFIG.API.TIMEOUT_MS || 30000) {
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
