# Hardening plan for RSpace Web Clipper

Each work package (WP) is a separate branch and pull request, tested in isolation before merge.
Manual test checklists below are superseded by the Playwright harness in `scripts/e2e/run.js`
where it covers the scenario; extend the harness rather than testing by hand.
Order matters only where noted. Baseline for every manual test: load the unpacked extension in Chrome,
connect to a test RSpace server (community or a local instance), and keep the service worker console
open via `chrome://extensions` > "service worker".

Common manual smoke test, run at the end of every WP:

1. Connect with a valid API key. Document list loads.
2. Selection clip into an existing simple document. Content and source link appear in RSpace.
3. Full Page clip into a new document. Document is created, tagged `web-clipper`.
4. URL Only clip into a Form based document, choosing a TEXT field.
5. PDF clip of the same page. PDF is attached and linked in the chosen field.
6. Settings > Clear Saved Data. Popup returns to the auth screen and the list is empty on reconnect.

---

## WP1: Tooling baseline (do first)

Status: done on `chore/tooling` (web-ext lint replaced by scripts/check-manifest.js, see commit).

Branch: `chore/tooling`

Scope:
- Add `package.json` with `jspdf` and `html2canvas` as dependencies (pin exact versions) and a
  `copy-libs` script that copies the UMD builds into the repo root.
- Add `.nvmrc` or an `engines` field.
- Add a GitHub Action that runs `npm ci`, `npm audit --audit-level=high`, and `npx web-ext lint`
  against the extension folder.
- Add a short "Development" section to the README explaining how to refresh the libraries.

Test:
- `npm run copy-libs` produces byte-identical files to the committed ones for the current versions.
- CI is green on the PR.
- `web-ext lint` reports no errors (warnings are acceptable, note them in the PR).

---

## WP2: Upgrade jsPDF to 4.2.1

Status: done on `deps/jspdf-4`, includes the Playwright e2e harness (scripts/e2e/run.js).

Branch: `deps/jspdf-4`
Depends on: WP1

Scope:
- Bump `jspdf` to `4.2.1` in `package.json`, run `copy-libs`, commit the new `jspdf.umd.min.js`.
- Check that the global is still exposed as `jspdf.jsPDF` (the UMD name did not change in 4.x,
  verify in the new file header).
- No code changes expected in `content.js`.

Test:
- PDF clip on a short page (one PDF page), a page of about five screens, and an image heavy page.
- Open each PDF from RSpace, confirm page count, margins and that the image is not stretched.
- `npm audit` reports no jsPDF advisories.
- Confirm html2canvas 1.4.1 is unchanged and still the latest on npm (`npm view html2canvas version`).

---

## WP3: Fix content script re-injection

Status: done on `fix/reinjection` (branched from main), verified by the e2e harness on a merge.

Branch: `fix/reinjection`

Severity note (from the e2e run): Chrome logs `Identifier 'DEBUG' has already been declared` in
the page but does not reject the injection, and the libraries load before content.js, so the PDF
clip still succeeds today. The fix removes the error and the dependence on that ordering.

Scope:
- `content.js`: wrap the whole file in a guard so a second injection is a no-op, for example
  `if (!window.__rspaceClipperLoaded) { window.__rspaceClipperLoaded = true; ... }`, or convert
  top level `const` to `var` plus a listener guard.
- `content.js` ping handler: respond with
  `{ status: 'ready', pdfLibs: typeof html2canvas !== 'undefined' && typeof jspdf !== 'undefined' }`.
- `popup.js` `ensureContentScriptInjected`: inject `content.js` only when ping fails; inject the two
  library files only when the ping reports `pdfLibs: false`. Never re-inject `content.js`.

Test:
- Fresh tab: Selection clip, then PDF clip, then Selection clip again, all in the same tab without
  reloading. All three succeed.
- Fresh tab: PDF clip first, then Selection clip. Both succeed.
- Reload the page between clips. Still works.
- Service worker console shows a single response per message (no duplicate listener).
- Inject manually twice from the console via `chrome.scripting.executeScript` and confirm no
  "already been declared" error.

---

## WP4: Permissions and manifest cleanup

Status: done on `chore/permissions` (stacked on deps/jspdf-4).

Branch: `chore/permissions`

Scope:
- Remove `tabs` from `permissions` in `manifest.json`. `activeTab`, `scripting` and `storage` remain.
- Bump `version` to `0.2.0`.
- Add a privacy note to the README: what is sent to the RSpace server and that nothing is sent anywhere else.

Test:
- Remove and re-add the unpacked extension. The install prompt no longer mentions browsing history.
- `tab.url` and `tab.title` are still populated in `handleClip` (they are, via `activeTab`, once the
  popup is opened on that tab). Verify the source link in a clipped document.
- Full smoke test.

---

## WP5: Credential handling

Status: done on `fix/credentials` (stacked on chore/permissions).

Branch: `fix/credentials`

Scope:
- `popup.js` `handleConnect`: move the `savedApiKey` write into the `response.success` branch.
  Keep the "forget" path (remove on unchecked) where it is.
- `background.js`: add a `logout` message handler that clears `documentsCache` and `activeRequests`.
- `popup.js` `handleClearSavedData`: no longer treat a missing handler as acceptable.
- Decide on the remember duration. Suggested: keep seven days but make it a `CONFIG` value.
- `popup.js` `setupServerUrlProtection` re-applies `https://` on every input event, so the
  `http://localhost` and `http://127.0.0.1` URLs that `handleConnect` explicitly allows cannot be
  typed. Relax the protection to allow those two hosts (found by the e2e harness).

Test:
- Enter a wrong API key with "remember" checked. Auth fails. Inspect `chrome.storage.local` from the
  service worker console: no `savedApiKey` present.
- Enter a correct key with "remember" checked. Auth succeeds. `savedApiKey` and `apiKeyExpiresAt` present.
- Set `apiKeyExpiresAt` to a past timestamp manually, reopen the popup. Key field is empty and the
  storage key is gone.
- Connect, load documents, click Clear Saved Data, connect again as a different user. The first
  user's document list is not shown from cache.

---

## WP6: Service worker robustness

Status: done on `fix/worker-robustness` (stacked on fix/credentials), with scripts/test-background.js unit tests.

Branch: `fix/worker-robustness`

Scope:
- `background.js` `fetchWithTimeout`: use `CONFIG.API.REQUEST_TIMEOUT_MS` (the current key name is
  wrong and silently falls back to 30 s).
- Use `fetchWithTimeout` for the file upload, with a longer dedicated timeout (`CONFIG.API.UPLOAD_TIMEOUT_MS`,
  suggested 120 s).
- Replace the four hardcoded cache TTLs with `CONFIG.CACHE.DOCUMENTS_TTL_MS` and a single
  `resetDocumentsCache()` helper.
- Remove `fetchWithTimeout` and `getUserFriendlyError` from `config.js`, or start using the latter
  in the popup. Pick one and delete the other.
- Validate `targetDoc.id` and `targetField.id` with `Number.isInteger` before building URLs.

Test:
- Temporarily set `REQUEST_TIMEOUT_MS` to 1 ms. Every action fails with the timeout message within
  a second. Restore the value.
- Throttle the network to "Slow 3G" in DevTools and clip a large PDF. The upload either completes or
  fails with a timeout message. The popup never stays on the loading screen indefinitely.
- Send a `clipContent` message from the service worker console with `targetDoc: { id: 'abc' }`.
  Response is a validation error, not a server call.
- Full smoke test.

---

## WP7: Sanitizer and content fidelity

Status: done on `fix/sanitizer` (stacked on fix/worker-robustness). The worker-side pass is now tag-aware instead of regex over the whole string.

Branch: `fix/sanitizer`

Scope:
- `background.js`: remove `sanitizeClippedHtml` regex passes, or reduce it to a tag level check that
  does not touch text nodes. The DOM sanitizer in `content.js` is the real layer.
- `content.js` `cleanHtml`: add `colspan`, `rowspan` and `scope` to the safe attribute list. Consider
  `width` and `height` on `img`.
- `content.js` `getFullPageContent`: strip `aside` as well as the current tags.

Test:
- Clip a selection that contains the text `configuration_id=5` and the phrase `javascript: is a URL
  scheme`. Both appear unchanged in RSpace.
- Clip a Wikipedia table with merged cells. Column structure is preserved in RSpace.
- Create a local test page with `<a href="javascript:alert(1)">`, `<img onerror="alert(1)">`,
  `<svg onload="alert(1)">` and an inline `<script>`. Clip it as Full Page. Inspect the stored field
  content via the API: no `on*` attributes, no `javascript:` href, no script tag.
- Clip a selection containing an image with a relative `src`. The stored URL is absolute.

---

## WP8: PDF rendering limits

Status: done on `fix/pdf-long-pages` (stacked on fix/sanitizer, with fix/reinjection merged in). Verified with a 20 876 px page producing 12 contiguous PDF pages.

Branch: `fix/pdf-long-pages`
Depends on: WP2, WP3

Scope:
- Render in chunks instead of one canvas: iterate over the page height in slices matching the A4
  content area ratio, calling `html2canvas` with `y`, `height` and `windowHeight` per slice, and add one
  image per PDF page.
- Add an upper bound (for example 50 pages) and return a clear error above it.
- Document in the README that cross origin images without CORS headers are omitted.

Test:
- Clip a page taller than 16 000 px (a long GitHub issue or a scrolling documentation page). The PDF
  has content on every page rather than blank pages.
- Compare memory in the Task Manager (`Shift+Esc`) between the old and new approach on the same page.
- Clip a page with a cross origin image lacking CORS headers. The PDF is produced, the image area is
  blank, no error is thrown.
- Short page still produces a single page PDF with correct margins.

---

## WP9: Search and popup lifecycle

Status: done on `feat/server-search` (stacked on fix/pdf-long-pages). Enter now selects rather than clips; the create hint text changed accordingly.

Branch: `feat/server-search`

Scope:
- `background.js` `getDocuments`: accept an optional `query` and pass it as the `query` parameter to
  `/api/v1/documents`. Do not cache query results.
- `popup.js` `handleDocumentSearch`: after the debounce, request from the server when the local
  filter returns fewer than a few hits and `hasMoreDocuments` is true.
- `popup.js`: Enter in the search box selects the highlighted document when there is an exact or
  single match, and creates a new one otherwise. Only the Save button triggers a clip.
- Optional: on popup open, check a `lastClipResult` value in session storage written by the worker
  and show it, so a clip that finished after the popup closed is not lost or repeated.

Test:
- With more than 50 documents in the account, type the name of a document that is not in the first
  page. It appears in the list.
- Type a partial name, press Enter. The matching document is selected, no clip happens.
- Start a clip, close the popup immediately, reopen it. The success message (or error) is shown once.

---

## WP10: Documentation

Status: done on `docs/readme` (stacked on feat/server-search). README rewritten, CHANGELOG.md added. Tag v0.2.0 on main after the stack merges.

Branch: `docs/readme`

Scope:
- Fix the "ISO timestamp" wording or switch `formatTimestamp` to `toISOString()`.
- Document development setup (WP1), library refresh, permissions, privacy, and known limitations
  (cross origin images, Form field types).

Test:
- A colleague follows the README from a clean checkout and can load, connect and clip without asking.

---

## Suggested sequencing

1. WP1 tooling
2. WP3 re-injection fix (small, high impact)
3. WP2 jsPDF upgrade
4. WP4 permissions, WP5 credentials (independent, can run in parallel)
5. WP6 worker robustness
6. WP7 sanitizer
7. WP8 PDF rendering
8. WP9 search and lifecycle
9. WP10 docs, then tag `0.2.0`
