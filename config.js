// Configuration constants for RSpace Web Clipper
// This file is loaded before other scripts via manifest.json

const CONFIG = {
  // API Configuration
  API: {
    DEFAULT_PAGE_SIZE: 50,
    MAX_DOCUMENTS_DISPLAY: 5,
    REQUEST_TIMEOUT_MS: 30000, // 30 seconds for JSON API calls
    UPLOAD_TIMEOUT_MS: 120000, // 2 minutes for the PDF file upload
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
  },

  // Persistent storage (chrome.storage.local)
  STORAGE: {
    API_KEY_EXPIRY_DAYS: 7, // how long an opted-in "remember API key" stays valid
  }
};
