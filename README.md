# Parts Tracker

A TypeScript/React parts library backed by Firebase Firestore and hosted on Firebase Hosting. The app applies edits immediately in the browser, keeps a local cache as a fallback, and saves each action to Firebase right away.

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
5. Start Firestore in production mode, then add rules appropriate for your team.

The app uses a lightweight team login screen backed by an approved username/password list in `src/App.tsx`.
To add a user, edit `APP_USERS` near the top of the file:

```ts
const APP_USERS = [
  { username: "HudsonM", password: "1648" },
  { username: "NewUser", password: "new-password" }
] as const;
```

Because this is not Firebase Authentication, use broad Firestore rules for this simple setup:

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

This keeps the page from casual use, but it is not high-security. Anyone with the Firebase project config could still access the database directly unless you later switch back to Firebase Authentication rules.

## Firestore Data

The app stores data under:

```txt
workspaces/{VITE_FIREBASE_WORKSPACE_ID}
workspaces/{workspaceId}/parts
workspaces/{workspaceId}/folders
workspaces/{workspaceId}/attachmentChunks
```

PDF BOM attachments are split into chunk documents in `attachmentChunks` and reassembled by the app for preview. This avoids the Firestore single-document size limit while staying within the free-tier style of setup.

## Firebase Hosting

Firebase Hosting works on the free Spark plan. GitHub remains the source of code, but the public site is deployed to Firebase Hosting instead of GitHub Pages.

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

## GitHub Deploys To Firebase

The repository includes `.github/workflows/deploy-firebase-hosting.yml`. On every push to `main`, GitHub Actions builds the app and deploys it to Firebase Hosting.

In GitHub, go to **Settings > Secrets and variables > Actions**.

Add these **Variables**:

```txt
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
VITE_FIREBASE_WORKSPACE_ID
```

Add this **Secret**:

```txt
FIREBASE_SERVICE_ACCOUNT
```

To create that secret:

1. Firebase Console > Project settings > Service accounts.
2. Click **Generate new private key**.
3. Copy the entire JSON file contents.
4. Paste it into the GitHub secret named `FIREBASE_SERVICE_ACCOUNT`.

Firebase web config is safe to ship in a frontend app; Firestore security rules are what protect the database. Keep the service account JSON secret private.

## Notes

Before each save, the app reads the latest Firebase workspace and merges in parts other people added. If two users created the same generated production part number, the app renumbers the local conflicting part before writing.

Folders behave like a file manager: create folders from the list toolbar, expand/collapse folders inline, drag parts into folders, nest folders, rename/unpack/delete folders from the right-click menu, and reorder by dragging.
