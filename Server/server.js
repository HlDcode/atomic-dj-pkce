import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 8888;

// ✅ Redirect URI must match Spotify dashboard exactly
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
if (!REDIRECT_URI) {
  throw new Error("Missing SPOTIFY_REDIRECT_URI in environment variables");
}

app.use(cors());
app.use(bodyParser.json());

// 🎯 Exchange Authorization Code for Access Token
app.post('/exchange_token', async (req, res) => {
  const { code, code_verifier, redirect_uri } = req.body;

  console.log('📥 Token exchange request:', {
    hasCode: !!code,
    hasVerifier: !!code_verifier,
    redirect_uri_client: redirect_uri,
    redirect_uri_server: REDIRECT_URI
  });

  if (!code || !code_verifier) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const params = new URLSearchParams({
      client_id: process.env.SPOTIFY_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI, // ✅ Force our redirect URI
      code_verifier
    });

    console.log('📤 Sending token request to Spotify with redirect_uri:', REDIRECT_URI);

    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    const data = await tokenResponse.json();

    if (data.error) {
      console.error('❌ Spotify token error:', data);
      return res.status(400).json(data);
    }

    console.log('✅ Token exchange successful.');
    res.json(data); // contains access_token, refresh_token, expires_in
  } catch (err) {
    console.error('🔥 Exchange error:', err);
    res.status(500).json({ error: 'Token exchange failed' });
  }
});

// ♻️ Refresh Access Token
app.post('/refresh_token', async (req, res) => {
  const { refresh_token } = req.body;

  console.log('♻️ Refresh token request received.');

  if (!refresh_token) {
    return res.status(400).json({ error: 'Missing refresh_token' });
  }

  try {
    const params = new URLSearchParams({
      client_id: process.env.SPOTIFY_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token
    });

    console.log('📤 Sending refresh request to Spotify...');

    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });

    const data = await tokenResponse.json();

    if (data.error) {
      console.error('❌ Spotify refresh error:', data);
      return res.status(400).json(data);
    }

    console.log('✅ Token refresh successful.');
    res.json(data); // contains new access_token
  } catch (err) {
    console.error('🔥 Refresh error:', err);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Spotify PKCE backend running on https://atomic-dj-pkce.onrender.com`);
  console.log(`Expected redirect URI: ${REDIRECT_URI}`);
});
