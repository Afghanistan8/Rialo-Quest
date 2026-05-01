// /api/admin-approve.js
// Admin endpoint to approve pending Discord/X submissions
// Protected by ADMIN_SECRET environment variable

const { ethers } = require('ethers');

const QUEST_MANAGER_ADDRESS = '0xC8E3c576c6aBC7536f7B158220e146aEE44C0725';
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const QUEST_MANAGER_ABI = [
  'function completeQuest(address user, uint256 questId) external',
  'function hasCompleted(address user, uint256 questId) view returns (bool)'
];

// In a real production setup, this list should live in a shared DB (Vercel KV, Postgres, etc.)
// For now we assume the same process holds it. If you want admin to actually persist across
// requests, use Vercel KV. See bottom of file for upgrade path.
const pendingSubmissions = require('./complete-quest').pendingSubmissions || [];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check
  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // GET: list pending submissions
  if (req.method === 'GET') {
    return res.status(200).json({
      pending: pendingSubmissions.filter(s => s.status === 'pending'),
      total: pendingSubmissions.length
    });
  }

  // POST: approve or reject a submission
  if (req.method === 'POST') {
    try {
      const { submissionId, action } = req.body || {};
      if (!submissionId || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'submissionId and action (approve|reject) required' });
      }

      const sub = pendingSubmissions.find(s => s.id === submissionId);
      if (!sub) return res.status(404).json({ error: 'Submission not found' });
      if (sub.status !== 'pending') {
        return res.status(400).json({ error: `Already ${sub.status}` });
      }

      if (action === 'reject') {
        sub.status = 'rejected';
        return res.status(200).json({ success: true, status: 'rejected' });
      }

      // Approve → mint onchain
      const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
      const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
      const contract = new ethers.Contract(QUEST_MANAGER_ADDRESS, QUEST_MANAGER_ABI, wallet);

      const alreadyDone = await contract.hasCompleted(sub.userAddress, sub.questId);
      if (alreadyDone) {
        sub.status = 'already_completed';
        return res.status(200).json({ success: false, error: 'Already completed onchain' });
      }

      const tx = await contract.completeQuest(sub.userAddress, sub.questId);
      await tx.wait();

      sub.status = 'approved';
      sub.txHash = tx.hash;

      return res.status(200).json({
        success: true,
        status: 'approved',
        txHash: tx.hash,
        explorerUrl: `https://sepolia.basescan.org/tx/${tx.hash}`
      });
    } catch (err) {
      console.error('admin-approve error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

/* ─── PRODUCTION UPGRADE PATH ────────────────────────────
   Replace the in-memory pendingSubmissions array with Vercel KV:
   
   1. Install: npm install @vercel/kv
   2. Add env vars: KV_REST_API_URL, KV_REST_API_TOKEN
   3. Replace the array operations with:
      const { kv } = require('@vercel/kv');
      // Save:    await kv.lpush('pending', JSON.stringify(submission));
      // List:    const items = await kv.lrange('pending', 0, -1);
      // Update:  use a hash: kv.hset('submission:id', { status: 'approved' });
   ──────────────────────────────────────────────────────── */
