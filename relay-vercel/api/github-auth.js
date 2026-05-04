// /api/github-auth.js
// Initiates GitHub OAuth flow.

const crypto = require('crypto');
const { createClient } = require('redis');

let redisClient = null;
async function getRedis() {
  if (redisClient && redisClient.isReady) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error:', err));
  await redisClient.connect();
  return redisClient;
}

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
  if (!process.env.REDIS_URL) {
    return res.status(500).json({ error: 'Redis not configured (missing REDIS_URL)' });
  }

  const state = crypto.randomBytes(16).toString('hex');

  try {
    const redis = await getRedis();
    // Store wallet keyed by state token, expire in 10 min
    await redis.set(`oauth-state:${state}`, wallet.toLowerCase(), { EX: 600 });
  } catch (err) {
    console.error('Redis error:', err);
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
