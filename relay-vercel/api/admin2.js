// /api/admin2.js
// Fresh admin endpoint. Lives in the RELAY project.
// Auth: ?secret=PASSWORD in URL (no headers = no CORS preflight)
// Methods: GET to list, GET with ?action=approve&id=X or ?action=reject&id=X to act

const { createWalletClient, createPublicClient, http, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');
const { createClient } = require('redis');

const PASSWORD = 'rialo2026';

const QUEST_MANAGER_ADDRESS = process.env.NEXT_PUBLIC_QUEST_MANAGER_CONTRACT || '0xC8E3c576c6aBC7536f7B158220e146aEE44C0725';
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
  // Permissive CORS — allow all origins
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const secret = (req.query.secret || '').trim();
    if (secret !== PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized', hint: 'pass ?secret=PASSWORD' });
    }

    const action = (req.query.action || 'list').toLowerCase();
    const id = req.query.id;
    const filter = (req.query.filter || 'pending').toLowerCase();

    const redis = await getRedis();

    // ─── LIST ───
    if (action === 'list') {
      const pendingIds = await redis.zRange('pending-submissions', 0, -1, { REV: true });
      const historyIds = await redis.zRange('history-submissions', 0, -1, { REV: true });
      const ids = filter === 'history' ? historyIds : pendingIds;

      const submissions = [];
      for (const sid of ids.slice(0, 50)) {
        const json = await redis.get(`submission:${sid}`);
        if (json) submissions.push(JSON.parse(json));
      }
      return res.status(200).json({
        submissions,
        counts: { pending: pendingIds.length, history: historyIds.length }
      });
    }

    // ─── REJECT ───
    if (action === 'reject') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const subJson = await redis.get(`submission:${id}`);
      if (!subJson) return res.status(404).json({ error: 'not found' });
      const sub = JSON.parse(subJson);
      if (sub.status !== 'pending') return res.status(400).json({ error: 'already ' + sub.status });

      sub.status = 'rejected';
      sub.reviewedAt = new Date().toISOString();
      await redis.set(`submission:${id}`, JSON.stringify(sub));
      await redis.zRem('pending-submissions', id);
      await redis.zAdd('history-submissions', { score: Date.now(), value: id });
      return res.status(200).json({ success: true, status: 'rejected' });
    }

    // ─── APPROVE → mint onchain ───
    if (action === 'approve') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const subJson = await redis.get(`submission:${id}`);
      if (!subJson) return res.status(404).json({ error: 'not found' });
      const sub = JSON.parse(subJson);
      if (sub.status !== 'pending') return res.status(400).json({ error: 'already ' + sub.status });

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
        await redis.set(`submission:${id}`, JSON.stringify(sub));
        await redis.zRem('pending-submissions', id);
        await redis.zAdd('history-submissions', { score: Date.now(), value: id });
        return res.status(200).json({ success: false, error: 'already completed onchain' });
      }

      const pk = process.env.RELAYER_PRIVATE_KEY.startsWith('0x')
        ? process.env.RELAYER_PRIVATE_KEY
        : '0x' + process.env.RELAYER_PRIVATE_KEY;
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
      await redis.set(`submission:${id}`, JSON.stringify(sub));
      await redis.zRem('pending-submissions', id);
      await redis.zAdd('history-submissions', { score: Date.now(), value: id });

      return res.status(200).json({
        success: true,
        status: 'approved',
        txHash,
        explorerUrl: 'https://sepolia.basescan.org/tx/' + txHash
      });
    }

    return res.status(400).json({ error: 'unknown action: ' + action });

  } catch (err) {
    console.error('admin2 error:', err);
    return res.status(500).json({ error: err.message });
  }
};
