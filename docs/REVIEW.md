# Code review of the 0.2.0 stack

Status: implemented on `refactor/review`. Every defect in section 1 has a regression check in
the e2e scripts; all simplifications in section 2 are applied except (k), where the small
worker-side sanitizer was kept.

Scope: everything between `main` and `docs/readme` (WP1 to WP10), plus the exploratory
Playwright session in `scripts/e2e/explore.js`. Goal as asked: more robust, less complex, less code.

Totals today: popup.js 1437 lines, background.js 958, content.js 366, e2e harness 447 + 487.
The proposals below remove roughly 500 lines from the extension and 130 from the tooling while
fixing the five defects the exploratory run surfaced.

## 1. Defects found by exploratory testing

These are ordered by user impact. Four of the five share one root cause: selection state in
the popup is mutated from six different places and never from a single function.

1. **A second Save after creating a document creates a duplicate.** After a clip creates a new
   document, `selectedDocument` stays null. The name is still in the search box, so the next
   Save sends `isNew: true` again. The Wikipedia scenario produced three documents with the
   same name; only the last held the PDF. Users who clip twice into "Notes" get two "Notes".
   Fix: after a successful clip, select the document the worker returned (id, globalId, name).
2. **Typing in the search box silently drops the Form field choice.** `handleDocumentSearch`
   resets `currentDocFields` and `selectedField` on every input event, and the exact match that
   follows sets `selectedDocument` without loading fields. Save then fails with "This document
   has multiple fields. Please select a field" and there is no selector on screen to use.
   Fix: every path that sets `selectedDocument` must load its fields (one function, see 2a).
3. **Case-insensitive match, case-sensitive save.** The search treats "notes" and "Notes" as the
   same document and highlights it, but `handleClip` compares `selectedDocument.name === docName`
   strictly and creates a second document. Scenario B7. Fix: compare ids, not names, which the
   single selection function makes natural.
4. **A revoked or expired key does not send the user back to the auth screen.** With a bad key,
   the clip error shows the server's raw text ("API key invalid - must match regexp:...") and a
   reopened popup stays on the clipper screen with the cached document list. Only the literal
   string "Not authenticated" triggers the auth screen. Fix: map every 401 in the worker to one
   outcome (clear session, return `{ error: 'Not authenticated' }`) and have the popup react to
   that in one place.
5. **The popup ignores input until the document list has loaded.** `setupEventListeners` runs
   after `await checkAuthStatus()`, which awaits the first list fetch. On a slow server the
   search box and buttons are dead for seconds, and the harness needed polling workarounds in
   three places because of it. Fix: attach listeners first.

Observations that are not defects: the data-URI image and HTML in a document name are stored
and rendered safely (B1, B2, C2 to C5); triple clicking Save appends once (D1); infinite scroll
reached all 296 documents without duplicates (E1, E2); Wikipedia and a JavaScript-heavy docs
page clip in all modes, with PDFs of 3 pages each (F); an unreachable server fails in about a
second (I1). `chrome://` pages could not be opened in headless Chromium, so G1 is untested.

## 2. Simplifications, by file

### popup.js (1437 lines, target about 1150)

a. **One selection function.** Replace the six places that touch `selectedDocument`,
   `selectedField` and `currentDocFields` (click, keyboard, Enter handler, `applySearchFilter`,
   `handleDocumentSearch`, the two clip handlers) with `setSelectedDocument(doc | null)`. It
   highlights the list item, writes the name into the box, hides the create hint, and loads the
   fields when a document is given. Clip handlers read `selectedDocument` only. This fixes
   defects 1, 2 and 3 and deletes the `selectedDocument.name === docName` comparison.

b. **Merge `handleClip` and `handlePdfClip`.** They are the same 110 lines with two
   differences: the message action and whether the PDF libraries are injected. One `handleSave()`
   builds `{ action, targetDoc, targetField, note, sourceUrl, sourceTitle, tabId, content? }`
   and the eight copies of "show clipper screen, show error, reset button" become one
   `failSave(message)`. The `finally` block already resets the button, so the resets inside each
   early return are dead code. Net about 120 lines removed.

c. **Delete `setupServerUrlProtection`.** 40 lines of input and focus listeners exist to keep
   `https://` in the box. Normalising once in `handleConnect` does the same with one line:
   `if (!/^https?:\/\//i.test(url)) url = 'https://' + url`. The default value in popup.html
   can stay as a hint.

d. **`handleDocumentSearch` and the Enter handler duplicate the matching logic.** Keep one
   `findMatch(query)` returning `{ exact, single }` and use it from both. With (a), the server
   search response no longer re-renders over a selection the user made meanwhile, because it
   only calls `setSelectedDocument` when there was no selection.

e. **Remove dead code**: `showSuccess`, `MAX_DOCUMENTS_DISPLAY`, the `migrateSessionToLocal`
   one-time migration (0.1 never shipped to users), and the duplicated "pre-fill credentials"
   block that appears in both `checkAuthStatus` and `handleSettings` (extract `fillAuthForm()`).

### background.js (958 lines, target about 780)

f. **Drop the document cache.** The popup requests the list once per open, so the cache saves
   nothing and caused two of the stale-list observations (a document created outside the popup
   is invisible for five minutes; a revoked key still shows the old list). Removing
   `documentsCache`, `emptyDocumentsCache`, `resetDocumentsCache`, the TTL config and the four
   reset calls is about 50 lines and one class of bug. The read deduplication in
   `activeRequests` goes with it; keep a single `clipInFlight` promise for the two clip actions,
   which is what D1 actually relies on.

g. **One `appendToField()`.** `clipContent` and `linkFileToDocument` both GET the document,
   resolve the target field, append HTML and PUT. The two copies differ only in the HTML they
   append. Likewise `formatClippedContent` and the inline template in `linkFileToDocument`
   build the same header; one `clipHeader(request, label)` serves both. About 100 lines.

h. **Use `getHttpErrorMessage` everywhere.** `clipContent` re-implements the 401/403/429/500
   ladder inline twice. Related to defect 4: map 401 in one place (`fetchApi` wrapper that
   clears the session and throws `NotAuthenticated`) instead of in each caller.

i. **Stop passing server error text to the UI.** `createDocument` surfaces `errorJson.message`,
   which is how "must match regexp" reached the user. Use the mapped message; log the server
   text.

j. **`toValidId`** can be `Number.isInteger(v) && v > 0`; the popup never sends strings.

k. **Second sanitizer layer.** `sanitizeClippedHtml` is 20 lines of regex over HTML. The only
   producer is content.js in the isolated world, so it is defence in depth rather than a
   boundary. It is small and unit tested, so keeping it is defensible; deleting it is the
   simpler choice. Either way, do not extend it.

### content.js (366 lines)

l. Fine as it is after WP3 and WP8. Two small items: `pages` in the printPage response is
   unused by the worker, and the `VALID_CONTENT_TYPES` check duplicates the `switch` default.

### config.js

m. Three files each define `DEBUG`, `log`, `logError`. The worker and popup both load
   config.js, so the definitions can live there; content.js keeps its own copy because it is
   injected alone.

### Tooling and tests

n. **Share the e2e helpers.** `run.js` and `explore.js` duplicate about 130 lines (test
   server, extension build, `openPopup`, `waitForStatus`, `clip`, API calls, cleanup). Move them
   to `scripts/e2e/lib.js`. The `popupRef` indirection in run.js disappears if scenarios are
   functions that receive the popup they need.

o. **Add `node scripts/test-content-script.js` to `npm test`** (was deferred while WP3 sat
   on its own branch; it is merged now).

p. **Add a regression scenario for defect 1** to run.js: clip to a new name, then Save again
   without touching the search box, then assert one document with two clips.

q. The manifest check, copy-libs, and background unit test are proportionate; no change.

## 3. Robustness notes outside the defects

- Map `fetch` network failures (`TypeError`) to "Could not reach the RSpace server" instead of
  the generic "An error occurred while clipping" seen in I1.
- `rememberClipResult` writes session storage on every clip and the popup removes the entry in
  two places. It works (verified) and is cheap; leave it.
- The GET/PUT append is still a lost-update window on concurrent edits in RSpace. Documented;
  nothing cheap fixes it without an API change.
- The e2e harness patches `host_permissions` into the loaded extension. The one thing it
  therefore cannot prove is that `activeTab` alone supplies the tab URL after dropping `tabs`.
  One manual clip in a normal Chrome profile before the store submission closes that gap.

## Suggested order

1. Defects 1 to 5 together with items a, b, d (they are the same change set in popup.js).
2. Items f, g, h, i in background.js, with the regression scenario (p) and the lib refactor (n).
3. The remaining small deletions (c, e, j, l, m, o).

Run `npm test`, the content-script test and both e2e scripts after each step; the exploratory
script should keep reporting 0 failures and the run.js harness 51 plus the new scenario.
