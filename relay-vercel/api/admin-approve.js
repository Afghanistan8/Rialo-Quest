// /api/admin-approve.js
// Admin endpoint to list, approve, and reject pending submissions.
// Auth: X-Admin-Secret header must match HARDCODED_ADMIN_SECRET below.

const { createWalletClient, createPublicClient, http, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');
const { createClient } = require('redis');

// ─── HARDCODED ADMIN SECRET ────────────────────────────────
// Change this string and redeploy if you ever want to rotate.
const HARDCODED_ADMIN_SECRET = 'rialo2026';
// ───────────────────────────────────────────────────────────

const QUEST_MANAGER_ADDRESS = process.env.NEXT_PUBLIC_QUEST_MANAGER_CONTRACT;
const ALCHEMY_URL = process.env.NEXT_PUBLIC_ALCHEMY_URL || 'https://sepolia.base.org';

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check — uses HARDCODED secret
  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret.trim() !== HARDCODED_ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const redis = await getRedis();

    // ─── GET: list submissions ─────────────────────────
    if (req.method === 'GET') {
      const filter = (req.query.filter || 'pending').toLowerCase();

      const pendingIds = await redis.zRange('pending-submissions', 0, -1, { REV: true });
      const historyIds = await redis.zRange('history-submissions', 0, -1, { REV: true });

      let allIds = [];
      if (filter === 'pending') allIds = pendingIds;
      else if (filter === 'history') allIds = historyIds;
      else allIds = [...pendingIds, ...historyIds];

      const submissions = [];
      for (const id of allIds.slice(0, 100)) {
        const json = await redis.get(`submission:${id}`);
        if (json) submissions.push(JSON.parse(json));
      }

      return res.status(200).json({
        submissions,
        counts: {
          pending: pendingIds.length,
          history: historyIds.length
        }
      });
    }

    // ─── POST: approve or reject ───────────────────────
    if (req.method === 'POST') {
      const { submissionId, action } = req.body || {};
      if (!submissionId || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'submissionId and action (approve|reject) required' });
      }

      const subJson = await redis.get(`submission:${submissionId}`);
      if (!subJson) return res.status(404).json({ error: 'Submission not found' });
      const sub = JSON.parse(subJson);

      if (sub.status !== 'pending') {
        return res.status(400).json({ error: `Already ${sub.status}` });
      }

      if (action === 'reject') {
        sub.status = 'rejected';
        sub.reviewedAt = new Date().toISOString();
        await redis.set(`submission:${submissionId}`, JSON.stringify(sub));
        await redis.zRem('pending-submissions', submissionId);
        await redis.zAdd('history-submissions', { score: Date.now(), value: submissionId });
        return res.status(200).json({ success: true, status: 'rejected', submission: sub });
      }

      // ── Approve → mint onchain ──
      const publicClient = createPublicClient({ chain: baseSepolia, transport: http(ALCHEMY_URL) });
      const alreadyDone = await publicClient.readContract({
        address: QUEST_MANAGER_ADDRESS,
        abi: QUEST_MANAGER_ABI,
        functionName: 'hasCompleted',
        args: [sub.questStringId, sub.userAddress]
      });

      if (alreadyDone) {
        sub.status = 'already_completed';
        sub.reviewedAt = new Date().toISOString();
        await redis.set(`submission:${submissionId}`, JSON.stringify(sub));
        await redis.zRem('pending-submissions', submissionId);
        await redis.zAdd('history-submissions', { score: Date.now(), value: submissionId });
        return res.status(200).json({ success: false, error: 'Already completed onchain', submission: sub });
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
        args: [sub.userAddress, sub.questStringId]
      });

      sub.status = 'approved';
      sub.txHash = txHash;
      sub.reviewedAt = new Date().toISOString();
      await redis.set(`submission:${submissionId}`, JSON.stringify(sub));
      await redis.zRem('pending-submissions', submissionId);
      await redis.zAdd('history-submissions', { score: Date.now(), value: submissionId });

      return res.status(200).json({
        success: true,
        status: 'approved',
        txHash,
        explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`,
        submission: sub
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('admin-approve error:', err);
    return res.status(500).json({ error: err.message });
  }
};
