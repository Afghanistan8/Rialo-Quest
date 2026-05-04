// /api/github-auth.js
// Initiates GitHub OAuth flow.
// Frontend redirects user here with their wallet address as ?wallet=0x...
// We then redirect to GitHub's authorization page with that wallet stored in the state.

const crypto = require('crypto');
const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { wallet } = req.query;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    return res.status(400).json({ error: 'Valid wallet address required' });
  }

  if (!process.env.GITHUB_CLIENT_ID) {
    return res.status(500).json({ error: 'GitHub OAuth not configured' });
  }

  // Generate a random state token to prevent CSRF — store wallet against it
  const state = crypto.randomBytes(16).toString('hex');

  try {
    // Store the wallet address keyed by state, expires in 10 min
    await kv.set(`oauth-state:${state}`, wallet.toLowerCase(), { ex: 600 });
  } catch (err) {
    console.error('KV error:', err);
    return res.status(500).json({ error: 'Storage error: ' + err.message });
  }

  const redirectUri = `https://${req.headers.host}/api/github-callback`;
  const githubUrl = new URL('https://github.com/login/oauth/authorize');
  githubUrl.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set('redirect_uri', redirectUri);
  githubUrl.searchParams.set('scope', 'read:user');
  githubUrl.searchParams.set('state', state);

  res.redirect(302, githubUrl.toString());
};
