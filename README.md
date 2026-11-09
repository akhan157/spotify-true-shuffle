# True Shuffle

Picks a source — Liked Songs or one of your playlists — shuffles it with
Fisher–Yates, and drops the result into a temporary private playlist that
deletes itself when you stop listening.

**Live:** https://akhan157.github.io/spotify-true-shuffle/

## How it works

Everything runs in the browser. There is no backend, no build step and no client
secret — authentication is OAuth 2.0 Authorization Code with PKCE.

1. **Connect Spotify.** The app generates a random PKCE verifier and `state`,
   hashes the verifier with SHA-256 and sends you to
   `accounts.spotify.com/authorize`. The `state` value is checked on return and
   the authorization code is exchanged for tokens directly from the browser.
2. **Pick a source.** Liked Songs, or any of the first 50 playlists in your
   library. Tracks are paged from the Web API, up to **500** per session.
3. **Shuffle.** Fisher–Yates over the track URIs, using `Math.random`.
4. **Create the playlist.** A **private** playlist named `🔀 Shuffle·<source>` is
   created and filled in batches of 100 tracks.
5. **Play.** On Premium, playback starts on your active device. Otherwise the app
   shows an *Open in Spotify* link.
6. **Clean up.** While the tab is open the app polls playback every 3 minutes;
   after **1 hour** without playback the playlist is emptied and unfollowed.
   Reopening the page resumes a session under an hour old and discards a stale
   one, and *End & Delete* does it immediately.

### Scopes requested

| Scope | Why |
| --- | --- |
| `playlist-read-private` | list and read your playlists |
| `playlist-read-collaborative` | read playlists shared with you |
| `playlist-modify-private` | create and fill the temporary playlist |
| `user-library-read` | read Liked Songs |
| `user-read-playback-state` | detect whether the shuffle playlist is playing |
| `user-modify-playback-state` | start playback on your active device |

## Run locally

Any static file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

Spotify only redirects to URIs registered on the app, so add
`http://localhost:8000/` under **Redirect URIs** in the
[Spotify dashboard](https://developer.spotify.com/dashboard) before logging in.
The app derives its redirect URI from the page it is served from
(`location.origin` + path, minus `index.html`), so it matches whatever
host/port you use — the dashboard entry has to match it exactly.

## Use your own Spotify client ID

The client ID lives at the top of `app-v5.js`:

```js
const CLIENT_ID = '2c5e62fe899d4881825d68e9e6c2f199';
```

Create an app in the [Spotify dashboard](https://developer.spotify.com/dashboard),
add your redirect URI, and replace that value. A Spotify client ID is public by
design in the PKCE flow — it is safe to commit. Never add a client **secret**:
this app has no server to keep one.

## Privacy

- The app runs entirely in your browser. The only outbound requests go to
  Spotify: `accounts.spotify.com` for sign-in, `api.spotify.com` for the Web
  API, and playlist cover images from Spotify's CDN.
- Access and refresh tokens are kept in `localStorage` on this origin and are
  never logged. *Log out* clears them; removing access in your
  [Spotify account](https://www.spotify.com/account/apps/) revokes them.
- No analytics, cookies, fonts or third-party scripts.

Because tokens live in `localStorage`, any script running on this origin could
read them — keep the page free of untrusted third-party scripts if you fork it.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | page shell, loads `app-v5.js` |
| `app-v5.js` | all app logic (auth, API, shuffle, UI) |
| `style.css` | styles |
| `manifest.json`, `icon.svg` | installable web app metadata and icon |

The `-v5` suffix is a cache-bust. If you rename the script, update the `<script>`
tag in `index.html`.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Adnan Khan.
