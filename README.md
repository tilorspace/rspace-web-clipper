# RSpace Web Clipper

Save web content from Chromium based browsers directly to your RSpace documents with one click.

## Features
- ✅ Save a text selection, the page's main content, just the link, or the whole page as a PDF
- ✅ Save to an existing document or create a new one, including Form based documents
- ✅ Search your documents as you type, including ones you have not scrolled to yet
- ✅ Source URL and timestamp are recorded with every clip
- ✅ Optional note per clip
- ✅ Minimal permissions, no telemetry (see [Permissions and privacy](#permissions-and-privacy))

---
## ⚠️ Please read before proceeding
- 🚧 This is a prototype, almost entirely written and reviewed using AI tools.
- 📱 Submission to the Chrome Web Store is envisioned, but we'd like to collect some feedback first.
- 📥 If you find any quirks, issues, and have general ideas and suggestions for improving the code and/or the functionality, please [reach out](https://github.com/rspace-os/rspace-web-clipper/issues/new/choose)!
---

### 1. Install

1. Download the files in this repository into a local folder or clone the GitHub repository to your local machine
2. Open Chrome → go to `chrome://extensions/` (for other Chromium browsers the address might be different, typically `{browsername}://extensions/`)
3. Turn on **"Developer mode"** (top right)
4. Click **"Load unpacked"** → select the extension folder on your local machine
5. Done! Look for the RSpace icon in your browser toolbar

### 2. Connect

1. Click the RSpace icon
2. Enter your RSpace server URL (e.g., `community.researchspace.com`). HTTPS is required, except for `localhost` and `127.0.0.1`
3. Enter your API key (Get it from: My RSpace → My Profile → API Key ([Read more](https://documentation.researchspace.com/article/v0dxtfvj7u-rspace-api-introduction#obtaining_your_api_key))
4. Optionally tick **Remember API key for 7 days**. Only do this on a private, trusted device. The key is stored on this device only and is forgotten after seven days or when you click **Clear Saved Data**
5. Click **Connect**. Chrome asks once for permission to access that server; nothing else is requested

### 3. Start Clipping

1. Go to any webpage
2. Click the RSpace icon
3. Choose what to save:
   - **Selection** - text you selected in your browser window
   - **URL Only** - just the link and the page title
   - **Full Page** - the page's main content as HTML (representation in RSpace might deviate)
   - **PDF** - the entire page rendered as a PDF file and attached to the document
4. Type in **Save to** to find a document. Pick it from the list (or press Enter when there is a single match). If no document matches, Save creates a new one with that name
5. In case the document is based on a Form, select the Form field of the document to save to (only text fields can receive clips)
6. (Optional) Add a note
7. Click **Save to RSpace**. A link to the document appears when the clip is saved; if you close the popup while it is saving, the result is shown the next time you open it

Each clip is appended to the end of the chosen field with the source link, the page title and a timestamp such as `2026-01-08 14:35:22 GMT+1`.

That's it! ✨

---
### Known limitations

- **PDF mode** renders the page with html2canvas, so it is a visual snapshot, not a print
  layout: images from other domains that do not send CORS headers are left blank, and complex
  CSS (fixed positioning, web fonts loaded late, canvas or video) may not render exactly.
  Pages that would need more than 50 A4 pages are refused.
- **Full Page** mode clips the main content area and strips navigation, headers, footers and
  sidebars; the result is plain HTML in RSpace and will not look like the original page.
- **Form documents**: only text fields can receive clips. Number, date, choice and other field
  types are not offered.
- Clips are appended to the end of a document field. Editing the same field in RSpace at the
  same moment can overwrite the clip.
- Pages the browser does not let extensions read (Chrome's own pages, the Web Store, PDF
  viewers) cannot be clipped.

### Permissions and privacy

The extension asks for the minimum Chrome permissions it can work with:

- **activeTab** and **scripting**: read the page you are clipping from, only when you click Save.
- **storage**: keep your server URL (and, if you opt in, your API key for a limited time) on this device.
- **Access to your RSpace server**: requested once for the exact server URL you enter, nothing else.

Page content, the page URL and title, your optional note, and (for PDF clips) a rendered PDF are
sent only to the RSpace server you configured, using your own API key. Nothing is sent anywhere
else, and the extension has no analytics or telemetry.

---
### Development

The extension is plain JavaScript with no build step. Two third-party browser bundles ship in the
repository root (`jspdf.umd.min.js` and `html2canvas.min.js`). Their versions are pinned in
`package.json` so that `npm audit` and Dependabot can track them.

```bash
npm ci                 # install pinned dependencies (Node 20 or newer)
npm run check-libs     # verify the committed bundles match the installed package versions
npm run copy-libs      # refresh the committed bundles after bumping a version in package.json
npm run check-manifest # validate manifest.json, referenced files, permissions, and script syntax
npm run unit           # worker and content script unit tests (Node, no browser)
npm run audit          # fail on high or critical advisories in the shipped libraries
npm test               # all of the above
```

End-to-end test against a running RSpace (loads the extension into Chromium via Playwright, clips
a local test page in every mode, and verifies the result through the RSpace API):

```bash
npx playwright install chromium
node --env-file=/path/to/.env scripts/e2e/run.js   # .env defines RSPACE_URL and RSPACE_API_KEY
```

`scripts/e2e/explore.js` is a longer exploratory session (Form documents, hostile input, real
external pages, expired sessions, unreachable server); `EXPLORE_ONLY=AB` limits it to the listed
scenario letters. Both scripts share `scripts/e2e/lib.js`.

Set `HEADED=1` to watch the browser and `E2E_KEEP=1` to keep the test documents. Screenshots,
the stored document HTML and the uploaded PDFs land in `web-ext-artifacts/e2e/`. The harness
deletes the test documents it creates. Note that the loaded copy of the extension is given
`host_permissions` for the RSpace and test page origins, because Chrome's permission prompt and
the toolbar click cannot be driven by Playwright; everything else is the committed code.

To upgrade a library: change the version in `package.json`, run `npm install`, then
`npm run copy-libs`, and commit both the lockfile and the refreshed bundle. CI runs the same checks
on every pull request.

Layout:

| File | Role |
|---|---|
| `manifest.json` | Manifest V3 definition, permissions, popup and worker |
| `background.js` | Service worker: authentication, RSpace API calls, document and file writes |
| `content.js` | Injected into the page on demand: content extraction, HTML sanitizing, PDF rendering |
| `popup.html`, `popup.js`, `popup.css` | The toolbar popup |
| `config.js` | Shared constants (timeouts, limits, cache TTL) |
| `scripts/` | Tooling, unit tests and the e2e scripts |

See [CHANGELOG.md](CHANGELOG.md) for release notes.

---
### Need Help?

- Report any problems you encounter or any functionality you're missing [via the issue tracker](https://github.com/rspace-os/rspace-web-clipper/issues/new/choose) on this repository.
