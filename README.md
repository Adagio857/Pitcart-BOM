# Parts Tracker

A TypeScript/React parts library backed by Firebase Firestore. The app applies edits immediately in the browser, keeps a local cache as a fallback, and syncs to Firebase about every 30 seconds. Use **Sync Now** before closing if the status shows unsynced changes.

The old Google Sheet / Apps Script backend has been replaced. `google-apps-script.gs` can be kept as a migration reference, but the app no longer calls it.

## Run Locally

1. Install Node.js LTS from https://nodejs.org/
2. Copy `.env.example` to `.env.local`.
3. Fill in the Firebase values from your Firebase project settings.
4. Open PowerShell in this folder and run:

```powershell
npm.cmd install
npm.cmd run dev
```

5. Open the local URL Vite prints, usually `http://127.0.0.1:5173/`.

On Windows you can also double-click `Start-PartsTracker.cmd`.

If PowerShell shows `npm.ps1 cannot be loaded because running scripts is disabled`, use `npm.cmd` as shown above.

## Firebase Setup

1. Go to https://console.firebase.google.com/ and create a project on the Spark plan.
2. Add a Web App in **Project settings > General > Your apps**.
3. Copy the web config values into `.env.local`:

```env
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_WORKSPACE_ID=parts-tracker
```

4. In Firebase, create a **Cloud Firestore** database.
5. Start in production mode, then add rules appropriate for your team.

For a private-ish team tool without login, you can temporarily use broad rules while testing:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /workspaces/{workspaceId}/{document=**} {
      allow read, write: if true;
    }
  }
}
```

Those rules mean anyone who can load the site and knows the Firebase config can read/write the data. For a real team deployment, add Firebase Auth and restrict writes to signed-in users.

## Firestore Data

The app stores data under:

```txt
workspaces/{VITE_FIREBASE_WORKSPACE_ID}
workspaces/{workspaceId}/parts
workspaces/{workspaceId}/folders
workspaces/{workspaceId}/attachmentChunks
```

PDF BOM attachments are split into chunk documents in `attachmentChunks` and reassembled by the app for preview. This avoids the Firestore single-document size limit while staying within the free-tier style of setup.

## GitHub Pages

This project can still be hosted as a static GitHub Pages site.

1. Push the project to GitHub.
2. In GitHub, open **Settings > Secrets and variables > Actions > Variables**.
3. Add the same `VITE_FIREBASE_*` values from `.env.local`.
4. Open **Settings > Pages**.
5. Set **Source** to **GitHub Actions**.
6. Push to `main`, or run the **Deploy GitHub Pages** workflow manually.

Firebase web config is safe to ship in a frontend app; Firestore security rules are what protect the database.

## Firebase Hosting

Firebase Hosting also works on the free Spark plan.

1. Install the Firebase CLI:

```powershell
npm.cmd install -g firebase-tools
```

2. Log in and select your Firebase project:

```powershell
firebase login
firebase use --add
```

3. Build and deploy:

```powershell
npm.cmd run build
firebase deploy --only hosting
```

The included `firebase.json` serves the built `dist` folder and routes app URLs back to `index.html`.

## Notes

Before each sync, the app reads the latest Firebase workspace and merges in parts other people added. If two users created the same generated production part number, the app renumbers the local conflicting part before writing.

Folders behave like a file manager: create folders from the list toolbar, expand/collapse folders inline, drag parts into folders, nest folders, rename/unpack/delete folders from the right-click menu, and reorder by dragging.
