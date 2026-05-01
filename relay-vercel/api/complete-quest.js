// /api/complete-quest.js
// Verifies quest completion and mints onchain via QuestManager

const { ethers } = require('ethers');

// ─── CONFIG ─────────────────────────────────────────────
const QUEST_MANAGER_ADDRESS = '0xC8E3c576c6aBC7536f7B158220e146aEE44C0725';
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';

// QuestManager ABI (minimal - just what we need)
const QUEST_MANAGER_ABI = [
  'function completeQuest(address user, uint256 questId) external',
  'function hasCompleted(address user, uint256 questId) view returns (bool)'
];

// ─── IRL EVENT CODES (Quest 4) ──────────────────────────
// Pre-generated codes you hand out at events. Add/remove as needed.
const VALID_IRL_CODES = new Set([
  'RIALO-MEET-001', 'RIALO-MEET-002', 'RIALO-MEET-003',
  'RIALO-MEET-004', 'RIALO-MEET-005', 'RIALO-MEET-006',
  'RIALO-MEET-007', 'RIALO-MEET-008', 'RIALO-MEET-009',
  'RIALO-MEET-010', 'RIALO-LAGOS-001', 'RIALO-LAGOS-002',
  'RIALO-LAGOS-003', 'RIALO-LAGOS-004', 'RIALO-LAGOS-005'
]);

// In-memory used-codes set (resets on cold start - upgrade to KV/DB later)
const usedCodes = new Set();

// In-memory pending submissions for manual review (Discord, X)
// Upgrade to Vercel KV or a proper DB for persistence
const pendingSubmissions = [];

// ─── VERIFIERS ──────────────────────────────────────────

// Quest 1: Deploy on Base — verify contract deployment tx
async function verifyBaseDeployment(userAddress, txHash) {
  if (!txHash || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { ok: false, reason: 'Invalid transaction hash format' };
  }

  try {
    const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
      return { ok: false, reason: 'Transaction not found on Base Sepolia' };
    }
    if (receipt.status !== 1) {
      return { ok: false, reason: 'Transaction failed onchain' };
    }
    if (receipt.from.toLowerCase() !== userAddress.toLowerCase()) {
      return { ok: false, reason: 'Transaction was not sent from your wallet' };
    }
    if (receipt.contractAddress === null) {
      return { ok: false, reason: 'This transaction is not a contract deployment' };
    }

    return { ok: true, message: `Verified deployment at ${receipt.contractAddress}` };
  } catch (err) {
    return { ok: false, reason: `RPC error: ${err.message}` };
  }
}

// Quest 3: GitHub Repository — verify public repo exists with rialo mention
async function verifyGitHubRepo(githubUsername) {
  if (!githubUsername || !/^[a-zA-Z0-9-]{1,39}$/.test(githubUsername)) {
    return { ok: false, reason: 'Invalid GitHub username' };
  }

  try {
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const res = await fetch(
      `https://api.github.com/users/${githubUsername}/repos?per_page=100&sort=updated`,
      { headers }
    );

    if (res.status === 404) return { ok: false, reason: 'GitHub user not found' };
    if (!res.ok) return { ok: false, reason: `GitHub API error: ${res.status}` };

    const repos = await res.json();
    const rialoRepo = repos.find(r => {
      const name = (r.name || '').toLowerCase();
      const desc = (r.description || '').toLowerCase();
      return name.includes('rialo') || desc.includes('rialo');
    });

    if (!rialoRepo) {
      return { ok: false, reason: 'No public repo with "rialo" found. Create one and try again.' };
    }

    return { ok: true, message: `Verified repo: ${rialoRepo.full_name}` };
  } catch (err) {
    return { ok: false, reason: `GitHub check failed: ${err.message}` };
  }
}

// Quest 4: Show Up IRL — verify event code
function verifyIRLCode(code) {
  if (!code) return { ok: false, reason: 'Code required' };
  const normalized = code.trim().toUpperCase();
  if (!VALID_IRL_CODES.has(normalized)) {
    return { ok: false, reason: 'Invalid event code' };
  }
  if (usedCodes.has(normalized)) {
    return { ok: false, reason: 'This code has already been used' };
  }
  usedCodes.add(normalized);
  return { ok: true, message: `Code ${normalized} accepted` };
}

// Quest 2 & 5: Manual review (Discord, X)
function queueForReview(userAddress, questId, proof) {
  if (!proof || proof.length < 3) {
    return { ok: false, reason: 'Proof URL/handle required' };
  }
  pendingSubmissions.push({
    id: `${userAddress}-${questId}-${Date.now()}`,
    userAddress,
    questId,
    proof,
    submittedAt: new Date().toISOString(),
    status: 'pending'
  });
  return {
    ok: true,
    pending: true,
    message: 'Submission received! An admin will review and approve within 24 hours.'
  };
}

// ─── ONCHAIN MINT ───────────────────────────────────────
async function mintQuestCompletion(userAddress, questId) {
  if (!process.env.RELAYER_PRIVATE_KEY) {
    throw new Error('Relayer not configured (missing RELAYER_PRIVATE_KEY)');
  }

  const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
  const wallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(QUEST_MANAGER_ADDRESS, QUEST_MANAGER_ABI, wallet);

  // Check if already completed
  const alreadyDone = await contract.hasCompleted(userAddress, questId);
  if (alreadyDone) {
    return { txHash: null, alreadyCompleted: true };
  }

  const tx = await contract.completeQuest(userAddress, questId);
  await tx.wait();
  return { txHash: tx.hash, alreadyCompleted: false };
}

// ─── MAIN HANDLER ───────────────────────────────────────
module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userAddress, questId, proof } = req.body || {};

    // Validation
    if (!userAddress || !ethers.isAddress(userAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid user address' });
    }
    if (!questId || typeof questId !== 'number') {
      return res.status(400).json({ success: false, error: 'questId must be a number' });
    }

    // Route to appropriate verifier
    let verification;
    switch (questId) {
      case 1:
        verification = await verifyBaseDeployment(userAddress, proof);
        break;
      case 2:
        verification = queueForReview(userAddress, 2, proof); // Discord
        break;
      case 3:
        verification = await verifyGitHubRepo(proof);
        break;
      case 4:
        verification = verifyIRLCode(proof);
        break;
      case 5:
        verification = queueForReview(userAddress, 5, proof); // X
        break;
      default:
        return res.status(400).json({ success: false, error: 'Unknown questId' });
    }

    if (!verification.ok) {
      return res.status(400).json({ success: false, error: verification.reason });
    }

    // If pending review, return without minting
    if (verification.pending) {
      return res.status(200).json({
        success: true,
        pending: true,
        message: verification.message
      });
    }

    // Verified! Mint onchain
    const mint = await mintQuestCompletion(userAddress, questId);
    if (mint.alreadyCompleted) {
      return res.status(200).json({
        success: false,
        error: 'Quest already completed for this address'
      });
    }

    return res.status(200).json({
      success: true,
      message: verification.message,
      txHash: mint.txHash,
      explorerUrl: `https://sepolia.basescan.org/tx/${mint.txHash}`
    });

  } catch (err) {
    console.error('complete-quest error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Export pending list for admin endpoint (in production, use shared DB)
module.exports.pendingSubmissions = pendingSubmissions;
