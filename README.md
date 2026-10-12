# RSpace Web Clipper

Save web content from Chromium based browsers directly to your RSpace documents with one click.

## Features
- ✅ Quick saving of web content
- ✅ **NEW: Save entire pages as PDF files**
- ✅ **NEW: Clip to Form fields**
- ✅ Auto-capture source URL and ISO timestamp
- ✅ Add notes (optional)
- ✅ Save to existing or new RSpace documents

---
## ⚠️ Please read before proceeding
- 🚧 This is a prototype, almost entirely written and reviewed using AI tools. 
- 📱Submission to the chrome web store is envisioned, but we'd like to collect some feedback first.
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
2. Enter your RSpace server URL (e.g., `community.researchspace.com`)
3. Enter your API key (Get it from: My RSpace → My Profile → API Key ([Read more](https://documentation.researchspace.com/article/v0dxtfvj7u-rspace-api-introduction#obtaining_your_api_key))
4. Click **Connect**

### 3. Start Clipping

1. Go to any webpage
2. Click the RSpace icon
3. Choose what to save:
   - **Selection** - text you selected in your browser window
   - **Full Page** - entire page (representation in RSpace might deviate)
   - **URL Only** - just the link and the page tile
   - **PDF** - 🆕 save entire page as PDF file attached to document
4. Select a document (or create a new one)
5. In case the document is based on a Form, select the Form field of the document to save to
6. (Optional) Add any additional comments
7. Click **Save to RSpace**

That's it! ✨

---
### Development

The extension is plain JavaScript with no build step. Two third-party browser bundles ship in the
repository root (`jspdf.umd.min.js` and `html2canvas.min.js`). Their versions are pinned in
`package.json` so that `npm audit` and Dependabot can track them.

```bash
npm ci                # install pinned dependencies (Node 20 or newer)
npm run check-libs    # verify the committed bundles match the installed package versions
npm run copy-libs     # refresh the committed bundles after bumping a version in package.json
npm run check-manifest # validate manifest.json, referenced files, permissions, and script syntax
npm run audit         # fail on high or critical advisories in the shipped libraries
npm test              # all of the above
```

To upgrade a library: change the version in `package.json`, run `npm install`, then
`npm run copy-libs`, and commit both the lockfile and the refreshed bundle. CI runs the same checks
on every pull request.

---
### Need Help?

- Report any problems you encounter or any functionality you're missing [via the issue tracker](https://github.com/rspace-os/rspace-web-clipper/issues/new/choose) on this repository.

