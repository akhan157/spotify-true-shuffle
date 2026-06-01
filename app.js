'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────
// 1. Go to https://developer.spotify.com/dashboard → Create App
// 2. Paste your Client ID below
// 3. Add your deployment URL as a Redirect URI in the Spotify app settings
//    (e.g. https://yourname.github.io/spotify-true-shuffle/ or https://yourapp.netlify.app/)
const CLIENT_ID = '2c5e62fe899d4881825d68e9e6c2f199';

const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',  // public playlists only — simpler grant, less likely to be blocked
  'user-library-read',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

const MAX_TRACKS    = 500;            // max tracks pulled from source
const POLL_MS       = 3 * 60 * 1000; // poll playback state every 3 min
const IDLE_LIMIT_MS = 60 * 60 * 1000; // delete playlist after 1hr idle
const SESSION_PREFIX = '\u{1F500} Shuffle·'; // 🔀 Shuffle·

// ─── PKCE ─────────────────────────────────────────────────────────────────────
function randB64(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

async function sha256B64(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

// ─── Local storage helpers ────────────────────────────────────────────────────
const ls = {
  g: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  s: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  d: k => localStorage.removeItem(k),
};

// ─── Token management ─────────────────────────────────────────────────────────
async function getToken() {
  const t = ls.g('ts_tok');
  if (!t) return null;
  if (Date.now() < t.exp - 60000) return t.access_token;
  // token expired — refresh
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLIENT_ID }),
    });
    if (!r.ok) { ls.d('ts_tok'); return null; }
    const d = await r.json();
    saveTok(d);
    return d.access_token;
  } catch { ls.d('ts_tok'); return null; }
}

function saveTok(d) {
  const granted = new Set((d.scope || '').split(' '));
  ls.s('ts_tok', { ...d, exp: Date.now() + d.expires_in * 1000, has_write: granted.has('playlist-modify-public') });
}

// ─── Spotify API wrapper ──────────────────────────────────────────────────────
async function api(method, path, body) {
  const token = await getToken();
  if (!token) { ls.d('ts_tok'); render(); throw new Error('Session expired — please reconnect.'); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let r;
  try {
    r = await fetch(`https://api.spotify.com/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'Request timed out. Check your connection.' : e.message);
  }
  clearTimeout(timer);
  if (r.status === 204) return {};
  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText);
    throw new Error(`Spotify API ${r.status}: ${msg}`);
  }
  return r.json();
}

async function paginate(path, max) {
  max = max || MAX_TRACKS;
  const items = [];
  let url = `${path}${path.includes('?') ? '&' : '?'}limit=50`;
  while (url && items.length < max) {
    const data = await api('GET', url.replace('https://api.spotify.com/v1', ''));
    if (!data || !data.items) break;
    items.push(...data.items);
    url = data.next;
  }
  return items.slice(0, max);
}

// ─── Fisher-Yates shuffle ─────────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Session ──────────────────────────────────────────────────────────────────
let _poll = null;
let _idleStart = null;

function getSession() { return ls.g('ts_sess'); }

async function destroyPlaylist(id) {
  try {
    // Clear tracks first so the empty playlist isn't confusing
    await api('PUT', `/playlists/${id}/tracks`, { uris: [] });
    // Unfollow removes it from the user's library
    await api('DELETE', `/playlists/${id}/followers`);
  } catch { /* best effort — don't block UI */ }
}

async function endSession() {
  const s = getSession();
  stopPoll();
  if (s) await destroyPlaylist(s.pid);
  ls.d('ts_sess');
  render();
}

async function startSession(sourceId, sourceName) {
  setStatus('Fetching tracks…');

  const raw = sourceId === 'liked'
    ? await paginate('/me/tracks')
    : await paginate(`/playlists/${sourceId}/tracks`);

  const uris = raw.map(i => i.track?.uri).filter(u => u?.startsWith('spotify:track:'));
  if (!uris.length) throw new Error('No playable tracks found. The source may be empty or only contain local/unavailable files.');

  shuffle(uris);
  setStatus(`Shuffled ${uris.length} tracks. Creating playlist…`);

  const me = await api('GET', '/me');
  let pl;
  try {
    pl = await api('POST', `/users/${me.id}/playlists`, {
      name: `${SESSION_PREFIX}${sourceName}`,
      description: 'True Shuffle session. Auto-deletes after 1hr idle.',
      public: true,
    });
  } catch (e) {
    if (e.message.includes('403')) {
      // Spotify cached grant is missing write scope — auto-redirect loops, so stop here.
      // Mark token as lacking write scope; render() will show the revoke-and-reconnect screen.
      const tok = ls.g('ts_tok');
      if (tok) ls.s('ts_tok', { ...tok, has_write: false });
      else ls.d('ts_tok');
      render();
      return;
    }
    throw e;
  }

  for (let i = 0; i < uris.length; i += 100) {
    setStatus(`Adding tracks… ${Math.min(i + 100, uris.length)}/${uris.length}`);
    await api('POST', `/playlists/${pl.id}/tracks`, { uris: uris.slice(i, i + 100) });
  }

  const isPremium = me.product === 'premium';
  let noDevice = !isPremium;

  if (isPremium) {
    setStatus('Starting playback…');
    try {
      await api('PUT', '/me/player/play', { context_uri: `spotify:playlist:${pl.id}` });
      noDevice = false;
    } catch {
      noDevice = true;
    }
  }

  const sess = { pid: pl.id, source: sourceName, count: uris.length, t0: Date.now(), noDevice };
  ls.s('ts_sess', sess);
  _idleStart = null;
  startPoll();
  renderSession(sess, null, sess.noDevice);
}

function startPoll() {
  stopPoll();
  _poll = setInterval(pollPlayback, POLL_MS);
}
function stopPoll() { if (_poll) { clearInterval(_poll); _poll = null; } }

async function pollPlayback() {
  const s = getSession();
  if (!s) { stopPoll(); return; }
  try {
    const state = await api('GET', '/me/player');
    const active = state?.is_playing === true && state?.context?.uri?.includes(s.pid);
    if (active) {
      _idleStart = null;
      if (s.noDevice) { s.noDevice = false; ls.s('ts_sess', s); }
      renderSession(s, null, false);
    } else {
      if (!_idleStart) _idleStart = Date.now();
      const idle = Date.now() - _idleStart;
      if (idle >= IDLE_LIMIT_MS) {
        await destroyPlaylist(s.pid);
        stopPoll();
        ls.d('ts_sess');
        render();
      } else {
        renderSession(s, Math.ceil((IDLE_LIMIT_MS - idle) / 60000), s.noDevice);
      }
    }
  } catch { /* network hiccup — skip this tick */ }
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
async function login() {
  if (CLIENT_ID === 'YOUR_CLIENT_ID') {
    alert('Open app.js and set CLIENT_ID to your Spotify Developer app Client ID first.');
    return;
  }
  const verifier = randB64(96);
  const state = randB64(8);
  ls.s('ts_pkce', verifier);
  ls.s('ts_state', state);
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: await sha256B64(verifier),
    state,
    show_dialog: 'true', // always show permission screen so cached grants can't skip scopes
  });
  location.href = `https://accounts.spotify.com/authorize?${p}`;
}

async function handleCallback(code, state) {
  const saved = ls.g('ts_state');
  ls.d('ts_state');
  if (saved && state !== saved) throw new Error('State mismatch — possible CSRF attempt.');
  const verifier = ls.g('ts_pkce');
  ls.d('ts_pkce');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier: verifier }),
  });
  if (!r.ok) throw new Error('Token exchange failed. Try logging in again.');
  saveTok(await r.json());
  history.replaceState({}, '', location.pathname);
}

// ─── UI ───────────────────────────────────────────────────────────────────────
const $app = document.getElementById('app');

function html(s) { $app.innerHTML = s; }

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

function renderLogin() {
  html(`<div class="screen center">
    <div class="logo">\u{1F500}</div>
    <h1>True Shuffle</h1>
    <p class="sub">Real random. No Spotify bias.</p>
    <button class="btn primary" onclick="login()">Connect Spotify</button>
  </div>`);
}

function renderSpinner(msg) {
  html(`<div class="screen center">
    <div class="spinner"></div>
    <p id="status">${esc(msg)}</p>
  </div>`);
}

let _playlists = [];

async function renderPicker() {
  renderSpinner('Loading playlists…');

  // cleanup orphaned sessions older than 24h
  const old = getSession();
  if (old && Date.now() - old.t0 > 86400000) {
    destroyPlaylist(old.pid).catch(() => {});
    ls.d('ts_sess');
  }

  try {
    const items = await paginate('/me/playlists', 50);
    _playlists = items.filter(p => p && !p.name?.startsWith(SESSION_PREFIX));

    const rows = _playlists.map((p, i) => {
      const img = p.images?.[0]?.url
        ? `<img src="${esc(p.images[0].url)}" alt="">`
        : `<div class="img-ph"></div>`;
      return `<button class="pitem" data-i="${i}" onclick="pickByEl(this)">
        ${img}
        <span class="pname">${esc(p.name ?? 'Untitled')}</span>
        <span class="pcnt">${p.tracks?.total ?? '?'}</span>
      </button>`;
    }).join('');

    html(`<div class="screen">
      <header>
        <span class="hlogo">\u{1F500} True Shuffle</span>
        <button class="lout" onclick="doLogout()">Log out</button>
      </header>
      <p class="hint">Pick a source to shuffle:</p>
      <div class="list">
        <button class="pitem liked" onclick="pickId('liked','Liked Songs')">
          <div class="img-liked">♥</div>
          <span class="pname">Liked Songs</span>
          <span class="pcnt">up to ${MAX_TRACKS}</span>
        </button>
        ${rows}
      </div>
    </div>`);
  } catch (e) {
    html(`<div class="screen center">
      <p class="error">${esc(e.message)}</p>
      <button class="btn secondary" onclick="render()">Retry</button>
    </div>`);
  }
}

function pickByEl(el) {
  const p = _playlists[+el.dataset.i];
  pickId(p.id, p.name);
}

async function pickId(id, name) {
  renderSpinner('Starting…');
  try {
    await startSession(id, name);
  } catch (e) {
    html(`<div class="screen center">
      <p class="error">${esc(e.message)}</p>
      <button class="btn secondary" onclick="render()">Back</button>
    </div>`);
  }
}

function renderSession(s, idleLeft, noDevice) {
  let statusHtml;
  if (noDevice) {
    statusHtml = `<p class="idle-warn">⏸ Not started</p>`;
  } else if (idleLeft != null) {
    statusHtml = `<p class="idle-warn">⏱ Paused — deletes in ${idleLeft} min</p>`;
  } else {
    statusHtml = `<p class="idle-ok">▶ Playing</p>`;
  }
  const deviceWarn = noDevice
    ? `<p class="warn-box">Playlist ready. Open Spotify and tap the button below to start playing.</p>`
    : '';
  html(`<div class="screen center">
    <div class="logo">\u{1F500}</div>
    <h2>${esc(s.source)}</h2>
    <p class="sub">${s.count} tracks · true shuffle</p>
    ${statusHtml}
    ${deviceWarn}
    <a class="btn primary" href="https://open.spotify.com/playlist/${esc(s.pid)}" target="_blank">Open in Spotify</a>
    <button class="btn secondary" onclick="endSession()">End &amp; Delete</button>
    <p class="fine">Keep this tab open to track idle time.</p>
  </div>`);
}

function doLogout() { ls.d('ts_tok'); render(); }

// ─── Router ───────────────────────────────────────────────────────────────────
async function render() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code');
  const state = p.get('state');
  const error = p.get('error');

  if (error) { renderLogin(); return; }

  if (code) {
    renderSpinner('Connecting…');
    try {
      await handleCallback(code, state);
    } catch (e) {
      html(`<div class="screen center">
        <p class="error">${esc(e.message)}</p>
        <button class="btn primary" onclick="login()">Try Again</button>
      </div>`);
      return;
    }
  }

  const token = await getToken();
  if (!token) { renderLogin(); return; }

  const tok = ls.g('ts_tok');
  if (tok && tok.has_write === false) {
    html(`<div class="screen center">
      <div class="logo">\u{1F500}</div>
      <p class="error">Spotify is blocking playlist creation.<br>A one-time fix is needed.</p>
      <p style="color:#b3b3b3;font-size:13px;max-width:280px;line-height:1.8;text-align:left">
        <strong style="color:#fff">Step 1:</strong> Tap <em>Remove access</em> — opens Spotify.<br>
        <strong style="color:#fff">Step 2:</strong> Find this app and tap <em>Remove access</em>.<br>
        <strong style="color:#fff">Step 3:</strong> Come back here and tap <em>Reconnect</em>.
      </p>
      <a class="btn primary" href="https://www.spotify.com/account/apps/" target="_blank">Remove access →</a>
      <button class="btn secondary" onclick="ls.d('ts_tok');login()">Reconnect Spotify</button>
    </div>`);
    return;
  }

  const sess = getSession();
  if (sess) {
    if (Date.now() - sess.t0 > IDLE_LIMIT_MS) {
      // Stale session from a closed tab — silently clean up
      destroyPlaylist(sess.pid).catch(() => {});
      ls.d('ts_sess');
    } else {
      startPoll();
      renderSession(sess, null, sess.noDevice ?? false);
      pollPlayback();
      return;
    }
  }

  renderPicker();
}

render();
