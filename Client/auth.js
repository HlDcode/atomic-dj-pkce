const backendUrl = 'https://atomic-dj-pkce.onrender.com';
const tokenEndpoint = `${backendUrl}/exchange_token`;
const refreshEndpoint = `${backendUrl}/refresh_token`;

// ✅ Direct landing page for auth
const REDIRECT_URI = 'https://atomic-dj.netlify.app/player.html';

// ---------------- PKCE Helpers ----------------
async function generateCodeVerifier(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map(x => chars[x % chars.length])
    .join('');
}

async function sha256(str) {
  const buf = new TextEncoder().encode(str);
  return crypto.subtle.digest('SHA-256', buf);
}

function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateCodeChallenge(v) {
  const hashed = await sha256(v);
  return base64UrlEncode(hashed);
}

// ---------------- Redirect to Spotify ----------------
async function redirectToSpotifyAuth() {
  // Clear tokens when starting fresh login
  localStorage.removeItem('spotify_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('token_expiry');
  localStorage.removeItem('code_verifier');

  const clientId = 'c2991b13ad5144b682be422d813e0c90';
  const scopes = 'streaming user-read-playback-state user-modify-playback-state app-remote-control';

  const verifier = await generateCodeVerifier(128);
  const challenge = await generateCodeChallenge(verifier);
  localStorage.setItem('code_verifier', verifier);

  const state = Math.random().toString(36).substring(2, 15);
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.append('client_id', clientId);
  url.searchParams.append('response_type', 'code');
  url.searchParams.append('redirect_uri', REDIRECT_URI);
  url.searchParams.append('code_challenge_method', 'S256');
  url.searchParams.append('code_challenge', challenge);
  url.searchParams.append('scope', scopes);
  url.searchParams.append('state', state);

  console.log('➡️ Redirecting to Spotify with redirect_uri:', REDIRECT_URI);
  window.location = url.toString();
}

// ---------------- Exchange Code for Token ----------------
async function fetchAccessToken(code) {
  const codeVerifier = localStorage.getItem('code_verifier');

  console.log('Exchanging token with:', {
    code,
    hasVerifier: !!codeVerifier,
    redirect_uri: REDIRECT_URI
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI
    }),
  });

  return await response.json();
}

// ---------------- Refresh Access Token ----------------
async function refreshAccessToken() {
  const refresh_token = localStorage.getItem('refresh_token');
  if (!refresh_token) {
    console.warn('No refresh token found — user must log in again.');
    return false;
  }

  try {
    const response = await fetch(refreshEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token })
    });

    const data = await response.json();
    if (data.access_token) {
      localStorage.setItem('spotify_token', data.access_token);
      const expires_in = data.expires_in || 3600;
      localStorage.setItem('token_expiry', Date.now() + expires_in * 1000);
      console.log('♻️ Access token refreshed.');
      return true;
    } else {
      console.error('❌ Refresh token failed:', data);
      return false;
    }
  } catch (err) {
    console.error('🔥 Refresh error:', err);
    return false;
  }
}

// ---------------- Handle Redirect After Login ----------------
(async () => {
  const params = new URLSearchParams(window.location.search);

  if (params.has('code')) {
    const code = params.get('code');
    console.log('✅ Found authorization code:', code);

    const tokenData = await fetchAccessToken(code);
    console.log('🎯 Received token data:', tokenData);

    if (tokenData.access_token) {
      localStorage.setItem('spotify_token', tokenData.access_token);
      if (tokenData.refresh_token) {
        localStorage.setItem('refresh_token', tokenData.refresh_token);
      }
      const expires_in = tokenData.expires_in || 3600;
      localStorage.setItem('token_expiry', Date.now() + expires_in * 1000);

      // ✅ Stay on player.html and remove ?code param
      window.history.replaceState({}, document.title, window.location.pathname);
    } else {
      document.getElementById('status').innerText =
        '❌ Token exchange failed: ' + JSON.stringify(tokenData);
    }
  } else {
    // 🚀 Auto-refresh if token exists
    const token = localStorage.getItem('spotify_token');
    const expiry = localStorage.getItem('token_expiry');

    if (token && expiry) {
      if (Date.now() > expiry - 60000) {
        const refreshed = await refreshAccessToken();
        if (!refreshed) {
          console.log('⚠️ Token refresh failed — redirecting to login.');
          redirectToSpotifyAuth();
        }
      }
    } else {
      console.log('🔑 No token — redirecting to login.');
      redirectToSpotifyAuth();
    }
  }
})();

// Attach login button
const loginBtn = document.getElementById('login');
if (loginBtn) {
  loginBtn.onclick = redirectToSpotifyAuth;
}
