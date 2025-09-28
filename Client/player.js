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

/* ---------------- Spotify Player Init ---------------- */
window.onSpotifyWebPlaybackSDKReady = () => {
  let token = localStorage.getItem('spotify_token');
  const playerName = 'Atomic DJ Player';

  if (!token) {
    document.getElementById('status').innerText = 'No Spotify token found. Please log in first.';
    return;
  }

  const player = new Spotify.Player({
    name: playerName,
    getOAuthToken: cb => {
      token = localStorage.getItem('spotify_token'); // always use latest token
      cb(token);
    }
  });

  /* ---------- Errors ---------- */
  player.addListener('initialization_error', ({ message }) => {
    console.error(message);
    updateStatus(`Initialization error: ${message}`);
  });
  player.addListener('authentication_error', async ({ message }) => {
    console.error(message);
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

  /* ---------- Track / State changes ---------- */
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
      //  - If > 2:00, fade at 1:55 (115s)
      //  - Else, fade 5 seconds before end
      const durationSec = Math.floor(duration / 1000);
      fadeStartAtSec = Math.max(0, Math.min(115, durationSec - 5));

      console.log(`🎵 New track: ${track.name} — duration=${durationSec}s, fadeStartAt=${fadeStartAtSec}s`);

      // Reset any running fade
      if (fadeInterval) {
        clearInterval(fadeInterval);
        fadeInterval = null;
      }

      // Restore full volume at the very start of the new track
      player.setVolume(1.0)
        .then(() => console.log('🔊 Volume restored to 100% at track start'))
        .catch(err => console.error('Volume restore failed:', err));
    }
  });

  /* ---------- Fade-out logic ---------- */
  function startFadeOutAndSkip() {
    if (fadeStarted) return;
    fadeStarted = true;

    console.log('🎚 Starting 5s fade-out…');
    let volume = 1.0;
    const stepMs = 250;           // run every 250ms
    const totalMs = 5000;         // 5s fade
    const steps = totalMs / stepMs;
    const step = 1 / steps;       // decrease per tick (0.05)

    if (fadeInterval) clearInterval(fadeInterval);
    fadeInterval = setInterval(async () => {
      volume = Math.max(0, volume - step);
      try {
        await player.setVolume(volume);
      } catch (e) {
        console.error('Volume set failed:', e);
      }
      console.log(`🔉 Volume: ${(volume * 100).toFixed(0)}%`);
      if (volume <= 0) {
        clearInterval(fadeInterval);
        fadeInterval = null;
        console.log('⏭ Fade complete — skipping track');
        try { await player.nextTrack(); } catch (e) { console.error('nextTrack failed:', e); }
      }
    }, stepMs);
  }

  /* ---------- Ready: make sure playback is on this device, then start poller ---------- */
  player.addListener('ready', async ({ device_id }) => {
    console.log('✅ Ready with Device ID', device_id);
    updateStatus('Player ready. Device ID: ' + device_id);
    window.spotifyDeviceId = device_id;

    // Force transfer to this device so setVolume works
    try {
      const tokenNow = localStorage.getItem('spotify_token');
      await fetch('https://api.spotify.com/v1/me/player', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokenNow}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          device_ids: [device_id],
          play: true // auto-start here if something is queued
        })
      });
      console.log('🎧 Playback transferred to Web SDK device');
    } catch (err) {
      console.error('❌ Failed to transfer playback automatically:', err);
    }

    // Start a single poller that decides when to fade based on current position
    if (!positionPoller) {
      console.log('🕒 Starting position poller…');
      positionPoller = setInterval(async () => {
        try {
          const state = await player.getCurrentState();
          if (!state) return; // not active

          const positionSec = Math.floor(state.position / 1000);
          const durationSec = Math.floor(state.duration / 1000);

          // If track changed without our listener catching it (rare), recompute fadeStartAt
          const track = state.track_window.current_track;
          if (track && track.id !== currentTrackId) {
            currentTrackId = track.id;
            fadeStarted = false;
            fadeStartAtSec = Math.max(0, Math.min(115, durationSec - 5));
            console.log(`(poll) 🆕 Track change detected — ${track.name}, duration=${durationSec}s, fadeStartAt=${fadeStartAtSec}s`);
            // restore volume
            try { await player.setVolume(1.0); } catch {}
          }

          // Trigger fade exactly when we pass fadeStartAtSec
          if (!fadeStarted && fadeStartAtSec != null && positionSec >= fadeStartAtSec) {
            console.log(`⏱ Reached fade point at ${positionSec}s (of ${durationSec}s).`);
            startFadeOutAndSkip();
          }
        } catch (e) {
          // ignore transient errors
        }
      }, 500);
    }
  });

  /* ---------- Not Ready ---------- */
  player.addListener('not_ready', ({ device_id }) => {
    console.log('⚠️ Device ID has gone offline', device_id);
    updateStatus('Device went offline');
  });

  /* ---------- Connect ---------- */
  player.connect();

  /* ---------- UI helpers ---------- */
  function updateStatus(msg) {
    document.getElementById('status').innerText = msg;
  }

  /* ---------- Buttons ---------- */
  document.getElementById('play').addEventListener('click', async () => {
    await transferPlaybackHere(true);
    player.resume();
  });

  document.getElementById('pause').addEventListener('click', () => {
    player.pause();
  });

  document.getElementById('next').addEventListener('click', () => {
    player.nextTrack();
  });

  document.getElementById('previous').addEventListener('click', () => {
    player.previousTrack();
  });

  async function transferPlaybackHere(autoplay = false) {
    const tokenNow = localStorage.getItem('spotify_token');
    const deviceId = window.spotifyDeviceId;
    if (!deviceId) {
      updateStatus('Device ID not ready yet');
      return;
    }
    try {
      await fetch('https://api.spotify.com/v1/me/player', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokenNow}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ device_ids: [deviceId], play: autoplay })
      });
      updateStatus('Playback transferred to this device');
    } catch (error) {
      console.error('Error transferring playback:', error);
      updateStatus('Failed to transfer playback');
    }
  }

  // 🔄 Background token refresh every 55 minutes
  setInterval(async () => {
    console.log('⏳ Checking if token needs refresh…');
    const expiry = localStorage.getItem('token_expiry');
    if (expiry && Date.now() > expiry - 60000) {
      console.log('♻️ Refreshing token before expiry…');
      await refreshAccessToken();
    }
  }, 3300000);
};

/* ---------------- IMPORTANT: make sure only THIS file defines window.onSpotifyWebPlaybackSDKReady ----------------
   If your page also includes another script (e.g., script.js) that sets window.onSpotifyWebPlaybackSDKReady,
   it will override this one and the fade will never run. Remove any second definition from the page. */
