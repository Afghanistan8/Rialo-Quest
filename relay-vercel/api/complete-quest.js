// /api/complete-quest.js
// Verifies quest completion and mints onchain via QuestManager.completeQuestAsRelayer

const { createWalletClient, createPublicClient, http, parseAbi, isAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

// ─── CONFIG ─────────────────────────────────────────────
const QUEST_MANAGER_ADDRESS = process.env.NEXT_PUBLIC_QUEST_MANAGER_CONTRACT;
const ALCHEMY_URL = process.env.NEXT_PUBLIC_ALCHEMY_URL || 'https://sepolia.base.org';

const QUEST_MANAGER_ABI = parseAbi([
  'function completeQuestAsRelayer(address player, string calldata questId) external',
  'function hasCompleted(string calldata questId, address player) external view returns (bool)'
]);

// ─── QUEST MAP ──────────────────────────────────────────
// Maps frontend numeric IDs to actual onchain string IDs
const QUEST_MAP = {
  1: { id: 'first-deploy',     trigger: 'onchain-self',  xp: 150 },  // Player must call directly
  2: { id: 'discord-og',       trigger: 'manual',        xp: 100 },  // Manual review
  3: { id: 'github-first-pr',  trigger: 'github',        xp: 200 },  // Auto verify
  4: { id: 'first-irl-event',  trigger: 'irl-code',      xp: 350 },  // Code system
  5: { id: 'thread-writer',    trigger: 'manual',        xp: 175 }   // Manual review
};

// ─── IRL EVENT CODES ────────────────────────────────────
const VALID_IRL_CODES = new Set([
  'RIALO-MEET-001', 'RIALO-MEET-002', 'RIALO-MEET-003',
  'RIALO-MEET-004', 'RIALO-MEET-005', 'RIALO-MEET-006',
  'RIALO-MEET-007', 'RIALO-MEET-008', 'RIALO-MEET-009',
  'RIALO-MEET-010', 'RIALO-LAGOS-001', 'RIALO-LAGOS-002',
  'RIALO-LAGOS-003', 'RIALO-LAGOS-004', 'RIALO-LAGOS-005'
]);

const usedCodes = new Set();
const pendingSubmissions = [];

// ─── VERIFIERS ──────────────────────────────────────────

// GitHub: Check user has at least 1 merged PR (matches your original logic)
async function verifyGitHub(githubUsername) {
  if (!githubUsername || !/^[a-zA-Z0-9-]{1,39}$/.test(githubUsername)) {
    return { ok: false, reason: 'Invalid GitHub username format' };
  }
  try {
    const headers = { Accept: 'application/vnd.github.v3+json' };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(
      `https://api.github.com/search/issues?q=author:${githubUsername}+type:pr+is:merged`,
      { headers }
    );
    if (!res.ok) {
      return { ok: false, reason: `GitHub API error: ${res.status}` };
    }
    const data = await res.json();
    if ((data.total_count || 0) === 0) {
      return { ok: false, reason: 'No merged pull requests found for this GitHub user' };
    }
    return { ok: true, message: `Verified ${data.total_count} merged PR(s)` };
  } catch (err) {
    return { ok: false, reason: `GitHub check failed: ${err.message}` };
  }
}

// IRL Event Code
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

// Manual review queue (Discord + Thread Writer)
function queueForReview(userAddress, questNumericId, questStringId, proof) {
  if (!proof || proof.length < 3) {
    return { ok: false, reason: 'Proof URL/handle required' };
  }
  pendingSubmissions.push({
    id: `${userAddress}-${questNumericId}-${Date.now()}`,
    userAddress,
    questNumericId,
    questStringId,
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
async function mintQuestCompletion(playerAddress, questStringId) {
  if (!process.env.RELAYER_PRIVATE_KEY) {
    throw new Error('Relayer not configured (missing RELAYER_PRIVATE_KEY)');
  }
  if (!QUEST_MANAGER_ADDRESS) {
    throw new Error('Missing NEXT_PUBLIC_QUEST_MANAGER_CONTRACT env var');
  }

  // Check if already completed
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(ALCHEMY_URL)
  });

  const alreadyDone = await publicClient.readContract({
    address: QUEST_MANAGER_ADDRESS,
    abi: QUEST_MANAGER_ABI,
    functionName: 'hasCompleted',
    args: [questStringId, playerAddress]
  });

  if (alreadyDone) return { txHash: null, alreadyCompleted: true };

  const pk = process.env.RELAYER_PRIVATE_KEY.startsWith('0x')
    ? process.env.RELAYER_PRIVATE_KEY
    : `0x${process.env.RELAYER_PRIVATE_KEY}`;

  const account = privateKeyToAccount(pk);
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(ALCHEMY_URL)
  });

  const txHash = await walletClient.writeContract({
    address: QUEST_MANAGER_ADDRESS,
    abi: QUEST_MANAGER_ABI,
    functionName: 'completeQuestAsRelayer',
    args: [playerAddress, questStringId]
  });

  return { txHash, alreadyCompleted: false };
}

// ─── MAIN HANDLER ───────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userAddress, questId, proof } = req.body || {};

    if (!userAddress || !isAddress(userAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid user address' });
    }
    const numId = Number(questId);
    if (!QUEST_MAP[numId]) {
      return res.status(400).json({ success: false, error: 'Unknown questId' });
    }

    const quest = QUEST_MAP[numId];
    let verification;

    switch (quest.trigger) {
      case 'github':
        verification = await verifyGitHub(proof);
        break;
      case 'irl-code':
        verification = verifyIRLCode(proof);
        break;
      case 'manual':
        verification = queueForReview(userAddress, numId, quest.id, proof);
        break;
      case 'onchain-self':
        // Player must call completeOnchainQuest directly from their wallet
        return res.status(200).json({
          success: false,
          requiresPlayerAction: true,
          message: 'This quest requires you to sign the transaction yourself. The frontend will guide you.',
          contractAddress: QUEST_MANAGER_ADDRESS,
          questStringId: quest.id
        });
      default:
        return res.status(500).json({ success: false, error: 'Unknown trigger type' });
    }

    if (!verification.ok) {
      return res.status(400).json({ success: false, error: verification.reason });
    }

    if (verification.pending) {
      return res.status(200).json({
        success: true,
        pending: true,
        message: verification.message
      });
    }

    // Verified — mint onchain
    const mint = await mintQuestCompletion(userAddress, quest.id);
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

module.exports.pendingSubmissions = pendingSubmissions;
module.exports.QUEST_MAP = QUEST_MAP;
