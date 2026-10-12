// Configuration constants for RSpace Web Clipper.
// Loaded by popup.html before popup.js and imported by background.js (importScripts).
// content.js is injected on its own and carries its own copy of the logging switch.

// Logging is off in release builds; flip DEBUG to see errors in the worker and popup consoles.
const DEBUG = false;
const logError = DEBUG ? console.error : () => {};

const CONFIG = {
  API: {
    DEFAULT_PAGE_SIZE: 50,
    REQUEST_TIMEOUT_MS: 30000, // 30 seconds for JSON API calls
    UPLOAD_TIMEOUT_MS: 120000, // 2 minutes for the PDF file upload
  },

  UI: {
    ERROR_DISPLAY_MS: 5000,
    SUCCESS_DISPLAY_MS: 3000,
    SEARCH_DEBOUNCE_MS: 300,
  },

  LIMITS: {
    MAX_DOC_TITLE_LENGTH: 255,
    MAX_NOTE_LENGTH: 10000,
    MAX_SERVER_URL_LENGTH: 500,
  },

  // Persistent storage (chrome.storage.local)
  STORAGE: {
    API_KEY_EXPIRY_DAYS: 7, // how long an opted-in "remember API key" stays valid
  }
};
