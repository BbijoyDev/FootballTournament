# Football Tournament Website

A static, public football tournament manager built with HTML, CSS, vanilla JavaScript and Firebase Firestore. It can be hosted directly on GitHub Pages. Public visitors do not need an account.

## Features

- Public team, player, fixture, live score, table, scorer and knockout views
- Real-time score updates through Firestore listeners
- Administrator login
- Tournament, team and player management
- Bulk player entry for a selected team, preserving its existing roster
- Owner-only permanent tournament deletion with a typed-name confirmation
- Optional per-team player limit, configurable separately for each tournament
- Team-specific player-entry cards with live roster capacity indicators
- Permanent Owner role and temporary, time-bounded Scorekeeper permissions
- Match-specific Scorekeeper permissions and immediate access revocation
- Round-robin fixtures
- Live matches, goal edits/removal and goal-scorer selection
- Score finishing and reopening
- Quarter-final, semi-final and final bracket progression
- Tournament reset

## 1. Create the GitHub repository

1. Create a public repository on GitHub.
2. Upload `index.html`, `styles.css`, `app.js`, `firebase-config.js`, `firestore.rules`, and `README.md`.
3. Keep `index.html` in the repository root.

Example repository: `https://github.com/USERNAME/football-tournament`

## 2. Publish with GitHub Pages

1. Open **Settings > Pages** in the GitHub repository.
2. Under **Build and deployment**, select **Deploy from a branch**.
3. Select the `main` branch and `/ (root)` folder, then save.
4. Wait for GitHub Pages to publish the site.

Your site URL will normally be:

`https://USERNAME.github.io/football-tournament/`

The app uses relative resources and reads the tournament ID from the `tournament` query parameter when present, so it does not require repository-specific absolute URLs.

## 3. Create the Firebase project

1. Open the Firebase console and create a project.
2. Enable **Google Analytics** only if desired; it is not required.

## 4. Create Firestore

1. In Firebase, open **Build > Firestore Database**.
2. Click **Create database**.
3. Start in **production mode**.
4. Choose a location close to your users.

## 5. Register the web application

1. Open **Project settings**.
2. Under **Your apps**, choose **Web**.
3. Register an app with a name such as `Football Tournament`.
4. Firebase will show the web configuration object.

## 6. Add the Firebase web configuration

Replace the placeholders in `firebase-config.js` with the Firebase web configuration:

```js
window.FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

These values identify a Firebase web app and are not administrator secrets. Do not add a Firebase service-account private key to this project.

## 7. Configure Firestore security rules

Open **Firestore Database > Rules**, copy and publish the contents of `firestore.rules`.

Tournament documents have an immutable `ownerUid`. The user who creates a tournament while signed in becomes its Owner. The rules allow anonymous read access to public tournament data, but only that Owner can modify teams, players, fixtures, settings, or access records. A Scorekeeper's writes are limited to permitted fields on authorized match documents.

## 8. Configure administrator authentication

1. Open **Firebase > Build > Authentication**.
2. Open **Sign-in method**.
3. Enable **Email/Password**.
4. Create the Owner's account in the Firebase Authentication Users page.
5. Use a strong unique password.

Add the GitHub Pages host (for example, `USERNAME.github.io`) under Authentication **Settings > Authorized domains**. The Owner signs into Admin mode and creates the tournament. The tournament's Owner role is tied to that Firebase Authentication UID, not to an email string or a hidden UI control.

## Temporary Scorekeeper access

1. Sign in as the tournament Owner and open **Admin mode > Manage Access**.
2. Enter the Scorekeeper's name and the exact email shown in Firebase Authentication, start and expiry times, and optionally select one match.
3. Enable **Allow corrections to completed matches** only when completed matches should be editable.
4. Create the user's Firebase Authentication account with that exact email. The Scorekeeper signs in, uses **Send verification email**, then selects **I've verified it** after following the email link.
5. Use **Revoke Access** to delete the grant immediately.

Firestore Rules check the user's verified email, the grant's start and expiry against server `request.time`, and the optional match ID on every write. Expired or revoked grants cannot write even if an old admin page is still open. Only the Owner can read or change the full Scorekeeper list; a Scorekeeper can read only their own grant.

Scorekeepers may change only match status, goals and score fields. They cannot create/delete matches, edit teams or players, change tournament data, or alter any access record. Only Owners progress knockout fixtures automatically when finishing a knockout match.

### Existing tournaments

Tournaments created before Owner roles were added may not have `ownerUid`. Such documents will be readable but no account will be treated as Owner. Migrate each existing tournament using the Firebase console (a privileged console edit) to set `ownerUid` to the intended Owner's Firebase Authentication UID before deploying the new rules. Do not add a client-side owner-claim flow.

## 9. Test public read-only access

1. Open the GitHub Pages URL in an incognito/private window.
2. Confirm that tournament data is visible.
3. Confirm that no admin controls are available.
4. Confirm that score changes made by the administrator appear without refreshing.

Public anonymous access is granted by Firestore rules, not merely by hiding buttons.

## 10. Test Owner and Scorekeeper access

1. Open the public site.
2. Choose **Admin mode**.
3. Sign in as the Owner, create a tournament, add teams and players, and generate fixtures.
4. Grant a verified test account temporary Scorekeeper access for one match and a short time window.
5. Verify the Scorekeeper can update that match but cannot update another match, edit teams, or change permissions.
6. Revoke the grant and verify writes fail immediately. Repeat with an expired grant.
7. Sign out and verify anonymous public viewers can read tournament information but cannot write.

Use the Firebase Rules simulator or Emulator Suite to verify denied writes as well as successful ones.

## Tournament data

Firestore uses this structure:

```text
tournaments/{tournamentId}
  maxPlayersPerTeam: number | null
  teamPlayerCounts: map<teamId, number>
  teams/{teamId}
  players/{playerId}
  matches/{matchId}
  scorekeepers/{verified-email}
```

The tournament document contains its name, immutable Owner UID, optional `maxPlayersPerTeam`, and maintained per-team `teamPlayerCounts`. Teams, players and matches are public-read subcollections. Scorekeeper access records are private and writable only by the Owner.

The Owner can set an optional maximum number of players per team in **Admin mode > Settings**. The same limit applies to every team in that tournament; leave it blank for no cap. Existing rosters remain intact if a lower cap is set, but a team over the limit cannot add players or accept transfers until it is under the cap. Adding, moving, and removing players update per-team counts transactionally. Existing tournaments initialize counts from their player rosters when an Owner opens them. Older tournaments automatically copy a saved `maxPlayers` value into the per-team limit field if no per-team value exists. New tournament documents start with no limit and empty counts.

In **Admin mode > Players**, the Owner can paste one player name per line to add multiple players to a selected team without replacing its existing roster. Blank lines are ignored, and each submission is limited to 400 names and checked against the team's remaining capacity. In **Admin mode > Settings**, the Owner can permanently delete a tournament and its teams, players, matches, and Scorekeeper records. Deletion requires typing the tournament name and cannot be undone.

## Local testing

Firebase web apps make cross-origin requests, so avoid opening `index.html` through a `file://` URL. From PowerShell in the project folder, start a local static server. If Python is installed:

```bash
py -m http.server 8080
```

If the Python launcher is unavailable but Node.js is installed, use this dependency-free server command instead:

```powershell
node -e "const http=require('http'),fs=require('fs'),path=require('path');http.createServer((q,s)=>{const u=new URL(q.url,'http://localhost'),p=u.pathname==='/'?'index.html':decodeURIComponent(u.pathname.slice(1));fs.readFile(path.join(process.cwd(),p),(e,d)=>{if(e){s.writeHead(404);s.end('Not found')}else{s.setHeader('Content-Type',p.endsWith('.html')?'text/html':p.endsWith('.css')?'text/css':p.endsWith('.js')?'text/javascript':'text/plain');s.end(d)}})}).listen(8080,'127.0.0.1')"
```

Open `http://localhost:8080`. Add `localhost` to Firebase Authentication's authorized domains if Firebase sign-in is rejected. Before using the app, replace the placeholders in `firebase-config.js` and publish `firestore.rules`. GitHub Pages hosting is also suitable.

## Cost considerations

GitHub Pages is a static host and has no application server cost. Firestore should remain free for a small local tournament by keeping listener scopes small and avoiding unbounded downloads. The app listens only to the selected tournament's teams, players and matches.
