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
    return true;
  }

  if (request.action === 'printPage') {
    log('Content script received printPage message');

    // Libraries are already loaded via manifest.json, just generate PDF
    printPageToPdf().then(result => {
      log('Sending PDF result back to background script');
      sendResponse(result);
    }).catch(error => {
      console.error('Error in printPageToPdf:', error);
      sendResponse({ success: false, error: error.message });
    });

    return true; // Keep message channel open for async response
  }

  return false; // No handler matched
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

// PDF generation configuration
const PDF_CONFIG = {
  // Canvas rendering settings
  CANVAS_SCALE: 1,                    // Scale factor for canvas rendering (1 = original size)
  JPEG_QUALITY: 0.8,                  // JPEG compression quality (0.0 - 1.0)
  USE_CORS: true,                     // Allow cross-origin images
  ALLOW_TAINT: false,                 // Security: don't allow tainted canvas
  BACKGROUND_COLOR: '#ffffff',        // Default white background

  // PDF document settings
  ORIENTATION: 'portrait',            // Page orientation (portrait/landscape)
  UNIT: 'mm',                         // Measurement units
  FORMAT: 'a4',                       // Paper format

  // Layout settings
  MARGIN_MM: 10,                      // Page margins in millimeters
};

/**
 * Generate PDF from current page using html2canvas and jsPDF
 * @returns {Promise<{pdfData: string}>} Promise resolving to PDF data as data URL
 */
async function printPageToPdf() {
  log('printPageToPdf: Starting PDF generation...');

  try {
    // Libraries are now bundled, so they should be available immediately
    if (typeof html2canvas === 'undefined') {
      throw new Error('html2canvas library not available. Make sure html2canvas.min.js is loaded before content.js in manifest.json');
    }
    if (typeof jspdf === 'undefined') {
      throw new Error('jsPDF library not available. Make sure jspdf.umd.min.js is loaded before content.js in manifest.json');
    }

    log('Libraries confirmed available');
    log('Capturing page with html2canvas...');
    const canvas = await html2canvas(document.body, {
      scale: PDF_CONFIG.CANVAS_SCALE,
      useCORS: PDF_CONFIG.USE_CORS,
      logging: DEBUG,
      windowWidth: document.documentElement.scrollWidth,
      windowHeight: document.documentElement.scrollHeight,
      allowTaint: PDF_CONFIG.ALLOW_TAINT,
      backgroundColor: PDF_CONFIG.BACKGROUND_COLOR
    });

    log(`Canvas captured: ${canvas.width}x${canvas.height}px`);

    const imgData = canvas.toDataURL('image/jpeg', PDF_CONFIG.JPEG_QUALITY);
    log(`Image data created, size: ${Math.round(imgData.length / 1024)} KB`);
    const pdf = new jspdf.jsPDF({
      orientation: PDF_CONFIG.ORIENTATION,
      unit: PDF_CONFIG.UNIT,
      format: PDF_CONFIG.FORMAT
    });

    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();
    const marginDouble = PDF_CONFIG.MARGIN_MM * 2;
    const imgWidth = pdfWidth - marginDouble;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    let heightLeft = imgHeight;
    let position = PDF_CONFIG.MARGIN_MM;

    pdf.addImage(imgData, 'JPEG', PDF_CONFIG.MARGIN_MM, position, imgWidth, imgHeight);
    heightLeft -= (pdfHeight - marginDouble);

    while (heightLeft > 0) {
      position = heightLeft - imgHeight + PDF_CONFIG.MARGIN_MM;
      pdf.addPage();
      pdf.addImage(imgData, 'JPEG', PDF_CONFIG.MARGIN_MM, position, imgWidth, imgHeight);
      heightLeft -= (pdfHeight - marginDouble);
    }

    const pdfData = pdf.output('dataurlstring');
    log(`PDF generated successfully, size: ${Math.round(pdfData.length / 1024)} KB`);

    return {
      pdfData: pdfData,
      success: true
    };

  } catch (error) {
    console.error('PDF generation failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}
