# Changelog

## 0.2.0 (unreleased)

Hardening release following a code and dependency review.

### Security
- jsPDF upgraded from 2.5.1 to 4.2.1, clearing the bundled DOMPurify advisories and the image
  handling denial of service fixes published since 2.5.1.
- The `tabs` permission was dropped; `activeTab` already covers what the popup needs.
- The API key is persisted (when "remember" is ticked) only after the server has accepted it.
- Document and field ids from the popup are validated before being used in API URLs.
- The worker side HTML sanitizer now only operates inside tags. Previously it also ran over
  text and could cut words out of clipped prose.

### Fixed
- Clipping as PDF after a text clip in the same tab logged a script redeclaration error.
- Long pages produced blank PDF pages because the whole page was rendered into one canvas.
  The PDF is now rendered one page at a time; pages above 50 A4 pages are refused.
- The request timeout read a configuration key that did not exist. The PDF upload now has its
  own two minute timeout instead of none.
- `http://localhost` could not be entered as the server URL although it was allowed.
- Clear Saved Data now also clears the worker's in-memory document cache.
- Clipped tables keep `colspan` and `rowspan`; images keep their size attributes.

### Fixed (found by exploratory testing)
- Saving twice into a newly created document created a second document with the same name.
  The created document now stays selected.
- Typing the exact name of a Form document did not offer the field choice, so saving failed
  with "select a field" and no selector on screen.
- A name differing only in case from an existing document created a duplicate.
- A revoked or expired API key showed the server's raw error and left the popup on the clipper
  screen; it now returns to the connect screen.
- The popup ignored input until the document list had loaded.

### Changed
- Document search also queries the server when the local list has few matches, so documents
  outside the loaded pages can be found.
- Enter in the search box selects the matching document; only the Save button clips.
- If the popup is closed while a clip is saving, the result is shown on the next open.
- Full Page mode also strips `<aside>` elements.

### Visual
- Error and success banners sit directly under the Save button (they were below the Settings
  link, and off screen on the connect screen).
- The create hint wrapped into two columns; it reads as one sentence now.
- Dark mode: inputs, selects and the note box use dark surfaces (text was light on light).
- The note box is a fixed two rows instead of growing on focus.
- The selected document is kept in view when the field selector appears; the empty state fits
  the space above the footer; tighter rhythm on the connect screen.

### Internals
- Popup: one `setSelectedDocument()` owns the selection state; the two clip handlers merged
  into `handleSave()`; the URL prefix protection, the one-time migration and the document cache
  were removed. Worker: shared `appendToField()` for HTML and PDF clips, one error mapping for
  all messages, 401 handled in one place, credentials read once and cached. A clip into a new
  document is two requests instead of three, and the popup reuses the fields the worker
  returns instead of fetching them again. PDFs render several pages per html2canvas pass.
  About 1400 lines removed.

### Development
- `package.json` pins the bundled libraries; `npm test` runs bundle, manifest, unit and audit checks.
- Playwright end-to-end harness against a running RSpace (`scripts/e2e/run.js`).
- GitHub Actions workflow running the checks on every pull request.

## 0.1

Initial prototype: selection, URL, full page and PDF clips; Form field support.
