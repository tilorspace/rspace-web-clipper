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

### Changed
- Document search also queries the server when the local list has few matches, so documents
  outside the loaded pages can be found.
- Enter in the search box selects the matching document; only the Save button clips.
- If the popup is closed while a clip is saving, the result is shown on the next open.
- Full Page mode also strips `<aside>` elements.

### Development
- `package.json` pins the bundled libraries; `npm test` runs bundle, manifest, unit and audit checks.
- Playwright end-to-end harness against a running RSpace (`scripts/e2e/run.js`).
- GitHub Actions workflow running the checks on every pull request.

## 0.1

Initial prototype: selection, URL, full page and PDF clips; Form field support.
