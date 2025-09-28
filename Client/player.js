console.log("🔑 Player page sees localStorage:", {
  spotify_token: localStorage.getItem('spotify_token'),
  refresh_token: localStorage.getItem('refresh_token'),
  token_expiry: localStorage.getItem('token_expiry'),
});

let fadeInterval;          // interval for volume fade
let positionPoller = null; // polls playback position
let currentTrackId = null; // to detect track changes
let fadeStarted = false;   // ensure we fade once per track
let fadeStartAtSec = null; // when to begin fading (seconds)

const BACKEND_URL = 'https://atomic-dj-pkce.onrender.com';
const REFRESH_ENDPOINT = `${BACKEND_URL}/refresh_token`;

/* ---------------- Refresh Access Token ---------------- */
// (keep your refreshAccessToken implementation unchanged)
async function refreshAccessToken() {
  const refresh_token = localStorage.getItem('refresh_token');
  if (!refresh_token) {
    console.warn('No refresh token — cannot refresh, must log in again.');
    return false;
  }
  try {
    const response = await fetch(REFRESH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token })
    });
    const data = await response.json();
    if (data.access_token) {
      localStorage.setItem('spotify_token', data.access_token);
      const expires_in = data.expires_in || 3600;
      localStorage.setItem('token_expiry', Date.now() + expires_in * 1000);
      console.log('♻️ Player refreshed access token.');
      return true;
    } else {
      console.error('❌ Token refresh failed:', data);
      return false;
    }
  } catch (err) {
    console.error('🔥 Refresh error in player:', err);
    return false;
  }
}

/* ---------------- Initialize Player (call only when token exists) ---------------- */
function initPlayer() {
  let token = localStorage.getItem('spotify_token');
  const playerName = 'Atomic DJ Player';

  if (!token) {
    document.getElementById('status').innerText = 'No Spotify token found. Please log in first.';
    return;
  }

  const player = new Spotify.Player({
    name: playerName,
    getOAuthToken: cb => {
      token = localStorage.getItem('spotify_token'); // always fetch fresh
      cb(token);
    }
  });

  // ---------- Error listeners ----------
  player.addListener('initialization_error', ({ message }) => {
    console.error(message);
    updateStatus(`Initialization error: ${message}`);
  });
  player.addListener('authentication_error', async ({ message }) => {
    console.error('auth err', message);
    updateStatus(`Authentication error: ${message}`);
    console.log('🔄 Attempting token refresh after authentication error...');
    const refreshed = await refreshAccessToken();
    if (refreshed) player.connect();
  });
  player.addListener('account_error', ({ message }) => {
    console.error(message);
    updateStatus(`Account error: ${message}`);
  });
  player.addListener('playback_error', ({ message }) => {
    console.error(message);
    updateStatus(`Playback error: ${message}`);
  });

  // ---------- Track / State changes ----------
  player.addListener('player_state_changed', state => {
    if (!state) {
      updateStatus('Player state unavailable');
      return;
    }
    const { paused, duration, position, track_window } = state;
    const track = track_window.current_track;
    updateStatus(`Now ${paused ? 'paused' : 'playing'}: ${track.name} — ${track.artists.map(a => a.name).join(', ')}`);

    // Detect real "new track"
    if (track.id !== currentTrackId) {
      currentTrackId = track.id;
      fadeStarted = false;

      // Compute fade start time:
      const durationSec = Math.floor(duration / 1000);
      fadeStartAtSec = Math.max(0, Math.min(115, durationSec - 5));

      console.log(`🎵 New track: ${track.name} — duration=${durationSec}s, fadeStartAt=${fadeStartAtSec}s`);

      // Reset any running fade
      if (fadeInterval) { clearInterval(fadeInterval); fadeInterval = null; }

      // Restore full volume at the very start of the new track
      player.setVolume(1.0)
        .then(() => console.log('🔊 Volume restored to 100% at track start'))
        .catch(err => console.error('Volume restore failed:', err));
    }
  });

  // ---------- Fade-out logic (unchanged) ----------
  function startFadeOutAndSkip() {
    if (fadeStarted) return;
    fadeStarted = true;

    console.log('🎚 Starting 5s fade-out…');
    let volume = 1.0;
    const stepMs = 250;
    const totalMs = 5000;
    const steps = totalMs / stepMs;
    const step = 1 / steps;

    if (fadeInterval) clearInterval(fadeInterval);
    fadeInterval = setInterval(async () => {
      volume = Math.max(0, volume - step);
      try { await player.setVolume(volume); } catch (e) { console.error('Volume set failed:', e); }
      console.log(`🔉 Volume: ${(volume * 100).toFixed(0)}%`);
      if (volume <= 0) {
        clearInterval(fadeInterval); fadeInterval = null;
        console.log('⏭ Fade complete — skipping track');
        try { await player.nextTrack(); } catch (e) { console.error('nextTrack failed:', e); }
      }
    }, stepMs);
  }

  // ---------- ready handler ----------
  player.addListener('ready', async ({ device_id }) => {
    console.log('✅ Ready with Device ID', device_id);
    updateStatus('Player ready. Device ID: ' + device_id);
    window.spotifyDeviceId = device_id;

    // transfer playback to this device
    try {
      const tokenNow = localStorage.getItem('spotify_token');
      await fetch('https://api.spotify.com/v1/me/player', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tokenNow}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_ids: [device_id], play: true })
      });
      console.log('🎧 Playback transferred to Web SDK device');
    } catch (err) {
      console.error('❌ Failed to transfer playback automatically:', err);
    }

    // position poller to trigger fade
    if (!positionPoller) {
      positionPoller = setInterval(async () => {
        try {
          const state = await player.getCurrentState();
          if (!state) return;
          const positionSec = Math.floor(state.position / 1000);
          const durationSec = Math.floor(state.duration / 1000);
          const track = state.track_window.current_track;
          if (track && track.id !== currentTrackId) {
            currentTrackId = track.id; fadeStarted = false;
            fadeStartAtSec = Math.max(0, Math.min(115, durationSec - 5));
            console.log(`(poll) 🆕 Track change detected — ${track.name}, duration=${durationSec}s, fadeStartAt=${fadeStartAtSec}s`);
            try { await player.setVolume(1.0); } catch (e) {}
          }
          if (!fadeStarted && fadeStartAtSec != null && positionSec >= fadeStartAtSec) {
            console.log(`⏱ Reached fade point at ${positionSec}s (of ${durationSec}s).`);
            startFadeOutAndSkip();
          }
        } catch (e) { /* ignore transient */ }
      }, 500);
    }
  });

  // ---------- not_ready ----------
  player.addListener('not_ready', ({ device_id }) => {
    console.log('⚠️ Device ID has gone offline', device_id);
    updateStatus('Device went offline');
  });

  // connect
  player.connect();

  // UI helpers & buttons (keep your existing handlers)
  function updateStatus(msg) { document.getElementById('status').innerText = msg; }

  document.getElementById('play').addEventListener('click', async () => { await transferPlaybackHere(true); player.resume(); });
  document.getElementById('pause').addEventListener('click', () => player.pause());
  document.getElementById('next').addEventListener('click', () => player.nextTrack());
  document.getElementById('previous').addEventListener('click', () => player.previousTrack());

  async function transferPlaybackHere(autoplay = false) {
    const tokenNow = localStorage.getItem('spotify_token');
    const deviceId = window.spotifyDeviceId;
    if (!deviceId) { updateStatus('Device ID not ready yet'); return; }
    try {
      await fetch('https://api.spotify.com/v1/me/player', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tokenNow}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_ids: [deviceId], play: autoplay })
      });
      updateStatus('Playback transferred to this device');
    } catch (error) { console.error('Error transferring playback:', error); updateStatus('Failed to transfer playback'); }
  }
}

/* ---------------- wait until Spotify SDK calls this, then wait for token (poll + event) ---------------- */
window.onSpotifyWebPlaybackSDKReady = () => {
  // try to initialize if token is already present, else wait up to 10s, also listen for event
  const tryInit = async () => {
    let token = localStorage.getItem('spotify_token');
    const start = Date.now();
    while (!token && (Date.now() - start) < 10000) { // 10s timeout
      console.log('⏳ Waiting for spotify_token to appear in localStorage...');
      await new Promise(r => setTimeout(r, 300));
      token = localStorage.getItem('spotify_token');
    }
    if (token) {
      console.log('✅ Token found — initializing player.');
      initPlayer();
      return;
    }
    // fallback: listen for event dispatched by auth.js
    console.log('🔔 No token yet — attaching event listener for spotify_token_ready.');
    window.addEventListener('spotify_token_ready', () => {
      console.log('🔔 spotify_token_ready received — initializing player.');
      initPlayer();
    }, { once: true });

    // if still no token after additional timeout, show message
    setTimeout(() => {
      if (!localStorage.getItem('spotify_token')) {
        document.getElementById('status').innerText = 'No Spotify token found. Please log in first.';
        console.warn('No spotify_token within timeout — user must re-login.');
      }
    }, 15000);
  };

  tryInit();
};
