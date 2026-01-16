// Content script - runs on web pages to extract content

// Security: Disable all logging in production
const DEBUG = false;
const log = DEBUG ? console.log : () => {};
const logError = DEBUG ? console.error : () => {};

// Define valid content types for validation
const VALID_CONTENT_TYPES = ['selection', 'full-page', 'url-only'];

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  log('Content script received message:', request);
  
  // Respond to ping to confirm content script is loaded
  if (request.action === 'ping') {
    sendResponse({ status: 'ready' });
    return true;
  }
  
  if (request.action === 'getContent') {
    try {
      // Validate contentType before processing
      if (!request.contentType || !VALID_CONTENT_TYPES.includes(request.contentType)) {
        logError('Invalid content type:', request.contentType);
        sendResponse(null);
        return true;
      }
      
      const content = extractContent(request.contentType);
      log('Extracted content:', content);
      sendResponse(content);
    } catch (error) {
      logError('Error extracting content:', error);
      sendResponse(null);
    }
  }
  return true;
});

/**
 * Extract content based on the specified type
 * @param {('selection'|'full-page'|'url-only')} contentType - Type of content to extract
 * @returns {{html: string, text: string}|null} Extracted content or null
 */
function extractContent(contentType) {
  switch (contentType) {
    case 'selection':
      return getSelectedContent();
    case 'full-page':
      return getFullPageContent();
    case 'url-only':
      return getUrlOnly();
    default:
      // Fallback to selection (should not reach here due to validation)
      return getSelectedContent();
  }
}

/**
 * Get currently selected content from the page
 * @returns {{html: string, text: string}|null}
 */
function getSelectedContent() {
  const selection = window.getSelection();
  
  if (!selection || selection.toString().trim() === '') {
    return null;
  }
  
  const range = selection.getRangeAt(0);
  const container = document.createElement('div');
  container.appendChild(range.cloneContents());
  
  return {
    html: cleanHtml(container.innerHTML),
    text: selection.toString()
  };
}

/**
 * Get full page content, attempting to find the main content area
 * @returns {{html: string, text: string}}
 */
function getFullPageContent() {
  // Try to find main content area
  const mainContent = 
    document.querySelector('main') ||
    document.querySelector('article') ||
    document.querySelector('[role="main"]') ||
    document.querySelector('.content') ||
    document.querySelector('#content') ||
    document.body;
  
  const clone = mainContent.cloneNode(true);
  
  // Remove script, style, and navigation elements
  ['script', 'style', 'nav', 'header', 'footer', 'iframe'].forEach(tag => {
    clone.querySelectorAll(tag).forEach(el => el.remove());
  });
  
  return {
    html: cleanHtml(clone.innerHTML),
    text: clone.textContent.trim()
  };
}

/**
 * Get only the URL and title of the current page
 * @returns {{html: string, text: string}}
 */
function getUrlOnly() {
  // Security: Escape URL and title to prevent XSS
  return {
    html: `<p>Page: <a href="${escapeHtml(window.location.href)}">${escapeHtml(document.title)}</a></p>`,
    text: `${document.title}: ${window.location.href}`
  };
}

/**
 * Clean and sanitize HTML content
 * @param {string} html - Raw HTML to clean
 * @returns {string} Cleaned HTML
 */
function cleanHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  
  // Security: Remove ALL potentially dangerous elements
  const dangerousTags = [
    'script', 'style', 'iframe', 'object', 'embed', 
    'link', 'meta', 'base', 'form', 'input', 'button',
    'textarea', 'select', 'applet', 'audio', 'video'
  ];
  dangerousTags.forEach(tag => {
    div.querySelectorAll(tag).forEach(el => el.remove());
  });
  
  // Security: Sanitize all remaining elements
  const elements = div.querySelectorAll('*');
  elements.forEach(el => {
    // Whitelist ONLY truly safe attributes
    const safeAttrs = ['href', 'src', 'alt', 'title'];
    Array.from(el.attributes).forEach(attr => {
      // Remove all event handlers (onclick, onload, etc.)
      if (attr.name.startsWith('on') || !safeAttrs.includes(attr.name)) {
        el.removeAttribute(attr.name);
      }
    });
    
    // Security: Sanitize href to prevent javascript: URLs
    if (el.hasAttribute('href')) {
      const href = el.getAttribute('href');
      const lowerHref = href.toLowerCase().trim();
      
      // Block dangerous protocols
      if (lowerHref.startsWith('javascript:') || 
          lowerHref.startsWith('data:') ||
          lowerHref.startsWith('vbscript:') ||
          lowerHref.startsWith('file:')) {
        el.removeAttribute('href');
      } else if (!href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('#')) {
        // Convert relative URLs to absolute
        try {
          el.setAttribute('href', new URL(href, window.location.href).href);
        } catch {
          el.removeAttribute('href');
        }
      }
    }
    
    // Security: Sanitize src for images
    if (el.hasAttribute('src')) {
      const src = el.getAttribute('src');
      const lowerSrc = src.toLowerCase().trim();
      
      // Only allow http(s) URLs and data: image URLs
      if (lowerSrc.startsWith('http://') || lowerSrc.startsWith('https://')) {
        // Keep as is
      } else if (lowerSrc.startsWith('data:image/')) {
        // Allow data URIs for images only
      } else {
        // Try to convert relative URL to absolute
        try {
          el.setAttribute('src', new URL(src, window.location.href).href);
        } catch {
          el.removeAttribute('src');
        }
      }
    }
  });
  
  // Remove empty elements (except images)
  div.querySelectorAll('*').forEach(el => {
    if (el.textContent.trim() === '' && !el.querySelector('img') && el.tagName !== 'IMG') {
      el.remove();
    }
  });
  
  return div.innerHTML;
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
