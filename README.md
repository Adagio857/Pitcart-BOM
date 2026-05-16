# Parts Tracker

A local TypeScript/React interface for a Google Sheet-backed parts library. The app does not store the parts database locally; it loads and saves parts through a Google Apps Script web app connected to your Sheet.

For speed, edits are applied immediately in the browser and cached locally, then synced to Google Sheets about every 30 seconds. Use **Sync Now** before closing the app if the status shows unsynced local changes.

Before each sync, the app pulls the latest Sheet data and merges in parts other people added. If two users created the same generated part number, the app renumbers the local conflicting part before writing. The Apps Script also enforces unique part numbers while writing to the Sheet.

## Run Locally

1. Install Node.js LTS from https://nodejs.org/
2. Open PowerShell in this folder.
3. Run:

```powershell
npm.cmd install
npm.cmd run dev
```

4. Open the local URL Vite prints, usually `http://127.0.0.1:5173/`.

On Windows you can also double-click `Start-PartsTracker.cmd` or run:

```cmd
Start-PartsTracker.cmd
```

If PowerShell shows `npm.ps1 cannot be loaded because running scripts is disabled`, use `npm.cmd` as shown above.

## GitHub Pages

This project can be hosted as a static GitHub Pages site.

1. Create a GitHub repo for this folder.
2. Push the project to the repo's `main` branch.
3. In GitHub, open **Settings > Pages**.
4. Set **Source** to **GitHub Actions**.
5. Push to `main` again, or run the **Deploy GitHub Pages** workflow manually.

The workflow builds the app with `VITE_BASE_PATH` set to `/<repo-name>/`, which is the path GitHub Pages uses for project sites.

To bake the Apps Script URL and Sheet URL into the deployed app, add GitHub repository variables:

- `VITE_APPS_SCRIPT_URL`
- `VITE_GOOGLE_SHEET_URL`

When those values are configured, the app connects to the Google Sheet automatically on load. The manual connection form only appears for an unconfigured local copy.

## Google Sheet Setup

1. Open the linked Google Sheet.
2. Go to **Extensions > Apps Script**.
3. Paste the contents of `google-apps-script.gs` into the Apps Script editor.
4. Click **Deploy > New deployment**.
5. Choose **Web app**.
6. Set **Execute as** to `Me`.
7. Set **Who has access** to **Anyone**. This is needed because the local app writes to the web app without Google OAuth.
8. Deploy and copy the `/exec` web app URL.
9. Add that `/exec` URL to `.env.local` for local development or to the GitHub repository variable `VITE_APPS_SCRIPT_URL` for Pages.
10. Add your Google Sheet URL to `.env.local` or to `VITE_GOOGLE_SHEET_URL`.
11. Reload the app. It will show the Google Sheet as connected without asking for the Apps Script link again.

The script creates/uses a `Parts` tab for part rows and a `Folders` tab for folder-only organization paths.

Anyone with the deployed Apps Script URL can write to the Sheet, so keep that URL private.

If the app says it cannot reach the Apps Script web app, check that you pasted the deployed `/exec` URL, not the Sheet URL and not the `/dev` test URL. Also confirm the deployment access is set to **Anyone**.

If Google shows **This app is blocked** during authorization, make sure the first lines of the Apps Script file are:

```js
/**
 * @OnlyCurrentDoc
 */
```

Then save the script and deploy a new web app version. The script must be opened from **Extensions > Apps Script** inside the target Sheet.

## Google Sheets

The app stores rows in the Sheet using these columns: `id`, `name`, `partNumber`, `originalPartNumber`, `folder`, `quantity`, `unitPrice`, `material`, `thickness`, `processes`, `drawingUrl`, `vendor`, `location`, and `notes`.

Process routes are stored as values like `Router:Done; Deburr:In Progress`.

Nested folders are stored as slash-separated paths, such as `Subsystem / Intake / Plates`. Folder-only paths live in the `Folders` tab. Parts without a folder live in the root of the library. Deleting a folder moves affected parts to the deleted folder's parent.

The library behaves like a file manager: use breadcrumbs to move through folders, create folders from the browser toolbar, open subfolders from folder tiles, drag parts from the table onto folders to move them, and drag folders onto other folders to nest/reorganize them. Folders can be renamed, unpacked into their parent, or deleted.

Folder order is user-controlled and stored in the `Folders` tab. Use the up/down controls in the folder tree to reorder sibling folders.
