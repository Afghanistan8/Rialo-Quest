// /api/admin-approve.js
// Admin endpoint to approve pending Discord/X submissions

const { createWalletClient, createPublicClient, http, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

const QUEST_MANAGER_ADDRESS = process.env.NEXT_PUBLIC_QUEST_MANAGER_CONTRACT;
const ALCHEMY_URL = process.env.NEXT_PUBLIC_ALCHEMY_URL || 'https://sepolia.base.org';

const QUEST_MANAGER_ABI = parseAbi([
  'function completeQuestAsRelayer(address player, string calldata questId) external',
  'function hasCompleted(string calldata questId, address player) external view returns (bool)'
]);

const completeQuest = require('./complete-quest');
const pendingSubmissions = completeQuest.pendingSubmissions || [];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const adminSecret = req.headers['x-admin-secret'];
  if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      pending: pendingSubmissions.filter(s => s.status === 'pending'),
      total: pendingSubmissions.length
    });
  }

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
      const publicClient = createPublicClient({ chain: baseSepolia, transport: http(ALCHEMY_URL) });
      const alreadyDone = await publicClient.readContract({
        address: QUEST_MANAGER_ADDRESS,
        abi: QUEST_MANAGER_ABI,
        functionName: 'hasCompleted',
        args: [sub.questStringId, sub.userAddress]
      });
      if (alreadyDone) {
        sub.status = 'already_completed';
        return res.status(200).json({ success: false, error: 'Already completed onchain' });
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

      return res.status(200).json({
        success: true,
        status: 'approved',
        txHash,
        explorerUrl: `https://sepolia.basescan.org/tx/${txHash}`
      });
    } catch (err) {
      console.error('admin-approve error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
