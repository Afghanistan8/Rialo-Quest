// /api/create-event.js
// Host creates an event and the system generates unique codes.
// Stored in Redis with hierarchical keys:
//   event:{eventId}              → event metadata
//   event-code:{code}            → { eventId, used, usedBy, usedAt }
//   host-events:{walletAddress}  → list of eventIds this host owns

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

// Generate a short, friendly code: PREFIX-NNNN-XXXX
function generateCode(prefix = 'RIALO') {
  const num = String(Math.floor(1000 + Math.random() * 9000));
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix.toUpperCase()}-${num}-${rand}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { hostAddress, name, location, eventDate, codeCount, codePrefix } = req.body || {};

    // Validation
    if (!hostAddress || !/^0x[a-fA-F0-9]{40}$/.test(hostAddress)) {
      return res.status(400).json({ error: 'Valid host wallet address required' });
    }
    if (!name || name.trim().length < 3) {
      return res.status(400).json({ error: 'Event name required (min 3 chars)' });
    }
    if (!location || location.trim().length < 2) {
      return res.status(400).json({ error: 'Event location required' });
    }
    if (!eventDate) {
      return res.status(400).json({ error: 'Event date required' });
    }
    const count = parseInt(codeCount) || 0;
    if (count < 1 || count > 500) {
      return res.status(400).json({ error: 'Code count must be between 1 and 500' });
    }

    const prefix = (codePrefix || 'RIALO').replace(/[^A-Z0-9]/gi, '').slice(0, 12) || 'RIALO';

    // Generate unique codes
    const codes = new Set();
    let attempts = 0;
    while (codes.size < count && attempts < count * 10) {
      codes.add(generateCode(prefix));
      attempts++;
    }
    const codesArray = Array.from(codes);

    const eventId = `evt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const event = {
      id: eventId,
      name: name.trim(),
      location: location.trim(),
      eventDate,
      hostAddress: hostAddress.toLowerCase(),
      codePrefix: prefix,
      codeCount: count,
      createdAt: new Date().toISOString(),
      claimsCount: 0
    };

    const redis = await getRedis();

    // Save event metadata
    await redis.set(`event:${eventId}`, JSON.stringify(event));

    // Save each code (no expiry — hosts decide when to delete)
    const pipeline = redis.multi();
    for (const code of codesArray) {
      pipeline.set(`event-code:${code}`, JSON.stringify({
        eventId,
        used: false,
        usedBy: null,
        usedAt: null,
        createdAt: new Date().toISOString()
      }));
    }
    await pipeline.exec();

    // Add to host's event list
    await redis.sAdd(`host-events:${hostAddress.toLowerCase()}`, eventId);

    return res.status(200).json({
      success: true,
      event,
      codes: codesArray
    });

  } catch (err) {
    console.error('create-event error:', err);
    return res.status(500).json({ error: err.message });
  }
};
