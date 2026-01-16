// Configuration constants for RSpace Web Clipper
// This file is loaded before other scripts via manifest.json

const CONFIG = {
  // API Configuration
  API: {
    DEFAULT_PAGE_SIZE: 50,
    MAX_DOCUMENTS_DISPLAY: 5,
    REQUEST_TIMEOUT_MS: 30000, // 30 seconds
  },
  
  // UI Configuration
  UI: {
    ERROR_DISPLAY_MS: 5000,   // 5 seconds
    SUCCESS_DISPLAY_MS: 3000, // 3 seconds
    SEARCH_DEBOUNCE_MS: 300,  // 300ms
  },
  
  // Input Validation Limits
  LIMITS: {
    MAX_DOC_TITLE_LENGTH: 255,
    MAX_NOTE_LENGTH: 10000,
    MAX_SERVER_URL_LENGTH: 500,
  },
  
  // Cache Configuration
  CACHE: {
    DOCUMENTS_TTL_MS: 5 * 60 * 1000, // 5 minutes
  }
};

// User-friendly error messages
const ERROR_MESSAGES = {
  'Not authenticated': 'Your session has expired. Please reconnect to RSpace.',
  'Authentication failed': 'Unable to verify your credentials. Please check your API key.',
  'Request timeout': 'The request took too long. Please check your connection and try again.',
  'Failed to create document': 'Unable to create document. Please check your permissions.',
  'Failed to save clipped content': 'Unable to save content. Please try again.',
  'Failed to fetch documents': 'Unable to load your documents. Please try again.',
  'Connection error': 'Unable to connect to RSpace. Please verify the server URL.',
  'Network error': 'Network error. Please check your internet connection.',
  'Invalid server URL': 'Please enter a valid RSpace server URL (e.g., https://your-server.com)',
  'Invalid API key': 'Please enter a valid API key from your RSpace profile.',
};

// Get user-friendly error message
function getUserFriendlyError(technicalError) {
  if (!technicalError) return 'An unexpected error occurred';
  
  const errorStr = typeof technicalError === 'string' 
    ? technicalError 
    : technicalError.message || technicalError.error || String(technicalError);
  
  // Check for known error patterns
  for (const [pattern, message] of Object.entries(ERROR_MESSAGES)) {
    if (errorStr.includes(pattern)) {
      return message;
    }
  }
  
  // Return generic message if no match found
  return 'An error occurred. Please try again.';
}

// Fetch with timeout wrapper
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
