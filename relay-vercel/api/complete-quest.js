// /api/complete-quest.js
// Verifies quest completion and mints onchain via QuestManager.completeQuestAsRelayer
// Pending submissions (Discord/Thread Writer) persist in Redis.

const { createWalletClient, createPublicClient, http, parseAbi, isAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');
const { createClient } = require('redis');
const crypto = require('crypto');

const QUEST_MANAGER_ADDRESS = process.env.NEXT_PUBLIC_QUEST_MANAGER_CONTRACT;
const ALCHEMY_URL = process.env.NEXT_PUBLIC_ALCHEMY_URL || 'https://sepolia.base.org';

const QUEST_MANAGER_ABI = parseAbi([
  'function completeQuestAsRelayer(address player, string calldata questId) external',
  'function hasCompleted(string calldata questId, address player) external view returns (bool)'
]);

const QUEST_MAP = {
  1: { id: 'first-deploy',     trigger: 'onchain-self', xp: 150, title: 'Deploy on Base' },
  2: { id: 'discord-og',       trigger: 'manual',       xp: 100, title: 'Discord OG' },
  3: { id: 'github-first-pr',  trigger: 'github-oauth', xp: 200, title: 'GitHub Builder' },
  4: { id: 'first-irl-event',  trigger: 'irl-code',     xp: 350, title: 'Show Up IRL' },
  5: { id: 'thread-writer',    trigger: 'manual',       xp: 175, title: 'Thread Writer' }
};

let redisClient = null;
async function getRedis() {
  if (redisClient && redisClient.isReady) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('Redis error:', err));
  await redisClient.connect();
  return redisClient;
}

// Verify IRL code from Redis
async function verifyIRLCode(code, userAddress) {
  if (!code) return { ok: false, reason: 'Code required' };
  const normalized = code.trim().toUpperCase();

  try {
    const redis = await getRedis();
    const codeJson = await redis.get(`event-code:${normalized}`);
    if (!codeJson) return { ok: false, reason: 'Invalid event code' };
    const codeData = JSON.parse(codeJson);
    if (codeData.used) return { ok: false, reason: 'This code has already been used' };

    const eventJson = await redis.get(`event:${codeData.eventId}`);
    const event = eventJson ? JSON.parse(eventJson) : null;

    codeData.used = true;
    codeData.usedBy = userAddress.toLowerCase();
    codeData.usedAt = new Date().toISOString();
    await redis.set(`event-code:${normalized}`, JSON.stringify(codeData));

    if (event) {
      event.claimsCount = (event.claimsCount || 0) + 1;
      await redis.set(`event:${codeData.eventId}`, JSON.stringify(event));
    }

    return {
      ok: true,
      message: event ? `Verified attendance at "${event.name}"` : 'Code accepted',
      eventName: event?.name
    };
  } catch (err) {
    console.error('IRL code error:', err);
    return { ok: false, reason: 'Verification system error' };
  }
}

// Save pending submission to Redis (persistent across deploys)
async function queueForReview(userAddress, questNumericId, quest, proof) {
  if (!proof || proof.length < 3) {
    return { ok: false, reason: 'Proof URL/handle required' };
  }
  try {
    const redis = await getRedis();
    const submissionId = `sub_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const submission = {
      id: submissionId,
      userAddress: userAddress.toLowerCase(),
      questNumericId,
      questStringId: quest.id,
      questTitle: quest.title,
      questXP: quest.xp,
      proof,
      submittedAt: new Date().toISOString(),
      status: 'pending'
    };

    // Save submission
    await redis.set(`submission:${submissionId}`, JSON.stringify(submission));
    // Add to pending queue (sorted set ordered by timestamp)
    await redis.zAdd('pending-submissions', { score: Date.now(), value: submissionId });

    return {
      ok: true,
      pending: true,
      message: 'Submission received! An admin will review and approve within 24 hours.'
    };
  } catch (err) {
    console.error('Queue error:', err);
    return { ok: false, reason: 'Could not save submission: ' + err.message };
  }
}

async function mintQuestCompletion(playerAddress, questStringId) {
  if (!process.env.RELAYER_PRIVATE_KEY) {
    throw new Error('Relayer not configured (missing RELAYER_PRIVATE_KEY)');
  }
  if (!QUEST_MANAGER_ADDRESS) {
    throw new Error('Missing NEXT_PUBLIC_QUEST_MANAGER_CONTRACT env var');
  }

  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(ALCHEMY_URL) });
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
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(ALCHEMY_URL) });

  const txHash = await walletClient.writeContract({
    address: QUEST_MANAGER_ADDRESS,
    abi: QUEST_MANAGER_ABI,
    functionName: 'completeQuestAsRelayer',
    args: [playerAddress, questStringId]
  });

  return { txHash, alreadyCompleted: false };
}

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
      case 'github-oauth':
        return res.status(400).json({
          success: false,
          error: 'This quest requires GitHub OAuth. Please use the "Sign in with GitHub" button.'
        });
      case 'irl-code':
        verification = await verifyIRLCode(proof, userAddress);
        break;
      case 'manual':
        verification = await queueForReview(userAddress, numId, quest, proof);
        break;
      case 'onchain-self':
        return res.status(200).json({
          success: false,
          requiresPlayerAction: true,
          message: 'This quest requires you to sign the transaction yourself.',
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
      eventName: verification.eventName,
      txHash: mint.txHash,
      explorerUrl: `https://sepolia.basescan.org/tx/${mint.txHash}`
    });

  } catch (err) {
    console.error('complete-quest error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports.QUEST_MAP = QUEST_MAP;
