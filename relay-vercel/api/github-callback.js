// /api/github-callback.js
// Handles GitHub OAuth callback, verifies user, mints quest onchain.

const { createClient } = require('redis');
const { createWalletClient, createPublicClient, http, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

const QUEST_MANAGER_ADDRESS = process.env.NEXT_PUBLIC_QUEST_MANAGER_CONTRACT;
const ALCHEMY_URL = process.env.NEXT_PUBLIC_ALCHEMY_URL || 'https://sepolia.base.org';
const QUEST_STRING_ID = 'github-first-pr';
const FRONTEND_URL = 'https://rialo-quest.vercel.app';

const QUEST_MANAGER_ABI = parseAbi([
  'function completeQuestAsRelayer(address player, string calldata questId) external',
  'function hasCompleted(string calldata questId, address player) external view returns (bool)'
]);

let redisClient = null;
async function getRedis() {
  if (redisClient && redisClient.isReady) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error:', err));
  await redisClient.connect();
  return redisClient;
}

function redirectWithStatus(res, status, message, extra = {}) {
  const url = new URL(FRONTEND_URL);
  url.searchParams.set('github_status', status);
  url.searchParams.set('github_msg', message);
  for (const [k, v] of Object.entries(extra)) {
    if (v) url.searchParams.set(k, v);
  }
  res.redirect(302, url.toString());
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { code, state, error: ghError } = req.query;

  if (ghError) return redirectWithStatus(res, 'error', 'GitHub access denied');
  if (!code || !state) return redirectWithStatus(res, 'error', 'Missing OAuth parameters');

  // Retrieve wallet from state
  let walletAddress;
  try {
    const redis = await getRedis();
    walletAddress = await redis.get(`oauth-state:${state}`);
    if (!walletAddress) {
      return redirectWithStatus(res, 'error', 'OAuth session expired. Try again.');
    }
    await redis.del(`oauth-state:${state}`);
  } catch (err) {
    console.error('Redis error:', err);
    return redirectWithStatus(res, 'error', 'Session storage error');
  }

  try {
    // Step 1: Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('GitHub token error:', tokenData);
      return redirectWithStatus(res, 'error', 'Failed to authenticate with GitHub');
    }

    // Step 2: Get user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (!userRes.ok) return redirectWithStatus(res, 'error', 'Failed to fetch GitHub profile');
    const githubUser = await userRes.json();
    const username = githubUser.login;

    // Step 3: Verify merged PRs
    const searchRes = await fetch(
      `https://api.github.com/search/issues?q=author:${username}+type:pr+is:merged`,
      {
        headers: {
          'Authorization': `Bearer ${tokenData.access_token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      }
    );
    const searchData = await searchRes.json();
    const prCount = searchData.total_count || 0;

    if (prCount === 0) {
      return redirectWithStatus(res, 'error',
        `@${username} has no merged PRs yet. Contribute to any open-source repo and try again.`);
    }

    // Step 4: Save mapping (audit trail)
    try {
      const redis = await getRedis();
      await redis.set(`github-user:${username.toLowerCase()}`, JSON.stringify({
        wallet: walletAddress,
        verifiedAt: new Date().toISOString(),
        prCount
      }));
    } catch (e) { /* non-fatal */ }

    // Step 5: Check if already completed
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(ALCHEMY_URL) });
    const alreadyDone = await publicClient.readContract({
      address: QUEST_MANAGER_ADDRESS,
      abi: QUEST_MANAGER_ABI,
      functionName: 'hasCompleted',
      args: [QUEST_STRING_ID, walletAddress]
    });

    if (alreadyDone) {
      return redirectWithStatus(res, 'info',
        `Quest already completed for this wallet. Verified @${username} (${prCount} merged PRs).`);
    }

    // Step 6: Mint
    if (!process.env.RELAYER_PRIVATE_KEY) {
      return redirectWithStatus(res, 'error', 'Relayer not configured');
    }
    const pk = process.env.RELAYER_PRIVATE_KEY.startsWith('0x')
      ? process.env.RELAYER_PRIVATE_KEY
      : `0x${process.env.RELAYER_PRIVATE_KEY}`;

    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(ALCHEMY_URL) });

    const txHash = await walletClient.writeContract({
      address: QUEST_MANAGER_ADDRESS,
      abi: QUEST_MANAGER_ABI,
      functionName: 'completeQuestAsRelayer',
      args: [walletAddress, QUEST_STRING_ID]
    });

    return redirectWithStatus(res, 'success',
      `Verified @${username} with ${prCount} merged PRs. +200 XP minted!`,
      { tx: txHash, github: username });

  } catch (err) {
    console.error('github-callback error:', err);
    return redirectWithStatus(res, 'error', err.message || 'OAuth failed');
  }
};
