// /api/github-callback.js
// Handles GitHub OAuth callback, verifies user is a builder, mints quest onchain.
//
// Verification accepts ANY of:
//   1. User has at least 1 merged PR (any public repo)
//   2. User owns a public repo with "rialo" in name/description
//   3. User owns a public repo with at least 5 commits AND not a fork

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

// Multi-criteria builder verification
async function verifyBuilder(username, accessToken) {
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Accept': 'application/vnd.github.v3+json'
  };

  // Criterion 1: Merged PRs
  try {
    const prRes = await fetch(
      `https://api.github.com/search/issues?q=author:${username}+type:pr+is:merged`,
      { headers }
    );
    const prData = await prRes.json();
    const prCount = prData.total_count || 0;
    if (prCount > 0) {
      return { ok: true, reason: `${prCount} merged PR${prCount === 1 ? '' : 's'}`, criterion: 'pr' };
    }
  } catch (e) { console.error('PR check failed:', e); }

  // Criterion 2 & 3: Check user's public repos
  try {
    const repoRes = await fetch(
      `https://api.github.com/users/${username}/repos?per_page=100&sort=updated&type=owner`,
      { headers }
    );
    if (!repoRes.ok) {
      return { ok: false, reason: 'Could not load your repositories' };
    }
    const repos = await repoRes.json();

    // Criterion 2: Rialo-related repo
    const rialoRepo = repos.find(r => {
      if (r.fork) return false;
      const name = (r.name || '').toLowerCase();
      const desc = (r.description || '').toLowerCase();
      return name.includes('rialo') || desc.includes('rialo');
    });
    if (rialoRepo) {
      return { ok: true, reason: `Rialo repo: ${rialoRepo.full_name}`, criterion: 'rialo-repo' };
    }

    // Criterion 3: Any substantial original repo (not a fork, has commits)
    // We'll check the first non-fork, non-empty repo for commit count
    const candidates = repos.filter(r => !r.fork && r.size > 0).slice(0, 5);
    for (const repo of candidates) {
      try {
        const commitsRes = await fetch(
          `https://api.github.com/repos/${repo.full_name}/commits?per_page=1`,
          { headers }
        );
        // GitHub returns last-page link in headers if there are many commits
        const linkHeader = commitsRes.headers.get('link') || '';
        let commitCount = 0;
        const lastMatch = linkHeader.match(/page=(\d+)>;\s*rel="last"/);
        if (lastMatch) {
          commitCount = parseInt(lastMatch[1]);
        } else if (commitsRes.ok) {
          const commits = await commitsRes.json();
          commitCount = commits.length;
        }
        if (commitCount >= 5) {
          return {
            ok: true,
            reason: `Public repo "${repo.name}" with ${commitCount}+ commits`,
            criterion: 'public-repo'
          };
        }
      } catch (e) { /* skip and try next */ }
    }

    // Nothing matched
    return {
      ok: false,
      reason: `@${username} doesn't qualify yet. Need: a merged PR, OR a public repo about Rialo, OR any public repo with 5+ commits.`
    };
  } catch (err) {
    return { ok: false, reason: 'Repo check failed: ' + err.message };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { code, state, error: ghError } = req.query;

  if (ghError) return redirectWithStatus(res, 'error', 'GitHub access denied');
  if (!code || !state) return redirectWithStatus(res, 'error', 'Missing OAuth parameters');

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
    // Exchange code for token
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
      return redirectWithStatus(res, 'error', 'Failed to authenticate with GitHub');
    }

    // Get profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (!userRes.ok) return redirectWithStatus(res, 'error', 'Failed to fetch GitHub profile');
    const githubUser = await userRes.json();
    const username = githubUser.login;

    // Multi-criteria verification
    const verification = await verifyBuilder(username, tokenData.access_token);
    if (!verification.ok) {
      return redirectWithStatus(res, 'error', verification.reason);
    }

    // Save mapping
    try {
      const redis = await getRedis();
      await redis.set(`github-user:${username.toLowerCase()}`, JSON.stringify({
        wallet: walletAddress,
        verifiedAt: new Date().toISOString(),
        criterion: verification.criterion,
        reason: verification.reason
      }));
    } catch (e) { /* non-fatal */ }

    // Check if already minted
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(ALCHEMY_URL) });
    const alreadyDone = await publicClient.readContract({
      address: QUEST_MANAGER_ADDRESS,
      abi: QUEST_MANAGER_ABI,
      functionName: 'hasCompleted',
      args: [QUEST_STRING_ID, walletAddress]
    });

    if (alreadyDone) {
      return redirectWithStatus(res, 'info',
        `Quest already completed for this wallet. Verified @${username} (${verification.reason}).`);
    }

    // Mint
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
      `Verified @${username} · ${verification.reason}. +200 XP minted!`,
      { tx: txHash, github: username });

  } catch (err) {
    console.error('github-callback error:', err);
    return redirectWithStatus(res, 'error', err.message || 'OAuth failed');
  }
};
